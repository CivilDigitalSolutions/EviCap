import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateLemon, checkProduct, isLemonKey, validateLemon, type LemonLicence, type LemonResponse } from '../src/lib/billing';
import { LEMON, onlinePurchaseReady, type LemonConfig } from '../src/lib/billing-config';

const KEY = '38b1460a-5104-4067-a91d-77b872934d51';
const LIC: LemonLicence = {
  key: KEY,
  instanceId: 'inst-1',
  status: 'active',
  email: 'jo@example.test',
  variantName: 'Monthly',
  expiresAtUtc: null,
  lastOkAtUtc: '2026-11-01T00:00:00.000Z',
  checkedAtUtc: '2026-11-01T00:00:00.000Z',
  problem: null,
};
const CONFIG: LemonConfig = { ...LEMON, storeId: 999, productId: 4242 };

function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Lemon Squeezy keys', () => {
  it('tells subscription keys (UUIDs) from EviCap licence keys', () => {
    expect(isLemonKey(KEY)).toBe(true);
    expect(isLemonKey(`  ${KEY.toUpperCase()}\n`)).toBe(true);
    expect(isLemonKey('EVICAP1-abc.def')).toBe(false);
    expect(isLemonKey('38b1460a51044067a91d77b872934d51')).toBe(false);
  });

  it('accepts only keys for EviCap Pro in Civil Digital’s store', () => {
    const meta = (store_id: number, product_id: number) => ({ meta: { store_id, product_id } }) as unknown as LemonResponse;
    expect(checkProduct(meta(999, 4242), CONFIG)).toBeNull();
    expect(checkProduct(meta(1, 4242), CONFIG)).toMatch(/different product/);
    expect(checkProduct(meta(999, 1), CONFIG)).toMatch(/different product/);
  });

  it('makes no request while the store is not set up (production build today)', async () => {
    expect(onlinePurchaseReady()).toBe(false);
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(activateLemon(KEY, 'EviCap on Edge, Windows 11')).rejects.toThrow(/not available yet/);
    expect(f).not.toHaveBeenCalled();
  });

  it('keeps the last answer when Lemon Squeezy cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const r = await validateLemon(LIC, '2026-11-02T00:00:00.000Z');
    expect(r).toMatchObject({ status: 'active', lastOkAtUtc: LIC.lastOkAtUtc, checkedAtUtc: '2026-11-02T00:00:00.000Z' });
    expect(r.problem).toMatch(/could not be reached/);
  });

  it('treats a server error like an unreachable server', async () => {
    vi.stubGlobal('fetch', reply(503, { error: 'down' }));
    const r = await validateLemon(LIC, '2026-11-02T00:00:00.000Z');
    expect(r.status).toBe('active');
    expect(r.problem).toMatch(/unavailable/);
  });

  it('marks a key Lemon Squeezy no longer knows as invalid', async () => {
    vi.stubGlobal('fetch', reply(404, { valid: false, error: 'license_key not found.' }));
    const r = await validateLemon(LIC, '2026-11-02T00:00:00.000Z');
    expect(r).toMatchObject({ status: 'invalid', problem: 'license_key not found.', lastOkAtUtc: '2026-11-02T00:00:00.000Z' });
  });

  it('sends only the key and this computer’s activation ID when checking', async () => {
    const f = reply(404, { valid: false, error: 'x' });
    vi.stubGlobal('fetch', f);
    await validateLemon(LIC);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.lemonsqueezy.com/v1/licenses/validate');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit' });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ license_key: KEY, instance_id: 'inst-1' });
  });
});
