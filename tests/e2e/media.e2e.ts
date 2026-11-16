import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../src/lib/audit';
import { sha256 } from '../../src/lib/hash';
import type { MediaResult } from '../../src/lib/media';
import type { AuditEvent, CaptureRecord } from '../../src/lib/types';
import { jpegWithExif, sampleTiff } from '../fixtures/exif';

/** SPEC F6 and F7-A in a real browser: right-click capture, the media picker, and direct video download. */

const EXT = resolve('.output/chrome-mv3');
const BROWSER = process.env.EVICAP_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let pageServer: Server;
let mediaServer: Server;
let pageBase = '';
let mediaBase = '';
let ctx: BrowserContext;
let sw: Worker;
let extId = '';
let dash: Page;
let profile = '';

const assets: Record<string, { type: string; body: Uint8Array }> = {};
const videoBytes = (() => {
  const b = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < b.length; i++) b[i] = (i * 2654435761) >>> 24;
  b.set([0, 0, 0, 0x18, ...[...'ftypisom'].map((c) => c.charCodeAt(0))], 0);
  return b;
})();
let videoDrops = 0;
let rangeRequests = 0;
let inlineDataUrl = '';

function listen(s: Server, host: string): Promise<string> {
  return new Promise((r) =>
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      r(`http://${host}:${typeof a === 'object' && a ? a.port : 0}`);
    }),
  );
}

