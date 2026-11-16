import verifierHtml from 'virtual:evicap-verifier';
import type { ExportedEvent } from './chain';
import { getCase, listAudit, listCaptures, listNotes, listVisits } from './db';
import { getEnvironment } from './environment';
import { createStreamingSha256, sha256Blob, sha256Json, type Sha256 } from './hash';
import { getInstallKey, signJson } from './keys';
import { rpc } from './messages';
import { isPro, proRequired } from './plan';
import { capturePath, openWritable, readFile, removePath, writeFile } from './opfs';
import { buildReportHtml, type ReportExhibit } from './report';
import type { AuditEvent, CaptureRecord, VisitRecord } from './types';
import { nowUtc, uuid } from './util';
import type { ExportManifest } from '../verifier/core';
import { ZipWriter } from './zip';

/**
 * Case and exhibit export (SPEC F10). Runs in the dashboard: it reads the case
 * from IndexedDB and OPFS, streams a stored ZIP into OPFS under exports/, signs
 * the export manifest, and asks the service worker to print the report to PDF
 * and to record the `export.created` audit event with the ZIP's own hash.
 */

export interface ExportProgress {
  stage: string;
  done: number;
  total: number;
}

export interface ExportResult {
  exportId: string;
  fileName: string;
  path: string;
  bytes: number;
  sha256: Sha256;
  reportPdf: string;
}

/** Stable exhibit numbers for a case: top-level captures in time order (EV-001), children lettered (EV-001a). */
export function exhibitNumbers(all: CaptureRecord[]): Map<string, string> {
  const sorted = [...all].sort((a, b) => a.startedAtUtc.localeCompare(b.startedAtUtc) || a.id.localeCompare(b.id));
  const ids = new Set(all.map((c) => c.id));
  const out = new Map<string, string>();
  let n = 0;
  for (const c of sorted) if (!c.parent || !ids.has(c.parent)) out.set(c.id, `EV-${String(++n).padStart(3, '0')}`);
  const childCount = new Map<string, number>();
  for (const c of sorted) {
    if (!c.parent || !out.has(c.parent)) continue;
    const k = childCount.get(c.parent) ?? 0;
    childCount.set(c.parent, k + 1);
    out.set(c.id, `${out.get(c.parent)}${String.fromCharCode(97 + (k % 26))}${k >= 26 ? Math.floor(k / 26) : ''}`);
  }
  return out;
}

/** CSV cell: quoted, with a leading apostrophe on values a spreadsheet would run as a formula. */
function cell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function visitsCsv(visits: VisitRecord[]): string {
  const cols = [
    'seq',
    'navigatedAtUtc',
    'leftAtUtc',
    'focusedSeconds',
    'title',
    'url',
    'finalUrl',
    'redirectChain',
    'transitionType',
    'referrer',
    'inPage',
    'incognito',
    'tags',
    'autoCaptureId',
    'visitId',
    'auditEventHash',
  ];
  const rows = visits.map((v) =>
    [
      v.seq + 1,
      v.navigatedAtUtc,
      v.leftAtUtc,
      v.leftAtUtc ? Math.round(v.focusedMs / 1000) : '',
      v.title,
      v.url,
      v.finalUrl,
      v.redirectChain.join(' -> '),
      v.transitionType,
      v.referrer,
      v.spa,
      v.incognito,
      v.tags.join('; '),
      v.autoCaptureId,
      v.id,
      v.auditEventHash,
    ]
      .map(cell)
      .join(','),
  );
  return '﻿' + [cols.join(','), ...rows].join('\r\n') + '\r\n';
}

/**
 * For an exhibit-only export, keep full details only for events about the
 * chosen captures (and the case itself); leave out the payload of every other
 * event. Its payloadHash stays, so the chain still verifies.
 */
export function redactEvents(events: AuditEvent[], keep: { captures: Set<string>; visits: Set<string>; notes: Set<string> }): ExportedEvent[] {
  return events.map((e) => {
    const p = e.payload as Record<string, unknown>;
    const related =
      e.type.startsWith('case.') ||
      e.type.startsWith('recording.') ||
      e.type === 'export.created' ||
      e.type === 'mirror.connected' ||
      e.type === 'licence.changed' ||
      e.type === 'clock.anomaly' ||
      (typeof p.captureId === 'string' && keep.captures.has(p.captureId)) ||
      (typeof p.visitId === 'string' && keep.visits.has(p.visitId)) ||
      (typeof p.noteId === 'string' && keep.notes.has(p.noteId)) ||
      (typeof p.targetId === 'string' && (keep.captures.has(p.targetId) || keep.visits.has(p.targetId)));
    return related ? e : { ...e, payload: null, redacted: true as const };
  });
}

async function thumbnail(blob: Blob): Promise<string | null> {
  if (blob.size > 80 * 1024 * 1024) return null;
  try {
    const bmp = await createImageBitmap(blob);
    const w = Math.min(480, bmp.width);
    const scale = w / bmp.width;
    const srcH = Math.min(bmp.height, Math.round((w * 1.3) / scale)); // tall pages: the top part
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(bmp, 0, 0, bmp.width, srcH, 0, 0, w, h);
    bmp.close();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.78 });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

