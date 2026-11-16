import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strFromU8 } from 'fflate';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../src/lib/audit';
import { sha256 } from '../../src/lib/hash';
import type { AuditEvent, CaptureRecord, VisitRecord } from '../../src/lib/types';
import { readWacz } from '../../src/lib/wacz';

/** SPEC F3 (auto-capture) and F4 (forensic capture) in a real browser. */

const EXT = resolve('.output/chrome-mv3');
const BROWSER = process.env.EVICAP_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let server: Server;
let base = '';
let ctx: BrowserContext;
let sw: Worker;
let dash: Page;
let profile = '';
let changing = 0;
let png = new Uint8Array();
const CSS = 'body{font-family:sans-serif;background:#fafafa} .hero{background:url(/bg.png) no-repeat;height:40px}';

function page(title: string, body: string) {
  return `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="/style.css"></head>
    <body><div class="hero"></div><h1>${title}</h1>${body}<img id="logo" src="/logo.png" width="20" height="20" alt="Logo">
    <a href="/same">Same page</a><script>window.ran = true</script></body></html>`;
}

function startServer(): Promise<string> {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const send = (type: string, body: string | Uint8Array, extra: Record<string, string> = {}) => {
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Test-Header': 'evicap', ...extra });
      res.end(typeof body === 'string' ? body : Buffer.from(body));
    };
    if (path === '/style.css') return send('text/css', CSS);
    if (path === '/logo.png' || path === '/bg.png') return send('image/png', png);
    if (path === '/same') return send('text/html; charset=utf-8', page('Same page', '<p>This page never changes.</p>'));
    if (path === '/changing') return send('text/html; charset=utf-8', page('Changing page', `<p>Version ${++changing}</p>`));
    if (path === '/big') return send('text/html; charset=utf-8', page('Big page', `<pre>${'x'.repeat(1_500_000)}</pre>`));
    if (path === '/redirect') {
      res.writeHead(302, { Location: '/same' });
      return res.end();
    }
    if (path === '/forensic')
      return send('text/html; charset=utf-8', page('Forensic page', '<p id="t">Evidence text</p><p>Second paragraph</p>'), { 'Set-Cookie': 'k=v' });
    res.writeHead(404);
    res.end();
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      r(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    }),
  );
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

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 250));
    v = await fn();
  }
  return v;
}

const events = async (caseId: string) => (await idbAll<AuditEvent>('audit')).filter((e) => e.caseId === caseId).sort((a, b) => a.seq - b.seq);
const captures = async (caseId: string) => (await idbAll<CaptureRecord>('captures')).filter((c) => c.caseId === caseId);

beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'evicap-e2e-pages-'));
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
  const extId = new URL(sw.url()).host;
  dash = await ctx.newPage();
  await dash.goto(`chrome-extension://${extId}/dashboard.html`);
  png = new Uint8Array(
    await dash.evaluate(async () => {
      const c = new OffscreenCanvas(20, 20);
      const g = c.getContext('2d')!;
      g.fillStyle = '#c33';
      g.fillRect(0, 0, 20, 20);
      return Array.from(new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    }),
  );
  base = await startServer();
});

afterAll(async () => {
  await ctx?.close();
  server?.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* locked briefly */
  }
});

