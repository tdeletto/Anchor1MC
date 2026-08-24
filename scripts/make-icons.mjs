#!/usr/bin/env node
/**
 * Produces the extension icons from the source artwork.
 *
 * Chrome needs PNGs at several fixed sizes; this downscales one square source
 * image into all of them. Put the artwork at icons/source.png (any resolution,
 * square, ideally 512px or larger) and run `npm run icons`.
 *
 * The source is used as-is: no trimming. An earlier version trimmed uniform
 * padding, which is exactly wrong for artwork whose background reaches the
 * edge — trim removes any uniform border, and for a dark icon that border is
 * the ground itself, leaving a floating glyph. Crop the source before saving
 * it instead.
 */
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'icons', 'source.png');
const SIZES = [16, 32, 48, 128];
/** Corner rounding as a fraction of the icon's side, matching the artwork. */
const CORNER_RATIO = 0.22;

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
  console.warn('warning: the source is not square; it will be letterboxed on the short axis.');
}
if (meta.width < 128) {
  console.warn(`warning: the source is only ${meta.width}px, so the 128px icon will be upscaled.`);
}

for (const size of SIZES) {
  const out = join(root, 'icons', `icon-${size}.png`);
  const radius = Math.round(size * CORNER_RATIO * 100) / 100;

  // A rounded-rectangle alpha mask, composited with dest-in so the corners
  // become transparent rather than a square of background colour. Without it a
  // dark icon shows as a hard black tile against a dark browser theme.
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/>`
    + `</svg>`,
  );

  await sharp(SOURCE)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`icons/icon-${size}.png`);
}
