/**
 * EviCap licence service (SPEC §9.2). A Cloudflare Worker run by Civil Digital.
 *
 * Stripe Managed Payments sells EviCap Pro through Payment Links but has no
 * licence keys, and the extension must never hold a Stripe secret key. This
 * service bridges the two:
 *
 *   GET  /success?session_id=cs_...   Payment Link "after payment" page. Checks
 *        the Checkout Session with Stripe and shows the buyer a signed EviCap
 *        licence key to paste into the extension.
 *   POST /refresh {"key": "EVICAP1-..."}   Called by the extension about once a
 *        day. Checks the subscription with Stripe and returns a renewed key,
 *        or {"status":"ended"} when the subscription has ended.
 *
 * Keys use the extension's own format (src/lib/licence.ts), signed with the
 * service's ECDSA P-256 key, and carry `subscriptionId`. Each key is valid
 * until the end of the paid period plus GRACE_DAYS, so the extension keeps
 * working if this service is briefly unreachable.
 *
 * The service stores nothing. It receives only the key (which holds the
 * buyer's email and subscription ID, both already known to Stripe).
 *
 * Secrets / variables (wrangler.toml, `wrangler secret put`):
 *   STRIPE_SECRET_KEY   a restricted key with read access to Checkout Sessions and Subscriptions
 *   SIGNING_KEY_JWK     the private JWK from tools/keys/service-signing-key.private.jwk
 *   PRICE_IDS           comma-separated Stripe price IDs for EviCap Pro (monthly, yearly)
 *   GRACE_DAYS          optional, default 14
 */
import { canonicalBytes } from '../../src/lib/jcs';
import { base64url, fromBase64url } from '../../src/lib/util';

export interface Env {
  STRIPE_SECRET_KEY: string;
  SIGNING_KEY_JWK: string;
  PRICE_IDS: string;
  GRACE_DAYS?: string;
}

export interface KeyPayload {
  schema: 'evicap.licence/1';
  licenceId: string;
  org: string;
  email: string;
  plan: 'pro';
  issuedAtUtc: string;
  expiresAtUtc: string;
  subscriptionId: string;
}

interface StripePrice {
  id: string;
}
interface StripeSubscription {
  id: string;
  status: string;
  current_period_end?: number;
  items: { data: { price: StripePrice; current_period_end?: number }[] };
  customer?: string | { id: string; email?: string | null; name?: string | null };
}
interface StripeSession {
  id: string;
  status: string | null;
  mode: string;
  subscription: StripeSubscription | string | null;
  customer_details: { email: string | null; name: string | null } | null;
}

const PREFIX = 'EVICAP1-';
const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;
/** Pro continues while Stripe is still retrying a failed payment. */
const LIVE = new Set(['active', 'trialing', 'past_due']);
const DAY = 86_400_000;

class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function stripe<T>(env: Env, path: string): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2025-03-31.basil' },
  });
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new StripeError(body.error?.message ?? `Stripe answered HTTP ${res.status}`, res.status);
  return body;
}

function priceIds(env: Env): Set<string> {
  return new Set(env.PRICE_IDS.split(',').map((s) => s.trim()).filter(Boolean));
}

function isEviCap(sub: StripeSubscription, env: Env): boolean {
  const allowed = priceIds(env);
  return sub.items.data.some((i) => allowed.has(i.price.id));
}

/** End of the paid period (moved from the subscription to its items in newer Stripe API versions). */
function periodEnd(sub: StripeSubscription): number {
  const ends = [sub.current_period_end ?? 0, ...sub.items.data.map((i) => i.current_period_end ?? 0)];
  return Math.max(...ends) * 1000;
}

async function signingKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', JSON.parse(env.SIGNING_KEY_JWK) as JsonWebKey, ALG, false, ['sign']);
}

async function verifyKey(env: Env): Promise<CryptoKey> {
  const { kty, crv, x, y } = JSON.parse(env.SIGNING_KEY_JWK) as JsonWebKey;
  return crypto.subtle.importKey('jwk', { kty, crv, x, y }, ALG, false, ['verify']);
}

export async function mintKey(env: Env, sub: StripeSubscription, who: { email: string; org: string }, now = new Date()): Promise<{ key: string; payload: KeyPayload }> {
  const grace = Number(env.GRACE_DAYS ?? 14) * DAY;
  const payload: KeyPayload = {
    schema: 'evicap.licence/1',
    licenceId: sub.id,
    org: who.org,
    email: who.email,
    plan: 'pro',
    issuedAtUtc: now.toISOString(),
    expiresAtUtc: new Date(periodEnd(sub) + grace).toISOString(),
    subscriptionId: sub.id,
  };
  const sig = await crypto.subtle.sign(SIGN, await signingKey(env), canonicalBytes(payload) as BufferSource);
  return { payload, key: `${PREFIX}${base64url(canonicalBytes(payload))}.${base64url(sig)}` };
}

