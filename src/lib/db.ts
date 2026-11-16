import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AuditEvent,
  CaptureRecord,
  CaseRecord,
  InstallKey,
  MirrorJob,
  NoteRecord,
  VisitRecord,
} from './types';

/** IndexedDB `evicap` database (SPEC §5.2). Artefact bytes live in OPFS, not here. */
export interface EviCapDB extends DBSchema {
  cases: { key: string; value: CaseRecord; indexes: { byStatus: string } };
  visits: { key: string; value: VisitRecord; indexes: { byCase: [string, number] } };
  captures: { key: string; value: CaptureRecord; indexes: { byCase: [string, string]; byStatus: string } };
  notes: { key: string; value: NoteRecord; indexes: { byCase: string; byTarget: [string, string] } };
  /** Append-only. There is no update or delete path in the data layer (§7.4). */
  audit: { key: [string, number]; value: AuditEvent };
  keys: { key: string; value: InstallKey };
  mirrorQueue: { key: number; value: MirrorJob; indexes: { byCase: string } };
  /** Small key/value store: mirror directory handle, timestamp queue, etc. */
  meta: { key: string; value: unknown };
}

export const DB_NAME = 'evicap';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<EviCapDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<EviCapDB>> {
  dbPromise ??= openDB<EviCapDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const cases = db.createObjectStore('cases', { keyPath: 'id' });
      cases.createIndex('byStatus', 'status');
      const visits = db.createObjectStore('visits', { keyPath: 'id' });
      visits.createIndex('byCase', ['caseId', 'seq']);
      const captures = db.createObjectStore('captures', { keyPath: 'id' });
      captures.createIndex('byCase', ['caseId', 'startedAtUtc']);
      captures.createIndex('byStatus', 'status');
      const notes = db.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('byCase', 'caseId');
      notes.createIndex('byTarget', ['targetKind', 'targetId']);
      db.createObjectStore('audit', { keyPath: ['caseId', 'seq'] });
      db.createObjectStore('keys', { keyPath: 'id' });
      const mq = db.createObjectStore('mirrorQueue', { keyPath: 'id', autoIncrement: true });
      mq.createIndex('byCase', 'caseId');
      db.createObjectStore('meta');
    },
  });
  return dbPromise;
}

/** For tests: close and forget the cached connection. */
export async function resetDbForTests() {
  const p = dbPromise;
  dbPromise = null;
  if (p) (await p.catch(() => null))?.close();
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await (await getDb()).get('meta', key)) as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await (await getDb()).put('meta', value, key);
}

// ---- Read helpers used by the UI (UI pages read IndexedDB directly; all writes
// go through the service worker so the audit chain has a single writer). ----

export async function listCases(): Promise<CaseRecord[]> {
  const all = await (await getDb()).getAll('cases');
  return all.sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc));
}

export async function getCase(id: string) {
  return (await getDb()).get('cases', id);
}

export async function listVisits(caseId: string, limit = Infinity): Promise<VisitRecord[]> {
  const db = await getDb();
  const range = IDBKeyRange.bound([caseId, 0], [caseId, Number.MAX_SAFE_INTEGER]);
  const out: VisitRecord[] = [];
  let cursor = await db.transaction('visits').store.index('byCase').openCursor(range, 'prev');
  while (cursor && out.length < limit) {
    out.push(cursor.value);
    cursor = await cursor.continue();
  }
  return out;
}

export async function listCaptures(caseId: string, limit = Infinity): Promise<CaptureRecord[]> {
  const db = await getDb();
  const range = IDBKeyRange.bound([caseId, ''], [caseId, '￿']);
  const out: CaptureRecord[] = [];
  let cursor = await db.transaction('captures').store.index('byCase').openCursor(range, 'prev');
  while (cursor && out.length < limit) {
    out.push(cursor.value);
    cursor = await cursor.continue();
  }
  return out;
}

export async function getCapture(id: string) {
  return (await getDb()).get('captures', id);
}

export async function listNotes(caseId: string): Promise<NoteRecord[]> {
  const notes = await (await getDb()).getAllFromIndex('notes', 'byCase', caseId);
  return notes.sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));
}

export async function listAudit(caseId: string): Promise<AuditEvent[]> {
  const range = IDBKeyRange.bound([caseId, 0], [caseId, Number.MAX_SAFE_INTEGER]);
  return (await getDb()).getAll('audit', range);
}
