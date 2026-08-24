/**
 * One shared ONNX Runtime instance for every engine.
 *
 * Notes specific to running ORT inside an MV3 extension:
 *  - wasmPaths points at the vendored copy; nothing is fetched from a CDN.
 *  - Threads need SharedArrayBuffer, which needs cross-origin isolation. The
 *    manifest opts in via COOP/COEP, but if that ever fails we fall back to a
 *    single thread rather than crashing at session creation.
 *  - The non-bundle ESM build is deliberate: its worker is created from a
 *    chrome-extension:// URL, which the MV3 CSP permits, unlike a blob: worker.
 */
import * as ort from '../../vendor/ort/ort.webgpu.min.mjs';
import { logger } from '../lib/log.js';
import { hasWebGpu } from './gpu.js';

const log = logger('ort');
let configured = false;

export function configureOrt({ numThreads = 'auto', logLevel = 'warning' } = {}) {
  if (configured) return ort;
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/ort/');
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const auto = Math.min(4, navigator.hardwareConcurrency || 2);
  ort.env.wasm.numThreads = isolated ? (numThreads === 'auto' ? auto : Number(numThreads) || 1) : 1;
  if (!isolated) log.warn('Not cross-origin isolated; running ONNX Runtime single-threaded.');
  // The proxy worker is another blob-worker path the CSP would reject.
  ort.env.wasm.proxy = false;
  ort.env.logLevel = logLevel;
  configured = true;
  return ort;
}

export { ort, hasWebGpu };

/**
 * Execution providers to try, in order. WebGPU first when asked for and
 * available; wasm is always the last resort so a session can still be created.
 */
export async function providersFor(device) {
  const wantGpu = device === 'webgpu' || (device === 'auto' && await hasWebGpu());
  return wantGpu ? ['webgpu', 'wasm'] : ['wasm'];
}

/** Create a session, degrading to wasm if the GPU provider refuses the graph. */
export async function createSession(buffer, { device = 'auto', graphName = 'model' } = {}) {
  const providers = await providersFor(device);
  let lastError = null;
  for (const ep of providers) {
    try {
      const session = await ort.InferenceSession.create(buffer, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      log.info(`${graphName}: running on ${ep}`);
      return { session, provider: ep };
    } catch (err) {
      lastError = err;
      log.warn(`${graphName}: ${ep} provider failed, trying next`, err?.message ?? err);
    }
  }
  throw new Error(`Could not create an inference session for ${graphName}: ${lastError?.message ?? lastError}`);
}

/**
 * Build an integer tensor whose element type matches what the graph declares.
 * ONNX exports disagree about int32 vs int64 for lengths and token ids, and the
 * runtime rejects a mismatch outright, so read the metadata when it is exposed
 * and guess int64 (the ONNX default for integers) when it is not.
 */
export function intTensor(values, dims, declaredType) {
  const type = declaredType ?? 'int64';
  if (type === 'int32') return new ort.Tensor('int32', Int32Array.from(values), dims);
  return new ort.Tensor('int64', BigInt64Array.from(values, (v) => BigInt(Math.trunc(v))), dims);
}

/** Input element types by name, when the build exposes metadata. */
export function inputTypes(session) {
  const meta = session.inputMetadata;
  const out = {};
  if (!meta) return out;
  // Newer builds expose an array of {name, type, ...}; older ones a map.
  if (Array.isArray(meta)) {
    for (const m of meta) out[m.name] = m.type ?? m.dataType;
  } else {
    for (const [name, m] of Object.entries(meta)) out[name] = m?.type ?? m?.dataType;
  }
  return out;
}

/** Declared dims by input name, so we can tell [B,1,D] from [B,D,1]. */
export function inputDims(session) {
  const meta = session.inputMetadata;
  const out = {};
  if (!meta) return out;
  const entries = Array.isArray(meta) ? meta.map((m) => [m.name, m]) : Object.entries(meta);
  for (const [name, m] of entries) out[name] = m?.dims ?? m?.shape ?? null;
  return out;
}
