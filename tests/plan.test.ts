import { beforeEach, describe, expect, it } from 'vitest';
import { checkLicence, decodeLicence } from '../src/lib/licence';
import { computeEntitlement, EMPTY_PLAN, getEntitlement, monthStartUtc, PlanError, proRequired, setPlanState } from '../src/lib/plan';
import { signLicence } from '../tools/issue-licence';
import { TEST_LICENCE_PRIVATE_JWK } from './fixtures/licence-test-key';

const TEST_PUBLIC: JsonWebKey = { kty: 'EC', crv: 'P-256', x: TEST_LICENCE_PRIVATE_JWK.x, y: TEST_LICENCE_PRIVATE_JWK.y };
const NOW = new Date('2026-06-01T12:00:00Z');
const DAY = 86_400_000;

async function key(months = 12, now = NOW) {
  return (await signLicence(TEST_LICENCE_PRIVATE_JWK, { org: 'Acme Ltd', email: 'jo@acme.example', months, now })).key;
}

describe('licence keys', () => {
  it('accepts a key signed by a trusted key, and reads its details', async () => {
    const r = await checkLicence(await key(), NOW, [TEST_PUBLIC]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.expired).toBe(false);
    expect(r.payload).toMatchObject({ org: 'Acme Ltd', email: 'jo@acme.example', plan: 'pro', expiresAtUtc: '2027-06-01T12:00:00.000Z' });
  });

  it('ignores whitespace and line breaks from email clients', async () => {
    const k = await key();
    const broken = k.match(/.{1,40}/g)!.join('\n  ');
    expect((await checkLicence(broken, NOW, [TEST_PUBLIC])).ok).toBe(true);
  });

  it('rejects a key whose details were changed', async () => {
    const k = await key();
    const d = decodeLicence(k)!;
    const forged = { ...d.payload, expiresAtUtc: '2099-01-01T00:00:00.000Z' };
    const body = Buffer.from(JSON.stringify(forged)).toString('base64url');
    const sig = k.split('.')[1];
    const r = await checkLicence(`EVICAP1-${body}.${sig}`, NOW, [TEST_PUBLIC]);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toMatch(/signature/);
  });

  it('rejects a key signed by another key (the production build does not trust the test key)', async () => {
    const r = await checkLicence(await key(), NOW);
    expect(r.ok).toBe(false);
  });

  it('reports an expired key as expired', async () => {
    const r = await checkLicence(await key(1), new Date(NOW.getTime() + 40 * DAY), [TEST_PUBLIC]);
    expect(r).toMatchObject({ ok: true, expired: true });
  });

  it('rejects text that is not a key', async () => {
    expect(await checkLicence('hello', NOW, [TEST_PUBLIC])).toMatchObject({ ok: false });
    expect(await checkLicence('EVICAP1-abc', NOW, [TEST_PUBLIC])).toMatchObject({ ok: false });
  });
});

describe('entitlement', () => {
  it('is free with nothing set, and the trial can start', () => {
    const e = computeEntitlement(EMPTY_PLAN, null, NOW);
    expect(e).toMatchObject({ plan: 'free', source: null, canStartTrial: true });
  });

  it('gives Pro for 14 days of trial, then free', () => {
    const state = { ...EMPTY_PLAN, trialStartedAtUtc: NOW.toISOString() };
    expect(computeEntitlement(state, null, new Date(NOW.getTime() + 13 * DAY))).toMatchObject({ plan: 'pro', source: 'trial', canStartTrial: false });
    expect(computeEntitlement(state, null, new Date(NOW.getTime() + 14 * DAY + 1))).toMatchObject({ plan: 'free', canStartTrial: false });
  });

  it('prefers a valid licence and flags renewal in the last 30 days', async () => {
    const lic = await checkLicence(await key(1), NOW, [TEST_PUBLIC]);
    const e = computeEntitlement(EMPTY_PLAN, lic, new Date(NOW.getTime() + 10 * DAY));
    expect(e).toMatchObject({ plan: 'pro', source: 'licence', renewalDue: true, untilUtc: '2026-07-01T12:00:00.000Z' });
    const long = computeEntitlement(EMPTY_PLAN, await checkLicence(await key(12), NOW, [TEST_PUBLIC]), NOW);
    expect(long.renewalDue).toBe(false);
  });

  it('falls back to free with a reason when the licence has expired', async () => {
    const later = new Date(NOW.getTime() + 40 * DAY);
    const e = computeEntitlement(EMPTY_PLAN, await checkLicence(await key(1), later, [TEST_PUBLIC]), later);
    expect(e.plan).toBe('free');
    expect(e.licenceProblem).toMatch(/expired on 2026-07-01/);
  });

  it('keeps a paid subscription for 14 days without an answer from the provider', () => {
    const sub = {
      provider: 'extensionpay' as const,
      paid: true,
      status: 'active',
      plan: 'monthly',
      email: null,
      checkedAtUtc: NOW.toISOString(),
      lastOkAtUtc: NOW.toISOString(),
    };
    const state = { ...EMPTY_PLAN, subscription: sub };
    expect(computeEntitlement(state, null, new Date(NOW.getTime() + 13 * DAY)).plan).toBe('pro');
    expect(computeEntitlement(state, null, new Date(NOW.getTime() + 15 * DAY)).plan).toBe('free');
    expect(computeEntitlement({ ...state, subscription: { ...sub, status: 'canceled' } }, null, NOW).plan).toBe('free');
  });

  it('reads the stored plan', async () => {
    await setPlanState({ ...EMPTY_PLAN, trialStartedAtUtc: new Date().toISOString() });
    expect((await getEntitlement()).plan).toBe('pro');
    await setPlanState(EMPTY_PLAN);
    expect((await getEntitlement()).plan).toBe('free');
  });

  it('explains how to upgrade when Pro is needed', () => {
    const e = proRequired('mediaPicker');
    expect(e).toBeInstanceOf(PlanError);
    expect(e.message).toBe('Picking several images and videos at once is part of EviCap Pro. Start a free 14-day trial or upgrade in Settings → Plan.');
  });

  it('counts the month from the first, in UTC', () => {
    expect(monthStartUtc(new Date('2026-03-31T23:30:00-02:00'))).toBe('2026-04-01T00:00:00.000Z');
  });
});

beforeEach(async () => {
  await chrome.storage.local.clear();
});
