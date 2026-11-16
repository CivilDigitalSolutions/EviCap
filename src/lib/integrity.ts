import { getDb } from './db';
import { sha256Blob, sha256Json } from './hash';
import { canonicalize } from './jcs';
import { importPublicJwk, verifyJson } from './keys';
import { capturePath, readFile } from './opfs';
import type { CaptureRecord } from './types';

export interface Integrity {
  files: Record<string, 'ok' | 'mismatch' | 'missing'>;
  manifest: 'ok' | 'mismatch' | 'missing';
  signature: 'ok' | 'invalid' | 'missing';
}

/** Re-hash on view (SPEC §7.1): recompute every file hash and check the signed manifest. */
export async function checkIntegrity(c: CaptureRecord): Promise<Integrity> {
  const files: Integrity['files'] = {};
  for (const f of c.files) {
    try {
      const h = await sha256Blob(await readFile(capturePath(c.caseId, c.id, f.path)));
      files[f.path] = h === f.sha256 ? 'ok' : 'mismatch';
    } catch {
      files[f.path] = 'missing';
    }
  }
  let manifest: Integrity['manifest'] = 'missing';
  let signature: Integrity['signature'] = 'missing';
  try {
    const parsed = JSON.parse(await (await readFile(capturePath(c.caseId, c.id, 'manifest.json'))).text());
    const fileMatch = canonicalize(parsed.files) === canonicalize(c.files);
    manifest = (await sha256Json(parsed)) === c.captureHash && fileMatch ? 'ok' : 'mismatch';
    const sig = await (await readFile(capturePath(c.caseId, c.id, 'manifest.sig'))).text();
    const key = await (await getDb()).get('keys', 'install');
    if (key) signature = (await verifyJson(await importPublicJwk(key.publicJwk), parsed, sig.trim())) ? 'ok' : 'invalid';
  } catch {
    /* leave as missing */
  }
  return { files, manifest, signature };
}

export function integrityProblems(c: CaptureRecord, i: Integrity): string[] {
  const out: string[] = [];
  for (const [p, v] of Object.entries(i.files)) if (v !== 'ok') out.push(`${c.id}/${p}: ${v}`);
  if (i.manifest !== 'ok') out.push(`${c.id}/manifest.json: ${i.manifest}`);
  if (i.signature !== 'ok') out.push(`${c.id}/manifest.sig: ${i.signature}`);
  return out;
}
