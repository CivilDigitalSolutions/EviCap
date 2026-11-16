import type { IDBPTransaction, StoreNames } from 'idb';
import { getDb, type EviCapDB } from './db';
import { sha256Json, type Sha256 } from './hash';
import { isMirrorEnabled, notifyMirror } from './mirror-queue';
import type { AuditEvent, AuditEventType, CaseRecord } from './types';
import { KeyedMutex, nowUtc } from './util';
import { eventHashInput } from './chain';

export { eventHashInput };

/**
 * Hash-chained, append-only audit log (SPEC §7.4).
 *
 *   payloadHash = SHA-256(JCS(payload))
 *   hash        = SHA-256(JCS({seq, caseId, type, atUtc, payloadHash, prevHash}))
 *
 * Each case has its own chain. Only the service worker appends, and appends for
 * a case are serialised with a mutex, so `prevHash` is always the current head.
 */

export async function buildEvent(
  caseId: string,
  seq: number,
  prevHash: Sha256 | null,
  type: AuditEventType,
  payload: Record<string, unknown>,
  atUtc = nowUtc(),
): Promise<AuditEvent> {
  const payloadHash = await sha256Json(payload);
  const base = { seq, caseId, type, atUtc, payloadHash, prevHash };
  const hash = await sha256Json(eventHashInput(base));
  return { ...base, payload, hash };
}

const mutex = new KeyedMutex();

type Stores = StoreNames<EviCapDB>[];
type Tx = IDBPTransaction<EviCapDB, Stores, 'readwrite'>;

/** Run work that appends to a case's chain, one at a time per case. */
export function withCaseLock<T>(caseId: string, fn: () => Promise<T>): Promise<T> {
  return mutex.run(caseId, fn);
}

/**
 * Append an event. `alsoWrite` runs inside the same IndexedDB transaction, so the
 * event and the records it describes are committed together or not at all.
 * It must only issue IndexedDB requests (no other awaits), or the transaction
 * would auto-commit early.
 *
 * Must be called inside `withCaseLock(caseId, …)`.
 */
export async function appendEventLocked(
  caseId: string,
  type: AuditEventType,
  payload: Record<string, unknown>,
  opts: {
    stores?: Stores;
    /** Change the case record in the same transaction (e.g. status, visit counter). */
    mutateCase?: (c: CaseRecord) => CaseRecord;
    alsoWrite?: (tx: Tx, event: AuditEvent) => void;
  } = {},
): Promise<AuditEvent> {
  const db = await getDb();
  const c = await db.get('cases', caseId);
  if (!c) throw new Error(`Unknown case ${caseId}`);
  const event = await buildEvent(caseId, c.nextSeq, c.chainHead, type, payload);
  const mirrorOn = await isMirrorEnabled();
  const stores = Array.from(
    new Set<StoreNames<EviCapDB>>(['cases', 'audit', 'mirrorQueue', ...(opts.stores ?? [])]),
  );
  const tx = db.transaction(stores, 'readwrite') as unknown as Tx;
  const casesStore = tx.objectStore('cases');
  const current = await casesStore.get(caseId);
  if (!current || current.chainHead !== c.chainHead || current.nextSeq !== c.nextSeq) {
    tx.abort();
    throw new Error('Audit chain changed during append');
  }
  void tx.objectStore('audit').add(event);
  const mutated = opts.mutateCase ? opts.mutateCase(current) : current;
  void casesStore.put({ ...mutated, chainHead: event.hash, nextSeq: event.seq + 1 });
  if (mirrorOn) {
    void tx.objectStore('mirrorQueue').add({
      caseId,
      kind: 'append',
      destPath: `${current.mirrorFolder}/audit-log.jsonl`,
      text: JSON.stringify(event) + '\n',
      attempts: 0,
    });
  }
  opts.alsoWrite?.(tx, event);
  await tx.done;
  if (mirrorOn) notifyMirror();
  return event;
}

export function appendEvent(
  caseId: string,
  type: AuditEventType,
  payload: Record<string, unknown>,
  opts?: Parameters<typeof appendEventLocked>[3],
): Promise<AuditEvent> {
  return withCaseLock(caseId, () => appendEventLocked(caseId, type, payload, opts));
}

export { verifyChain, type ChainCheck } from './chain';
