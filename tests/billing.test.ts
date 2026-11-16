import { afterEach, describe, expect, it, vi } from 'vitest';
import service, { mintKey, readKey, type Env } from '../service/src/index';
import { renewSubscriptionKey } from '../src/lib/billing';
import { BILLING, onlinePurchaseReady } from '../src/lib/billing-config';
import { checkLicence } from '../src/lib/licence';
import { TEST_LICENCE_PRIVATE_JWK } from './fixtures/licence-test-key';

const PUBLIC: JsonWebKey = { kty: 'EC', crv: 'P-256', x: TEST_LICENCE_PRIVATE_JWK.x, y: TEST_LICENCE_PRIVATE_JWK.y };
const ENV: Env = { STRIPE_SECRET_KEY: 'rk_test_x', SIGNING_KEY_JWK: JSON.stringify(TEST_LICENCE_PRIVATE_JWK), PRICE_IDS: 'price_month, price_year' };
const PERIOD_END = Date.parse('2026-12-16T00:00:00Z') / 1000;

const sub = (status = 'active', price = 'price_month') => ({
  id: 'sub_123',
  status,
  items: { data: [{ price: { id: price }, current_period_end: PERIOD_END }] },
});

/** A fake Stripe API: answers by path, records the calls. */
function fakeStripe(routes: Record<string, [number, unknown]>) {
  const calls: { url: string; auth: string | null }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get('Authorization') });
    const path = url.replace('https://api.stripe.com/v1/', '').split('?')[0]!;
    const [status, body] = routes[path] ?? [404, { error: { message: 'No such object' } }];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', f);
  return calls;
}

const get = (path: string) => service.fetch(new Request(`https://licence.example.test${path}`), ENV);
const post = (path: string, body: unknown) =>
  service.fetch(new Request(`https://licence.example.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }), ENV);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('licence service', () => {
  it('shows a signed key after a completed EviCap checkout', async () => {
    const calls = fakeStripe({
      'checkout/sessions/cs_test_abc': [200, { id: 'cs_test_abc', status: 'complete', mode: 'subscription', subscription: sub(), customer_details: { email: 'jo@example.test', name: 'Jo Tester' } }],
    });
    const res = await get('/success?session_id=cs_test_abc');
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ auth: 'Bearer rk_test_x' });
    expect(calls[0]!.url).toContain('expand[]=subscription');
    const html = await res.text();
    const key = /EVICAP1-[A-Za-z0-9_\-.]+/.exec(html)?.[0] ?? '';
    const check = await checkLicence(key, new Date('2026-11-20T00:00:00Z'), [PUBLIC]);
    expect(check).toMatchObject({ ok: true, expired: false, payload: { email: 'jo@example.test', org: 'Jo Tester', subscriptionId: 'sub_123', plan: 'pro' } });
    // The end of the paid period plus 14 days' grace.
    expect(check.ok && check.payload.expiresAtUtc).toBe('2026-12-30T00:00:00.000Z');
  });

  it('refuses checkouts that are unfinished, for another product, or unknown', async () => {
    fakeStripe({
      'checkout/sessions/cs_open': [200, { id: 'cs_open', status: 'open', mode: 'subscription', subscription: null, customer_details: null }],
      'checkout/sessions/cs_other': [200, { id: 'cs_other', status: 'complete', mode: 'subscription', subscription: sub('active', 'price_farmflow'), customer_details: null }],
    });
    expect((await get('/success?session_id=cs_open')).status).toBe(409);
    expect((await get('/success?session_id=cs_other')).status).toBe(403);
    expect((await get('/success?session_id=cs_missing')).status).toBe(404);
    expect((await get('/success?session_id=../../v1/customers')).status).toBe(400);
  });

  it('renews a key while the subscription is live, and says when it has ended', async () => {
    const { key } = await mintKey(ENV, sub(), { email: 'jo@example.test', org: '' }, new Date('2026-11-16T00:00:00Z'));
    fakeStripe({ 'subscriptions/sub_123': [200, { ...sub('past_due'), items: { data: [{ price: { id: 'price_month' }, current_period_end: PERIOD_END + 30 * 86400 }] } }] });
    const live = (await (await post('/refresh', { key })).json()) as { status: string; key: string };
    expect(live.status).toBe('active');
    const renewed = await checkLicence(live.key, new Date('2027-01-10T00:00:00Z'), [PUBLIC]);
    expect(renewed).toMatchObject({ ok: true, expired: false, payload: { subscriptionId: 'sub_123', email: 'jo@example.test' } });

    fakeStripe({ 'subscriptions/sub_123': [200, sub('canceled')] });
    expect(await (await post('/refresh', { key })).json()).toEqual({ status: 'ended', reason: 'Your subscription has ended.' });
    fakeStripe({});
    expect(await (await post('/refresh', { key })).json()).toMatchObject({ status: 'ended' });
  });

  it('only renews keys it issued itself', async () => {
    const calls = fakeStripe({});
    const { key } = await mintKey(ENV, sub(), { email: 'jo@example.test', org: '' });
    const forged = key.replace(/\.[^.]+$/, '.AAAA');
    expect((await post('/refresh', { key: forged })).status).toBe(400);
    expect((await post('/refresh', { key: 'EVICAP1-nonsense' })).status).toBe(400);
    expect(await readKey(ENV, key)).toMatchObject({ subscriptionId: 'sub_123' });
    expect(calls).toHaveLength(0);
  });

  it('reports Stripe outages as a server error, so the extension keeps its key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 })));
    const { key } = await mintKey(ENV, sub(), { email: 'jo@example.test', org: '' });
    expect((await post('/refresh', { key })).status).toBe(502);
  });
});

describe('extension side', () => {
  it('has the Stripe Payment Links, and stays offline until the service is set up', () => {
    expect(BILLING.checkoutMonthly).toMatch(/^https:\/\/buy\.stripe\.com\//);
    expect(BILLING.checkoutYearly).toMatch(/^https:\/\/buy\.stripe\.com\//);
    expect(onlinePurchaseReady({ ...BILLING, serviceUrl: null })).toBe(false);
    expect(onlinePurchaseReady({ ...BILLING, serviceUrl: 'https://evicap-licence.example.workers.dev' })).toBe(true);
  });

  it('makes no request when the service address is not set', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    if (!BILLING.serviceUrl) {
      await expect(renewSubscriptionKey('EVICAP1-x.y')).rejects.toThrow(/not switched on/);
      expect(f).not.toHaveBeenCalled();
    }
  });
});
