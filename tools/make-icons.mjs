// Draws EviCap's toolbar/store icons as PNGs (no dependencies): a blue rounded
// square with a white lens ring and a red "record" dot. Run: node tools/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v) => Math.max(0, Math.min(1, v));
const over = (dst, src, a) => dst.map((d, i) => d * (1 - a) + src[i] * a);

function icon(size) {
  const S = 4; // supersampling
  return png(size, (px, py) => {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < S; sy++)
      for (let sx = 0; sx < S; sx++) {
        const x = (px + (sx + 0.5) / S) / size;
        const y = (py + (sy + 0.5) / S) / size;
        // Rounded square
        const r = 0.2;
        const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
        const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
        const inside = Math.hypot(dx, dy) <= r;
        if (!inside) continue;
        let c = [31, 95, 139]; // #1f5f8b
        const d = Math.hypot(x - 0.46, y - 0.5);
        if (d > 0.21 && d < 0.31) c = [255, 255, 255]; // lens ring
        if (Math.hypot(x - 0.46, y - 0.5) <= 0.1) c = [255, 255, 255]; // pupil
        if (Math.hypot(x - 0.76, y - 0.24) <= 0.12) c = [220, 38, 38]; // record dot
        acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2], acc[3] + 255];
      }
    const n = S * S;
    const a = acc[3] / n;
    if (a === 0) return [0, 0, 0, 0];
    const k = acc[3] / 255;
    return [acc[0] / k, acc[1] / k, acc[2] / k, a].map(Math.round);
  });
}

mkdirSync('public/icon', { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icon/${s}.png`, icon(s));
console.log('Wrote public/icon/{16,32,48,128}.png');
void clamp;
void over;
