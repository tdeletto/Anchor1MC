/**
 * WebGPU availability, deliberately free of any ONNX Runtime import.
 *
 * The capability probe runs before anything is loaded and must stay cheap: if
 * this lived in ort-setup.js, asking "does this machine have a GPU?" would drag
 * the entire runtime in with it.
 */
export async function hasWebGpu() {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

/**
 * Does this GPU expose `shader-f16`?
 *
 * Half-precision model builds (q4f16, fp16) require it. Chromebook integrated
 * GPUs vary, and when the feature is missing the model does not run slowly —
 * it fails outright at load, so it has to be checked before choosing a build.
 */
export async function hasShaderF16() {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter?.features?.has('shader-f16');
  } catch {
    return false;
  }
}

/** Half-precision build -> the equivalent that needs no f16 support. */
const F16_FALLBACK = { q4f16: 'q4', q8f16: 'q8', fp16: 'fp32' };

/**
 * Quantizations to try, in order, for a requested one.
 *
 * Pure and exported so the choice can be tested without a GPU.
 * @param {string} requested
 * @param {boolean} f16Supported
 * @returns {string[]}
 */
export function dtypeCandidates(requested, f16Supported) {
  const fallback = F16_FALLBACK[requested];
  if (!fallback) return [requested];
  // With f16 support the half-precision build is still preferred, but a load
  // can fail for other reasons, so keep the fallback behind it.
  return f16Supported ? [requested, fallback] : [fallback];
}
