import { appendEventLocked, withCaseLock } from './audit';
import { getDb } from './db';
import { getEnvironment } from './environment';
import { sha256, sha256Blob, sha256Json } from './hash';
import { canonicalize } from './jcs';
import { signJson } from './keys';
import { isMirrorEnabled } from './mirror-queue';
import { capturePath, storageStatus, writeFile } from './opfs';
import type { CaptureFile, CaptureManifest, CaptureRecord, CaptureType, MirrorJob } from './types';
import { nowUtc, uuid } from './util';

export interface NewCaptureFile {
  path: string;
  data: Uint8Array | Blob;
  mime: string;
  role: string;
}

export interface NewCapture {
  caseId: string;
  type: CaptureType;
  method: string;
  url: string;
  title: string;
  startedAtUtc: string;
  files: NewCaptureFile[];
  degraded?: string[];
  parent?: string | null;
  meta?: Record<string, unknown>;
}

export class StorageFullError extends Error {
  constructor() {
    super('Storage is 95% full. Free up space or export and delete old cases before capturing more.');
  }
}

/**
 * Store a capture (SPEC §6, §7). Order matters for integrity:
 *  1. a `pending` record is written, so an interrupted capture is visible later
 *  2. each file is hashed, then the same bytes are written to OPFS
 *  3. the manifest is built, hashed (the capture hash) and signed
 *  4. the `capture.created` audit event and the `complete` record are committed
 *     in one transaction, with mirror jobs if the disk mirror is on
 * The capture appears in the UI only after step 4.
 */
export async function storeCapture(input: NewCapture): Promise<CaptureRecord> {
  if ((await storageStatus()).level === 'block') throw new StorageFullError();

  const db = await getDb();
  const id = uuid();
  const pending: CaptureRecord = {
    id,
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

  const files: CaptureFile[] = [];
  for (const f of input.files) {
    const hash = f.data instanceof Blob ? await sha256Blob(f.data) : await sha256(f.data);
    await writeFile(capturePath(input.caseId, id, f.path), f.data);
    const bytes = f.data instanceof Blob ? f.data.size : f.data.byteLength;
    files.push({ path: f.path, bytes, sha256: hash, mime: f.mime, role: f.role });
  }

  const manifest: CaptureManifest = {
    schema: 'evicap.capture/1',
    captureId: id,
    caseId: input.caseId,
    type: input.type,
    method: input.method,
    degraded: pending.degraded,
    url: input.url,
    title: input.title,
    startedAtUtc: input.startedAtUtc,
    completedAtUtc: nowUtc(),
    environment: await getEnvironment(),
    files,
    parent: pending.parent,
    meta: pending.meta,
  };
  const captureHash = await sha256Json(manifest);
  const signature = await signJson(manifest);
  const manifestText = canonicalize(manifest);
  await writeFile(capturePath(input.caseId, id, 'manifest.json'), new TextEncoder().encode(manifestText));
  await writeFile(capturePath(input.caseId, id, 'manifest.sig'), new TextEncoder().encode(signature));

  const mirrorOn = await isMirrorEnabled();
  return withCaseLock(input.caseId, async () => {
    const c = await db.get('cases', input.caseId);
    if (!c) throw new Error('Case not found');
    let record: CaptureRecord | null = null;
    await appendEventLocked(
      input.caseId,
      pending.parent ? 'artefact.derived' : 'capture.created',
      {
        captureId: id,
        type: input.type,
        method: input.method,
        url: input.url,
        parent: pending.parent,
        captureHash,
        files: files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
        degraded: pending.degraded,
      },
      {
        stores: ['captures'],
        alsoWrite(tx, event) {
          record = {
            ...pending,
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
export async function markInterruptedCaptures(): Promise<number> {
  const db = await getDb();
  const pending = await db.getAllFromIndex('captures', 'byStatus', 'pending');
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
