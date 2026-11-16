import { beforeEach, describe, expect, it } from 'vitest';
import { appendEvent, verifyChain } from '../src/lib/audit';
import { getDb, listAudit, resetDbForTests, DB_NAME } from '../src/lib/db';
import { importPublicJwk, signBytes, verifyJson, getInstallKey } from '../src/lib/keys';
import { canonicalBytes } from '../src/lib/jcs';
import type { CaseRecord } from '../src/lib/types';

function makeCase(id: string): CaseRecord {
  return {
    id,
    name: 'Test case',
    reference: 'T-1',
    investigator: '',
    organisation: '',
    description: '',
    status: 'open',
    createdAtUtc: new Date().toISOString(),
    closedAtUtc: null,
    scope: { mode: 'all', domains: [] },
    recordIncognito: false,
    autoCapture: true,
    chainHead: null,
    nextSeq: 0,
    nextVisitSeq: 0,
    lastExportedAtUtc: null,
    mirrorFolder: 'EviCap_T-1',
  };
}

beforeEach(async () => {
  await resetDbForTests();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
});

describe('audit chain', () => {
  it('builds a valid chain and moves the case head', async () => {
    const db = await getDb();
    await db.add('cases', makeCase('c1'));
    await appendEvent('c1', 'case.created', { name: 'Test case' });
    await appendEvent('c1', 'recording.started', {});
    const last = await appendEvent('c1', 'visit.recorded', { url: 'https://example.com/' });
    const events = await listAudit('c1');
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events[0]!.prevHash).toBeNull();
    expect(events[1]!.prevHash).toBe(events[0]!.hash);
    const check = await verifyChain(events);
    expect(check.ok).toBe(true);
    expect(check.head).toBe(last.hash);
    expect((await db.get('cases', 'c1'))!.chainHead).toBe(last.hash);
  });

  it('keeps sequence and chain intact under concurrent appends', async () => {
    const db = await getDb();
    await db.add('cases', makeCase('c2'));
    await Promise.all(Array.from({ length: 25 }, (_, i) => appendEvent('c2', 'note.created', { i })));
    const events = await listAudit('c2');
    expect(events).toHaveLength(25);
    expect((await verifyChain(events)).ok).toBe(true);
  });

  it('detects an edited payload at exactly that event', async () => {
    const db = await getDb();
    await db.add('cases', makeCase('c3'));
    for (let i = 0; i < 4; i++) await appendEvent('c3', 'note.created', { text: `note ${i}` });
    const events = await listAudit('c3');
    events[2] = { ...events[2]!, payload: { text: 'changed' } };
    const check = await verifyChain(events);
    expect(check.ok).toBe(false);
    expect(check.errors.map((e) => e.seq)).toEqual([2]);
  });

  it('detects a removed event', async () => {
    const db = await getDb();
    await db.add('cases', makeCase('c4'));
    for (let i = 0; i < 4; i++) await appendEvent('c4', 'note.created', { i });
    const events = (await listAudit('c4')).filter((e) => e.seq !== 1);
    const check = await verifyChain(events);
    expect(check.ok).toBe(false);
    expect(check.errors.some((e) => e.problem.includes('prevHash'))).toBe(true);
  });

  it('detects an edited event hash', async () => {
    const db = await getDb();
    await db.add('cases', makeCase('c5'));
    for (let i = 0; i < 3; i++) await appendEvent('c5', 'note.created', { i });
    const events = await listAudit('c5');
    events[0] = { ...events[0]!, atUtc: '2000-01-01T00:00:00.000Z' };
    expect((await verifyChain(events)).errors[0]!.seq).toBe(0);
  });
});

describe('signing', () => {
  it('signs JCS bytes and verifies with the exported public key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const manifest = { schema: 'evicap.capture/1', captureId: 'x', files: [{ path: 'a.png', sha256: 'sha256:00' }] };
    const sig = await signBytes(pair.privateKey, canonicalBytes(manifest));
    const pub = await importPublicJwk(await crypto.subtle.exportKey('jwk', pair.publicKey));
    expect(await verifyJson(pub, manifest, sig)).toBe(true);
    // Key order doesn't matter, content does.
    expect(await verifyJson(pub, { files: manifest.files, captureId: 'x', schema: 'evicap.capture/1' }, sig)).toBe(true);
    expect(await verifyJson(pub, { ...manifest, captureId: 'y' }, sig)).toBe(false);
  });

  it('creates one non-extractable install key and reuses it', async () => {
    const a = await getInstallKey();
    expect(a.privateKey.extractable).toBe(false);
    expect(a.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const b = await getInstallKey();
    expect(b.fingerprint).toBe(a.fingerprint);
  });
});
