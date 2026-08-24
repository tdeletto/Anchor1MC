/**
 * The offscreen document does everything a service worker cannot: hold a
 * microphone stream, run WebGPU/WASM inference, play sounds, and touch the
 * clipboard. The service worker drives it by message.
 */
import { MSG } from '../lib/messaging.js';
import { setLogLevel, logger } from '../lib/log.js';
import { concat, resampleTo16k, TARGET_RATE } from '../audio/resample.js';
import { SilenceDetector, rms } from '../audio/vad.js';
import { chirpWav } from '../audio/chirp.js';
import { postProcess } from '../lib/text.js';
import { cacheStats, clearModelCache, formatBytes } from '../lib/models.js';

/**
 * Everything above is small and dependency-free. The engines are not: they pull
 * in ONNX Runtime and Transformers.js, tens of megabytes that take real time to
 * evaluate and can fail for their own reasons.
 *
 * Loading them at the top would mean the message listener does not register
 * until they finish — and never registers at all if one of them throws. The
 * service worker would then see silence and could say nothing more useful than
 * "the audio worker did not respond". So they are imported on first use, after
 * the listener is already in place, and an import failure surfaces as an error
 * on the call that needed it.
 */
const load = {
  registry: () => import('../engines/registry.js'),
  webspeech: () => import('../engines/webspeech.js'),
  remote: () => import('../engines/remote.js'),
  llm: () => import('../enhance/llm.js'),
  enhance: () => import('../enhance/enhance.js'),
  gpu: () => import('../engines/gpu.js'),
};

const log = logger('offscreen');

/** Live recording state; null whenever we are idle. */
let capture = null;
let audioContext = null;

const toBackground = (type, payload = {}) => chrome.runtime.sendMessage({ target: 'background', type, ...payload }).catch(() => {});

// ---------------------------------------------------------------- capture ---

/**
 * The one AudioContext, always resumed.
 *
 * A context created here starts suspended: autoplay policy wants a user
 * gesture, and an offscreen document never has one. While suspended its clock
 * does not advance, so anything scheduled against currentTime simply never
 * happens — silently. So resume() is attempted on creation too, not only when
 * reusing an existing context.
 */
async function getAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    // Ask for 16 kHz, the rate every engine wants anyway. The browser
    // resamples the microphone for us, which removes a conversion step and
    // cuts the memory a long recording holds by two thirds — at 48 kHz the
    // maximum-length ceiling would be hundreds of megabytes of Float32.
    try {
      audioContext = new AudioContext({ sampleRate: TARGET_RATE });
    } catch {
      // Some devices refuse a forced rate; the resample path still handles it.
      audioContext = new AudioContext();
    }
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL('src/offscreen/recorder-worklet.js'));
    log.info(`audio context running at ${audioContext.sampleRate} Hz`);
  }
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch (err) {
      log.warn('could not resume the audio context', err?.message ?? err);
    }
  }
  return audioContext;
}


