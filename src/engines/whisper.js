/**
 * Whisper on-device via Transformers.js. Lighter than Parakeet and the sensible
 * choice on modest hardware or while the Parakeet download finishes.
 */
import { env, pipeline } from '../../vendor/transformers/transformers.web.min.js';
import { logger } from '../lib/log.js';
import { hasWebGpu, hasShaderF16, dtypeCandidates } from './gpu.js';

const log = logger('whisper');
let envReady = false;

function prepareEnv() {
  if (envReady) return;
  // Everything ORT needs is vendored; nothing may be pulled from a CDN.
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/ort/');
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  env.backends.onnx.wasm.numThreads = isolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  env.backends.onnx.wasm.proxy = false;
  // Weights still come from Hugging Face, and are cached by Transformers.js.
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  envReady = true;
}

export class WhisperEngine {
  static id = 'whisper';
  static displayName = 'Whisper (on-device)';

  constructor(config = {}) {
    this.config = config;
    this.loaded = false;
  }

  get modelKey() {
    return `${this.config.modelId}:${this.config.dtype}`;
  }

  async load({ onProgress } = {}) {
    if (this.loaded) return;
    prepareEnv();
    const { modelId, dtype = 'q8', device = 'auto' } = this.config;
    const resolved = device === 'auto' ? (await hasWebGpu() ? 'webgpu' : 'wasm') : device;

    // Half-precision builds need shader-f16, which not every integrated GPU
    // has; without it the load fails rather than degrading.
    const candidates = dtypeCandidates(dtype, await hasShaderF16());
    let lastError = null;
    for (const candidate of candidates) {
      try {
        onProgress?.({ phase: 'downloading', message: `Downloading ${modelId}…` });
        this.pipe = await pipeline('automatic-speech-recognition', modelId, {
          dtype: candidate,
          device: resolved,
          progress_callback: (p) => {
            if (p.status === 'progress') {
              onProgress?.({ phase: 'downloading', message: `Downloading ${p.file ?? modelId}…`, file: p.file, loaded: p.loaded, total: p.total });
            } else if (p.status === 'ready') {
              onProgress?.({ phase: 'ready', message: 'Ready' });
            }
          },
        });
        if (candidate !== dtype) log.warn(`${dtype} unavailable on this GPU; loaded ${candidate} instead`);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        this.pipe = null;
        log.warn(`could not load ${modelId} as ${candidate}: ${err?.message ?? err}`);
      }
    }
    if (!this.pipe) throw new Error(`Could not load ${modelId} on this device: ${lastError?.message ?? lastError}`);
    this.provider = resolved;
    this.loaded = true;
    log.info(`loaded ${modelId} (${dtype}) on ${resolved}`);
  }

  /**
   * @param {Float32Array} samples 16 kHz mono
   */
  async transcribe(samples, { language, translate, initialPrompt, onPartial } = {}) {
    if (!this.loaded) throw new Error('Whisper engine used before load()');
    const options = {
      chunk_length_s: this.config.chunkLengthSec ?? 30,
      stride_length_s: this.config.strideLengthSec ?? 5,
      task: translate ? 'translate' : 'transcribe',
      return_timestamps: false,
      // Whisper decodes greedily and can fall into a loop, emitting one word
      // hundreds of times. A mild penalty discourages it, and blocking a
      // repeated six-word sequence caps any loop that still forms — six being
      // long enough that ordinary speech never trips it. Anything that gets
      // through is caught again by collapseRepetition on the text.
      repetition_penalty: 1.1,
      no_repeat_ngram_size: 6,
    };
    // 'auto' means let Whisper detect; anything else pins the decoder.
    if (language && language !== 'auto') options.language = language;
    // Whisper takes a biasing prompt as decoder context where supported.
    if (initialPrompt) options.prompt = initialPrompt;

    const result = await this.pipe(samples, options);
    const text = (Array.isArray(result) ? result.map((r) => r.text).join(' ') : result.text) ?? '';
    onPartial?.(text.trim());
    return { text: text.trim() };
  }

  async unload() {
    try { await this.pipe?.dispose?.(); } catch { /* already gone */ }
    this.pipe = null;
    this.loaded = false;
  }
}
