import { BILLING } from './billing-config';

/**
 * Renewing subscription licence keys (SPEC §9.2, §10 row 1). The only module
 * that talks to Civil Digital's licence service, and only once the user has
 * entered a subscription key: about once a day it sends that key and gets back
 * a renewed one (or word that the subscription has ended). The key holds the
 * buyer's email and Stripe subscription ID, which Stripe already has. Never
 * case data, logs, captures or files. tests/media.test.ts allows `fetch` here
 * and in net.ts only.
 */

export type RenewResult = { status: 'active'; key: string } | { status: 'ended'; reason: string };

export class BillingNetworkError extends Error {}

async function serviceUrl(): Promise<string | null> {
  if (__EVICAP_E2E__) {
    const v = (await chrome.storage.local.get('e2eLicenceService'))['e2eLicenceService'] as string | undefined;
    if (v) return v;
  }
  return BILLING.serviceUrl;
}

export async function renewSubscriptionKey(key: string): Promise<RenewResult> {
  const base = await serviceUrl();
  if (!base) throw new BillingNetworkError('Subscription checks are not switched on in this version of EviCap.');
  let res: Response;
  try {
    res = await fetch(`${base}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ key }),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new BillingNetworkError('The EviCap licence service could not be reached. Check the internet connection and try again.');
  }
  let body: { status?: string; key?: string; reason?: string; error?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new BillingNetworkError(`The licence service sent an unexpected answer (HTTP ${res.status}). Try again later.`);
  }
  if (res.status >= 500) throw new BillingNetworkError(body.error ?? `The licence service is unavailable (HTTP ${res.status}). Try again later.`);
  if (res.ok && body.status === 'active' && body.key) return { status: 'active', key: body.key };
  if (res.ok && body.status === 'ended') return { status: 'ended', reason: body.reason ?? 'Your subscription has ended.' };
  throw new Error(body.error ?? `The licence service refused this key (HTTP ${res.status}).`);
}