function startServers() {
  // The media lives on a different origin from the page and sends no CORS headers,
  // so only the extension's own request (with host permission) can read it.
  mediaServer = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/clip.mp4') {
      const total = videoBytes.length;
      const range = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''));
      const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', ETag: '"clip-v1"' };
      if (range) {
        rangeRequests++;
        const start = Number(range[1]);
        res.writeHead(206, { ...headers, 'Content-Length': total - start, 'Content-Range': `bytes ${start}-${total - 1}/${total}` });
        return res.end(Buffer.from(videoBytes.subarray(start)));
      }
      res.writeHead(200, { ...headers, 'Content-Length': total });
      // The extension's first download (Sec-Fetch-Dest: empty) is cut off after 1 MB, to test resuming.
      if (req.headers['sec-fetch-dest'] === 'empty' && videoDrops === 0) {
        videoDrops++;
        res.write(Buffer.from(videoBytes.subarray(0, 1024 * 1024)), () => setTimeout(() => res.socket?.destroy(), 50));
        return;
      }
      return res.end(Buffer.from(videoBytes));
    }
    const a = assets[path];
    if (!a) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': a.type, 'Content-Length': a.body.length, 'Cache-Control': 'no-store' });
    res.end(Buffer.from(a.body));
  });
  pageServer = createServer((req, res) => {
    const m = mediaBase;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Media page</title></head><body style="margin:20px">
      <h1>Media</h1>
      <figure style="margin:0 0 20px"><img id="photo" src="${m}/photo.jpg" width="200" height="150" alt="Test photo" title="A photo">
        <figcaption>Photo caption text</figcaption></figure>
      <img id="responsive" src="${m}/small.png" srcset="${m}/small.png 100w, ${m}/large.png 400w" sizes="100px" width="100" height="100" alt="Responsive">
      <img id="inline" src="${inlineDataUrl}" width="40" height="40" alt="Inline">
      <img id="tiny" src="${m}/small.png" width="8" height="8" alt="">
      <div style="height:1100px"></div>
      <video id="clip" src="${m}/clip.mp4" poster="${m}/poster.png" preload="none" width="320" height="180">
        <track kind="captions" srclang="en" label="English" src="${m}/track.vtt">
      </video>
      <video id="mse" width="160" height="90" style="background:#333"></video>
      <script>document.getElementById('mse').src = URL.createObjectURL(new MediaSource());</script>
      <div style="height:400px"></div>
    </body></html>`);
  });
  return Promise.all([listen(pageServer, '127.0.0.1'), listen(mediaServer, 'localhost')]).then(([p, m]) => {
    pageBase = p;
    mediaBase = m;
  });
}

async function rpc<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  const res = await dash.evaluate(([mth, a]) => chrome.runtime.sendMessage({ kind: 'rpc', method: mth, args: a }), [method, args] as const);
  if (!res?.ok) throw new Error(`rpc ${method} failed: ${res?.error}`);
  return res.value as T;
}

async function idbAll<T>(store: string): Promise<T[]> {
  return dash.evaluate(
    (s) =>
      new Promise<unknown[]>((ok, fail) => {
        const open = indexedDB.open('evicap');
        open.onsuccess = () => {
          const req = open.result.transaction(s).objectStore(s).getAll();
          req.onsuccess = () => ok(req.result);
          req.onerror = () => fail(req.error);
        };
      }),
    store,
  ) as Promise<T[]>;
}

async function opfsBytes(c: CaptureRecord, path: string): Promise<Uint8Array> {
  const arr = await dash.evaluate(
    async ([caseId, id, p]) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of `cases/${caseId}/captures/${id}`.split('/')) dir = await dir.getDirectoryHandle(part);
      const parts = p.split('/');
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      return Array.from(new Uint8Array(await (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).arrayBuffer()));
    },
    [c.caseId, c.id, path] as const,
  );
  return new Uint8Array(arr);
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200));
    v = await fn();
  }
  return v;
}

beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'evicap-e2e-media-'));
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: BROWSER,
    headless: true,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
    ],
    viewport: { width: 1200, height: 800 },
  });
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20_000 }));
  extId = new URL(sw.url()).host;
  dash = await ctx.newPage();
  await dash.goto(`chrome-extension://${extId}/dashboard.html`);

  // Real, decodable images made by the browser; the photo then gets an EXIF block.
  const made = await dash.evaluate(async () => {
    const draw = async (w: number, h: number, type: string, fill: (g: OffscreenCanvasRenderingContext2D) => void) => {
      const c = new OffscreenCanvas(w, h);
      fill(c.getContext('2d')!);
      return Array.from(new Uint8Array(await (await c.convertToBlob({ type, quality: 0.9 })).arrayBuffer()));
    };
    return {
      photo: await draw(200, 150, 'image/jpeg', (g) => {
        const grad = g.createLinearGradient(0, 0, 200, 150);
        grad.addColorStop(0, '#0af');
        grad.addColorStop(1, '#f50');
        g.fillStyle = grad;
        g.fillRect(0, 0, 200, 150);
      }),
      small: await draw(100, 100, 'image/png', (g) => ((g.fillStyle = '#f00'), g.fillRect(0, 0, 100, 100))),
      large: await draw(400, 400, 'image/png', (g) => ((g.fillStyle = '#00f'), g.fillRect(0, 0, 400, 400))),
      poster: await draw(320, 180, 'image/png', (g) => ((g.fillStyle = '#0a0'), g.fillRect(0, 0, 320, 180))),
      noise: await draw(40, 40, 'image/png', (g) => {
        for (let i = 0; i < 1600; i++) {
          g.fillStyle = `rgb(${(i * 37) % 256},${(i * 91) % 256},${(i * 13) % 256})`;
          g.fillRect(i % 40, Math.floor(i / 40), 1, 1);
        }
      }),
    };
  });
  assets['/photo.jpg'] = { type: 'image/jpeg', body: jpegWithExif(new Uint8Array(made.photo), sampleTiff()) };
  assets['/small.png'] = { type: 'image/png', body: new Uint8Array(made.small) };
  assets['/large.png'] = { type: 'image/png', body: new Uint8Array(made.large) };
  assets['/poster.png'] = { type: 'image/png', body: new Uint8Array(made.poster) };
  assets['/track.vtt'] = { type: 'text/vtt', body: new TextEncoder().encode('WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n') };
  assets['/noise.png'] = { type: 'image/png', body: new Uint8Array(made.noise) };
  inlineDataUrl = `data:image/png;base64,${Buffer.from(made.noise).toString('base64')}`;
  await startServers();
});

