/**
 * Keeps at most one transcription engine loaded, and swaps it when the
 * configuration changes. Loading Parakeet costs seconds and hundreds of
 * megabytes of memory, so the instance is kept warm between dictations unless
 * the user has asked otherwise.
 */
import { logger } from '../lib/log.js';

const log = logger('registry');

/**
 * Engines are imported on demand. Parakeet drags in ONNX Runtime and Whisper
 * drags in Transformers.js, so importing all four up front would make someone
 * using a self-hosted endpoint — who needs neither — pay for both.
 */
const ENGINE_LOADERS = {
  parakeet: () => import('./parakeet.js').then((m) => m.ParakeetEngine),
  whisper: () => import('./whisper.js').then((m) => m.WhisperEngine),
  remote: () => import('./remote.js').then((m) => m.RemoteEngine),
  webspeech: () => import('./webspeech.js').then((m) => m.WebSpeechEngine),
};

export const ENGINE_IDS = Object.keys(ENGINE_LOADERS);

/** Per-engine slice of settings, so an engine never sees the whole tree. */
export function configFor(settings) {
  const t = settings.transcription;
  const base = { numThreads: settings.advanced?.numThreads ?? 'auto' };
  switch (t.engine) {
    case 'parakeet': return { ...base, ...t.parakeet };
    case 'whisper': return { ...base, ...t.whisper };
    case 'remote': return { ...base, ...t.remote };
    case 'webspeech': return { ...base, ...t.webspeech };
    default: throw new Error(`Unknown transcription engine "${t.engine}"`);
  }
}

let current = null;      // { id, key, engine }
let unloadTimer = null;

export function activeEngine() {
  return current?.engine ?? null;
}

/** Load (or reuse) the engine the settings ask for. */
export async function getEngine(settings, { onProgress, signal } = {}) {
  const id = settings.transcription.engine;
  const loader = ENGINE_LOADERS[id];
  if (!loader) throw new Error(`Unknown transcription engine "${id}"`);
  const Engine = await loader();

  const config = configFor(settings);
  const probe = new Engine(config);
  const key = probe.modelKey;

  if (current && current.id === id && current.key === key) {
    scheduleUnload(settings);
    return current.engine;
  }

  if (current) {
    log.info(`swapping engine ${current.id} -> ${id}`);
    await current.engine.unload().catch(() => {});
    current = null;
  }

  await probe.load({ onProgress, signal });
  current = { id, key, engine: probe };
  scheduleUnload(settings);
  return probe;
}

export async function unloadEngine() {
  clearTimeout(unloadTimer);
  unloadTimer = null;
  if (!current) return;
  await current.engine.unload().catch(() => {});
  current = null;
  log.info('engine unloaded');
}

/** Free the model after an idle stretch, unless the user wants it resident. */
export function scheduleUnload(settings) {
  clearTimeout(unloadTimer);
  const minutes = settings.advanced?.unloadAfterMinutes ?? 0;
  if (!settings.advanced?.keepModelWarm) {
    // Not keeping it warm means dropping it as soon as the dictation is done.
    unloadTimer = setTimeout(() => unloadEngine(), 1000);
    return;
  }
  if (minutes > 0) unloadTimer = setTimeout(() => unloadEngine(), minutes * 60_000);
}

/** Engine status for the options page, without forcing a load. */
export function engineStatus() {
  return current
    ? { loaded: true, id: current.id, key: current.key, provider: current.engine.provider ?? null }
    : { loaded: false, id: null, key: null, provider: null };
}