function previewFile(c: CaptureRecord, children: CaptureRecord[]) {
  const img = (x: CaptureRecord) => x.files.find((f) => f.mime.startsWith('image/') && (f.role === 'primary' || f.role === 'screenshot' || f.role === 'poster'));
  const own = img(c);
  if (own) return { c, f: own };
  for (const ch of children) {
    const f = img(ch);
    if (f) return { c: ch, f };
  }
  return null;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'case';

/** Ask the browser whether there is room for a copy of the export. */
async function checkSpace(needed: number) {
  const est = await navigator.storage.estimate();
  const free = (est.quota ?? Infinity) - (est.usage ?? 0);
  if (free < needed * 1.05 + 50 * 1024 * 1024) {
    throw new Error(`Not enough storage for this export: it needs about ${Math.ceil(needed / 1024 ** 2)} MB free. Free up disk space, or export selected exhibits only.`);
  }
}

export async function exportCase(
  caseId: string,
  opts: { captureIds?: string[] } = {},
  onProgress: (p: ExportProgress) => void = () => undefined,
): Promise<ExportResult> {
  const c = await getCase(caseId);
  if (!c) throw new Error('Case not found');
  const kind: ExportManifest['kind'] = opts.captureIds ? 'exhibits' : 'case';
  if (kind === 'exhibits' && !(await isPro())) throw proRequired('exhibitExport');
  onProgress({ stage: 'Reading the case', done: 0, total: 1 });
  const [allCaptures, allVisits, allNotes, events, key, environment] = await Promise.all([
    listCaptures(caseId),
    listVisits(caseId),
    listNotes(caseId),
    listAudit(caseId),
    getInstallKey(),
    getEnvironment(),
  ]);
  const numbers = exhibitNumbers(allCaptures);

  // What goes in.
  let captures = allCaptures;
  if (opts.captureIds) {
    const chosen = new Set(opts.captureIds);
    for (const x of allCaptures) if (x.parent && chosen.has(x.parent)) chosen.add(x.id);
    captures = allCaptures.filter((x) => chosen.has(x.id));
    if (!captures.length) throw new Error('Choose at least one capture to export');
  }
  captures.sort((a, b) => a.startedAtUtc.localeCompare(b.startedAtUtc));
  const capIds = new Set(captures.map((x) => x.id));
  const visitIds = new Set(
    captures.flatMap((x) => [x.meta.visitId, ...allVisits.filter((v) => v.autoCaptureId === x.id).map((v) => v.id)]).filter((v): v is string => typeof v === 'string'),
  );
  const visits = kind === 'case' ? allVisits : allVisits.filter((v) => visitIds.has(v.id));
  const notes = allNotes.filter(
    (n) => kind === 'case' || (n.targetKind === 'capture' && capIds.has(n.targetId)) || (n.targetKind === 'visit' && visitIds.has(n.targetId)),
  );
  const exportedEvents: ExportedEvent[] =
    kind === 'case' ? events : redactEvents(events, { captures: capIds, visits: visitIds, notes: new Set(notes.map((n) => n.id)) });
  const redactedEvents = exportedEvents.filter((e) => e.redacted).length;
  const head = events.at(-1);

  const exportId = uuid();
  const createdAtUtc = nowUtc();
  const stamp = createdAtUtc.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const fileName = `EviCap_${safeName(c.reference || c.name)}_${kind === 'exhibits' ? 'exhibits_' : ''}${stamp}.zip`;
  const dir = `exports/${exportId}`;
  const zipPath = `${dir}/${fileName}`;

  // Each capture's files, plus its signed manifest.
  const captureFiles: { path: string; src: () => Promise<Blob> }[] = [];
  let totalBytes = 0;
  for (const x of captures) {
    if (x.deleted) continue;
    const names = [...x.files.map((f) => f.path), ...(x.status === 'complete' ? ['manifest.json', 'manifest.sig'] : [])];
    for (const name of names) {
      const p = capturePath(caseId, x.id, name);
      captureFiles.push({ path: `captures/${x.id}/${name}`, src: () => readFile(p) });
    }
    totalBytes += x.files.reduce((n, f) => n + f.bytes, 0);
  }
  await checkSpace(totalBytes);

  // Report, with previews.
  const exhibits: ReportExhibit[] = [];
  let i = 0;
  for (const x of captures) {
    onProgress({ stage: 'Preparing the report', done: i++, total: captures.length });
    const children = captures.filter((ch) => ch.parent === x.id);
    const pv = x.deleted ? null : previewFile(x, children);
    const thumb = pv ? await thumbnail(await readFile(capturePath(caseId, pv.c.id, pv.f.path)).catch(() => new Blob())) : null;
    exhibits.push({
      exhibit: numbers.get(x.id) ?? '?',
      capture: x,
      thumb,
      notes: notes.filter((n) => n.targetKind === 'capture' && n.targetId === x.id),
      parentExhibit: x.parent ? (numbers.get(x.parent) ?? null) : null,
    });
  }
  const eventCounts: Record<string, number> = {};
  for (const e of events) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
  const version = chrome.runtime.getManifest().version;
  const software = { name: 'EviCap', version };
  const reportHtml = buildReportHtml({
    exportId,
    kind,
    createdAtUtc,
    software,
    environment,
    case: c,
    fingerprint: key.fingerprint,
    auditHead: { seq: head?.seq ?? -1, hash: head?.hash ?? null },
    auditEvents: events.length,
    redactedEvents,
    eventCounts,
    exhibits,
    visits,
    caseNotes: notes.filter((n) => n.targetKind === 'case'),
  });
  await writeFile(`${dir}/report.html`, new TextEncoder().encode(reportHtml));

  onProgress({ stage: 'Printing the report to PDF', done: 0, total: 1 });
  let reportPdf = 'included';
  let pdf: Blob | null = null;
  try {
    await rpc('printReportPdf', `${dir}/report.html`, `${dir}/report.pdf`);
    pdf = await readFile(`${dir}/report.pdf`);
  } catch (err) {
    reportPdf = `not included: ${(err as Error).message}. Open report.html and print it to PDF from the browser.`;
  }

  // The ZIP.
  const writable = await openWritable(zipPath);
  let buf: Uint8Array[] = [];
  let bufBytes = 0;
  const flush = async () => {
    if (!bufBytes) return;
    const all = new Uint8Array(bufBytes);
    let o = 0;
    for (const b of buf) all.set(b, o), (o += b.length);
    buf = [];
    bufBytes = 0;
    await writable.write(all);
  };
  const zip = new ZipWriter(async (chunk) => {
    buf.push(chunk.slice());
    bufBytes += chunk.length;
    if (bufBytes >= 4 * 1024 * 1024) await flush();
  });
  const listed: ExportManifest['files'] = [];
  const add = async (path: string, data: Blob | Uint8Array | string) => {
    const h = await createStreamingSha256();
    const body = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const { bytes } = await zip.add(path, body, (ch) => h.update(ch));
    listed.push({ path, bytes, sha256: h.digest() });
  };
  const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

  try {
    const done = { n: 0 };
    const total = captureFiles.length + 10;
    const step = (stage: string) => onProgress({ stage, done: done.n++, total });
    step('Writing the case files');
    await add('case.json', json(c));
    await add('captures.json', json(captures.map((x) => ({ exhibit: numbers.get(x.id) ?? null, ...x }))));
    await add('visits.json', json(visits));
    await add('visits.csv', visitsCsv(visits));
    await add('notes.json', json(notes));
    await add('audit-log.jsonl', exportedEvents.map((e) => JSON.stringify(e)).join('\n') + (exportedEvents.length ? '\n' : ''));
    await add('public-key.jwk', json(key.publicJwk));
    for (const f of captureFiles) {
      step(`Adding ${f.path}`);
      await add(f.path, await f.src());
    }
    step('Adding the report and verifier');
    await add('report.html', reportHtml);
    if (pdf) await add('report.pdf', pdf);
    await add('verify.html', verifierHtml);

    const manifest: ExportManifest = {
      schema: 'evicap.export/1',
      exportId,
      kind,
      createdAtUtc,
      software,
      environment: environment as unknown as Record<string, unknown>,
      case: { id: c.id, name: c.name, reference: c.reference, investigator: c.investigator, organisation: c.organisation, status: c.status },
      publicKey: { file: 'public-key.jwk', fingerprint: key.fingerprint },
      auditHead: { seq: head?.seq ?? -1, hash: head?.hash ?? null, redactedEvents },
      captures: captures
        .filter((x) => x.status === 'complete' && !x.deleted)
        .map((x) => ({ id: x.id, exhibit: numbers.get(x.id) ?? '?', captureHash: x.captureHash })),
      reportPdf,
      files: listed,
    };
    step('Signing');
    const signature = await signJson(manifest);
    await zip.add('manifest.json', new TextEncoder().encode(json(manifest)));
    await zip.add('manifest.sig', new TextEncoder().encode(signature + '\n'));
    await zip.finish();
    await flush();
    await writable.close();

    onProgress({ stage: 'Hashing the export', done: 0, total: 1 });
    const file = await readFile(zipPath);
    const sha256 = await sha256Blob(file);
    await rpc('recordExport', caseId, {
      exportId,
      kind,
      fileName,
      path: zipPath,
      bytes: file.size,
      sha256,
      manifestHash: await sha256Json(manifest),
      captureIds: manifest.captures.map((x) => x.id),
      reportPdf: pdf ? 'included' : 'not included',
    });
    return { exportId, fileName, path: zipPath, bytes: file.size, sha256, reportPdf };
  } catch (err) {
    await writable.abort().catch(() => undefined);
    await removePath(dir).catch(() => undefined);
    throw err;
  } finally {
    await removePath(`${dir}/report.html`).catch(() => undefined);
    await removePath(`${dir}/report.pdf`).catch(() => undefined);
  }
}

/** Save a stored export to the user's computer (a normal browser download). */
export async function downloadExport(path: string, fileName: string) {
  const file = await readFile(path);
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function exportExists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}