/** Read a key this service issued; null if it is not one, or its signature fails. */
export async function readKey(env: Env, text: string): Promise<KeyPayload | null> {
  const clean = text.replace(/\s+/g, '');
  if (!clean.startsWith(PREFIX)) return null;
  const [body, sig] = clean.slice(PREFIX.length).split('.');
  if (!body || !sig) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as KeyPayload;
    if (!payload.subscriptionId) return null;
    const ok = await crypto.subtle.verify(SIGN, await verifyKey(env), fromBase64url(sig) as BufferSource, canonicalBytes(payload) as BufferSource);
    return ok ? payload : null;
  } catch {
    return null;
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · EviCap</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1b1f24;--muted:#5b6470;--card:#fff;--border:#d8dde3;--accent:#1f5fbf}
@media (prefers-color-scheme:dark){:root{--bg:#14171b;--fg:#e7eaee;--muted:#9aa3ad;--card:#1d2126;--border:#323840;--accent:#6aa2f0}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:48px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:6px;padding:24px}
h1{font-size:22px;margin:0 0 12px}
textarea{width:100%;box-sizing:border-box;font:13px ui-monospace,Consolas,monospace;padding:10px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);resize:vertical}
button{font:inherit;padding:7px 14px;border-radius:4px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
ol{padding-left:20px}.muted{color:var(--muted);font-size:13px}
</style></head><body><main><div class="card">${body}</div>
<p class="muted">EviCap by Civil Digital · info@civildigital.co.uk</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    },
  });
}

function problem(text: string, status = 400): Response {
  return page('Licence key', `<h1>We couldn't show your licence key</h1><p>${esc(text)}</p><p>If you have paid, email <a href="mailto:info@civildigital.co.uk">info@civildigital.co.uk</a> and we'll send your key.</p>`, status);
}

async function success(env: Env, url: URL): Promise<Response> {
  const id = url.searchParams.get('session_id') ?? '';
  if (!/^cs_(test_|live_)?[A-Za-z0-9]+$/.test(id)) return problem('This page needs the link from your payment confirmation.');
  let session: StripeSession;
  try {
    session = await stripe<StripeSession>(env, `checkout/sessions/${encodeURIComponent(id)}?expand[]=subscription`);
  } catch (e) {
    return problem(e instanceof StripeError && e.status === 404 ? 'This payment was not found.' : 'Stripe could not be reached. Reload this page in a minute.', e instanceof StripeError && e.status === 404 ? 404 : 502);
  }
  const sub = session.subscription;
  if (session.status !== 'complete' || session.mode !== 'subscription' || !sub || typeof sub === 'string') {
    return problem('This payment is not complete yet. Reload this page in a minute.', 409);
  }
  if (!isEviCap(sub, env)) return problem('This payment is not for EviCap Pro.', 403);
  if (!LIVE.has(sub.status)) return problem('This subscription is no longer active.', 410);
  const { key, payload } = await mintKey(env, sub, { email: session.customer_details?.email ?? '', org: session.customer_details?.name ?? '' });
  return page(
    'Your licence key',
    `<h1>Thank you. Here is your EviCap Pro licence key</h1>
<ol>
<li>Copy the key below.</li>
<li>Open EviCap, go to <strong>Settings → Plan</strong>, paste it into <strong>Licence key</strong> and press <strong>Activate licence</strong>.</li>
</ol>
<textarea id="key" rows="6" readonly aria-label="Licence key">${esc(key)}</textarea>
<p><button type="button" onclick="navigator.clipboard.writeText(document.getElementById('key').value).then(()=>this.textContent='Copied')">Copy key</button></p>
<p class="muted">Keep this key, or bookmark this page. EviCap renews the key automatically while your subscription is active. It is for ${esc(payload.email || 'you')}; use it on your own computers only. Manage or cancel your subscription at <a href="https://app.link.com">link.com</a>.</p>`,
  );
}

async function refresh(env: Env, request: Request): Promise<Response> {
  let text = '';
  try {
    text = String(((await request.json()) as { key?: unknown }).key ?? '');
  } catch {
    return json(400, { error: 'Send {"key": "EVICAP1-..."}.' });
  }
  const old = await readKey(env, text);
  if (!old) return json(400, { error: 'This is not a subscription key issued by EviCap.' });
  let sub: StripeSubscription;
  try {
    sub = await stripe<StripeSubscription>(env, `subscriptions/${encodeURIComponent(old.subscriptionId)}`);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return json(200, { status: 'ended', reason: 'This subscription no longer exists.' });
    return json(502, { error: 'Stripe could not be reached.' });
  }
  if (!isEviCap(sub, env)) return json(200, { status: 'ended', reason: 'This subscription is not for EviCap Pro.' });
  if (!LIVE.has(sub.status)) return json(200, { status: 'ended', reason: 'Your subscription has ended.' });
  const { key, payload } = await mintKey(env, sub, { email: old.email, org: old.org });
  return json(200, { status: 'active', key, expiresAtUtc: payload.expiresAtUtc });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/success') return success(env, url);
    if (request.method === 'POST' && url.pathname === '/refresh') return refresh(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
    if (request.method === 'GET' && url.pathname === '/') return page('EviCap licence service', '<h1>EviCap licence service</h1><p>This service issues licence keys for EviCap Pro subscriptions.</p>');
    return json(404, { error: 'Not found' });
  },
};
