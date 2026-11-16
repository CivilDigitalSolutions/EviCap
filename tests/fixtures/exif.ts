/** Builds small TIFF/EXIF blocks and wraps them in JPEG, PNG or WebP containers, for tests. */

export type Entry = { tag: number; type: 2 | 3 | 4 | 5; value: string | number[] };

/** Big-endian TIFF with IFD0, and optional Exif and GPS sub-IFDs. Rationals are given as [num, den, ...]. */
export function buildTiff(ifd0: Entry[], exif: Entry[] = [], gps: Entry[] = []): Uint8Array {
  const buf = new ArrayBuffer(8192);
  const v = new DataView(buf);
  v.setUint16(0, 0x4d4d);
  v.setUint16(2, 42);
  v.setUint32(4, 8);
  const ifdSize = (n: number) => 2 + 12 * n + 4;
  const n0 = ifd0.length + (exif.length ? 1 : 0) + (gps.length ? 1 : 0);
  const off0 = 8;
  const offExif = off0 + ifdSize(n0);
  const offGps = offExif + (exif.length ? ifdSize(exif.length) : 0);
  let data = offGps + (gps.length ? ifdSize(gps.length) : 0);

  const encode = (e: Entry): { bytes: number[]; count: number } => {
    const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    if (e.type === 2) {
      const bytes = [...(e.value as string)].map((c) => c.charCodeAt(0)).concat(0);
      return { bytes, count: bytes.length };
    }
    const a = e.value as number[];
    if (e.type === 3) return { bytes: a.flatMap((n) => [(n >> 8) & 255, n & 255]), count: a.length };
    if (e.type === 4) return { bytes: a.flatMap(be32), count: a.length };
    return { bytes: a.flatMap(be32), count: a.length / 2 };
  };

  const writeIfd = (off: number, entries: Entry[]) => {
    v.setUint16(off, entries.length);
    entries.forEach((e, i) => {
      const p = off + 2 + i * 12;
      const { bytes, count } = encode(e);
      v.setUint16(p, e.tag);
      v.setUint16(p + 2, e.type);
      v.setUint32(p + 4, count);
      if (bytes.length <= 4) bytes.forEach((b, j) => v.setUint8(p + 8 + j, b));
      else {
        v.setUint32(p + 8, data);
        bytes.forEach((b, j) => v.setUint8(data + j, b));
        data += bytes.length + (bytes.length % 2);
      }
    });
    v.setUint32(off + 2 + entries.length * 12, 0);
  };

  const all = [...ifd0];
  if (exif.length) all.push({ tag: 0x8769, type: 4, value: [offExif] });
  if (gps.length) all.push({ tag: 0x8825, type: 4, value: [offGps] });
  writeIfd(off0, all);
  if (exif.length) writeIfd(offExif, exif);
  if (gps.length) writeIfd(offGps, gps);
  return new Uint8Array(buf.slice(0, data));
}

/** A camera-like EXIF block: Make, Model, DateTimeOriginal and a GPS position in London. */
export function sampleTiff(make = 'EviCapTest'): Uint8Array {
  return buildTiff(
    [
      { tag: 0x010f, type: 2, value: make },
      { tag: 0x0110, type: 2, value: 'Model X' },
      { tag: 0x0112, type: 3, value: [1] },
    ],
    [
      { tag: 0x9003, type: 2, value: '2026:11:01 09:30:15' },
      { tag: 0x8827, type: 3, value: [200] },
      { tag: 0x829a, type: 5, value: [1, 250] },
    ],
    [
      { tag: 0x0001, type: 2, value: 'N' },
      { tag: 0x0002, type: 5, value: [51, 1, 30, 1, 2646, 100] },
      { tag: 0x0003, type: 2, value: 'W' },
      { tag: 0x0004, type: 5, value: [0, 1, 7, 1, 3993, 100] },
      { tag: 0x0006, type: 5, value: [3550, 100] },
    ],
  );
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

/** Insert an APP1 Exif segment straight after the JPEG's start-of-image marker. */
export function jpegWithExif(jpeg: Uint8Array, tiff: Uint8Array): Uint8Array {
  const len = 2 + 6 + tiff.length;
  const app1 = concat(Uint8Array.from([0xff, 0xe1, len >> 8, len & 255]), ascii('Exif\0\0'), tiff);
  return concat(jpeg.subarray(0, 2), app1, jpeg.subarray(2));
}

/** A minimal JPEG-shaped byte string (not decodable) for parser tests. */
export function fakeJpeg(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0xff, 0xd9]);
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const len = body.length;
  // CRC left as zero: the reader under test does not check it.
  return concat(Uint8Array.from([(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255]), ascii(type), body, new Uint8Array(4));
}

export function pngWithExif(tiff: Uint8Array): Uint8Array {
  return concat(ascii('\x89PNG\r\n\x1a\n'), chunk('IHDR', new Uint8Array(13)), chunk('eXIf', tiff), chunk('IEND', new Uint8Array(0)));
}

export function webpWithExif(tiff: Uint8Array): Uint8Array {
  const body = concat(ascii('Exif\0\0'), tiff);
  const pad = body.length % 2 ? new Uint8Array(1) : new Uint8Array(0);
  const exif = concat(ascii('EXIF'), Uint8Array.from([body.length & 255, (body.length >> 8) & 255, (body.length >> 16) & 255, 0]), body, pad);
  const size = 4 + exif.length;
  return concat(ascii('RIFF'), Uint8Array.from([size & 255, (size >> 8) & 255, (size >> 16) & 255, 0]), ascii('WEBP'), exif);
}
