#!/usr/bin/env node
/**
 * Tests for the logic that does not need a browser: settings merging, text
 * post-processing, Power Mode matching, silence detection, and the log-mel
 * front-end. Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(join(root, p)));

// settings.js touches chrome.storage at import time, so stand in for it.
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj) => Object.assign(store, obj),
    },
    onChanged: { addListener() {} },
  },
};

let passed = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(`  ✓ ${name}`);
  } catch (err) {
    results.push(`  ✗ ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

const { postProcess, applyReplacements, removeFillers, unwrapModelOutput, autoCapitalize } = await load('src/lib/text.js');
const { resolveProfile, applyProfile, profileMatches, isSiteDisabled, makeProfile } = await load('src/lib/power-mode.js');
const { SilenceDetector, rms } = await load('src/audio/vad.js');
const { MelSpectrogram } = await load('src/audio/mel.js');
const { DEFAULTS } = await load('src/lib/defaults.js');
const settingsModule = await load('src/lib/settings.js');

// ------------------------------------------------------------------ text --

await test('replacements respect word boundaries', () => {
  const rules = [{ from: 'cat', to: 'dog' }];
  assert.equal(applyReplacements('the cat sat', rules), 'the dog sat');
  assert.equal(applyReplacements('concatenate', rules), 'concatenate');
});

await test('replacements can be case-sensitive and regex', () => {
  assert.equal(applyReplacements('API api', [{ from: 'api', to: 'X', matchCase: true }]), 'API X');
  assert.equal(applyReplacements('v1.2.3', [{ from: '\\d+\\.\\d+\\.\\d+', to: 'VER', regex: true }]), 'vVER');
});

await test('a malformed user regex does not break the pipeline', () => {
  assert.equal(applyReplacements('hello', [{ from: '([', to: 'x', regex: true }]), 'hello');
});

await test('filler removal leaves clean spacing', () => {
  assert.equal(removeFillers('um so uh yes', ['um', 'uh']).replace(/\s+/g, ' ').trim(), 'so yes');
});

await test('capitalization handles sentences and the pronoun I', () => {
  assert.equal(autoCapitalize('hello there. i went home'), 'Hello there. I went home');
});

await test('the full pipeline composes', () => {
  const dict = {
    removeFillers: true, fillerWords: ['um'], replacements: [{ from: 'jason', to: 'JSON' }],
    trimWhitespace: true, autoCapitalize: true, autoPunctuate: true,
  };
  assert.equal(postProcess('um  i sent the jason file', dict), 'I sent the JSON file.');
});

await test('model output is unwrapped', () => {
  assert.equal(unwrapModelOutput('```\nHi.\n```'), 'Hi.');
  assert.equal(unwrapModelOutput('<think>x</think>\nHi.'), 'Hi.');
  assert.equal(unwrapModelOutput('Here is the text:\n```\nHi.\n```'), 'Hi.');
  assert.equal(unwrapModelOutput('"Hi."'), 'Hi.');
  assert.equal(unwrapModelOutput('Say "hi" to them.'), 'Say "hi" to them.');
});

// ------------------------------------------------------------ power mode --

await test('domain matching covers subdomains but not lookalikes', () => {
  const profile = makeProfile({ match: { type: 'domain', value: 'google.com' } });
  assert.equal(profileMatches(profile, 'https://mail.google.com/x'), true);
  assert.equal(profileMatches(profile, 'https://google.com/'), true);
  assert.equal(profileMatches(profile, 'https://notgoogle.com/'), false);
  assert.equal(profileMatches(profile, 'https://google.com.evil.test/'), false);
});

await test('a disabled profile never matches', () => {
  const profile = makeProfile({ enabled: false, match: { type: 'domain', value: 'google.com' } });
  assert.equal(profileMatches(profile, 'https://google.com/'), false);
});

await test('profile overrides apply, and nulls inherit', () => {
  const base = structuredClone(DEFAULTS);
  base.powerMode.enabled = true;
  const profile = makeProfile({
    name: 'Gmail',
    match: { type: 'domain', value: 'mail.google.com' },
    overrides: { engine: 'whisper', enhancementEnabled: true, modeId: 'email', autoSend: null },
  });
  base.powerMode.profiles = [profile];

  const matched = resolveProfile(base, 'https://mail.google.com/mail/u/0');
  assert.equal(matched?.name, 'Gmail');

  const applied = applyProfile(base, matched);
  assert.equal(applied.transcription.engine, 'whisper');
  assert.equal(applied.enhancement.enabled, true);
  assert.equal(applied.enhancement.activeModeId, 'email');
  assert.equal(applied.output.autoSend, DEFAULTS.output.autoSend, 'null override should inherit');
  assert.equal(base.transcription.engine, DEFAULTS.transcription.engine, 'the base settings must not be mutated');
});

await test('power mode off means no profile resolves', () => {
  const base = structuredClone(DEFAULTS);
  base.powerMode.profiles = [makeProfile({ match: { type: 'domain', value: 'a.test' } })];
  assert.equal(resolveProfile(base, 'https://a.test/'), null);
});

await test('disabled sites match by suffix', () => {
  const base = structuredClone(DEFAULTS);
  base.sites.disabled = ['bank.example'];
  assert.equal(isSiteDisabled(base, 'https://login.bank.example/x'), true);
  assert.equal(isSiteDisabled(base, 'https://example.com/'), false);
});

// --------------------------------------------------------------- settings --

await test('stored settings merge over defaults without losing new keys', async () => {
  store.settings = { transcription: { engine: 'whisper' }, enhancement: { enabled: true } };
  const loaded = await settingsModule.getSettings({ force: true });
  assert.equal(loaded.transcription.engine, 'whisper', 'stored value wins');
  assert.equal(loaded.transcription.parakeet.precision, DEFAULTS.transcription.parakeet.precision, 'unknown-to-storage keys come from defaults');
  assert.equal(loaded.enhancement.modes.length, DEFAULTS.enhancement.modes.length, 'array defaults survive');
  assert.equal(loaded.recording.maxDurationSec, DEFAULTS.recording.maxDurationSec);
});

await test('an emptied array is respected rather than refilled', async () => {
  store.settings = { enhancement: { modes: [] } };
  const loaded = await settingsModule.getSettings({ force: true });
  assert.equal(loaded.enhancement.modes.length, 0);
});

await test('dotted paths read and write', async () => {
  const s = structuredClone(DEFAULTS);
  settingsModule.setPath(s, 'transcription.parakeet.device', 'webgpu');
  assert.equal(settingsModule.getPath(s, 'transcription.parakeet.device'), 'webgpu');
});

// ---------------------------------------------------------------- defaults --

await test('the defaults are the ones we ship on purpose', () => {
  assert.equal(DEFAULTS.transcription.engine, 'whisper', 'Whisper is the default engine');
  assert.equal(DEFAULTS.recording.maxDurationSec, 3000);
  assert.equal(DEFAULTS.enhancement.enabled, false, 'enhancement is opt-in');
  assert.equal(DEFAULTS.enhancement.provider, 'browser', 'on-device by default');
  assert.equal(DEFAULTS.enhancement.browser.modelId, 'onnx-community/Qwen2.5-0.5B-Instruct');
  assert.equal(DEFAULTS.enhancement.fallbackToRaw, true, 'a dead AI endpoint must not lose the dictation');
  assert.equal(DEFAULTS.hotkeys.modifierKey, 'AltRight');
  assert.equal(DEFAULTS.history.enabled, true);
});

const { dtypeCandidates } = await load('src/engines/gpu.js');

await test('a half-precision build falls back where shader-f16 is missing', () => {
  assert.deepEqual(dtypeCandidates('q4f16', false), ['q4'], 'no f16 support: skip straight to q4');
  assert.deepEqual(dtypeCandidates('q4f16', true), ['q4f16', 'q4'], 'with support, still keep a fallback');
  assert.deepEqual(dtypeCandidates('fp16', false), ['fp32']);
});

await test('quantizations needing no f16 are left alone', () => {
  for (const dtype of ['q4', 'q8', 'fp32']) {
    assert.deepEqual(dtypeCandidates(dtype, false), [dtype]);
    assert.deepEqual(dtypeCandidates(dtype, true), [dtype]);
  }
});

await test('every provider a user may have stored is preserved', async () => {
  // All three remain valid choices; loading must never quietly reassign one.
  for (const provider of ['browser', 'endpoint', 'hosted']) {
    store.settings = { version: 1, enhancement: { provider, endpoint: { baseUrl: 'http://localhost:9999/v1' } } };
    const loaded = await settingsModule.getSettings({ force: true });
    assert.equal(loaded.enhancement.provider, provider, `${provider} must survive a load`);
    assert.equal(loaded.enhancement.endpoint.baseUrl, 'http://localhost:9999/v1');
  }
});

// ------------------------------------------------------------ model urls --

const { hfApiUrl, hfFileUrl, bytesForModel } = await load('src/lib/models.js');

await test('the Hugging Face API url keeps the owner/name separator', () => {
  // Encoding the whole repo id turns the slash into %2F and the API answers 400.
  assert.equal(
    hfApiUrl('istupakov/parakeet-tdt-0.6b-v3-onnx'),
    'https://huggingface.co/api/models/istupakov/parakeet-tdt-0.6b-v3-onnx',
  );
  assert.ok(!hfApiUrl('a/b').includes('%2F'));
});

await test('file urls keep nested paths intact', () => {
  assert.equal(
    hfFileUrl('onnx-community/whisper-base', 'onnx/encoder_model.onnx'),
    'https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model.onnx',
  );
});

await test('unsafe characters in a segment are still escaped', () => {
  assert.equal(hfApiUrl('own er/na me'), 'https://huggingface.co/api/models/own%20er/na%20me');
});

await test('cached bytes are attributed to the right model', () => {
  // Both models cache into the same store, so the panels have to tell them
  // apart by repo id rather than by which cache the entry sits in.
  const entries = [
    { url: 'https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder.onnx', size: 60_000_000 },
    { url: 'https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/decoder.onnx', size: 50_000_000 },
    { url: 'https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct/resolve/main/onnx/model_q4f16.onnx', size: 400_000_000 },
  ];
  assert.equal(bytesForModel(entries, 'onnx-community/whisper-base'), 110_000_000);
  assert.equal(bytesForModel(entries, 'onnx-community/Qwen2.5-0.5B-Instruct'), 400_000_000);
  assert.equal(bytesForModel(entries, 'onnx-community/whisper-small'), 0, 'an uncached model reports nothing');
  assert.equal(bytesForModel(entries, ''), 0);
});

await test('a model name that prefixes another is not double counted', () => {
  const entries = [
    { url: 'https://huggingface.co/onnx-community/whisper-base.en/resolve/main/m.onnx', size: 10 },
  ];
  assert.equal(bytesForModel(entries, 'onnx-community/whisper-base'), 0, 'whisper-base must not claim whisper-base.en');
});

// -------------------------------------------------------------------- vad --

await test('silence detection fires only after sustained quiet', () => {
  const det = new SilenceDetector({ silenceMs: 1000, graceMs: 0 });
  let now = 0;
  for (let i = 0; i < 20; i += 1) det.push(0.2, now += 50); // speech
  assert.equal(det.push(0.2, now += 50), false);
  let fired = false;
  for (let i = 0; i < 30 && !fired; i += 1) fired = det.push(0.0005, now += 50);
  assert.equal(fired, true, 'should stop after ~1s of quiet');
});

await test('steady speech never triggers a stop', () => {
  const det = new SilenceDetector({ silenceMs: 500, graceMs: 0 });
  let now = 0;
  for (let i = 0; i < 200; i += 1) {
    assert.equal(det.push(0.15, now += 20), false);
  }
});

await test('a noisy room calibrates instead of recording forever', () => {
  // 700 ms of ambient hiss, then speech, then back to hiss: the detector should
  // learn the hiss during the grace window and still stop when talking ends.
  const det = new SilenceDetector({ silenceMs: 1000, graceMs: 700 });
  let now = 0;
  for (let i = 0; i < 14; i += 1) det.push(0.05, now += 50);   // ambient
  for (let i = 0; i < 20; i += 1) {
    assert.equal(det.push(0.30, now += 50), false, 'speech must not trigger a stop');
  }
  let fired = false;
  for (let i = 0; i < 40 && !fired; i += 1) fired = det.push(0.05, now += 50);
  assert.equal(fired, true, 'returning to ambient should end the recording');
});

await test('rms is correct for a known signal', () => {
  const block = new Float32Array(1000).fill(0.5);
  assert.ok(Math.abs(rms(block) - 0.5) < 1e-6);
});

// ------------------------------------------------------------------ chirp --

const { chirpWav } = await load('src/audio/chirp.js');

await test('the chirp is a valid WAV of the requested length', async () => {
  const blob = chirpWav(880, 0.08, 0.25, 44100);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const ascii = (from, n) => String.fromCharCode(...bytes.slice(from, from + n));
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  const expected = Math.round(44100 * 0.08);
  assert.equal(bytes.length, 44 + expected * 2, 'header plus 16-bit samples');
});

await test('the chirp fades in and out so it cannot click', async () => {
  const blob = chirpWav(880, 0.08, 0.5, 44100);
  const view = new DataView(await blob.arrayBuffer());
  const sampleAt = (i) => view.getInt16(44 + i * 2, true) / 32767;
  const count = (view.byteLength - 44) / 2;
  assert.ok(Math.abs(sampleAt(0)) < 0.02, 'starts near silence');
  assert.ok(Math.abs(sampleAt(count - 1)) < 0.02, 'ends near silence');
  let peak = 0;
  for (let i = 0; i < count; i += 1) peak = Math.max(peak, Math.abs(sampleAt(i)));
  assert.ok(peak > 0.4 && peak <= 0.51, `peak should reach the requested volume, got ${peak.toFixed(3)}`);
});

await test('zero volume produces silence rather than a click', async () => {
  const blob = chirpWav(880, 0.05, 0, 44100);
  const view = new DataView(await blob.arrayBuffer());
  for (let i = 0; i < (view.byteLength - 44) / 2; i += 1) {
    assert.equal(view.getInt16(44 + i * 2, true), 0);
  }
});

// -------------------------------------------------------------------- mel --

await test('log-mel produces the expected shape and normalization', () => {
  const mel = new MelSpectrogram();
  const sr = 16000;
  const samples = new Float32Array(sr); // 1 second
  for (let i = 0; i < samples.length; i += 1) samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr);
  const { data, nMels, frames } = mel.compute(samples);

  assert.equal(nMels, 128);
  assert.equal(frames, 101, '10 ms hop over 1 s with centre padding');
  assert.equal(data.length, 128 * 101);
  assert.ok(data.every(Number.isFinite), 'no NaN or Infinity');

  // per_feature normalization means each mel bin has ~zero mean.
  for (let m = 0; m < nMels; m += 1) {
    let sum = 0;
    for (let t = 0; t < frames; t += 1) sum += data[m * frames + t];
    assert.ok(Math.abs(sum / frames) < 1e-3, `bin ${m} mean should be ~0`);
  }
});

await test('log-mel puts a 440 Hz tone in a low mel bin', () => {
  const mel = new MelSpectrogram();
  const sr = 16000;
  const samples = new Float32Array(sr * 0.5);
  for (let i = 0; i < samples.length; i += 1) samples[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
  const { data, nMels, frames } = mel.compute(samples);

  // Energy is normalized per bin, so compare pre-normalization ranking by
  // looking at which bin varies least — a pure tone excites one narrow band.
  const mid = Math.floor(frames / 2);
  let loud = 0;
  let best = -Infinity;
  const raw = new MelSpectrogram({ preemph: 0 });
  const spectrum = raw.compute(samples);
  for (let m = 0; m < nMels; m += 1) {
    const v = spectrum.data[m * spectrum.frames + mid];
    if (v > best) { best = v; loud = m; }
  }
  // 440 Hz sits around mel bin 30 of 128 on a 0-8 kHz Slaney scale.
  assert.ok(loud > 10 && loud < 55, `expected a low-mid bin, got ${loud}`);
  assert.ok(Number.isFinite(data[0]));
});

// ----------------------------------------------------------------- history --
// Exercises the real IndexedDB code against an in-memory implementation. The
// store is the one piece where a silent write failure looks exactly like an
// empty history, so it is worth running for real rather than reasoning about.

let fakeIdb = true;
try {
  await import('fake-indexeddb/auto');
} catch {
  fakeIdb = false;
  results.push('  – history tests skipped (run "npm install" for fake-indexeddb)');
}

if (fakeIdb) {
  const history = await load('src/lib/history.js');
  const entry = (over = {}) => ({
    raw: 'hello world', final: 'Hello world.', enhanced: false, modeId: null,
    engine: 'whisper', language: 'auto', durationMs: 1500, latencyMs: 900,
    url: 'https://example.com/', title: 'Example', ...over,
  });

  await test('an entry survives a write, a prune, and a read back', async () => {
    const written = await history.addEntry(entry());
    assert.equal(written.wordCount, 2);
    assert.equal(await history.countEntries(), 1);

    // The service worker prunes immediately after every write; the entry it
    // just wrote must not be what gets pruned.
    await history.prune({ retainDays: 30, maxEntries: 500 });
    assert.equal(await history.countEntries(), 1, 'prune must not delete a fresh entry');

    const list = await history.listEntries({ limit: 200, query: '' });
    assert.equal(list.length, 1);
    assert.equal(list[0].final, 'Hello world.');
  });

  await test('search matches transcript and title', async () => {
    await history.addEntry(entry({ final: 'Entirely different text.', title: 'Somewhere else' }));
    assert.equal((await history.listEntries({ query: 'different' })).length, 1);
    assert.equal((await history.listEntries({ query: 'Somewhere' })).length, 1);
    assert.equal((await history.listEntries({ query: 'nothing matches this' })).length, 0);
  });

  await test('newest entries come first', async () => {
    await history.clearHistory();
    await history.addEntry(entry({ final: 'first' }));
    await new Promise((r) => setTimeout(r, 2));
    await history.addEntry(entry({ final: 'second' }));
    const list = await history.listEntries({});
    assert.equal(list[0].final, 'second');
  });

  await test('retention limits actually delete', async () => {
    await history.clearHistory();
    for (let i = 0; i < 5; i += 1) await history.addEntry(entry({ final: `entry ${i}` }));
    await history.prune({ retainDays: 30, maxEntries: 3 });
    assert.equal(await history.countEntries(), 3, 'maxEntries should cap the store');
  });

  await test('export produces usable json and csv', async () => {
    await history.clearHistory();
    await history.addEntry(entry({ final: 'He said "hi", then left.' }));
    const json = JSON.parse(await history.exportEntries('json'));
    assert.equal(json.length, 1);
    const csv = await history.exportEntries('csv');
    assert.ok(csv.split('\n')[0].startsWith('timestamp,'));
    assert.ok(csv.includes('""hi""'), 'quotes must be escaped for CSV');
  });

  await history.clearHistory();
}

console.log(results.join('\n'));
console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}`);
