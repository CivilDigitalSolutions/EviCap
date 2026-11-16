import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../src/lib/audit';
import { sha256 } from '../../src/lib/hash';
import type { AuditEvent, CaptureRecord, VisitRecord } from '../../src/lib/types';

const EXT = resolve('.output/chrome-mv3');
const BROWSER =
  process.env.EVICAP_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let server: Server;
let base = '';
let ctx: BrowserContext;
let sw: Worker;
let extId = '';
let dash: Page;
let profile = '';

function fixtureSite(): Promise<void> {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/redirect') {
      res.writeHead(302, { Location: '/b' });
      return res.end();
    }
    const page = (title: string, body: string) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>${title}</title><meta name="author" content="Fixture"></head><body>${body}</body></html>`);
    };
    if (url === '/a') return page('Page A', '<h1>Page A</h1><a id="to-b" href="/b">to B</a>');
    if (url === '/b') return page('Page B', '<h1>Page B</h1>');
    if (url === '/spa')
      return page('SPA', '<h1>SPA</h1><script>setTimeout(()=>history.pushState({}, "", "/spa/route-2"), 300)</script>');
    if (url === '/long')
      return page(
        'Long page',
        '<style>body{margin:0}</style>' +
          Array.from({ length: 120 }, (_, i) => `<div style="height:40px;background:rgb(${i * 2},${255 - i * 2},0)">Row ${i}</div>`).join(''),
      );
    page('Home', '<h1>Home</h1>');
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      r();
    }),
  );
}

/** Call the extension's RPC from an extension page. */
async function rpc<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  const res = await dash.evaluate(
    ([m, a]) => chrome.runtime.sendMessage({ kind: 'rpc', method: m, args: a }),
    [method, args] as const,
  );
  if (!res?.ok) throw new Error(`rpc ${method} failed: ${res?.error}`);
  return res.value as T;
}

async function idbAll<T>(store: string): Promise<T[]> {
  return dash.evaluate(
    (s) =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open('evicap');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction(s).objectStore(s).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        };
      }),
    store,
  ) as Promise<T[]>;
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 250));
    v = await fn();
  }
  return v;
}

beforeAll(async () => {
  await fixtureSite();
  profile = mkdtempSync(join(tmpdir(), 'evicap-e2e-'));
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
  // The onboarding tab opens on install; use a fresh dashboard page for RPC.
  dash = await ctx.newPage();
  await dash.goto(`chrome-extension://${extId}/dashboard.html`);
});

afterAll(async () => {
  await ctx?.close();
  server?.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* profile may still be locked briefly */
  }
});

