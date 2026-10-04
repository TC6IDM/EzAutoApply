// Draws the extension icon (a text field with typed text and a caret, on a
// rounded square) into public/icon/{16,32,48,128}.png.
// Dependency-free: rasterizes with 4x4 supersampling and writes PNGs with
// node:zlib. Run: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon');
// The panel's accent, oklch(50.5% 0.19 264), and its text-on-accent colour.
const BG = [41, 89, 207];
const FG = [250, 252, 255];

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const inRoundedSquare = (x, y, r) => inRoundedRect(x, y, 0, 0, 1, 1, r);

// A text field in a 0..1 unit square: typed text, then a text caret (I-beam).
const STROKE = 0.065;

function inMark(x, y) {
  const field = inRoundedRect(x, y, 0.14, 0.32, 0.86, 0.68, 0.1) && !inRoundedRect(x, y, 0.14 + STROKE, 0.32 + STROKE, 0.86 - STROKE, 0.68 - STROKE, 0.04);
  const text = inRoundedRect(x, y, 0.25, 0.45, 0.5, 0.55, 0.05);
  const beam = (x >= 0.6 && x <= 0.66 && y >= 0.22 && y <= 0.78) || ((y >= 0.22 && y <= 0.27) || (y >= 0.73 && y <= 0.78)) && x >= 0.54 && x <= 0.72;
  return field || text || beam;
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const S = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          if (!inRoundedSquare(x, y, 0.22)) continue;
          if (inMark(x, y)) fg++;
          else bg++;
        }
      }
      const total = S * S;
      const a = (bg + fg) / total;
      const mix = bg + fg ? fg / (bg + fg) : 0;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(BG[c] * (1 - mix) + FG[c] * mix);
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `${size}.png`), png(size));
  console.log(`wrote public/icon/${size}.png`);
}
