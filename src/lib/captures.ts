import { appendEventLocked, withCaseLock } from './audit';
import { getDb } from './db';
import { getEnvironment } from './environment';
import { createStreamingSha256, sha256, sha256Blob, sha256Json, type Sha256 } from './hash';
import { canonicalize } from './jcs';
import { signJson } from './keys';
import { isMirrorEnabled } from './mirror-queue';
import { capturePath, readFile, storageStatus, writeFile, writeStream } from './opfs';
import type { CaptureFile, CaptureManifest, CaptureRecord, CaptureType, MirrorJob } from './types';
import { nowUtc, uuid } from './util';

export type NewCaptureData =
  | Uint8Array
  | Blob
  /** Streamed: hashed incrementally while it is written (large video, SPEC F7-A). */
  | { stream: ReadableStream<Uint8Array>; onProgress?: (bytes: number) => void }
  /**
   * Already written to this capture's folder by another context (a tab
   * recording from the offscreen document). It is re-hashed here; if that
   * context also hashed it, the two must match.
   */
  | { prewritten: true; expectSha256?: Sha256 };

export interface NewCaptureFile {
  path: string;
  data: NewCaptureData;
  mime: string;
  role: string;
}

export interface CaptureHeader {
  /** Pre-assigned id, when files are written before the capture is stored. */
  id?: string;
  caseId: string;
  type: CaptureType;
  method: string;
  url: string;
  title: string;
  startedAtUtc: string;
  degraded?: string[];
  parent?: string | null;
  meta?: Record<string, unknown>;
}

export interface NewCapture extends CaptureHeader {
  files: NewCaptureFile[];
}

export class StorageFullError extends Error {
  constructor() {
    super('Storage is 95% full. Free up space or export and delete old cases before capturing more.');
  }
}

/** Store a capture in one go: begin, write the files, complete. */
export async function storeCapture(input: NewCapture): Promise<CaptureRecord> {
  const pending = await beginCapture(input);
  try {
    return await completeCapture(pending, input.files);
  } catch (err) {
    await failCapture(pending, (err as Error)?.message ?? String(err));
    throw err;
  }
}

/**
 * Step 1 (SPEC §6, §7): write a `pending` record, so an interrupted capture
 * is visible later. Long captures (downloads, tab recordings) stay pending
 * while they run.
 */
export async function beginCapture(input: CaptureHeader): Promise<CaptureRecord> {
  if ((await storageStatus()).level === 'block') throw new StorageFullError();
  const db = await getDb();
  const pending: CaptureRecord = {
    id: input.id ?? uuid(),
    caseId: input.caseId,
    type: input.type,
    method: input.method,
    status: 'pending',
    url: input.url,
    title: input.title,
    startedAtUtc: input.startedAtUtc,
    completedAtUtc: null,
    files: [],
    degraded: input.degraded ?? [],
    parent: input.parent ?? null,
    meta: input.meta ?? {},
    tags: [],
    captureHash: null,
    signature: null,
    auditEventHash: null,
    deleted: null,
  };
  await db.put('captures', pending);
  return pending;
}

/** Hash and write one file. Streamed data is hashed chunk by chunk as it is written. */
async function writeCaptureFile(caseId: string, captureId: string, f: NewCaptureFile): Promise<CaptureFile> {
  const path = capturePath(caseId, captureId, f.path);
  const d = f.data;
  if (d instanceof Uint8Array || d instanceof Blob) {
    const hash = d instanceof Blob ? await sha256Blob(d) : await sha256(d);
    await writeFile(path, d);
    return { path: f.path, bytes: d instanceof Blob ? d.size : d.byteLength, sha256: hash, mime: f.mime, role: f.role };
  }
  if ('prewritten' in d) {
    const file = await readFile(path);
    const hash = await sha256Blob(file);
    if (d.expectSha256 && d.expectSha256 !== hash) {
      throw new Error(`${f.path} changed after it was written (hash mismatch)`);
    }
    return { path: f.path, bytes: file.size, sha256: hash, mime: f.mime, role: f.role };
  }
  const h = await createStreamingSha256();
  await writeStream(path, d.stream, (chunk) => {
    h.update(chunk);
    d.onProgress?.(h.bytes);
  });
  return { path: f.path, bytes: h.bytes, sha256: h.digest(), mime: f.mime, role: f.role };
}

/**
 * Steps 2-4: hash and write each file; build, hash and sign the manifest; then
 * commit the `capture.created` audit event and the `complete` record in one
 * transaction, with mirror jobs if the disk mirror is on. The capture appears
 * in the UI only after this.
 */
