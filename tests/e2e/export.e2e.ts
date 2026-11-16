import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testLicenceKey } from './licence';
import { sha256 } from '../../src/lib/hash';
import type { AuditEvent, CaptureRecord } from '../../src/lib/types';
import { readZipEntries, zipEntryBlob } from '../../src/lib/zip';
import { verifyBundle, zipSource, type ExportManifest } from '../../src/verifier/core';

/** SPEC F10 (export) and F11 (verification) in a real browser. */

const EXT = resolve('.output/chrome-mv3-e2e');
const BROWSER = process.env.EVICAP_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let server: Server;
let base = '';
let ctx: BrowserContext;
let sw: Worker;
let dash: Page;
let extId = '';
let profile = '';
let work = '';
let caseId = '';

function startServer(): Promise<string> {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Page ${path}</title><body style="background:#eef"><h1>Evidence page ${path}</h1><p>Secret ${path} text</p></body>`);
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

async function opfsFile(path: string): Promise<Buffer> {
  const arr = await dash.evaluate(async (p) => {
    let dir = await navigator.storage.getDirectory();
    const parts = p.split('/');
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    return Array.from(new Uint8Array(await (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).arrayBuffer()));
  }, path);
  return Buffer.from(arr);
}

const events = async () => (await idbAll<AuditEvent>('audit')).filter((e) => e.caseId === caseId).sort((a, b) => a.seq - b.seq);
const blobOf = (b: Buffer) => Object.assign(new Blob([new Uint8Array(b)]), { name: "export.zip" });

async function entryText(zip: Blob, name: string) {
  const e = (await readZipEntries(zip)).find((x) => x.name === name);
  return e ? (await zipEntryBlob(zip, e)).text() : null;
}

/** Click Export in the dashboard and return the export.created event. */
async function exportViaUi(select?: (page: Page) => Promise<void>) {
  const before = (await events()).filter((e) => e.type === 'export.created').length;
  await dash.goto(`chrome-extension://${extId}/dashboard.html#/case/${caseId}`);
  await dash.getByRole('tab', { name: 'Export & verify' }).click();
  if (select) await select(dash);
  else await dash.getByRole('button', { name: 'Export case' }).click();
  await dash.getByText('Export saved as').waitFor({ timeout: 90_000 });
  const ev = (await events()).filter((e) => e.type === 'export.created');
  expect(ev.length).toBe(before + 1);
  return ev.at(-1)!;
}

beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'evicap-e2e-export-'));
  work = mkdtempSync(join(tmpdir(), 'evicap-e2e-export-files-'));
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: BROWSER,
    headless: true,
    acceptDownloads: true,
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
  base = await startServer();
  await rpc('activateLicence', await testLicenceKey()); // exhibit-only export is Pro

  ({ id: caseId } = await rpc<{ id: string }>('createCase', { name: 'Export case', reference: 'EX/1', investigator: 'A. Tester', autoCapture: false }));
  await rpc('setActiveCase', caseId);
  await rpc('setRecording', true);
  const tab = await ctx.newPage();
  for (const p of ['/one', '/two', '/three']) {
    await tab.goto(`${base}${p}`);
    await tab.bringToFront();
    const tabId = (await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, `${base}${p}`))!;
    await rpc('screenshot', 'visible', tabId);
    if (p === '/two') await rpc('forensicCapture', false, tabId);
  }
  const caps = (await idbAll<CaptureRecord>('captures')).filter((c) => c.caseId === caseId);
  const one = caps.find((c) => c.url.endsWith('/one'))!;
  await rpc('addNote', caseId, 'capture', one.id, 'Note on exhibit one');
  await rpc('setTag', caseId, 'capture', one.id, 'key', true);
  await rpc('setRecording', false);
});

afterAll(async () => {
  await ctx?.close();
  server?.close();
  // EVICAP_KEEP=1 keeps the exported files for inspection.
  if (process.env.EVICAP_KEEP) console.log('Export files kept in', work);
  for (const d of process.env.EVICAP_KEEP ? [profile] : [profile, work]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* locked briefly */
    }
  }
});

