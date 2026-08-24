#!/usr/bin/env node
/**
 * Produces the extension icons from the source artwork.
 *
 * Chrome needs PNGs at several fixed sizes; this downscales one square source
 * image into all of them. Put the artwork at icons/source.png (any resolution,
 * square, ideally 512px or larger) and run `npm run icons`.
 *
 * Uniform padding around the artwork is trimmed first, so a source exported
 * with whitespace still fills the icon rather than sitting small inside it.
 */
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'icons', 'source.png');
const SIZES = [16, 32, 48, 128];

if (!existsSync(SOURCE)) {
  console.error(
    `No source artwork at icons/source.png.\n`
    + `Add a square PNG there (512px or larger) and run this again.`,
  );
  process.exit(1);
}

const meta = await sharp(SOURCE).metadata();
console.log(`source: ${meta.width}x${meta.height} ${meta.format}`);
if (Math.abs(meta.width - meta.height) > 2) {
  console.warn('warning: the source is not square, so it will be letterboxed.');
}

// Trim first, then pad back to a square, so a rectangular export does not
// stretch the artwork.
const trimmed = await sharp(SOURCE).trim().toBuffer();
const trimmedMeta = await sharp(trimmed).metadata();
const side = Math.max(trimmedMeta.width, trimmedMeta.height);
const squared = await sharp(trimmed)
  .extend({
    top: Math.floor((side - trimmedMeta.height) / 2),
    bottom: Math.ceil((side - trimmedMeta.height) / 2),
    left: Math.floor((side - trimmedMeta.width) / 2),
    right: Math.ceil((side - trimmedMeta.width) / 2),
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .toBuffer();

for (const size of SIZES) {
  const out = join(root, 'icons', `icon-${size}.png`);
  await sharp(squared)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`icons/icon-${size}.png`);
}
