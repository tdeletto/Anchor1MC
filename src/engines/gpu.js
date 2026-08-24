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
