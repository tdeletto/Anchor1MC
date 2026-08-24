#!/usr/bin/env node
/**
 * Renders the extension icons. Chrome requires PNG, so this rasterizes a
 * microphone glyph by hand and writes the PNGs directly — no image libraries,
 * and no opaque binary assets checked into the repo.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SS = 4; // supersampling factor, for antialiasing

const crcTable = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

/** @param {Uint8Array} rgba length === size*size*4 */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // truecolour with alpha
  // Each scanline is prefixed with its filter byte; filter 0 is "none".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Signed-distance helpers, all in 0..1 icon space. */
function insideRoundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside <= radius;
}

function insideRing(x, y, cx, cy, rInner, rOuter, minY) {
  const d = Math.hypot(x - cx, y - cy);
  return d >= rInner && d <= rOuter && y >= minY;
}

/** Colour at a point, as [r, g, b, a] with components 0..255. */
function sample(x, y) {
  // Rounded-square background with a soft vertical gradient.
  if (!insideRoundedRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.24)) return [0, 0, 0, 0];

  const t = clamp01(y);
  const bg = [
    Math.round(0x6d + (0x9b - 0x6d) * t),
    Math.round(0x5c + (0x7c - 0x5c) * t),
    Math.round(0xf6 + (0xff - 0xf6) * t),
    255,
  ];

  // Microphone capsule.
  if (insideRoundedRect(x, y, 0.5, 0.40, 0.115, 0.205, 0.115)) return [255, 255, 255, 255];
  // The arc cradling it.
  if (insideRing(x, y, 0.5, 0.44, 0.205, 0.262, 0.44)) return [255, 255, 255, 255];
  // Stem and base.
  if (insideRoundedRect(x, y, 0.5, 0.735, 0.028, 0.055, 0.028)) return [255, 255, 255, 255];
  if (insideRoundedRect(x, y, 0.5, 0.80, 0.135, 0.028, 0.028)) return [255, 255, 255, 255];

  return bg;
}

function render(size) {
  const rgba = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const [sr, sg, sb, sa] = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          const w = sa / 255;
          r += sr * w; g += sg * w; b += sb * w; a += sa;
        }
      }
      const samples = SS * SS;
      const alpha = a / samples;
      const weight = alpha > 0 ? a / 255 : 1;
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r / weight);
      rgba[i + 1] = Math.round(g / weight);
      rgba[i + 2] = Math.round(b / weight);
      rgba[i + 3] = Math.round(alpha);
    }
  }
  return rgba;
}

mkdirSync(join(root, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(render(size), size);
  writeFileSync(join(root, 'icons', `icon-${size}.png`), png);
  console.log(`icons/icon-${size}.png (${png.length} bytes)`);
}
