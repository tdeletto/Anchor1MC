#!/usr/bin/env node
/**
 * Copies the ONNX Runtime Web + Transformers.js runtime files into vendor/.
 *
 * Two things make this less trivial than a copy:
 *
 *  1. MV3 forbids remote code, so every byte of runtime has to live in the
 *     extension. We take ORT from the exact version Transformers.js pins so a
 *     single wasm binary serves both the Parakeet and the Whisper engine.
 *
 *  2. MV3's CSP has no `blob:` in script-src, so ORT's `*.bundle.min.mjs`
 *     builds (which spawn their wasm worker from an inlined blob) fail to start
 *     threads. We ship the non-bundle ESM build instead: it creates its worker
 *     from a real chrome-extension:// URL, which the CSP allows.
 *
 * Transformers.js's web build imports bare specifiers, which browsers cannot
 * resolve without an import map (and import maps do not work inside workers),
 * so the specifiers are rewritten to relative paths on the way in.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = join(root, 'node_modules');

const tfRoot = join(modules, '@huggingface', 'transformers');
const tfDir = join(tfRoot, 'dist');
// Transformers.js keeps its pinned ORT in a nested node_modules; prefer that
// copy so the wasm binary and the JS driving it are always the same build.
const nested = join(tfRoot, 'node_modules', 'onnxruntime-web');
const ortRoot = existsSync(nested) ? nested : join(modules, 'onnxruntime-web');
const ortDir = join(ortRoot, 'dist');

const tfVersion = JSON.parse(await readFile(join(tfRoot, 'package.json'), 'utf8')).version;
const ortVersion = JSON.parse(await readFile(join(ortRoot, 'package.json'), 'utf8')).version;

const ortOut = join(root, 'vendor', 'ort');
const tfOut = join(root, 'vendor', 'transformers');
await rm(join(root, 'vendor'), { recursive: true, force: true });
await mkdir(ortOut, { recursive: true });
await mkdir(tfOut, { recursive: true });

/**
 * Which wasm variant is needed is not a matter of taste: the JS bundles name
 * the file they will fetch, and fetching anything else fails with "no available
 * backend found". As of ORT 1.26 the WebGPU build asks for the asyncify build,
 * and Transformers.js additionally asks for the plain one when it runs on CPU.
 * The check script re-derives this list from the shipped bundles so a runtime
 * upgrade that renames them fails the build rather than the user's first
 * dictation.
 */
const ortFiles = [
  'ort.webgpu.min.mjs',                   // WebGPU + WASM execution providers
  'ort-wasm-simd-threaded.asyncify.mjs',  // glue for the WebGPU backend
  'ort-wasm-simd-threaded.asyncify.wasm', // kernels, ~23 MB
  'ort-wasm-simd-threaded.mjs',           // glue for the CPU backend
  'ort-wasm-simd-threaded.wasm',          // kernels, ~13 MB
];
/** Source maps are not vendored, so drop the references that would 404. */
const stripMapRef = (text) => text.replace(/\n?\/\/# sourceMappingURL=.*$/m, '\n');

for (const f of ortFiles) {
  if (f.endsWith('.wasm')) await cp(join(ortDir, f), join(ortOut, f));
  else await writeFile(join(ortOut, f), stripMapRef(await readFile(join(ortDir, f), 'utf8')));
}

// Transformers.js: rewrite bare imports to vendored relative paths.
const src = await readFile(join(tfDir, 'transformers.web.min.js'), 'utf8');
const patched = src
  .replaceAll('"onnxruntime-web/webgpu"', '"../ort/ort.webgpu.min.mjs"')
  .replaceAll('"onnxruntime-common"', '"./ort-common-shim.mjs"');
if (patched === src) throw new Error('Transformers.js import rewrite matched nothing — check the dist layout.');
await writeFile(join(tfOut, 'transformers.web.min.js'), stripMapRef(patched));
await writeFile(
  join(tfOut, 'ort-common-shim.mjs'),
  `// onnxruntime-common is re-exported by the ORT web build; this shim points\n` +
  `// Transformers.js at it so no bare specifier survives into the browser.\n` +
  `export * from '../ort/ort.webgpu.min.mjs';\n`
);

await writeFile(
  join(root, 'vendor', 'VERSIONS.json'),
  JSON.stringify({ 'onnxruntime-web': ortVersion, '@huggingface/transformers': tfVersion, vendoredAt: new Date().toISOString() }, null, 2) + '\n'
);
console.log(`vendored onnxruntime-web@${ortVersion} + @huggingface/transformers@${tfVersion}`);