async function startCapture(settings) {
  if (capture) await abortCapture();

  const rec = settings.recording;
  const constraints = {
    audio: {
      echoCancellation: rec.echoCancellation,
      noiseSuppression: rec.noiseSuppression,
      autoGainControl: rec.autoGainControl,
      ...(rec.deviceId && rec.deviceId !== 'default' ? { deviceId: { exact: rec.deviceId } } : {}),
    },
  };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // The offscreen document cannot show a permission prompt, so the grant has
    // to have happened already on an extension page.
    throw new Error(
      err.name === 'NotAllowedError'
        ? 'Microphone access is not granted. Open Anchor1MC options and click “Grant microphone access”.'
        : `Could not open the microphone: ${err.message}`,
    );
  }

  const ctx = await getAudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'anchor1mc-recorder');

  const state = {
    stream,
    source,
    node,
    chunks: [],
    length: 0,
    sampleRate: ctx.sampleRate,
    startedAt: performance.now(),
    detector: new SilenceDetector({ silenceMs: rec.autoStopSilenceMs }),
    settings,
    aborted: false,
    live: null,
    lastLevelSent: 0,
  };

  // The Chrome speech engine listens on its own stream in parallel; ours still
  // drives the level meter, the auto-stop timer, and audio retention.
  if (settings.transcription.engine === 'webspeech') {
    const { WebSpeechEngine } = await load.webspeech();
    const engine = new WebSpeechEngine(settings.transcription.webspeech);
    await engine.load();
    state.live = engine.start({
      language: settings.transcription.language,
      onPartial: (text) => toBackground(MSG.PARTIAL_TEXT, { text }),
    });
    state.liveEngine = engine;
  }

  node.port.onmessage = (event) => {
    if (state.aborted) return;
    const block = event.data;
    state.chunks.push(block);
    state.length += block.length;

    const level = rms(block);
    const now = performance.now();
    if (now - state.lastLevelSent > 80) {
      state.lastLevelSent = now;
      toBackground(MSG.CAPTURE_LEVEL, { level, elapsedMs: now - state.startedAt });
    }

    const elapsed = (now - state.startedAt) / 1000;
    if (elapsed >= rec.maxDurationSec) {
      toBackground(MSG.STOP_CAPTURE, { reason: 'max-duration' });
      return;
    }
    if (rec.autoStopEnabled && state.detector.push(level, now)) {
      toBackground(MSG.STOP_CAPTURE, { reason: 'silence' });
    }
  };

  source.connect(node);
  // Not connected to the destination: we are recording, not monitoring.
  capture = state;
  if (rec.soundFeedback) void playTone(880, 0.08, rec.soundVolume);
  log.info('capture started', { sampleRate: state.sampleRate });
  return { sampleRate: state.sampleRate };
}

function teardownCapture(state) {
  try { state.node.port.postMessage('stop'); } catch { /* already gone */ }
  try { state.source.disconnect(); } catch { /* already gone */ }
  try { state.node.disconnect(); } catch { /* already gone */ }
  for (const track of state.stream.getTracks()) track.stop();
}

async function abortCapture() {
  if (!capture) return;
  const state = capture;
  capture = null;
  state.aborted = true;
  state.live?.abort();
  teardownCapture(state);
  log.info('capture aborted');
}

/**
 * Stop recording and run the full pipeline: transcribe, post-process, enhance.
 * @returns {Promise<object>} result payload for the service worker
 */
async function stopCaptureAndTranscribe({ context, settings: overrideSettings }) {
  if (!capture) throw new Error('Nothing is being recorded.');
  const state = capture;
  capture = null;
  const settings = overrideSettings ?? state.settings;
  const rec = settings.recording;

  teardownCapture(state);
  if (rec.soundFeedback) void playTone(660, 0.08, rec.soundVolume);

  const durationMs = performance.now() - state.startedAt;
  if (durationMs < rec.minDurationMs) {
    state.live?.abort();
    log.info('discarded a tap shorter than minDurationMs');
    return { discarded: true, reason: 'too-short', durationMs };
  }

  const started = performance.now();
  const raw = concat(state.chunks, state.length);
  const samples = await resampleTo16k(raw, state.sampleRate);

  let text = '';
  if (state.live) {
    const result = await state.live.finish();
    text = result.text;
  } else {
    const { getEngine, scheduleUnload } = await load.registry();
    const engine = await getEngine(settings, {
      onProgress: (p) => toBackground(MSG.MODEL_PROGRESS, { progress: p, kind: 'speech' }),
    });
    const result = await engine.transcribe(samples, {
      language: settings.transcription.language,
      translate: settings.transcription.translateToEnglish,
      initialPrompt: buildInitialPrompt(settings),
      onPartial: (partial) => toBackground(MSG.PARTIAL_TEXT, { text: partial }),
    });
    text = result.text;
    scheduleUnload(settings);
  }

  const transcribedAt = performance.now();
  const cleaned = postProcess(text, settings.dictionary);

  let final = cleaned;
  let enhanced = false;
  let enhanceError = null;
  if (settings.enhancement.enabled && cleaned) {
    toBackground(MSG.STATE_CHANGED, { state: 'enhancing' });
    const { enhance } = await load.enhance();
    const result = await enhance(cleaned, settings, {
      context,
      onProgress: (p) => toBackground(MSG.MODEL_PROGRESS, { progress: p, kind: 'ai' }),
    });
    // Replacements run again so dictionary spellings survive the rewrite.
    final = settings.dictionary.replacements.length
      ? postProcess(result.text, { ...settings.dictionary, removeFillers: false, autoPunctuate: false })
      : result.text;
    enhanced = result.enhanced;
    enhanceError = result.error ?? null;
  }

  return {
    discarded: false,
    raw: cleaned,
    rawEngineText: text,
    final,
    enhanced,
    enhanceError,
    durationMs,
    latencyMs: performance.now() - started,
    transcribeMs: transcribedAt - started,
    engine: settings.transcription.engine,
    language: settings.transcription.language,
    modeId: settings.enhancement.enabled ? settings.enhancement.activeModeId : null,
    sampleRate: TARGET_RATE,
  };
}

