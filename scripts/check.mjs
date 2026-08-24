#!/usr/bin/env node
/**
 * Static checks for the extension. There is no bundler here, so a typo in an
 * import path or a data-setting attribute would only show up at runtime, in a
 * context (offscreen document, content script) that is awkward to watch.
 *
 * Verifies:
 *   1. every file the manifest names exists,
 *   2. every static import resolves to a real file,
 *   3. every asset an HTML page references exists,
 *   4. every data-setting path in the options page exists in DEFAULTS,
 *   5. the message names duplicated in the content script match messaging.js,
 *   6. no page pulls in remote code, which MV3 forbids.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const fail = (msg) => problems.push(msg);
const rel = (p) => relative(root, p);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'vendor') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(root);
const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
const htmlFiles = files.filter((f) => f.endsWith('.html'));

// 1 — manifest references ------------------------------------------------
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const manifestPaths = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...Object.values(manifest.icons ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
].filter(Boolean);

for (const p of manifestPaths) {
  if (!existsSync(join(root, p))) fail(`manifest.json references a missing file: ${p}`);
}
for (const war of manifest.web_accessible_resources ?? []) {
  for (const pattern of war.resources ?? []) {
    if (pattern.includes('*')) continue;
    if (!existsSync(join(root, pattern))) fail(`web_accessible_resources references a missing file: ${pattern}`);
  }
}

// 2 — static imports ------------------------------------------------------
const IMPORT_RE = /(?:^|[\s;=(])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const file of jsFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (!spec) continue;
    if (/^https?:/.test(spec)) {
      fail(`${rel(file)} imports remote code, which MV3 forbids: ${spec}`);
      continue;
    }
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      // Build and test scripts run in Node, where bare specifiers resolve
      // normally. Only extension code has to be browser-resolvable.
      if (spec.startsWith('node:') || file.startsWith(join(root, 'scripts'))) continue;
      fail(`${rel(file)} imports a bare specifier the browser cannot resolve: ${spec}`);
      continue;
    }
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) fail(`${rel(file)} imports a missing file: ${spec}`);
  }
}

// 3 — HTML asset references ----------------------------------------------
for (const file of htmlFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
    const ref = match[1];
    if (/^(https?:|data:|mailto:)/.test(ref)) fail(`${rel(file)} references an external asset: ${ref}`);
    else if (!existsSync(resolve(dirname(file), ref))) fail(`${rel(file)} references a missing asset: ${ref}`);
  }
}

// 4 — data-setting paths --------------------------------------------------
const { DEFAULTS } = await import(pathToFileURL(join(root, 'src/lib/defaults.js')));
const hasPath = (path) => path.split('.').reduce((node, key) => (node && key in node ? node[key] : undefined), DEFAULTS) !== undefined;

const optionsHtml = readFileSync(join(root, 'src/options/options.html'), 'utf8');
const settingPaths = [...optionsHtml.matchAll(/data-setting="([^"]+)"/g)].map((m) => m[1]);
for (const path of settingPaths) {
  if (!hasPath(path)) fail(`options.html binds an unknown setting path: ${path}`);
}
if (settingPaths.length < 30) fail(`only ${settingPaths.length} bound settings found; expected the full option set`);

// 5 — message names duplicated in the content script ----------------------
const messagingSource = readFileSync(join(root, 'src/lib/messaging.js'), 'utf8');
const canonical = Object.fromEntries([...messagingSource.matchAll(/^\s{2}([A-Z_]+):\s*'([^']+)',/gm)].map((m) => [m[1], m[2]]));
const contentSource = readFileSync(join(root, 'src/content/content.js'), 'utf8');
const contentBlock = contentSource.match(/const MSG = \{([\s\S]*?)\};/);
if (!contentBlock) fail('content.js no longer declares its inline MSG table');
else {
  for (const [, key, value] of contentBlock[1].matchAll(/([A-Z_]+):\s*'([^']+)'/g)) {
    if (!(key in canonical)) fail(`content.js declares MSG.${key}, which messaging.js does not define`);
    else if (canonical[key] !== value) fail(`content.js MSG.${key} is '${value}' but messaging.js says '${canonical[key]}'`);
  }
}

// 6 — the offscreen entry point stays light -------------------------------
// Anything imported statically here runs before the message listener is
// registered, and takes the listener down with it if it throws. That failure
// mode is invisible from the service worker, so it is guarded here instead.
const offscreenSource = readFileSync(join(root, 'src/offscreen/offscreen.js'), 'utf8');
const HEAVY = ['registry.js', 'parakeet.js', 'whisper.js', 'ort-setup.js', 'enhance.js', 'llm.js', 'webspeech.js', 'remote.js'];
for (const match of offscreenSource.matchAll(/^import\s+[^;]*?from\s+'([^']+)';/gm)) {
  const spec = match[1];
  if (HEAVY.some((h) => spec.endsWith(h))) {
    fail(`offscreen.js statically imports ${spec}; load it lazily so a failure cannot stop the message listener registering`);
  }
}

// 7 — the offscreen document may only touch chrome.runtime -----------------
// Chrome grants offscreen documents chrome.runtime and nothing else. Any other
// chrome.* call throws, and if it throws while a module is evaluating it takes
// the document's message listener down with it — leaving the service worker
// unable to report anything more useful than a timeout. So the whole reachable
// graph is walked, dynamic imports included.
{
  const seen = new Set();
  const queue = [join(root, 'src/offscreen/offscreen.js')];
  const GRAPH_RE = /(?:from\s*['"]([^'"]+)['"])|(?:import\(\s*['"]([^'"]+)['"]\s*\))/g;

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');

    // One report per API per file, not one per occurrence.
    const offenders = new Set(
      [...source.matchAll(/\bchrome\.([a-zA-Z]+)/g)].map((m) => m[1]).filter((api) => api !== 'runtime'),
    );
    for (const api of offenders) {
      fail(`${rel(file)} uses chrome.${api}, but it is reachable from the offscreen document, which only has chrome.runtime`);
    }

    for (const match of source.matchAll(GRAPH_RE)) {
      const spec = match[1] ?? match[2];
      if (!spec?.startsWith('.')) continue;
      const target = resolve(dirname(file), spec);
      // The vendored runtimes are third-party and touch no chrome APIs.
      if (!target.includes(`${sep}vendor${sep}`)) queue.push(target);
    }
  }
  if (seen.size < 8) fail(`offscreen graph walk only reached ${seen.size} files; the import scan is probably broken`);
}

// 8 — vendored runtime present -------------------------------------------
// Entry points only; the wasm variants are derived from these below rather
// than listed, since which ones are needed changes with the runtime version.
for (const required of [
  'vendor/ort/ort.webgpu.min.mjs',
  'vendor/transformers/transformers.web.min.js',
  'vendor/transformers/ort-common-shim.mjs',
]) {
  if (!existsSync(join(root, required))) fail(`missing vendored runtime file: ${required} (run "npm run vendor")`);
}
const vendored = readFileSync(join(root, 'vendor/transformers/transformers.web.min.js'), 'utf8');
if (vendored.includes('"onnxruntime-web/webgpu"')) fail('vendor/transformers still contains bare ORT specifiers; re-run "npm run vendor"');

// Every wasm artefact the runtime bundles name must be present. MV3 forbids
// fetching one at runtime, so a missing variant surfaces to the user as
// "no available backend found" on their first dictation — far from the cause.
{
  const bundles = ['vendor/ort/ort.webgpu.min.mjs', 'vendor/transformers/transformers.web.min.js'];
  const needed = new Set();
  for (const bundle of bundles) {
    const source = readFileSync(join(root, bundle), 'utf8');
    for (const [name] of source.matchAll(/ort-wasm[a-z0-9.-]*\.(?:mjs|wasm)/g)) {
      // The proxy worker is only fetched when env.wasm.proxy is on, and it is
      // deliberately off: its blob worker would violate the MV3 CSP.
      if (name.startsWith('ort-wasm-proxy-worker')) continue;
      needed.add(name);
      // The glue fetches the matching binary by name.
      if (name.endsWith('.mjs')) needed.add(name.replace(/\.mjs$/, '.wasm'));
    }
  }
  if (!needed.size) fail('found no ort-wasm references in the vendored bundles; the scan is probably broken');
  for (const name of [...needed].sort()) {
    if (!existsSync(join(root, 'vendor/ort', name))) {
      fail(`the vendored runtime references ${name}, but vendor/ort/${name} is missing (re-run "npm run vendor")`);
    }
  }
}

// ------------------------------------------------------------------------
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`✓ manifest, ${jsFiles.length} JS files, ${htmlFiles.length} pages, ${settingPaths.length} bound settings — all references resolve`);