describe('EviCap in a real browser', () => {
  let caseId = '';
  let tab: Page;

  it('loads and shows onboarding on install', async () => {
    expect(extId).toMatch(/^[a-p]{32}$/);
    await waitFor(async () => ctx.pages().map((p) => p.url()), (urls) => urls.some((u) => u.includes('#/onboarding')));
    expect(ctx.pages().some((p) => p.url().includes('#/onboarding'))).toBe(true);
  });

  it('creates a case and records visits, redirects and in-page navigation', async () => {
    ({ id: caseId } = await rpc<{ id: string }>('createCase', { name: 'E2E case', reference: 'E2E-1' }));
    await rpc('setActiveCase', caseId);
    await rpc('setRecording', true);

    tab = await ctx.newPage();
    await tab.goto(`${base}/a`);
    await tab.click('#to-b');
    await tab.waitForURL('**/b');
    await tab.goto(`${base}/redirect`);
    await tab.goto(`${base}/spa`);
    await tab.waitForURL('**/spa/route-2');

    const visits = await waitFor(
      () => idbAll<VisitRecord>('visits'),
      (v) => v.some((x) => x.finalUrl.endsWith('/spa/route-2')),
    );
    const urls = visits.sort((a, b) => a.seq - b.seq).map((v) => new URL(v.finalUrl).pathname);
    expect(urls).toEqual(['/a', '/b', '/b', '/spa', '/spa/route-2']);
    const redirected = visits.find((v) => v.redirectChain.length > 0)!;
    expect(redirected.url).toBe(`${base}/redirect`);
    expect(redirected.redirectChain).toEqual([`${base}/redirect`, `${base}/b`]);
    expect(visits.find((v) => v.finalUrl.endsWith('/spa/route-2'))!.spa).toBe(true);
    expect(visits.find((v) => v.finalUrl.endsWith('/b') && v.transitionType === 'link')).toBeTruthy();
  });

  it('takes visible and full-page screenshots with correct hashes and signatures', async () => {
    await tab.goto(`${base}/long`);
    await tab.bringToFront();
    const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, `${base}/long`);
    expect(tabId).toBeTypeOf('number');

    const v = await rpc<{ captureId: string }>('screenshot', 'visible', tabId);
    const f = await rpc<{ captureId: string }>('screenshot', 'full', tabId);
    const captures = await idbAll<CaptureRecord>('captures');
    const visible = captures.find((c) => c.id === v.captureId)!;
    const full = captures.find((c) => c.id === f.captureId)!;
    expect(visible.status).toBe('complete');
    expect(full.status).toBe('complete');
    expect(full.method).toContain('cdp');
    expect(full.title).toBe('Long page');

    // Re-hash the stored bytes from OPFS and compare.
    for (const c of [visible, full]) {
      for (const file of c.files) {
        const bytes = await dash.evaluate(
          async ([caseId, id, path]) => {
            let dir = await navigator.storage.getDirectory();
            for (const p of `cases/${caseId}/captures/${id}`.split('/')) dir = await dir.getDirectoryHandle(p);
            const parts = path.split('/');
            for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
            const buf = await (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).arrayBuffer();
            return Array.from(new Uint8Array(buf));
          },
          [c.caseId, c.id, file.path] as const,
        );
        expect(await sha256(new Uint8Array(bytes))).toBe(file.sha256);
        if (process.env.EVICAP_E2E_DUMP) writeFileSync(join(tmpdir(), `evicap-${c.meta.mode}-${file.path.replace(/\//g, '_')}`), new Uint8Array(bytes));
      }
    }
    // The stored full-page image must show the whole page: sample rows 0, 60 and 119.
    const png = full.files.find((x) => x.role === 'primary')!;
    const pixels = await dash.evaluate(
      async ([caseId, id, path]) => {
        let dir = await navigator.storage.getDirectory();
        for (const p of `cases/${caseId}/captures/${id}`.split('/')) dir = await dir.getDirectoryHandle(p);
        const bmp = await createImageBitmap(await (await dir.getFileHandle(path)).getFile());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const scale = bmp.height / 4800;
        const at = (row: number) => Array.from(g.getImageData(600, Math.round((row * 40 + 20) * scale), 1, 1).data.slice(0, 3));
        return { w: bmp.width, h: bmp.height, rows: [at(0), at(60), at(119)] };
      },
      [full.caseId, full.id, png.path] as const,
    );
    expect(pixels.h).toBeGreaterThanOrEqual(4800);
    expect(pixels.rows).toEqual([
      [0, 255, 0],
      [120, 135, 0],
      [238, 17, 0],
    ]);

    // Signature check with the install public key.
    const ok = await dash.evaluate(async ([caseId, id]) => {
      let dir = await navigator.storage.getDirectory();
      for (const p of `cases/${caseId}/captures/${id}`.split('/')) dir = await dir.getDirectoryHandle(p);
      const manifest = await (await (await dir.getFileHandle('manifest.json')).getFile()).text();
      const sig = await (await (await dir.getFileHandle('manifest.sig')).getFile()).text();
      const db: IDBDatabase = await new Promise((r) => {
        const o = indexedDB.open('evicap');
        o.onsuccess = () => r(o.result);
      });
      const key: { publicJwk: JsonWebKey } = await new Promise((r) => {
        const q = db.transaction('keys').objectStore('keys').get('install');
        q.onsuccess = () => r(q.result);
      });
      const pub = await crypto.subtle.importKey('jwk', key.publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const b64 = sig.replace(/-/g, '+').replace(/_/g, '/');
      const raw = Uint8Array.from(atob(b64 + '==='.slice((b64.length + 3) % 4)), (ch) => ch.charCodeAt(0));
      return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, raw, new TextEncoder().encode(manifest));
    }, [full.caseId, full.id] as const);
    expect(ok).toBe(true);
  });

  it('keeps an intact audit chain covering every visit and capture', async () => {
    await rpc('setRecording', false);
    const events = (await idbAll<AuditEvent>('audit')).filter((e) => e.caseId === caseId);
    const check = await verifyChain(events);
    expect(check.errors).toEqual([]);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('case.created');
    expect(types.filter((t) => t === 'visit.recorded').length).toBe(6);
    expect(types.filter((t) => t === 'capture.created').length).toBe(2);
    expect(types.at(-1)).toBe('recording.paused');
  });

  it('mirrors the case to a folder and the copies match their hashes', async () => {
    // Stand-in for a user-picked folder: an OPFS directory handle (always permitted).
    await dash.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('mirror-test', { create: true });
      const db: IDBDatabase = await new Promise((r) => {
        const o = indexedDB.open('evicap');
        o.onsuccess = () => r(o.result);
      });
      await new Promise<void>((r) => {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(dir, 'mirrorDir');
        tx.oncomplete = () => r();
      });
    });
    await rpc('mirrorConnected');
    const status = await waitFor(
      () => dash.evaluate(() => new Promise<{ state: string; queued: number } | undefined>((r) => {
        const o = indexedDB.open('evicap');
        o.onsuccess = () => {
          const q = o.result.transaction('meta').objectStore('meta').get('mirrorStatus');
          q.onsuccess = () => r(q.result);
        };
      })),
      (s) => s?.state === 'ok' && s.queued === 0,
      30_000,
    );
    expect(status?.state).toBe('ok');

    const listing = await dash.evaluate(async () => {
      const out: Record<string, number> = {};
      const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
        // @ts-expect-error entries() exists on directory handles
        for await (const [name, h] of dir.entries()) {
          if (h.kind === 'directory') await walk(h, `${prefix}${name}/`);
          else out[`${prefix}${name}`] = (await h.getFile()).size;
        }
      };
      await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('mirror-test'), '');
      return out;
    });
    const paths = Object.keys(listing);
    expect(paths.some((p) => p.endsWith('/audit-log.jsonl'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/visits.jsonl'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/case.json'))).toBe(true);
    expect(paths.filter((p) => p.endsWith('/manifest.sig')).length).toBe(2);
    expect(paths.some((p) => p.endsWith('/fullpage.png'))).toBe(true);

    // New events after connecting are appended to the mirrored audit log.
    await rpc('addNote', caseId, 'case', caseId, 'Mirror append test');
    const lines = await waitFor(
      () =>
        dash.evaluate(async () => {
          const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('mirror-test');
          // @ts-expect-error entries()
          for await (const [name, h] of root.entries()) {
            if (h.kind !== 'directory') continue;
            const f = await (await h.getFileHandle('audit-log.jsonl')).getFile();
            return (await f.text()).trim().split('\n').length;
          }
          return 0;
        }),
      (n) => n > 0 && n === 0 + n && true,
    );
    const total = (await idbAll<AuditEvent>('audit')).filter((e) => e.caseId === caseId).length;
    const final = await waitFor(
      () =>
        dash.evaluate(async () => {
          const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('mirror-test');
          // @ts-expect-error entries()
          for await (const [, h] of root.entries()) {
            if (h.kind !== 'directory') continue;
            const f = await (await h.getFileHandle('audit-log.jsonl')).getFile();
            return (await f.text()).trim().split('\n').length;
          }
          return 0;
        }),
      (n) => n === total,
    );
    expect(lines).toBeGreaterThan(0);
    expect(final).toBe(total);
  });

  it('renders the dashboard case page without errors', async () => {
    const errors: string[] = [];
    dash.on('pageerror', (e) => errors.push(e.message));
    await dash.goto(`chrome-extension://${extId}/dashboard.html#/case/${caseId}`);
    await dash.getByRole('heading', { name: 'E2E case' }).waitFor();
    await dash.getByRole('tab', { name: 'Audit log' }).click();
    await dash.getByRole('button', { name: 'Verify chain' }).click();
    await dash.getByText('Chain intact').waitFor();
    await dash.getByRole('tab', { name: 'Captures' }).click();
    await dash.locator('a.card').first().click();
    await dash.getByText('Verified: every file matches').waitFor();
    await dash.screenshot({ path: join(tmpdir(), 'evicap-e2e-capture.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
});
