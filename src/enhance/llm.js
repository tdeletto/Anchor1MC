/**
 * Chat-completions clients for the enhancement layer.
 *
 * Two shapes: an on-device WebGPU model through Transformers.js, which reuses
 * the same ONNX Runtime the speech engines already load, and any
 * OpenAI-compatible server — one you run yourself, or a hosted one with a key.
 * Both endpoint providers share a client; only the key differs.
 */
import { logger } from '../lib/log.js';
import { dtypeCandidates, hasShaderF16 } from '../engines/gpu.js';

const log = logger('llm');
const trimSlash = (s) => (s ?? '').replace(/\/+$/, '');

/** @returns {Promise<string>} assistant text */
export async function chatViaEndpoint({ baseUrl, model, apiKey }, messages, { temperature = 0.2, timeoutMs = 30000, signal, maxTokens = 1024 } = {}) {
  if (!baseUrl) throw new Error('No AI endpoint configured.');
  const url = `${trimSlash(baseUrl)}/chat/completions`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
      signal: composite,
    });
  } catch (err) {
    if (timeout.aborted) throw new Error(`The AI endpoint did not answer within ${Math.round(timeoutMs / 1000)}s.`);
    if (signal?.aborted) throw err;
    throw new Error(`Could not reach ${url}. (${err.message})`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI endpoint returned HTTP ${res.status}. ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
  if (typeof text !== 'string') throw new Error('AI endpoint replied without message content.');
  return text;
}

let browserPipe = null;
let browserKey = null;

/** On-device generation. First call downloads the model. */
export async function ensureBrowserLlm({ modelId, dtype = 'q4f16', device = 'webgpu' }, { onProgress } = {}) {
  const { env, pipeline } = await import('../../vendor/transformers/transformers.web.min.js');
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/ort/');
  env.backends.onnx.wasm.proxy = false;
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  const key = `${modelId}:${dtype}:${device}`;
  if (!browserPipe || browserKey !== key) {
    try { await browserPipe?.dispose?.(); } catch { /* nothing loaded */ }

    // A half-precision build fails to load outright on a GPU without
    // shader-f16, so drop to the equivalent full-precision build rather than
    // letting the user hit an unexplained error.
    const candidates = dtypeCandidates(dtype, await hasShaderF16());
    let lastError = null;
    for (const candidate of candidates) {
      try {
        onProgress?.({ phase: 'downloading', message: `Downloading ${modelId}…` });
        browserPipe = await pipeline('text-generation', modelId, {
          dtype: candidate,
          device,
          progress_callback: (p) => {
            if (p.status === 'progress') onProgress?.({ phase: 'downloading', message: `Downloading ${p.file ?? modelId}…`, file: p.file, loaded: p.loaded, total: p.total });
          },
        });
        if (candidate !== dtype) log.warn(`${dtype} unavailable on this GPU; loaded ${candidate} instead`);
        log.info(`on-device LLM ready: ${modelId}:${candidate}:${device}`);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        browserPipe = null;
        log.warn(`could not load ${modelId} as ${candidate}: ${err?.message ?? err}`);
      }
    }
    if (!browserPipe) throw new Error(`Could not load ${modelId} on this device: ${lastError?.message ?? lastError}`);
    browserKey = key;
  }
  onProgress?.({ phase: 'ready', message: 'Ready' });
  return browserPipe;
}

/** Whether the on-device model is currently resident. */
export function browserLlmStatus() {
  return { loaded: !!browserPipe, key: browserKey };
}

/** @returns {Promise<string>} assistant text from the on-device model */
export async function chatViaBrowser(config, messages, { temperature = 0.2, onProgress, signal } = {}) {
  const pipe = await ensureBrowserLlm(config, { onProgress });

  const out = await pipe(messages, {
    max_new_tokens: config.maxNewTokens ?? 512,
    temperature,
    do_sample: temperature > 0,
    return_full_text: false,
  });
  signal?.throwIfAborted();
  const generated = out?.[0]?.generated_text;
  if (typeof generated === 'string') return generated;
  // Chat-formatted pipelines return the message list; take the last turn.
  if (Array.isArray(generated)) return generated.at(-1)?.content ?? '';
  return '';
}

export async function unloadBrowserLlm() {
  try { await browserPipe?.dispose?.(); } catch { /* nothing loaded */ }
  browserPipe = null;
  browserKey = null;
}

/** Reachability check for the options page. */
export async function testChatEndpoint({ baseUrl, apiKey }) {
  const url = `${trimSlash(baseUrl)}/models`;
  try {
    const res = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status} from ${url}` };
    const data = await res.json().catch(() => null);
    const models = (data?.data ?? data?.models ?? []).map((m) => m.id ?? m.name ?? String(m)).filter(Boolean);
    return { ok: true, message: models.length ? `Reachable — ${models.length} model(s)` : 'Reachable', models };
  } catch (err) {
    return { ok: false, message: `Could not reach ${url}: ${err.message}` };
  }
}
