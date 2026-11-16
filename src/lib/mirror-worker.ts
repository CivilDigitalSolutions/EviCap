import { getDb, getMeta, setMeta } from './db';
import { sha256Blob } from './hash';
import { broadcast } from './messages';
import { MIRROR_OFF, type MirrorStatus } from './mirror-queue';
import { readFile } from './opfs';
import type { MirrorJob } from './types';
import { nowUtc } from './util';

/**
 * Drains the mirror queue into the user's folder. Runs in a window context
 * (offscreen document or dashboard), where File System Access handles work.
 * Jobs are processed oldest first; a job is deleted only after it succeeds,
 * and copied files are re-hashed and compared with the recorded hash.
 */

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
};

async function dirFor(root: FileSystemDirectoryHandle, parts: string[]) {
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
  return dir;
}

async function fileHandle(root: FileSystemDirectoryHandle, path: string) {
  const parts = path.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) throw new Error(`Invalid path ${path}`);
  const name = parts.pop()!;
  return (await dirFor(root, parts)).getFileHandle(name, { create: true });
}

async function runJob(root: FileSystemDirectoryHandle, job: MirrorJob) {
  const handle = await fileHandle(root, job.destPath);
  if (job.kind === 'copy') {
    const src = await readFile(job.opfsPath);
    const w = await handle.createWritable();
    await w.write(src);
    await w.close();
    if (job.sha256.length > 'sha256:'.length) {
      const written = await sha256Blob(await handle.getFile());
      if (written !== job.sha256) throw new Error(`Hash mismatch after copying ${job.destPath}`);
    }
  } else if (job.kind === 'write') {
    const w = await handle.createWritable();
    await w.write(job.text);
    await w.close();
  } else {
    const size = (await handle.getFile()).size;
    const w = await handle.createWritable({ keepExistingData: true });
    await w.seek(size);
    await w.write(job.text);
    await w.close();
  }
}

let draining: Promise<void> | null = null;

export function drainMirror(): Promise<void> {
  draining ??= drain().finally(() => {
    draining = null;
  });
  return draining;
}

async function setStatus(patch: Partial<MirrorStatus>) {
  const prev = (await getMeta<MirrorStatus>('mirrorStatus')) ?? MIRROR_OFF;
  await setMeta('mirrorStatus', { ...prev, ...patch });
  broadcast({ scope: 'mirror' });
}

async function drain() {
  const root = await getMeta<DirHandle>('mirrorDir');
  if (!root) return setStatus({ ...MIRROR_OFF });
  const permission = await root.queryPermission({ mode: 'readwrite' });
  const db = await getDb();
  const queued = await db.count('mirrorQueue');
  if (permission !== 'granted') {
    return setStatus({ state: 'needs-permission', folderName: root.name, queued });
  }
  if (queued === 0) return setStatus({ state: 'ok', folderName: root.name, queued: 0, lastError: null });
  await setStatus({ state: 'working', folderName: root.name, queued });

  let done = 0;
  for (;;) {
    const cursor = await db.transaction('mirrorQueue').store.openCursor();
    if (!cursor) break;
    const job = cursor.value;
    try {
      await runJob(root, job);
      await db.delete('mirrorQueue', job.id!);
      done++;
      if (done % 25 === 0) await setStatus({ queued: await db.count('mirrorQueue'), lastWriteUtc: nowUtc() });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const notAllowed = (err as DOMException)?.name === 'NotAllowedError';
      if (notAllowed) {
        return setStatus({ state: 'needs-permission', queued: await db.count('mirrorQueue'), lastError: message });
      }
      if ((err as DOMException)?.name === 'NotFoundError' && job.kind === 'copy') {
        // The source is gone (e.g. deleted artefact); drop the job.
        await db.delete('mirrorQueue', job.id!);
        continue;
      }
      const attempts = job.attempts + 1;
      if (attempts >= 5) {
        // Don't let one bad file block the rest of the mirror; the error stays visible.
        await db.delete('mirrorQueue', job.id!);
        await setStatus({ lastError: `Gave up on ${job.destPath}: ${message}` });
        continue;
      }
      await db.put('mirrorQueue', { ...job, attempts });
      return setStatus({ state: 'error', queued: await db.count('mirrorQueue'), lastError: message });
    }
  }
  await setStatus({ state: 'ok', folderName: root.name, queued: 0, lastWriteUtc: nowUtc(), lastError: null });
}
