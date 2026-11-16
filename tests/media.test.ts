import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readExif } from '../src/lib/exif';
import { decodeDataUrl, extensionFor, sniffMime } from '../src/lib/net';
import { fakeJpeg, jpegWithExif, pngWithExif, sampleTiff, webpWithExif } from './fixtures/exif';

describe('readExif', () => {
  it('reads camera tags and GPS from a JPEG', () => {
    const r = readExif(jpegWithExif(fakeJpeg(), sampleTiff()));
    expect(r.format).toBe('jpeg');
    expect(r.tags.Make).toBe('EviCapTest');
    expect(r.tags.Model).toBe('Model X');
    expect(r.tags.Orientation).toBe(1);
    expect(r.tags.DateTimeOriginal).toBe('2026:11:01 09:30:15');
    expect(r.tags.ISO).toBe(200);
    expect(r.tags.ExposureTime).toBe(0.004);
    // 51° 30' 26.46" N, 0° 7' 39.93" W
    expect(r.gps!.latitude).toBeCloseTo(51.50735, 5);
    expect(r.gps!.longitude).toBeCloseTo(-0.1277583, 5);
    expect(r.gps!.altitude).toBe(35.5);
  });

  it('reads EXIF from PNG eXIf and WebP EXIF chunks', () => {
    expect(readExif(pngWithExif(sampleTiff('PngCam'))).tags.Make).toBe('PngCam');
    const w = readExif(webpWithExif(sampleTiff('WebpCam')));
    expect(w.format).toBe('webp');
    expect(w.tags.Make).toBe('WebpCam');
  });

  it('reports no tags for an image without EXIF', () => {
    const r = readExif(fakeJpeg());
    expect(r).toEqual({ format: 'jpeg', tags: {}, gps: null, hasXmp: false, hasIptc: false });
  });

  it('does not throw on truncated or random bytes', () => {
    const good = jpegWithExif(fakeJpeg(), sampleTiff());
    for (let n = 0; n < good.length; n += 7) expect(() => readExif(good.subarray(0, n))).not.toThrow();
    const noise = Uint8Array.from({ length: 2000 }, (_, i) => (i * 7919) % 256);
    expect(() => readExif(noise)).not.toThrow();
    noise[0] = 0xff;
    noise[1] = 0xd8;
    expect(() => readExif(noise)).not.toThrow();
  });
});

describe('net helpers', () => {
  it('decodes base64 and percent-encoded data URLs', () => {
    const b = decodeDataUrl('data:image/png;base64,iVBORw0KGgo=');
    expect(b.mime).toBe('image/png');
    expect(Array.from(b.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const t = decodeDataUrl('data:image/svg+xml,%3Csvg%3E%3C/svg%3E');
    expect(t.mime).toBe('image/svg+xml');
    expect(new TextDecoder().decode(t.bytes)).toBe('<svg></svg>');
  });

  it('identifies formats from their first bytes', () => {
    const enc = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
    expect(sniffMime(fakeJpeg())).toBe('image/jpeg');
    expect(sniffMime(enc('\x89PNG\r\n\x1a\n....'))).toBe('image/png');
    expect(sniffMime(enc('GIF89a'))).toBe('image/gif');
    expect(sniffMime(enc('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffMime(enc('\0\0\0\x18ftypavif'))).toBe('image/avif');
    expect(sniffMime(enc('\0\0\0\x18ftypisom'))).toBe('video/mp4');
    expect(sniffMime(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe('video/webm');
    expect(sniffMime(enc('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(sniffMime(enc('WEBVTT\n'))).toBe('text/vtt');
    expect(sniffMime(enc('hello'))).toBeNull();
  });

  it('picks file extensions from the type or the address', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('', 'https://x.test/a/b/photo.JPEG?w=200')).toBe('jpeg');
    expect(extensionFor('application/octet-stream', 'https://x.test/download')).toBe('bin');
    expect(extensionFor('', 'data:image/png;base64,xx')).toBe('bin');
  });
});

describe('network rules (SPEC §10)', () => {
  // Only these modules may make network requests: net.ts (extension contexts),
  // media-scripts.ts (runs inside the captured page itself) and billing.ts
  // (Lemon Squeezy, only after the user pastes a subscription key).
  const ALLOWED = new Set(['src/lib/net.ts', 'src/lib/media-scripts.ts', 'src/lib/billing.ts']);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) files.push(relative(process.cwd(), p).replace(/\\/g, '/'));
    }
  };
  walk(join(process.cwd(), 'src'));

  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('allows fetch, XHR, WebSocket, beacons and EventSource only in the network module', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOWED.has(f)) continue;
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/(?<![\w-])fetch\s*\(|XMLHttpRequest|new\s+WebSocket|sendBeacon|new\s+EventSource|importScripts\s*\(/.test(code)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
