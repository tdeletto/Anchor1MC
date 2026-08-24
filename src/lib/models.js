/**
 * Model catalog plus the download/cache layer.
 *
 * Weights are data, not code, so MV3 lets us fetch them at runtime. They go
 * into Cache Storage keyed by URL, and are handed to ONNX Runtime as
 * ArrayBuffers, which means everything works offline after the first download.
 *
 * File names inside a Hugging Face repo are resolved from the repo listing
 * rather than hardcoded, because ONNX exports of the same model do not agree on
 * naming (encoder-model.onnx vs encoder.onnx vs model_encoder.onnx, and so on).
 */
import { logger } from './log.js';

const log = logger('models');
const CACHE_NAME = 'anchor1mc-models-v1';
/** Transformers.js keeps its own store, so Whisper and the on-device LLM land
 *  here rather than in ours. Counting only our cache made both invisible. */
const TRANSFORMERS_CACHE = 'transformers-cache';
const HF = 'https://huggingface.co';

export const MODEL_CATALOG = {
  parakeet: [
    {
      id: 'istupakov/parakeet-tdt-0.6b-v3-onnx',
      name: 'Parakeet TDT 0.6B v3 (multilingual)',
      note: '25 European languages. The most accurate option that runs on-device.',
      sizes: { int8: '~650 MB', fp32: '~2.4 GB' },
      languages: 'multilingual',
    },
    {
      id: 'istupakov/parakeet-tdt-0.6b-v2-onnx',
      name: 'Parakeet TDT 0.6B v2 (English)',
      note: 'English only, slightly faster, very accurate on clean speech.',
      sizes: { int8: '~650 MB', fp32: '~2.4 GB' },
      languages: 'en',
    },
  ],
  whisper: [
    { id: 'onnx-community/whisper-tiny', name: 'Whisper tiny', note: 'Fastest, roughest. Good on weak hardware.', sizes: { q4: '~40 MB', q8: '~60 MB', fp32: '~150 MB' } },
    { id: 'onnx-community/whisper-base', name: 'Whisper base', note: 'Reasonable accuracy, small footprint.', sizes: { q4: '~70 MB', q8: '~110 MB', fp32: '~290 MB' } },
    { id: 'onnx-community/whisper-small', name: 'Whisper small', note: 'Noticeably better, needs WebGPU to feel quick.', sizes: { q4: '~200 MB', q8: '~330 MB', fp32: '~970 MB' } },
    { id: 'onnx-community/whisper-large-v3-turbo', name: 'Whisper large v3 turbo', note: 'Best Whisper quality. WebGPU and patience required.', sizes: { q4: '~900 MB', q8: '~1.6 GB' } },
  ],
  llm: [
    {
      id: 'onnx-community/Qwen3-0.6B-ONNX',
      name: 'Qwen3 0.6B',
      note: 'A generation newer than Qwen2.5 at nearly the same size, and its ONNX export is built for this runtime specifically. The best starting point for speed with reliable instruction-following. May emit a reasoning block, which is stripped.',
      sizes: { q4f16: '~450 MB' },
    },
    {
      id: 'HuggingFaceTB/SmolLM2-360M-Instruct',
      name: 'SmolLM2 360M',
      note: 'The fastest option here, and the least capable. Punctuation and filler removal only — it will not reliably resolve a change of mind.',
      sizes: { q4f16: '~280 MB' },
    },
    { id: 'onnx-community/Qwen2.5-0.5B-Instruct', name: 'Qwen2.5 0.5B Instruct', note: 'Smallest and quickest. Handles punctuation and filler removal, but degenerates on longer or messier speech more often than the 1.5B.', sizes: { q4f16: '~400 MB' } },
    { id: 'onnx-community/Qwen2.5-1.5B-Instruct', name: 'Qwen2.5 1.5B Instruct', note: 'Markedly more reliable at self-corrections and rewriting. Worth the extra download if you have the memory.', sizes: { q4f16: '~1.1 GB' } },
    { id: 'onnx-community/Llama-3.2-1B-Instruct', name: 'Llama 3.2 1B Instruct', note: 'Alternative 1B option.', sizes: { q4f16: '~900 MB' } },
  ],
};

/**
 * Percent-encode each path segment while keeping the separators.
 *
 * A repo id is `owner/name` and a file path may nest further. Running
 * encodeURIComponent over the whole string turns those slashes into %2F, which
 * the API reads as one malformed segment and rejects outright.
 */
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

export function hfApiUrl(repo) {
  return `${HF}/api/models/${encodePath(repo)}`;
}

export function hfFileUrl(repo, path, revision = 'main') {
  return `${HF}/${encodePath(repo)}/resolve/${encodeURIComponent(revision)}/${encodePath(path)}`;
}

/** List the files in a Hugging Face repo. Throws with a useful message offline. */
export async function listRepoFiles(repo) {
  const url = hfApiUrl(repo);
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    throw new Error(`Could not reach Hugging Face at ${url}. Check your connection. (${err.message})`);
  }
  if (!res.ok) {
    // Distinguish the cases, because the fix differs for each.
    const reason = {
      400: 'the request was malformed — this is a bug, please report it',
      401: 'the repo is private or gated; Anchor1MC can only use public models',
      403: 'access to this repo is restricted; you may need to accept its licence on Hugging Face',
      404: 'no such model — check the ID',
      429: 'Hugging Face is rate-limiting this device; wait a minute and retry',
    }[res.status] ?? 'unexpected response';
    throw new Error(`Could not read the file list for ${repo}: HTTP ${res.status}, ${reason}. (${url})`);
  }
  const meta = await res.json();
  const files = (meta.siblings ?? []).map((s) => s.rfilename);
  if (!files.length) throw new Error(`${repo} reports no files. It may be empty or gated.`);
  return files;
}

