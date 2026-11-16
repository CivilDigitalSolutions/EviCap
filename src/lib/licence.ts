import { canonicalBytes } from './jcs';
import { base64url, fromBase64url } from './util';

/**
 * Licence keys (SPEC §9.2, §9.6). A key is
 * JCS({schema, licenceId, org, email, plan, issuedAtUtc, expiresAtUtc[, subscriptionId]})
 * signed with ECDSA P-256 by one of two Civil Digital keys:
 * - the offline licence key, for invoice licences (tools/issue-licence.ts);
 * - the licence service's key, for Stripe subscriptions (service/). These keys
 *   carry `subscriptionId` and expire at the end of the paid period plus 14
 *   days; the extension renews them through the service (billing.ts).
 * Checking a key makes no network request.
 *
 * Key text: `EVICAP1-<base64url(JCS(payload))>.<base64url(signature)>`
 */

export interface LicencePayload {
  schema: 'evicap.licence/1';
  licenceId: string;
  org: string;
  email: string;
  plan: 'pro';
  issuedAtUtc: string;
  expiresAtUtc: string;
  /** Stripe subscription ID: present on keys from the licence service. */
  subscriptionId?: string;
}

export type LicenceCheck =
  | { ok: true; payload: LicencePayload; expired: boolean }
  | { ok: false; reason: string };

const PREFIX = 'EVICAP1-';
const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Civil Digital's licence-signing public key (private key: tools/keys, never in the extension). */
const PRODUCTION_KEY: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'XExL_hIEgaud2BAq5MMELakHjXQQLrwnnt7cmdp2VWI',
  y: 'iiRfconGSo_bg8MbkzLfJ3cLG4sQspRsnqeg24KJRWI',
};

/** The licence service's public key (private key: the service's SIGNING_KEY_JWK secret). */
const SERVICE_KEY: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'IJNntnXXcI7aVb1viURsa23XrlvJb6MEk-7LwNVzVwQ',
  y: 'U4X4FXR2yrF4FcLm3VA1LKQ76HRdes7DYD1Cxeq_MaA',
};

/** Test builds (`wxt build --mode e2e`) also trust the key in tests/fixtures/licence-test-key.ts. */
function trustedKeys(): JsonWebKey[] {
  const keys = [PRODUCTION_KEY, SERVICE_KEY];
  if (__EVICAP_E2E__) {
    keys.push({ kty: 'EC', crv: 'P-256', x: 'KJv9l1zO3DuwePzGGTH5nd-6IYNwJtfvouLpSvXOUi0', y: 'C-YAd8TGzQLwiX0--uZm_MsakUEYdyhe-1E6hlcOkWE' });
  }
  return keys;
}

export function encodeLicence(payload: LicencePayload, signature: Uint8Array | ArrayBuffer): string {
  return `${PREFIX}${base64url(canonicalBytes(payload))}.${base64url(signature)}`;
}

export function decodeLicence(text: string): { payload: LicencePayload; signature: Uint8Array } | null {
  const clean = text.replace(/\s+/g, '');
  if (!clean.startsWith(PREFIX)) return null;
  const [body, sig] = clean.slice(PREFIX.length).split('.');
  if (!body || !sig) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as LicencePayload;
    return { payload, signature: fromBase64url(sig) };
  } catch {
    return null;
  }
}

export async function checkLicence(text: string, now = new Date(), keys: JsonWebKey[] = trustedKeys()): Promise<LicenceCheck> {
  const decoded = decodeLicence(text);
  if (!decoded) return { ok: false, reason: 'This is not an EviCap licence key. Paste the whole key, starting EVICAP1-.' };
  const { payload, signature } = decoded;
  if (payload.schema !== 'evicap.licence/1' || payload.plan !== 'pro' || !payload.expiresAtUtc || !payload.licenceId) {
    return { ok: false, reason: 'This licence key is not in a format this version of EviCap understands.' };
  }
  let valid = false;
  for (const jwk of keys) {
    try {
      const key = await crypto.subtle.importKey('jwk', jwk, ALG, false, ['verify']);
      if (await crypto.subtle.verify(SIGN, key, signature as BufferSource, canonicalBytes(payload) as BufferSource)) {
        valid = true;
        break;
      }
    } catch {
      /* try the next key */
    }
  }
  if (!valid) return { ok: false, reason: 'This licence key is not valid: its signature does not check. Copy it again exactly as issued.' };
  const expires = Date.parse(payload.expiresAtUtc);
  if (Number.isNaN(expires)) return { ok: false, reason: 'This licence key has no valid expiry date.' };
  return { ok: true, payload, expired: expires <= now.getTime() };
}
