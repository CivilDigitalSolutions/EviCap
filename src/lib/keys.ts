import { getDb } from './db';
import { sha256, type Sha256 } from './hash';
import { canonicalBytes } from './jcs';
import type { InstallKey } from './types';
import { base64url, fromBase64url, nowUtc } from './util';

/**
 * Install signing key (SPEC §7.3): ECDSA P-256, generated on first use. The
 * private key is non-extractable and stored as a CryptoKey in IndexedDB.
 */
const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

let cached: Promise<InstallKey> | null = null;

export function getInstallKey(): Promise<InstallKey> {
  cached ??= (async () => {
    const db = await getDb();
    const existing = await db.get('keys', 'install');
    if (existing) return existing;
    const pair = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    const record: InstallKey = {
      id: 'install',
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicJwk,
      fingerprint: await sha256(spki),
      createdAtUtc: nowUtc(),
    };
    // `add` fails if another context created the key first; then use theirs.
    try {
      await db.add('keys', record);
      return record;
    } catch {
      const winner = await db.get('keys', 'install');
      if (!winner) throw new Error('Could not create the signing key');
      return winner;
    }
  })();
  cached.catch(() => {
    cached = null;
  });
  return cached;
}

export async function signBytes(privateKey: CryptoKey, bytes: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign(SIGN, privateKey, bytes as BufferSource);
  return base64url(sig);
}

/** Sign JCS(value) with the install key. Returns a base64url signature. */
export async function signJson(value: unknown): Promise<string> {
  const key = await getInstallKey();
  return signBytes(key.privateKey, canonicalBytes(value));
}

export async function importPublicJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, ALG, true, ['verify']);
}

export async function verifyJson(publicKey: CryptoKey, value: unknown, signature: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(SIGN, publicKey, fromBase64url(signature) as BufferSource, canonicalBytes(value) as BufferSource);
  } catch {
    return false;
  }
}

export async function fingerprintOf(publicKey: CryptoKey): Promise<Sha256> {
  return sha256(await crypto.subtle.exportKey('spki', publicKey));
}

/** Short form of a fingerprint for display, e.g. `9F86 D081 884C 7D65`. */
export function shortFingerprint(fp: Sha256): string {
  return fp
    .slice(7, 23)
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1 ');
}
