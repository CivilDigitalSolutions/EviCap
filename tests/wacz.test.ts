import { gunzipSync, strFromU8, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/lib/hash';
import { normalizeMhtml } from '../src/lib/mhtml';
import { buildWacz, buildWarc, readWacz, storableHeaders, surt, ts14, type WarcEntry } from '../src/lib/wacz';

const html = strToU8('<!doctype html><title>Home</title><img src="/a.png">');
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
const entries: WarcEntry[] = [
  { kind: 'request', url: 'https://www.example.com/', date: '2026-11-16T10:00:00.000Z', method: 'GET', headers: [['Accept', 'text/html']], body: new Uint8Array(), recordId: '<urn:uuid:11111111-1111-1111-1111-111111111111>' },
  {
    kind: 'response',
    url: 'https://www.example.com/',
    date: '2026-11-16T10:00:00.000Z',
    status: 200,
    headers: [
      ['content-type', 'text/html; charset=utf-8'],
      ['content-encoding', 'br'],
      ['content-length', '12'],
      ['set-cookie', 'a=1\nb=2'],
    ],
    body: html,
    concurrentTo: '<urn:uuid:11111111-1111-1111-1111-111111111111>',
    warcHeaders: { 'WARC-IP-Address': '93.184.216.34' },
  },
  { kind: 'resource', url: 'https://www.example.com/a.png', date: '2026-11-16T10:00:01.000Z', mime: 'image/png', body: png },
];

describe('WARC and WACZ', () => {
  it('makes SURT keys and 14-digit timestamps', () => {
    expect(surt('https://www.Example.com/Path?b=2&a=1')).toBe('com,example)/path?a=1&b=2');
    expect(surt('http://127.0.0.1:8080/x')).toBe('127.0.0.1:8080)/x');
    expect(surt('https://sub.example.co.uk:443/')).toBe('uk,co,example,sub)/');
    expect(ts14('2026-11-16T10:42:07.123Z')).toBe('20261116104207');
  });

  it('rewrites wire-encoding headers for decoded bodies', () => {
    expect(storableHeaders([['content-encoding', 'gzip'], ['Transfer-Encoding', 'chunked'], [':status', '200'], ['ETag', 'x']], 5)).toEqual([
      ['X-EviCap-Original-Content-Encoding', 'gzip'],
      ['ETag', 'x'],
      ['Content-Length', '5'],
    ]);
  });

  it('writes one gzip member per record, indexed by offset and length', async () => {
    const warc = await buildWarc(entries, { software: 'EviCap test' });
    expect(warc.cdxj).toHaveLength(2);
    const line = warc.cdxj.find((l) => l.includes('a.png'))!;
    const j = JSON.parse(line.slice(line.indexOf('{')));
    const rec = strFromU8(gunzipSync(warc.bytes.subarray(Number(j.offset), Number(j.offset) + Number(j.length))));
    expect(rec.startsWith('WARC/1.1\r\nWARC-Type: resource')).toBe(true);
    expect(j.digest).toBe(await sha256(png));
  });

  it('builds a WACZ that reads back with intact hashes and bodies', async () => {
    const wacz = await buildWacz({
      title: 'Test',
      software: 'EviCap test',
      entries,
      pages: [{ url: 'https://www.example.com/', ts: '2026-11-16T10:00:00.000Z', title: 'Home', text: 'Home' }],
      warcInfo: { software: 'EviCap test' },
    });
    const r = readWacz(wacz);
    expect(Object.keys(r.files).sort()).toEqual([
      'archive/data.warc.gz',
      'datapackage-digest.json',
      'datapackage.json',
      'indexes/index.cdx',
      'pages/pages.jsonl',
    ]);
    expect((await r.verify()).every((v) => v.ok)).toBe(true);
    expect(r.datapackage.mainPageURL).toBe('https://www.example.com/');
    expect(r.pages[0]!.title).toBe('Home');

    const home = r.get('https://www.example.com/')!;
    expect(home.status).toBe(200);
    expect(home.mime).toBe('text/html');
    expect(strFromU8(home.body)).toBe(strFromU8(html));
    expect(home.warcHeaders['WARC-IP-Address']).toBe('93.184.216.34');
    expect(home.httpHeaders).toContainEqual(['X-EviCap-Original-Content-Encoding', 'br']);
    expect(home.httpHeaders).toContainEqual(['Content-Length', String(html.length)]);
    expect(home.httpHeaders.filter(([k]) => k === 'set-cookie')).toHaveLength(2);

    const img = r.get('https://www.example.com/a.png')!;
    expect(Array.from(img.body)).toEqual(Array.from(png));
    expect(r.get('https://www.example.com/missing')).toBeNull();

    const digest = JSON.parse(strFromU8(r.files['datapackage-digest.json']!));
    expect(digest.hash).toBe(await sha256(r.files['datapackage.json']!));
  });
});

describe('normalizeMhtml', () => {
  const save = (boundary: string, frame: string, date: string) =>
    [
      'From: <Saved by Blink>',
      'Snapshot-Content-Location: https://example.com/',
      `Date: ${date}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html',
      `Content-ID: <frame-${frame}@mhtml.blink>`,
      '',
      '<html>Hello</html>',
      `--${boundary}--`,
    ].join('\r\n');

  it('ignores per-save dates, boundaries and part ids', () => {
    const a = save('----MultipartBoundary--AAAA1111----', '0A1B2C3D4E5F60718293A4B5C6D7E8F9', 'Mon, 16 Nov 2026 10:00:00 -0000');
    const b = save('----MultipartBoundary--BBBB2222----', 'FFEEDDCCBBAA99887766554433221100', 'Mon, 16 Nov 2026 10:05:00 -0000');
    expect(a).not.toBe(b);
    expect(normalizeMhtml(a)).toBe(normalizeMhtml(b));
  });

  it('still sees a change in the page itself', () => {
    const a = save('--X1--', '0A1B2C3D4E5F60718293A4B5C6D7E8F9', 'd1');
    const b = save('--X2--', '0A1B2C3D4E5F60718293A4B5C6D7E8F9', 'd2').replace('Hello', 'Hello!');
    expect(normalizeMhtml(a)).not.toBe(normalizeMhtml(b));
  });
});
