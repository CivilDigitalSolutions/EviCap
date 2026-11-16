/**
 * Artefact bytes live in the Origin Private File System (SPEC §5.2):
 *   cases/<caseId>/captures/<captureId>/<file>
 */

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

function splitPath(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) throw new Error(`Invalid path ${path}`);
  return parts;
}

async function dirFor(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = await root();
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return dir;
}

export function capturePath(caseId: string, captureId: string, file: string): string {
  return `cases/${caseId}/captures/${captureId}/${file}`;
}

export async function writeFile(path: string, data: Blob | Uint8Array | ArrayBuffer): Promise<void> {
  const parts = splitPath(path);
  const name = parts.pop()!;
  const dir = await dirFor(parts, true);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data as FileSystemWriteChunkType);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => undefined);
    throw err;
  }
}

export async function readFile(path: string): Promise<File> {
  const parts = splitPath(path);
  const name = parts.pop()!;
  const dir = await dirFor(parts, false);
  return (await dir.getFileHandle(name)).getFile();
}

export async function removePath(path: string): Promise<void> {
  const parts = splitPath(path);
  const name = parts.pop()!;
  try {
    const dir = await dirFor(parts, false);
    await dir.removeEntry(name, { recursive: true });
  } catch (err) {
    if ((err as DOMException)?.name !== 'NotFoundError') throw err;
  }
}

export interface StorageStatus {
  usage: number;
  quota: number;
  ratio: number;
  persisted: boolean;
  level: 'ok' | 'warn' | 'block';
}

/** Warn at 80% of available space; block new captures at 95% (SPEC §5.2). */
export async function storageStatus(): Promise<StorageStatus> {
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  const ratio = quota > 0 ? usage / quota : 0;
  return { usage, quota, ratio, persisted, level: ratio >= 0.95 ? 'block' : ratio >= 0.8 ? 'warn' : 'ok' };
}