describe('Automatic capture (F3)', () => {
  let caseId = '';
  let tab: Page;

  it('saves MHTML, text and a screenshot for each logged page, linked to its visit', async () => {
    await rpc('saveSettings', { autoCaptureThrottleSec: 1, autoCaptureMaxMhtmlMb: 1 });
    ({ id: caseId } = await rpc<{ id: string }>('createCase', { name: 'Auto case', reference: 'A-1' }));
    await rpc('setActiveCase', caseId);
    await rpc('setRecording', true);
    tab = await ctx.newPage();
    await tab.goto(`${base}/same`);
    await tab.bringToFront();

    const [auto] = await waitFor(
      async () => (await captures(caseId)).filter((c) => c.type === 'auto' && c.status === 'complete'),
      (l) => l.length > 0,
    );
    expect(auto).toBeTruthy();
    expect(auto!.url).toBe(`${base}/same`);
    expect(auto!.title).toBe('Same page');
    expect(auto!.method).toBe('pageCapture+captureVisibleTab');
    expect(auto!.files.map((f) => `${f.path}:${f.role}`).sort()).toEqual(['page.mhtml:mhtml', 'screenshot.png:primary', 'text.txt:text']);
    const text = strFromU8(await opfsBytes(auto!, 'text.txt'));
    expect(text).toContain('This page never changes.');
    const mhtml = strFromU8(await opfsBytes(auto!, 'page.mhtml'));
    expect(mhtml).toContain('Snapshot-Content-Location');
    // MHTML parts are quoted-printable: undo soft line breaks before searching.
    expect(mhtml.replace(/=\r?\n/g, '')).toContain('never changes');
    for (const f of auto!.files) expect(await sha256(await opfsBytes(auto!, f.path))).toBe(f.sha256);

    const visit = (await idbAll<VisitRecord>('visits')).find((v) => v.caseId === caseId && v.finalUrl === `${base}/same`)!;
    expect(visit.autoCaptureId).toBe(auto!.id);
    expect(auto!.meta.visitId).toBe(visit.id);
  });

  it('links an unchanged page to its earlier capture instead of storing a copy', async () => {
    const before = (await captures(caseId)).length;
    await new Promise((r) => setTimeout(r, 1100)); // past the 1 s throttle
    await tab.goto(`${base}/same?again=1`);
    await tab.goto(`${base}/same`);
    const reused = await waitFor(
      async () => (await events(caseId)).filter((e) => e.type === 'capture.reused'),
      (l) => l.length > 0,
    );
    expect(reused).toHaveLength(1);
    expect((await captures(caseId)).filter((c) => c.url === `${base}/same`)).toHaveLength(1);
    const visits = (await idbAll<VisitRecord>('visits')).filter((v) => v.caseId === caseId && v.finalUrl === `${base}/same`);
    const latest = visits.sort((a, b) => b.seq - a.seq)[0]!;
    expect(latest.autoCaptureId).toBe(reused[0]!.payload.captureId);
    // The ?again=1 page is a different address, so it gets its own capture (or is replaced by the newer visit).
    expect((await captures(caseId)).length).toBeGreaterThanOrEqual(before);
  });

  it('captures a page again when its content has changed', async () => {
    await tab.goto(`${base}/changing`);
    await waitFor(async () => (await captures(caseId)).filter((c) => c.url === `${base}/changing`), (l) => l.length === 1);
    await new Promise((r) => setTimeout(r, 1100));
    await tab.goto(`${base}/same`);
    await new Promise((r) => setTimeout(r, 300));
    await tab.goto(`${base}/changing`);
    const both = await waitFor(async () => (await captures(caseId)).filter((c) => c.url === `${base}/changing`), (l) => l.length === 2);
    expect(both).toHaveLength(2);
    expect(both[0]!.meta.textSha256).not.toBe(both[1]!.meta.textSha256);
  });

  it('skips a page over the size limit and records why', async () => {
    await new Promise((r) => setTimeout(r, 1100));
    await tab.goto(`${base}/big`);
    const skipped = await waitFor(
      async () => (await events(caseId)).filter((e) => e.type === 'capture.skipped'),
      (l) => l.length > 0,
    );
    expect(skipped[0]!.payload.url).toBe(`${base}/big`);
    expect(String(skipped[0]!.payload.reason)).toContain('over the 1 MB auto-capture limit');
    expect((await captures(caseId)).some((c) => c.url === `${base}/big`)).toBe(false);
  });

  it('keeps the audit chain intact', async () => {
    const ev = await events(caseId);
    expect((await verifyChain(ev)).ok).toBe(true);
    await rpc('setRecording', false);
  });
});

