#!/usr/bin/env node
// Tess companion — draws the icons: a vinyl record with the accent label, on the app's dark.
// Pure Node so the icons build without PIL: an RGBA buffer, zlib, and the smallest honest PNG encoder.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'companion', 'icons');

// ---------- the smallest honest PNG encoder ----------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // no filter
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- the drawing ----------
function icon(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const na = a / 255;
    px[i] = Math.round(px[i] * (1 - na) + r * na);
    px[i + 1] = Math.round(px[i + 1] * (1 - na) + g * na);
    px[i + 2] = Math.round(px[i + 2] * (1 - na) + b * na);
    px[i + 3] = Math.max(px[i + 3], a);
  };
  const c = (size - 1) / 2;
  const disc = (cx, cy, radius, r, g, b, a = 255) => {
    const r2 = radius * radius;
    for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
      for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) put(x, y, r, g, b, a);
      }
    }
  };
  const ring = (cx, cy, inner, outer, r, g, b, a = 255) => {
    const ri2 = inner * inner, ro2 = outer * outer;
    for (let y = Math.floor(cy - outer); y <= cy + outer; y++) {
      for (let x = Math.floor(cx - outer); x <= cx + outer; x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= ro2 && d2 >= ri2) put(x, y, r, g, b, a);
      }
    }
  };
  const S = size;
  disc(c, c, S * 0.485, 27, 27, 33);                       // the record
  ring(c, c, S * 0.20, S * 0.46, 255, 255, 255, 10);        // grooves, one soft wash
  for (let i = 0; i < 6; i++) ring(c, c, S * (0.23 + i * 0.04), S * (0.235 + i * 0.04), 255, 255, 255, 14);
  disc(c, c, S * 0.185, 250, 74, 96);                       // the accent label
  ring(c, c, S * 0.05, S * 0.06, 255, 255, 255, 70);        // spindle glint
  disc(c, c, S * 0.048, 20, 20, 25);
  // a light sweep across the upper-left, like a glossed record
  for (let i = 0; i < 26; i++) {
    const a = Math.PI * 1.12 + (Math.PI * 0.55) * (i / 26);
    ring(c + Math.cos(a) * 0, c + Math.sin(a) * 0, S * 0.20, S * 0.455, 255, 255, 255, 5 + i * 0.6);
  }
  return encodePNG(size, size, px);
}

mkdirSync(OUT, { recursive: true });
for (const n of [192, 512]) writeFileSync(join(OUT, `icon-${n}.png`), icon(n));
writeFileSync(join(OUT, 'apple-touch-icon.png'), icon(180));
console.log('icons written to', OUT);