describe('Export and verification', () => {
  let zipPath = '';
  let zip: Buffer;

  it('exports the whole case as a signed ZIP with a report, a PDF and the verifier', async () => {
    const ev = await exportViaUi();
    const p = ev.payload as Record<string, any>;
    expect(p.kind).toBe('case');
    expect(p.fileName).toMatch(/^EviCap_EX-1_\d{8}T\d{6}Z\.zip$/);
    zip = await opfsFile(p.path);
    expect(zip.length).toBe(p.bytes);
    expect(await sha256(new Uint8Array(zip))).toBe(p.sha256);
    zipPath = join(work, p.fileName);
    writeFileSync(zipPath, zip);

    const blob = blobOf(zip);
    const names = (await readZipEntries(blob)).map((e) => e.name);
    for (const n of ['manifest.json', 'manifest.sig', 'public-key.jwk', 'audit-log.jsonl', 'visits.csv', 'visits.json', 'notes.json', 'case.json', 'captures.json', 'report.html', 'report.pdf', 'verify.html'])
      expect(names).toContain(n);
    const manifest = JSON.parse((await entryText(blob, 'manifest.json'))!) as ExportManifest;
    expect(manifest.captures).toHaveLength(4); // three screenshots and one forensic capture
    expect(manifest.reportPdf).toBe('included');
    expect(names.filter((n) => n.endsWith('/page.wacz'))).toHaveLength(1);

    const pdf = (await zipEntryBlob(blob, (await readZipEntries(blob)).find((e) => e.name === 'report.pdf')!)).slice(0, 5);
    expect(await pdf.text()).toBe('%PDF-');
    const report = (await entryText(blob, 'report.html'))!;
    expect(report).toContain('Export case');
    expect(report).toContain('A. Tester');
    expect(report).toContain('EV-004');
    expect(report).toContain('Note on exhibit one');
    expect(report).toContain('data:image/jpeg;base64');
    expect(report).not.toMatch(/<script/i);
    const csv = (await entryText(blob, 'visits.csv'))!;
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(4);

    // The same checks verify.html runs, here in Node.
    const r = await verifyBundle(await zipSource(blob));
    expect(r.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('verify.html opened from disk passes the export and catches tampering', async () => {
    const verifyPath = join(work, 'verify.html');
    writeFileSync(verifyPath, (await entryText(blobOf(zip), 'verify.html'))!);
    const page = await ctx.newPage();
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(pathToFileURL(verifyPath).href);
    await page.locator('#zip').setInputFiles(zipPath);
    await page.waitForFunction(() => document.body.dataset.result, null, { timeout: 60_000 });
    expect(await page.evaluate(() => document.body.dataset.result)).toBe('pass');
    expect(await page.locator('.verdict').textContent()).toContain('Verified');

    // Change one byte inside a capture's screenshot.
    const blob = blobOf(zip);
    const entry = (await readZipEntries(blob)).find((e) => e.name.endsWith('/screenshot.png'))!;
    const h = zip.subarray(entry.headerOffset, entry.headerOffset + 30);
    const dataStart = entry.headerOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    const tampered = Buffer.from(zip);
    const at = dataStart + Math.floor(entry.size / 2);
    tampered[at] = tampered[at]! ^ 0xff;
    const tamperedPath = join(work, 'tampered.zip');
    writeFileSync(tamperedPath, tampered);
    await page.evaluate(() => delete document.body.dataset.result);
    await page.locator('#zip').setInputFiles(tamperedPath);
    await page.waitForFunction(() => document.body.dataset.result, null, { timeout: 60_000 });
    expect(await page.evaluate(() => document.body.dataset.result)).toBe('fail');
    const text = (await page.locator('#result').textContent())!;
    expect(text).toContain('1 of');
    expect(text).toContain(entry.name);
    expect(requests.every((u) => u.startsWith('file:'))).toBe(true);
    await page.close();
  });

  it('exports selected exhibits with unrelated audit details left out', async () => {
    const ev = await exportViaUi(async (page) => {
      await page.getByLabel('Selected exhibits').check();
      await page.getByLabel('Include EV-001').check();
      await page.getByRole('button', { name: 'Export 1 exhibit' }).click();
    });
    const p = ev.payload as Record<string, any>;
    expect(p.kind).toBe('exhibits');
    expect(p.captureIds).toHaveLength(1);
    const blob = blobOf(await opfsFile(p.path));
    const manifest = JSON.parse((await entryText(blob, 'manifest.json'))!) as ExportManifest;
    expect(manifest.kind).toBe('exhibits');
    expect(manifest.captures.map((c) => c.exhibit)).toEqual(['EV-001']);
    expect(manifest.auditHead.redactedEvents).toBeGreaterThan(0);
    const log = (await entryText(blob, 'audit-log.jsonl'))!;
    expect(log).not.toContain('/three');
    expect(log).toContain('/one');
    const r = await verifyBundle(await zipSource(blob));
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.label === 'Audit chain')!.detail).toContain('left out');
  });

  it('checks an export and the live case from the dashboard, and logs each check', async () => {
    await dash.goto(`chrome-extension://${extId}/dashboard.html#/verify`);
    await dash.locator('input[type=file][accept]').setInputFiles(zipPath);
    await dash.getByText('Verified: every file matches').waitFor({ timeout: 60_000 });
    await dash.getByText('recorded in the audit log of the case').waitFor();

    await dash.goto(`chrome-extension://${extId}/dashboard.html#/case/${caseId}`);
    await dash.getByRole('tab', { name: 'Export & verify' }).click();
    await dash.getByRole('button', { name: 'Check every file' }).click();
    await dash.getByText(/Verified: \d+ files match/).waitFor({ timeout: 60_000 });
    const runs = (await events()).filter((e) => e.type === 'verify.run');
    expect(runs.map((e) => (e.payload as { scope: string; ok: boolean }).scope)).toEqual(['bundle', 'case']);
    expect(runs.every((e) => (e.payload as { ok: boolean }).ok)).toBe(true);
    await expect.poll(() => dash.getByText('Previous exports').count()).toBe(1);
    expect(await dash.getByRole('button', { name: 'Save again' }).count()).toBe(2);
  });

  it('reads back as a standard ZIP', () => {
    // The ZIP is ordinary (no ZIP64 needed at this size), so any tool can open it.
    expect(readFileSync(zipPath).readUInt32LE(0)).toBe(0x04034b50);
  });
});
