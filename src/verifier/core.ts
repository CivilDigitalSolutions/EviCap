import { verifyChain, type ExportedEvent } from '../lib/chain';
import { createStreamingSha256, sha256, sha256Json, type Sha256 } from '../lib/hash';
import { canonicalBytes } from '../lib/jcs';
import { fromBase64url } from '../lib/util';
import { readZipEntries, zipEntryBlob } from '../lib/zip';

/**
 * Checks an EviCap export (SPEC F11). Shared by the offline verify.html in
 * every export and the dashboard's Verify page. It makes no network requests
 * and imports nothing that touches browser storage.
 */

export interface ExportManifest {
  schema: 'evicap.export/1';
  exportId: string;
  kind: 'case' | 'exhibits';
  createdAtUtc: string;
  software: { name: string; version: string };
  environment: Record<string, unknown>;
  case: { id: string; name: string; reference: string; investigator: string; organisation: string; status: string };
  publicKey: { file: 'public-key.jwk'; fingerprint: Sha256 };
  auditHead: { seq: number; hash: Sha256 | null; redactedEvents: number };
  captures: { id: string; exhibit: string; captureHash: Sha256 | null }[];
  reportPdf: string;
  files: { path: string; bytes: number; sha256: Sha256 }[];
}

export interface BundleSource {
  name: string;
  paths: string[];
  open(path: string): Promise<Blob | null>;
}

export async function zipSource(file: Blob & { name?: string }): Promise<BundleSource> {
  const entries = await readZipEntries(file);
  const byName = new Map(entries.filter((e) => !e.name.endsWith('/')).map((e) => [e.name, e]));
  return {
    name: file.name ?? 'export.zip',
    paths: [...byName.keys()],
    async open(path) {
      const e = byName.get(path);
      return e ? zipEntryBlob(file, e) : null;
    },
  };
}

/** Files picked as a folder (an unzipped export). The top folder name is removed. */
export function folderSource(files: (File & { webkitRelativePath?: string })[]): BundleSource {
  const map = new Map<string, File>();
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    map.set(rel.includes('/') ? rel.slice(rel.indexOf('/') + 1) : rel, f);
  }
  // A folder that contains the export one level down (e.g. "Downloads/EviCap_…/").
  if (!map.has('manifest.json')) {
    const nested = [...map.keys()].find((k) => k.endsWith('/manifest.json') && k.split('/').length === 2);
    if (nested) {
      const prefix = nested.slice(0, nested.indexOf('/') + 1);
      for (const [k, v] of [...map]) {
        map.delete(k);
        if (k.startsWith(prefix)) map.set(k.slice(prefix.length), v);
      }
    }
  }
  return { name: 'folder', paths: [...map.keys()], open: async (p) => map.get(p) ?? null };
}

export type Status = 'pass' | 'fail' | 'warn';
export interface Check {
  label: string;
  status: Status;
  detail?: string;
}
export interface FileResult {
  path: string;
  bytes: number;
  expected: Sha256;
  actual: Sha256 | null;
  status: Status;
}
export interface VerifyReport {
  ok: boolean;
  manifest: ExportManifest | null;
  checks: Check[];
  files: FileResult[];
}

async function text(src: BundleSource, path: string): Promise<string | null> {
  const b = await src.open(path);
  return b ? b.text() : null;
}

async function hashBlob(blob: Blob, onBytes?: (n: number) => void): Promise<Sha256> {
  const h = await createStreamingSha256();
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
    onBytes?.(value.length);
  }
  return h.digest();
}

const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

async function verifySig(key: CryptoKey, value: unknown, sig: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(SIGN, key, fromBase64url(sig.trim()) as BufferSource, canonicalBytes(value) as BufferSource);
  } catch {
    return false;
  }
}

