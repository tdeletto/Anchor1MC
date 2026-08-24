#!/usr/bin/env node
/** Zips the loadable extension into dist/, ready for the Web Store or sharing. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const out = join(root, 'dist', `anchor1mc-${version}.zip`);

mkdirSync(join(root, 'dist'), { recursive: true });
rmSync(out, { force: true });

// Only the files Chrome actually loads.
const include = ['manifest.json', 'src', 'vendor', 'icons'];
try {
  execFileSync('zip', ['-r', '-q', '-9', out, ...include], { cwd: root, stdio: 'inherit' });
} catch (err) {
  console.error('Packaging needs the `zip` command on PATH.');
  throw err;
}
console.log(`packaged ${out}`);
