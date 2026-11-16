import { LEMON, onlinePurchaseReady, type LemonConfig } from './billing-config';

/**
 * Card subscriptions through Lemon Squeezy (SPEC §9, §10 row 1). Lemon Squeezy
 * sells EviCap Pro as merchant of record and emails each buyer a licence key.
 * This module is the only one that talks to Lemon Squeezy, and it does so only
 * after the user pastes such a key: to activate it on this computer, re-check
 * it about once a day, and release it when the user removes it.
 *
 * What is sent: the licence key, the activation ID Lemon Squeezy gave this
 * computer, and a label naming the browser and operating system. Never case
 * data, logs, captures or files. tests/media.test.ts allows `fetch` here and
 * in net.ts only.
 */

export type LemonStatus = 'inactive' | 'active' | 'expired' | 'disabled';

export interface LemonResponse {
  activated?: boolean;
  valid?: boolean;
  deactivated?: boolean;
  error: string | null;
  license_key?: { status: LemonStatus; key: string; activation_limit: number | null; activation_usage: number; expires_at: string | null };
  instance?: { id: string; name: string; created_at: string } | null;
  meta?: {
    store_id: number;
    product_id: number;
    product_name: string;
    variant_id: number;
    variant_name: string;
    customer_email: string;
    customer_name: string;
    order_id: number;
  };
}

/** What EviCap keeps about a Lemon Squeezy licence (chrome.storage.local, inside the plan state). */
export interface LemonLicence {
  key: string;
  instanceId: string;
  status: LemonStatus | 'invalid';
  email: string | null;
  variantName: string | null;
  expiresAtUtc: string | null;
  /** Last time Lemon Squeezy answered about this key. Pro is kept for 14 days without an answer. */
  lastOkAtUtc: string;
  checkedAtUtc: string;
  /** The last problem reported (for example, the network was unavailable). */
  problem: string | null;
}

/** A Lemon Squeezy licence key is a UUID. EviCap's own keys start EVICAP1-. */
export function isLemonKey(text: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text.trim());
}

export class BillingNetworkError extends Error {}

/** Check that a key belongs to EviCap Pro in Civil Digital's store (Lemon Squeezy's own advice). */
export function checkProduct(r: LemonResponse, c: LemonConfig = LEMON): string | null {
  if (!r.meta) return null;
  if (r.meta.store_id !== c.storeId || r.meta.product_id !== c.productId) {
    return 'This licence key is for a different product. Use the key from your EviCap Pro receipt.';
  }
  return null;
}

async function apiBase(): Promise<string> {
  if (__EVICAP_E2E__) {
    const v = (await chrome.storage.local.get('e2eLemonApi'))['e2eLemonApi'] as string | undefined;
    if (v) return v;
  }
  return LEMON.apiBase;
}

async function call(path: 'activate' | 'validate' | 'deactivate', form: Record<string, string>): Promise<{ status: number; body: LemonResponse }> {
  let res: Response;
  try {
    res = await fetch(`${await apiBase()}/${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new BillingNetworkError('Lemon Squeezy could not be reached. Check the internet connection and try again.');
  }
  let body: LemonResponse;
  try {
    body = (await res.json()) as LemonResponse;
  } catch {
    throw new BillingNetworkError(`Lemon Squeezy sent an unexpected answer (HTTP ${res.status}). Try again later.`);
  }
  if (res.status >= 500) throw new BillingNetworkError(`Lemon Squeezy is unavailable (HTTP ${res.status}). Try again later.`);
  return { status: res.status, body };
}

function fromResponse(key: string, instanceId: string, r: LemonResponse, now: string): LemonLicence {
  return {
    key,
    instanceId,
    status: r.license_key?.status ?? 'invalid',
    email: r.meta?.customer_email ?? null,
    variantName: r.meta?.variant_name ?? null,
    expiresAtUtc: r.license_key?.expires_at ?? null,
    lastOkAtUtc: now,
    checkedAtUtc: now,
    problem: null,
  };
}

/** Activate a key on this computer. Throws with a message for the user if it can't be used. */
export async function activateLemon(key: string, instanceName: string, now = new Date().toISOString()): Promise<LemonLicence> {
  if (!onlinePurchaseReady()) throw new Error('Online purchase is not available yet. Contact info@civildigital.co.uk for a licence key.');
  key = key.trim();
  const { body } = await call('activate', { license_key: key, instance_name: instanceName });
  if (!body.activated || !body.instance) {
    const status = body.license_key?.status;
    if (status === 'expired') throw new Error('This licence key has expired because its subscription ended. Renew it from your Lemon Squeezy account.');
    if (status === 'disabled') throw new Error('This licence key has been disabled. Contact info@civildigital.co.uk.');
    if (/activation limit/i.test(body.error ?? '')) {
      throw new Error('This licence key is already in use on as many computers as it allows. Remove it from the other computer first (Settings → Plan → Remove licence).');
    }
    throw new Error(body.error ? `Lemon Squeezy did not accept this key: ${body.error}` : 'Lemon Squeezy did not accept this key.');
  }
  const wrong = checkProduct(body);
  if (wrong) {
    // Give the activation back so the key isn't used up by a mistake.
    await call('deactivate', { license_key: key, instance_id: body.instance.id }).catch(() => undefined);
    throw new Error(wrong);
  }
  return fromResponse(key, body.instance.id, body, now);
}

/**
 * Re-check a key. Returns the updated licence; on a network failure it keeps
 * the previous answer and notes the problem (the 14-day grace applies).
 */
export async function validateLemon(lic: LemonLicence, now = new Date().toISOString()): Promise<LemonLicence> {
  try {
    const { status, body } = await call('validate', { license_key: lic.key, instance_id: lic.instanceId });
    if (status === 404 || (!body.valid && !body.license_key)) {
      return { ...lic, status: 'invalid', checkedAtUtc: now, lastOkAtUtc: now, problem: body.error ?? 'Lemon Squeezy no longer recognises this key.' };
    }
    if (checkProduct(body)) return { ...lic, status: 'invalid', checkedAtUtc: now, lastOkAtUtc: now, problem: checkProduct(body) };
    const next = fromResponse(lic.key, lic.instanceId, body, now);
    // `valid` is false when this computer's activation was removed in the Lemon Squeezy dashboard.
    if (!body.valid && next.status === 'active') return { ...next, status: 'invalid', problem: body.error ?? 'This computer is no longer activated for this key.' };
    return next;
  } catch (e) {
    if (e instanceof BillingNetworkError) return { ...lic, checkedAtUtc: now, problem: e.message };
    throw e;
  }
}

/** Release this computer's activation. Best effort: the key is removed locally either way. */
export async function deactivateLemon(lic: LemonLicence): Promise<boolean> {
  try {
    const { body } = await call('deactivate', { license_key: lic.key, instance_id: lic.instanceId });
    return !!body.deactivated;
  } catch {
    return false;
  }
}