export async function verifyBundle(src: BundleSource, onProgress?: (done: number, total: number) => void): Promise<VerifyReport> {
  const checks: Check[] = [];
  const files: FileResult[] = [];
  const fail = (label: string, detail?: string) => checks.push({ label, status: 'fail', detail });
  const pass = (label: string, detail?: string) => checks.push({ label, status: 'pass', detail });
  const warn = (label: string, detail?: string) => checks.push({ label, status: 'warn', detail });
  const done = (manifest: ExportManifest | null): VerifyReport => ({
    ok: checks.every((c) => c.status !== 'fail'),
    manifest,
    checks,
    files,
  });

  if (!globalThis.crypto?.subtle) {
    fail('Browser support', 'This browser does not allow signature checks here. Open the file in a current version of Chrome, Edge, Firefox or Safari.');
    return done(null);
  }

  // 1. The export manifest.
  let manifest: ExportManifest;
  try {
    const raw = await text(src, 'manifest.json');
    if (raw === null) {
      fail('Export manifest', 'manifest.json is missing. Choose the EviCap export ZIP, or the folder it was unzipped to.');
      return done(null);
    }
    manifest = JSON.parse(raw);
    if (manifest.schema !== 'evicap.export/1') throw new Error(`unknown schema ${String(manifest.schema)}`);
  } catch (err) {
    fail('Export manifest', `manifest.json could not be read: ${(err as Error).message}`);
    return done(null);
  }
  pass('Export manifest', `${manifest.files.length} files listed`);

  // 2. Key and signature.
  let key: CryptoKey | null = null;
  try {
    const jwk = JSON.parse((await text(src, 'public-key.jwk')) ?? 'null');
    if (!jwk) throw new Error('public-key.jwk is missing');
    key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const fp = await sha256(await crypto.subtle.exportKey('spki', key));
    if (fp === manifest.publicKey.fingerprint) pass('Public key', `Fingerprint ${fp}`);
    else fail('Public key', `The key's fingerprint ${fp} differs from the one in the manifest (${manifest.publicKey.fingerprint}).`);
  } catch (err) {
    fail('Public key', (err as Error).message);
  }
  const sig = await text(src, 'manifest.sig');
  if (!key) fail('Manifest signature', 'No public key to check it with.');
  else if (sig === null) fail('Manifest signature', 'manifest.sig is missing.');
  else if (await verifySig(key, manifest, sig)) pass('Manifest signature', 'The manifest was signed by this key and has not changed since.');
  else fail('Manifest signature', 'The signature does not match: the manifest has been changed, or was signed by a different key.');

  // 3. Every file against its hash.
  const total = manifest.files.reduce((n, f) => n + f.bytes, 0);
  let hashed = 0;
  const actualByPath = new Map<string, Sha256>();
  for (const f of manifest.files) {
    const blob = await src.open(f.path);
    if (!blob) {
      files.push({ path: f.path, bytes: f.bytes, expected: f.sha256, actual: null, status: 'fail' });
      continue;
    }
    const actual = await hashBlob(blob, (n) => onProgress?.((hashed += n), total));
    actualByPath.set(f.path, actual);
    files.push({ path: f.path, bytes: f.bytes, expected: f.sha256, actual, status: actual === f.sha256 && blob.size === f.bytes ? 'pass' : 'fail' });
  }
  const bad = files.filter((f) => f.status === 'fail');
  if (bad.length === 0) pass('File hashes', `All ${files.length} files match their SHA-256 hashes.`);
  else fail('File hashes', `${bad.length} of ${files.length} files are missing or changed: ${bad.slice(0, 5).map((f) => f.path).join(', ')}${bad.length > 5 ? '…' : ''}`);
  const listed = new Set([...manifest.files.map((f) => f.path), 'manifest.json', 'manifest.sig']);
  const extra = src.paths.filter((p) => !listed.has(p) && !p.endsWith('/'));
  if (extra.length) warn('Unlisted files', `${extra.length} file(s) not covered by the manifest: ${extra.slice(0, 5).join(', ')}`);

  // 4. The audit chain.
  let events: ExportedEvent[] = [];
  try {
    events = ((await text(src, 'audit-log.jsonl')) ?? '')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const chain = await verifyChain(events);
    const headOk = chain.head === manifest.auditHead.hash && chain.count - 1 === manifest.auditHead.seq;
    if (!chain.ok) fail('Audit chain', chain.errors.slice(0, 5).map((e) => `event ${e.seq}: ${e.problem}`).join('; '));
    else if (!headOk) fail('Audit chain', `The chain ends at ${chain.head}, not at the head recorded in the manifest (${manifest.auditHead.hash}).`);
    else
      pass(
        'Audit chain',
        `${chain.count} events, each linked to the one before. Head ${chain.head}.${chain.redacted ? ` ${chain.redacted} unrelated events have their details left out of this exhibit-only export; their hashes are still checked.` : ''}`,
      );
  } catch (err) {
    fail('Audit chain', `audit-log.jsonl could not be read: ${(err as Error).message}`);
  }

  // 5. Each capture's own signed manifest, and the audit event that recorded it.
  let capOk = 0;
  for (const c of manifest.captures) {
    const label = `Capture ${c.exhibit}`;
    const raw = await text(src, `captures/${c.id}/manifest.json`);
    if (raw === null) {
      fail(label, 'Its manifest.json is missing.');
      continue;
    }
    const m = JSON.parse(raw) as { files: { path: string; sha256: Sha256 }[] };
    const problems: string[] = [];
    if ((await sha256Json(m)) !== c.captureHash) problems.push('its manifest does not match the capture hash');
    const csig = await text(src, `captures/${c.id}/manifest.sig`);
    if (!key || csig === null || !(await verifySig(key, m, csig))) problems.push('its manifest signature does not check');
    for (const f of m.files) {
      const got = actualByPath.get(`captures/${c.id}/${f.path}`);
      if (got !== f.sha256) problems.push(`${f.path} does not match its capture manifest`);
    }
    const ev = events.find((e) => e.payload && e.payload.captureId === c.id && (e.type === 'capture.created' || e.type === 'artefact.derived'));
    if (!ev) problems.push('no audit event records it');
    else if (ev.payload!.captureHash !== c.captureHash) problems.push('its audit event has a different capture hash');
    if (problems.length) fail(label, problems.join('; '));
    else capOk++;
  }
  if (manifest.captures.length && capOk === manifest.captures.length)
    pass('Captures', `All ${capOk} captures have a signed manifest that matches their files and their audit event.`);

  return done(manifest);
}
