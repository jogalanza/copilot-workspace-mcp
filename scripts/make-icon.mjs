// Draws the app icon (shell/app.ico) to match the web UI: the dark spotlit panel with the call counter's four
// glowing arcs around a thin ring. No dependencies - a small supersampling rasterizer plus PNG-in-ICO packing.
//   node scripts/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'shell', 'app.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const ROUTE = [0x2a, 0xa7, 0xff]; // --color-route
const TOP = [0x1d, 0x22, 0x2b]; // spotlight colour at the top of the page background
const INK = [0x0a, 0x0a, 0x0b]; // --color-ink
const ARCS = [[-62, -20], [20, 62], [118, 160], [200, 242]].map(([a, b]) => [(a * Math.PI) / 180, (b * Math.PI) / 180]);

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Distance from (x, y), relative to the centre, to the arc a0..a1 of radius R. */
function arcDist(x, y, R, a0, a1) {
  let t = Math.atan2(y, x);
  while (t < a0 - Math.PI) t += 2 * Math.PI;
  while (t > a0 + Math.PI) t -= 2 * Math.PI;
  const c = Math.min(Math.max(t, a0), a1);
  return Math.hypot(x - R * Math.cos(c), y - R * Math.sin(c));
}

function sample(u, v) {
  // u, v in 0..1 across the icon. Returns [r, g, b, a] (a 0..1, colours 0..255, not premultiplied).
  const x = u - 0.5, y = v - 0.5;
  const half = 0.5 - 0.02, rad = 0.2;
  const qx = Math.abs(x) - (half - rad), qy = Math.abs(y) - (half - rad);
  const box = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
  if (box > 0) return [0, 0, 0, 0];

  // Spotlit dark panel.
  let col = mix(TOP, INK, Math.min(1, Math.hypot(x, y + 0.5) / 0.9));
  const R = 0.31;
  const w = 0.045; // arc stroke width

  // Thin faint ring.
  const ring = Math.abs(Math.hypot(x, y) - R);
  if (ring < 0.008) col = mix(col, ROUTE, 0.3);

  // Arcs with a soft glow.
  let d = Infinity;
  for (const [a0, a1] of ARCS) d = Math.min(d, arcDist(x, y, R, a0, a1));
  const glow = 0.45 * Math.exp(-Math.pow(Math.max(d - w / 2, 0) / 0.035, 2));
  col = mix(col, ROUTE, Math.min(1, glow));
  if (d < w / 2) col = mix(col, ROUTE, 1);

  // Centre dot, like the pulse of the call counter.
  if (Math.hypot(x, y) < 0.045) col = mix(col, [255, 255, 255], 0.92);

  return [...col, 1];
}

function render(size) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const [cr, cg, cb, ca] = sample((i + (si + 0.5) / SS) / size, (j + (sj + 0.5) / SS) / size);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const o = (j * size + i) * 4;
      if (a > 0) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); }
      px[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return png(size, px);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const images = SIZES.map((s) => ({ size: s, data: render(s) }));
const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map(({ size, data }) => {
  const e = Buffer.alloc(16);
  e[0] = size === 256 ? 0 : size; e[1] = e[0]; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});
fs.writeFileSync(OUT, Buffer.concat([head, ...entries, ...images.map((i) => i.data)]));
fs.writeFileSync(path.join(root, 'shell', 'app-256.png'), images[images.length - 1].data);
console.log(`Wrote ${path.relative(root, OUT)} (${SIZES.join(', ')} px).`);
