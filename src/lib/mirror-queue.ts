import { getMeta } from './db';

/**
 * Disk mirror (SPEC §5.2). The service worker queues jobs in IndexedDB inside
 * the same transactions that create the data. The offscreen document drains
 * the queue into the folder the user picked, re-hashing every copied file.
 *
 * Meta keys:
 *   mirrorDir     FileSystemDirectoryHandle chosen by the user
 *   mirrorStatus  MirrorStatus, written by the offscreen document
 */

export interface MirrorStatus {
  state: 'off' | 'ok' | 'working' | 'needs-permission' | 'error';
  folderName: string | null;
  lastWriteUtc: string | null;
  lastError: string | null;
  queued: number;
}

export const MIRROR_OFF: MirrorStatus = {
  state: 'off',
  folderName: null,
  lastWriteUtc: null,
  lastError: null,
  queued: 0,
};

let enabledCache: { value: boolean; at: number } | null = null;

export async function isMirrorEnabled(): Promise<boolean> {
  if (enabledCache && Date.now() - enabledCache.at < 2000) return enabledCache.value;
  const dir = await getMeta<FileSystemDirectoryHandle>('mirrorDir');
  enabledCache = { value: !!dir, at: Date.now() };
  return enabledCache.value;
}

export function invalidateMirrorCache() {
  enabledCache = null;
}

type Notifier = () => void;
let notifier: Notifier = () => undefined;

/** The service worker installs a notifier that wakes the offscreen document. */
export function setMirrorNotifier(fn: Notifier) {
  notifier = fn;
}

export function notifyMirror() {
  try {
    notifier();
  } catch {
    /* best effort; the queue is drained again on the next kick */
  }
}

/** Make a safe, readable folder name, e.g. `EviCap_OP-HAWK_Smith-profile_1a2b3c4d`. */
export function mirrorFolderName(name: string, reference: string, id: string): string {
  const slug = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40);
  const parts = ['EviCap', slug(reference), slug(name), id.slice(0, 8)].filter(Boolean);
  return parts.join('_');
}