afterAll(async () => {
  await ctx?.close();
  pageServer?.close();
  mediaServer?.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* locked briefly */
  }
});

describe('Media capture in a real browser', () => {
  let caseId = '';
  let tab: Page;
  let tabId = 0;
  const pageErrors: string[] = [];

  it('captures a right-clicked cross-origin image with its original bytes, EXIF and an in-context screenshot', async () => {
    ({ id: caseId } = await rpc<{ id: string }>('createCase', { name: 'Media case', reference: 'M-1' }));
    await rpc('setActiveCase', caseId);
    tab = await ctx.newPage();
    tab.on('pageerror', (e) => pageErrors.push(e.message));
    await tab.goto(`${pageBase}/media`);
    await tab.bringToFront();
    await tab.waitForFunction(() => (document.getElementById('photo') as HTMLImageElement).complete);
    tabId = (await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, `${pageBase}/media`))!;

    const r = await rpc<MediaResult>('captureMediaUrl', `${mediaBase}/photo.jpg`, 'image', tabId);
    expect(r.failed).toEqual([]);
    expect(r.captured).toHaveLength(1);

    const all = await idbAll<CaptureRecord>('captures');
    const photo = all.find((c) => c.id === r.captured[0]!.captureId)!;
    expect(photo.status).toBe('complete');
    expect(photo.type).toBe('image');
    expect(photo.method).toBe('extension-fetch');
    expect(photo.degraded).toEqual([]);
    const file = photo.files[0]!;
    expect(file.path).toBe('image.jpg');
    // Byte-for-byte the file the server sent, EXIF included.
    expect(file.sha256).toBe(await sha256(assets['/photo.jpg']!.body));
    expect(await sha256(await opfsBytes(photo, file.path))).toBe(file.sha256);
    const meta = photo.meta as Record<string, any>;
    expect(meta.exif.tags.Make).toBe('EviCapTest');
    expect(meta.exif.gps.latitude).toBeCloseTo(51.50735, 4);
    expect(meta.element.alt).toBe('Test photo');
    expect(meta.element.natural).toEqual({ width: 200, height: 150 });
    expect(meta.snippet).toContain('Photo caption text');
    expect(meta.responseHeaders['content-type']).toBe('image/jpeg');

    const child = all.find((c) => c.parent === photo.id)!;
    expect(child.type).toBe('screenshot');
    expect(child.meta.mode).toBe('context');
    expect(child.files[0]!.mime).toBe('image/png');
  });

  it('captures several items with the media picker, and flags streamed video for tab recording', async () => {
    await tab.bringToFront();
    await tab.evaluate(() => scrollTo(0, 0));
    const pending = rpc<MediaResult>('pickMedia', tabId);
    await waitFor(
      () => tab.evaluate(() => !!document.querySelector('[data-evicap-overlay]')),
      (v) => v,
    );
    for (const sel of ['#responsive', '#inline', '#clip', '#mse']) {
      const el = tab.locator(sel);
      await el.scrollIntoViewIfNeeded();
      const box = (await el.boundingBox())!;
      await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await tab.keyboard.press('Enter');
    const r = await pending;
    expect(r.failed).toEqual([]);
    expect(r.captured.map((c) => c.kind)).toEqual(['image', 'image', 'video']);
    expect(r.needsTabRecording).toHaveLength(1);
    expect(r.needsTabRecording[0]!.src).toMatch(/^blob:/);
    expect(await tab.evaluate(() => document.querySelector('[data-evicap-overlay]'))).toBeNull();

    const all = await idbAll<CaptureRecord>('captures');
    const [responsive, inline, clip] = r.captured.map((c) => all.find((x) => x.id === c.captureId)!);

    // The largest srcset candidate, not the 100w one shown on screen.
    expect(responsive!.meta.sourceChoice).toBe('srcset-largest');
    expect(String(responsive!.meta.sourceUrl)).toBe(`${mediaBase}/large.png`);
    expect(responsive!.files[0]!.sha256).toBe(await sha256(assets['/large.png']!.body));

    expect(inline!.method).toBe('data-url');
    expect(inline!.files[0]!.sha256).toBe(await sha256(assets['/noise.png']!.body));

    // Direct download: streamed, hashed as it arrived, and resumed once after the dropped connection.
    expect(clip!.type).toBe('video');
    expect(clip!.status).toBe('complete');
    expect(clip!.method).toBe('extension-fetch(stream)');
    const video = clip!.files.find((f) => f.role === 'primary')!;
    expect(video.path).toBe('video.mp4');
    expect(video.bytes).toBe(videoBytes.length);
    expect(video.sha256).toBe(await sha256(videoBytes));
    expect(await sha256(await opfsBytes(clip!, video.path))).toBe(video.sha256);
    expect(videoDrops).toBe(1);
    expect(rangeRequests).toBe(1);
    expect(clip!.meta.resumedAt).toEqual([expect.any(Number)]);
    const poster = clip!.files.find((f) => f.role === 'poster')!;
    expect(poster.sha256).toBe(await sha256(assets['/poster.png']!.body));
    const track = clip!.files.find((f) => f.role === 'track')!;
    expect(track.path).toBe('tracks/01-en.vtt');
    expect(track.sha256).toBe(await sha256(assets['/track.vtt']!.body));

    const jobs = await sw.evaluate(async () => (await chrome.storage.session.get('jobs')).jobs as { status: string; captureId: string }[]);
    expect(jobs.find((j) => j.captureId === clip!.id)?.status).toBe('done');

    // Every captured item has its in-context screenshot.
    for (const c of [responsive, inline, clip]) expect(all.some((x) => x.parent === c!.id && x.meta.mode === 'context')).toBe(true);
  });

  it('logs every media capture in an intact audit chain', async () => {
    const events = (await idbAll<AuditEvent>('audit')).filter((e) => e.caseId === caseId);
    const check = await verifyChain(events);
    expect(check.errors).toEqual([]);
    expect(events.filter((e) => e.type === 'capture.created')).toHaveLength(4);
    expect(events.filter((e) => e.type === 'artefact.derived')).toHaveLength(4);
    expect(events.some((e) => e.type === 'capture.incomplete')).toBe(false);
  });

  it('shows EXIF, the source and the video player in the dashboard', async () => {
    const errors: string[] = [];
    dash.on('pageerror', (e) => errors.push(e.message));
    const all = await idbAll<CaptureRecord>('captures');
    const photo = all.find((c) => c.type === 'image' && String(c.meta.sourceUrl).endsWith('/photo.jpg'))!;
    await dash.goto(`chrome-extension://${extId}/dashboard.html#/case/${caseId}/capture/${photo.id}`);
    await dash.getByText('Verified: every file matches').waitFor();
    await dash.locator('dd', { hasText: /^EviCapTest$/ }).waitFor();
    await dash.locator('dd', { hasText: '51.50735' }).first().waitFor();
    await dash.getByRole('link', { name: /in-context screenshot/ }).waitFor();

    const clip = all.find((c) => c.type === 'video')!;
    await dash.goto(`chrome-extension://${extId}/dashboard.html#/case/${caseId}/capture/${clip.id}`);
    await dash.getByText('Verified: every file matches').waitFor();
    expect(await dash.locator('video').count()).toBe(1);

    await dash.goto(`chrome-extension://${extId}/dashboard.html#/case/${caseId}`);
    await dash.getByRole('tab', { name: 'Captures' }).click();
    // Context screenshots are grouped under their parent: 4 cards, not 8.
    await dash.locator('a.card').first().waitFor();
    expect(await dash.locator('a.card').count()).toBe(4);
    await dash.screenshot({ path: join(tmpdir(), 'evicap-e2e-media.png'), fullPage: true });
    expect(errors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
