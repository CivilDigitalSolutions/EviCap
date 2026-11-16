import { sha256Json, type Sha256 } from './hash';
import type { AuditEvent } from './types';

/**
 * Audit chain hashing and checking (SPEC §7.4), with no database code, so the
 * offline verifier can bundle it.
 *
 *   payloadHash = SHA-256(JCS(payload))
 *   hash        = SHA-256(JCS({seq, caseId, type, atUtc, payloadHash, prevHash}))
 *
 * Because an event's hash covers only its payload's hash, an exhibit-only
 * export can leave out the payload of an unrelated event (`redacted: true`)
 * and the chain still checks.
 */

export type ExportedEvent = Omit<AuditEvent, 'payload'> & { payload: Record<string, unknown> | null; redacted?: true };

export function eventHashInput(e: Pick<AuditEvent, 'seq' | 'caseId' | 'type' | 'atUtc' | 'payloadHash' | 'prevHash'>) {
  return {
    seq: e.seq,
    caseId: e.caseId,
    type: e.type,
    atUtc: e.atUtc,
    payloadHash: e.payloadHash,
    prevHash: e.prevHash,
  };
}

export interface ChainCheck {
  ok: boolean;
  count: number;
  /** Events whose payload was left out of an exhibit-only export. */
  redacted: number;
  head: Sha256 | null;
  /** Problems, each tied to a sequence number. */
  errors: { seq: number; problem: string }[];
}

/** Walk a chain and recompute every hash. */
export async function verifyChain(events: (AuditEvent | ExportedEvent)[]): Promise<ChainCheck> {
  const errors: ChainCheck['errors'] = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let prev: Sha256 | null = null;
  let redacted = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (e.seq !== i) errors.push({ seq: e.seq, problem: `expected sequence ${i}` });
    if (e.prevHash !== prev) errors.push({ seq: e.seq, problem: 'prevHash does not match the previous event' });
    if ('redacted' in e && e.redacted && e.payload === null) {
      redacted++;
    } else if ((await sha256Json(e.payload)) !== e.payloadHash) {
      errors.push({ seq: e.seq, problem: 'payload has been changed' });
    }
    if ((await sha256Json(eventHashInput(e))) !== e.hash) errors.push({ seq: e.seq, problem: 'event hash does not match its contents' });
    prev = e.hash;
  }
  return { ok: errors.length === 0, count: sorted.length, redacted, head: prev, errors };
}