/** First filename matching any pattern, tried in order. */
function pick(files, patterns, label) {
  for (const re of patterns) {
    const hit = files.find((f) => re.test(f));
    if (hit) return hit;
  }
  throw new Error(`No ${label} file found in the model repo. Files present: ${files.slice(0, 40).join(', ')}`);
}

/**
 * Work out which files make up a Parakeet TDT export.
 * A TDT model is three graphs: a mel front-end, a conformer encoder, and a
 * fused decoder+joint that also predicts how many frames to skip.
 */
export async function resolveParakeetFiles(repo, precision = 'int8') {
  const files = await listRepoFiles(repo);
  const q = precision === 'int8';
  // Quantized variants are usually a suffix on the same stem.
  const quant = (stem) => (q
    ? [new RegExp(`${stem}[^/]*\\.(int8|quantized|uint8)\\.onnx$`, 'i'), new RegExp(`${stem}[^/]*\\.onnx$`, 'i')]
    : [new RegExp(`^(?![^/]*(int8|quantized|uint8))[^/]*${stem}[^/]*\\.onnx$`, 'i'), new RegExp(`${stem}[^/]*\\.onnx$`, 'i')]);

  const encoder = pick(files, quant('encoder'), 'encoder');
  const decoder = pick(files, quant('decoder'), 'decoder/joint');
  // The mel front-end is exported separately by onnx-asr as nemo128.onnx.
  let mel = null;
  try {
    mel = pick(files, [/nemo\d*\.onnx$/i, /(pre)?process(or)?[^/]*\.onnx$/i, /mel[^/]*\.onnx$/i], 'preprocessor');
  } catch {
    log.info('No preprocessor graph in the repo; using the built-in JS log-mel front-end.');
  }
  const vocab = pick(files, [/vocab\.txt$/i, /tokens\.txt$/i, /vocab\.json$/i], 'vocabulary');

  return {
    encoder: hfFileUrl(repo, encoder),
    decoderJoint: hfFileUrl(repo, decoder),
    mel: mel ? hfFileUrl(repo, mel) : null,
    vocab: hfFileUrl(repo, vocab),
    names: { encoder, decoder, mel, vocab },
  };
}

async function cache() {
  return caches.open(CACHE_NAME);
}

export async function isCached(url) {
  return !!(await (await cache()).match(url));
}

/**
 * Fetch a URL into Cache Storage, reporting progress. Already-cached URLs
 * resolve immediately. Rejects on `signal` abort, leaving no partial entry.
 */
export async function cacheFile(url, { onProgress, signal } = {}) {
  const c = await cache();
  const hit = await c.match(url);
  if (hit) {
    onProgress?.({ url, loaded: 1, total: 1, done: true, cached: true });
    return;
  }

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Download failed for ${url} (HTTP ${res.status})`);

  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastTick = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - lastTick > 200) {
      lastTick = now;
      onProgress?.({ url, loaded, total, done: false });
    }
  }
  const blob = new Blob(chunks);
  // Store a synthetic response so the cached copy survives header quirks.
  await c.put(url, new Response(blob, { headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'content-length': String(blob.size) } }));
  onProgress?.({ url, loaded, total: total || blob.size, done: true });
}

/** Cached bytes for a URL, downloading first if needed. */
export async function getCachedBuffer(url, opts) {
  await cacheFile(url, opts);
  const hit = await (await cache()).match(url);
  if (!hit) throw new Error(`Cache miss right after caching ${url}`);
  return hit.arrayBuffer();
}

export async function getCachedText(url, opts) {
  await cacheFile(url, opts);
  const hit = await (await cache()).match(url);
  if (!hit) throw new Error(`Cache miss right after caching ${url}`);
  return hit.text();
}

/** Total bytes cached across every store we use, with a per-URL breakdown. */
export async function cacheStats() {
  const entries = [];
  let bytes = 0;
  for (const name of [CACHE_NAME, TRANSFORMERS_CACHE]) {
    let store;
    try {
      store = await caches.open(name);
    } catch {
      continue; // nothing has been written to this one yet
    }
    for (const req of await store.keys()) {
      const res = await store.match(req);
      if (!res) continue;
      const size = Number(res.headers.get('content-length')) || (await res.clone().blob()).size;
      bytes += size;
      entries.push({ url: req.url, size, cache: name });
    }
  }
  return { bytes, entries };
}

/**
 * Bytes cached for one model, matched on its repo id appearing in the URL.
 * @param {{url: string, size: number}[]} entries from cacheStats()
 * @param {string} modelId e.g. 'onnx-community/whisper-base'
 */
export function bytesForModel(entries, modelId) {
  if (!modelId) return 0;
  const needle = `/${modelId}/`;
  return entries
    .filter((e) => e.url.includes(needle))
    .reduce((total, e) => total + e.size, 0);
}

export async function clearModelCache(urlPrefix = null) {
  const c = await cache();
  const keys = await c.keys();
  let removed = 0;
  for (const req of keys) {
    if (urlPrefix && !req.url.startsWith(urlPrefix)) continue;
    if (await c.delete(req)) removed += 1;
  }
  // Transformers.js keeps its own cache; clear it alongside ours.
  if (!urlPrefix) {
    try { await caches.delete(TRANSFORMERS_CACHE); } catch { /* nothing cached yet */ }
  }
  return removed;
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