export async function completeCapture(
  pending: CaptureRecord,
  inputFiles: NewCaptureFile[],
  patch: { degraded?: string[]; meta?: Record<string, unknown>; title?: string; url?: string } = {},
): Promise<CaptureRecord> {
  const db = await getDb();
  const { id, caseId } = pending;
  const files: CaptureFile[] = [];
  for (const f of inputFiles) files.push(await writeCaptureFile(caseId, id, f));
  const header: CaptureRecord = {
    ...pending,
    degraded: patch.degraded ?? pending.degraded,
    meta: patch.meta ?? pending.meta,
    title: patch.title ?? pending.title,
    url: patch.url ?? pending.url,
  };

  const manifest: CaptureManifest = {
    schema: 'evicap.capture/1',
    captureId: id,
    caseId,
    type: header.type,
    method: header.method,
    degraded: header.degraded,
    url: header.url,
    title: header.title,
    startedAtUtc: header.startedAtUtc,
    completedAtUtc: nowUtc(),
    environment: await getEnvironment(),
    files,
    parent: header.parent,
    meta: header.meta,
  };
  const captureHash = await sha256Json(manifest);
  const signature = await signJson(manifest);
  const manifestText = canonicalize(manifest);
  await writeFile(capturePath(caseId, id, 'manifest.json'), new TextEncoder().encode(manifestText));
  await writeFile(capturePath(caseId, id, 'manifest.sig'), new TextEncoder().encode(signature));

  const mirrorOn = await isMirrorEnabled();
  return withCaseLock(caseId, async () => {
    const c = await db.get('cases', caseId);
    if (!c) throw new Error('Case not found');
    let record: CaptureRecord | null = null;
    await appendEventLocked(
      caseId,
      header.parent ? 'artefact.derived' : 'capture.created',
      {
        captureId: id,
        type: header.type,
        method: header.method,
        url: header.url,
        parent: header.parent,
        captureHash,
        files: files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
        degraded: header.degraded,
      },
      {
        stores: ['captures'],
        alsoWrite(tx, event) {
          record = {
            ...header,
            status: 'complete',
            completedAtUtc: manifest.completedAtUtc,
            files,
            captureHash,
            signature,
            auditEventHash: event.hash,
          };
          void tx.objectStore('captures').put(record);
          if (mirrorOn) {
            const q = tx.objectStore('mirrorQueue');
            for (const job of captureMirrorJobs(c.mirrorFolder, record)) void q.add(job);
          }
        },
      },
    );
    return record!;
  });
}

/** A capture that failed part-way is marked `incomplete` and logged with the reason. */
export async function failCapture(pending: CaptureRecord, reason: string): Promise<void> {
  await withCaseLock(pending.caseId, async () => {
    const db = await getDb();
    const current = await db.get('captures', pending.id);
    if (!current || current.status !== 'pending') return;
    await appendEventLocked(
      pending.caseId,
      'capture.incomplete',
      { captureId: pending.id, type: pending.type, url: pending.url, reason },
      {
        stores: ['captures'],
        alsoWrite(tx) {
          void tx.objectStore('captures').put({ ...current, status: 'incomplete', degraded: [...current.degraded, reason] });
        },
      },
    );
  }).catch(() => undefined);
}

/** Mirror jobs that copy one capture's files, manifest and signature. */
export function captureMirrorJobs(mirrorFolder: string, capture: CaptureRecord): MirrorJob[] {
  const jobs: MirrorJob[] = capture.files.map((f) => ({
    caseId: capture.caseId,
    kind: 'copy',
    opfsPath: capturePath(capture.caseId, capture.id, f.path),
    destPath: `${mirrorFolder}/captures/${capture.id}/${f.path}`,
    sha256: f.sha256,
    attempts: 0,
  }));
  for (const name of ['manifest.json', 'manifest.sig']) {
    jobs.push({
      caseId: capture.caseId,
      kind: 'copy',
      opfsPath: capturePath(capture.caseId, capture.id, name),
      destPath: `${mirrorFolder}/captures/${capture.id}/${name}`,
      sha256: 'sha256:',
      attempts: 0,
    });
  }
  return jobs;
}

/**
 * On start-up, captures left `pending` by a killed service worker are marked
 * `incomplete` and logged, so the gap is visible (SPEC §13 Reliability).
 */
export async function markInterruptedCaptures(stillRunning: string[] = []): Promise<number> {
  const db = await getDb();
  const pending = (await db.getAllFromIndex('captures', 'byStatus', 'pending')).filter(
    (p) => !stillRunning.includes(p.id),
  );
  for (const p of pending) {
    await withCaseLock(p.caseId, () =>
      appendEventLocked(
        p.caseId,
        'capture.incomplete',
        { captureId: p.id, type: p.type, url: p.url, reason: 'interrupted before completion' },
        {
          stores: ['captures'],
          alsoWrite(tx) {
            void tx.objectStore('captures').put({ ...p, status: 'incomplete' });
          },
        },
      ).catch(() => undefined),
    );
  }
  return pending.length;
}