/** Whisper-style biasing prompt built from the user's dictionary. */
function buildInitialPrompt(settings) {
  const words = settings.dictionary?.words ?? [];
  const base = settings.transcription.initialPrompt ?? '';
  if (!words.length) return base;
  const hint = `Vocabulary: ${words.join(', ')}.`;
  return base ? `${base} ${hint}` : hint;
}

// ------------------------------------------------------------------ sound ---

/**
 * Play a short chirp, by whichever route works.
 *
 * The AudioContext path is preferred — it is cheap and needs no allocation —
 * but it is the one subject to a suspended clock. An <audio> element playing a
 * generated WAV is the route Chrome's own offscreen documentation uses for the
 * AUDIO_PLAYBACK reason, so it is the fallback rather than the other way round.
 *
 * @returns {Promise<{ok: boolean, via?: string, error?: string}>}
 */
async function playTone(frequency, seconds = 0.08, volume = 0.25) {
  const level = Math.max(0, Math.min(1, volume));
  if (level === 0) return { ok: true, via: 'muted' };

  try {
    const ctx = await getAudioContext();
    if (ctx.state === 'running') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      osc.type = 'sine';
      // Scheduled slightly ahead, so the attack is not clipped by the time the
      // graph is actually wired up.
      const start = ctx.currentTime + 0.01;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(level, start + 0.006);
      gain.gain.setValueAtTime(level, start + seconds - 0.02);
      gain.gain.linearRampToValueAtTime(0, start + seconds);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + seconds + 0.02);
      return { ok: true, via: 'audiocontext' };
    }
    log.warn(`audio context is "${ctx.state}"; falling back to an audio element`);
  } catch (err) {
    log.warn('audio context chirp failed', err?.message ?? err);
  }

  try {
    const url = URL.createObjectURL(chirpWav(frequency, seconds, level));
    const element = new Audio(url);
    element.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
    await element.play();
    return { ok: true, via: 'audio-element' };
  } catch (err) {
    log.error('could not play the chirp', err);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// -------------------------------------------------------------- clipboard ---

function copyToClipboard(text) {
  // navigator.clipboard needs focus, which an offscreen document never has;
  // the textarea + execCommand path still works here.
  const area = document.createElement('textarea');
  area.value = text;
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}

// --------------------------------------------------------------- messages ---

const handlers = {
  async [MSG.START_CAPTURE]({ settings }) {
    return startCapture(settings);
  },
  async [MSG.STOP_CAPTURE](payload) {
    return stopCaptureAndTranscribe(payload ?? {});
  },
  async [MSG.ABORT_CAPTURE]() {
    await abortCapture();
    return { ok: true };
  },
  async [MSG.PING]() {
    // Answered as soon as this listener exists, which is the whole point:
    // it lets the service worker wait for readiness instead of guessing.
    return { ready: true };
  },
  async [MSG.PRELOAD_MODEL]({ settings }) {
    const { getEngine, engineStatus } = await load.registry();
    await getEngine(settings, { onProgress: (p) => toBackground(MSG.MODEL_PROGRESS, { progress: p, kind: 'speech' }) });
    return engineStatus();
  },
  async [MSG.UNLOAD_MODEL]() {
    const { unloadEngine, engineStatus } = await load.registry();
    const { unloadBrowserLlm } = await load.llm();
    await unloadEngine();
    await unloadBrowserLlm();
    return engineStatus();
  },
  async [MSG.MODEL_STATUS]() {
    const stats = await cacheStats();
    // The cache is readable on its own, so report it even when the engine
    // modules refuse to load — that is exactly when someone needs to see it,
    // and the import error is more useful inline than swallowed.
    let engine = { loaded: false, id: null, key: null, provider: null };
    try {
      const { engineStatus } = await load.registry();
      engine = engineStatus();
    } catch (err) {
      engine.error = err?.message ?? String(err);
      log.error('engine modules failed to load', err);
    }
    return { ...engine, cacheBytes: stats.bytes, cacheHuman: formatBytes(stats.bytes), entries: stats.entries };
  },
  async [MSG.PRELOAD_LLM]({ config }) {
    const { ensureBrowserLlm, browserLlmStatus } = await load.llm();
    await ensureBrowserLlm(config, {
      onProgress: (p) => toBackground(MSG.MODEL_PROGRESS, { progress: p, kind: 'ai' }),
    });
    return browserLlmStatus();
  },
  async [MSG.UNLOAD_LLM]() {
    const { unloadBrowserLlm, browserLlmStatus } = await load.llm();
    await unloadBrowserLlm();
    return browserLlmStatus();
  },
  async [MSG.LLM_STATUS]() {
    const { browserLlmStatus } = await load.llm();
    return browserLlmStatus();
  },
  async [MSG.CLEAR_MODEL_CACHE]({ urlPrefix } = {}) {
    const { unloadEngine } = await load.registry();
    await unloadEngine();
    const removed = await clearModelCache(urlPrefix ?? null);
    return { removed };
  },
  async [MSG.TEST_ENDPOINT]({ kind, config }) {
    if (kind === 'chat') {
      const { testChatEndpoint } = await load.llm();
      return testChatEndpoint(config);
    }
    const { testTranscriptionEndpoint } = await load.remote();
    return testTranscriptionEndpoint(config);
  },
  async [MSG.LIST_DEVICES]() {
    // Labels only populate once mic permission has been granted.
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }));
  },
  async [MSG.PROBE_CAPABILITIES]() {
    const { hasWebGpu } = await load.gpu();
    return {
      webgpu: await hasWebGpu(),
      crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated,
      threads: typeof SharedArrayBuffer !== 'undefined',
      cores: navigator.hardwareConcurrency ?? null,
      memoryGb: navigator.deviceMemory ?? null,
      speechRecognition: !!(globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition),
    };
  },
  async [MSG.PLAY_SOUND]({ frequency = 880, seconds = 0.08, volume = 0.25 }) {
    // Awaited and returned, so the Test button can report what actually
    // happened instead of always claiming success.
    return playTone(frequency, seconds, volume);
  },
  async [MSG.COPY_TO_CLIPBOARD]({ text }) {
    return { ok: copyToClipboard(text) };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  const handler = handlers[message.type];
  if (!handler) return false;
  // Settings ride along with every operational message, since this document
  // cannot read them from storage itself.
  if (message.settings?.advanced?.logLevel) setLogLevel(message.settings.advanced.logLevel);
  handler(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => {
      log.error(message.type, err);
      sendResponse({ ok: false, error: err?.message ?? String(err) });
    });
  return true; // async response
});

toBackground(MSG.OFFSCREEN_READY);
log.info('offscreen document ready');