describe('Forensic capture (F4)', () => {
  let caseId = '';
  let tab: Page;
  let tabId = 0;

  beforeAll(async () => {
    ({ id: caseId } = await rpc<{ id: string }>('createCase', { name: 'Forensic case', reference: 'F-1', autoCapture: false }));
    await rpc('setActiveCase', caseId);
    await rpc('setRecording', true);
    tab = await ctx.newPage();
    await tab.goto(`${base}/forensic`);
    await tab.bringToFront();
    await tab.waitForFunction(() => (document.getElementById('logo') as HTMLImageElement).complete);
    tabId = (await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, `${base}/forensic`))!;
  });

  const check = async (c: CaptureRecord, reload: boolean) => {
    expect(c.status).toBe('complete');
    expect(c.type).toBe('forensic');
    expect(c.method).toBe(`cdp(${reload ? 'reload' : 'current-state'})+wacz`);
    const paths = c.files.map((f) => f.path);
    for (const p of ['page.wacz', 'page.mhtml', 'dom.html', 'network.json', 'links.json', 'text.txt']) expect(paths).toContain(p);
    expect(c.files.find((f) => f.role === 'primary')!.path).toBe('page.wacz');
    expect(c.files.some((f) => f.role === 'screenshot' && f.mime === 'image/png')).toBe(true);
    for (const f of c.files) expect(await sha256(await opfsBytes(c, f.path))).toBe(f.sha256);

    const wacz = readWacz(await opfsBytes(c, 'page.wacz'));
    expect((await wacz.verify()).every((v) => v.ok)).toBe(true);
    expect(wacz.pages[0]!.url).toBe(`${base}/forensic`);
    const doc = wacz.get(`${base}/forensic`)!;
    expect(strFromU8(doc.body)).toContain('Evidence text');
    const css = wacz.get(`${base}/style.css`)!;
    expect(strFromU8(css.body)).toBe(CSS);
    expect(Array.from(wacz.get(`${base}/logo.png`)!.body)).toEqual(Array.from(png));

    const dom = strFromU8(await opfsBytes(c, 'dom.html'));
    expect(dom.startsWith('<!DOCTYPE html>') || dom.startsWith('<!doctype html>')).toBe(true);
    expect(dom).toContain('Evidence text');
    const links = JSON.parse(strFromU8(await opfsBytes(c, 'links.json')));
    expect(links.some((l: { href: string }) => l.href === `${base}/same`)).toBe(true);
    const net = JSON.parse(strFromU8(await opfsBytes(c, 'network.json'))) as Record<string, any>[];
    return { wacz, net, doc };
  };

  it('captures the page as it is, without reloading', async () => {
    const { captureId } = await rpc<{ captureId: string }>('forensicCapture', false, tabId);
    const c = (await captures(caseId)).find((x) => x.id === captureId)!;
    const { wacz } = await check(c, false);
    expect(c.degraded.some((d) => d.includes('no reload'))).toBe(true);
    // The no-store page HTML is not kept in memory, so it is downloaded again and flagged.
    expect(c.meta.refetchedDocument).toBe(true);
    expect(c.degraded.some((d) => d.includes('downloaded again'))).toBe(true);
    // Without a reload, resources come from the page's memory as WARC resource records.
    expect(wacz.get(`${base}/style.css`)!.type).toBe('resource');
    expect(await tab.evaluate(() => (window as unknown as { ran: boolean }).ran)).toBe(true);
  });

  it('reloads with network recording and stores full HTTP responses', async () => {
    const { captureId } = await rpc<{ captureId: string }>('forensicCapture', true, tabId);
    const c = (await captures(caseId)).find((x) => x.id === captureId)!;
    const { net, doc } = await check(c, true);
    expect(doc.type).toBe('response');
    expect(doc.status).toBe(200);
    expect(doc.httpHeaders).toContainEqual(['X-Test-Header', 'evicap']);
    expect(doc.warcHeaders['WARC-IP-Address']).toBe('127.0.0.1');
    const main = net.find((r) => r.url === `${base}/forensic` && r.resourceType === 'Document')!;
    expect(main.status).toBe(200);
    expect(main.bodyBytes).toBeGreaterThan(100);
    expect(net.some((r) => r.url === `${base}/logo.png`)).toBe(true);
    const m = c.meta as Record<string, any>;
    expect(m.mainDocument.remoteIPAddress).toBe('127.0.0.1');
    expect(m.counts.requests).toBeGreaterThanOrEqual(3);
    expect(c.degraded).toEqual([]);
  });

  it('builds an offline snapshot view in the dashboard', async () => {
    const c = (await captures(caseId)).find((x) => x.method === 'cdp(reload)+wacz')!;
    await dash.goto(dash.url().replace(/#.*$/, '') + `#/case/${caseId}/capture/${c.id}/snapshot`);
    const frame = dash.frameLocator('iframe.snapshot-frame');
    await expect.poll(async () => (await frame.locator('#t').textContent().catch(() => null)) ?? '', { timeout: 15_000 }).toBe('Evidence text');
    const html = await dash.locator('iframe.snapshot-frame').getAttribute('srcdoc');
    expect(html).not.toContain('<script');
    expect(html).toContain('data:image/png;base64');
    expect(html).not.toContain(`${base}/logo.png"`);
  });

  it('keeps the audit chain intact', async () => {
    expect((await verifyChain(await events(caseId))).ok).toBe(true);
  });
});
