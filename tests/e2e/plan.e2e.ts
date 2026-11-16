import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Entitlement } from '../../src/lib/plan';
import type { AuditEvent } from '../../src/lib/types';
import { mintKey } from '../../service/src/index';
import { TEST_LICENCE_PRIVATE_JWK } from '../fixtures/licence-test-key';
import { testLicenceKey } from './licence';

const EXT = resolve('.output/chrome-mv3-e2e');
const BROWSER = process.env.EVICAP_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

let server: Server;
let base = '';
let ctx: BrowserContext;
let sw: Worker;
let extId = '';
let dash: Page;
let profile = '';

async function call(method: string, ...args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  return dash.evaluate(([m, a]) => chrome.runtime.sendMessage({ kind: 'rpc', method: m, args: a }), [method, args] as const);
}

async function rpc<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  const res = await call(method, ...args);
  if (!res?.ok) throw new Error(`rpc ${method} failed: ${res?.error}`);
  return res.value as T;
}

async function rpcError(method: string, ...args: unknown[]): Promise<string> {
  const res = await call(method, ...args);
  expect(res.ok, `${method} should fail`).toBe(false);
  return res.error ?? '';
}

const plan = () => rpc<{ entitlement: Entitlement; usage: { openCases: number; forensicThisMonth: number } }>('planStatus');

async function idbAll<T>(store: string): Promise<T[]> {
  return dash.evaluate(
    (s) =>
      new Promise<unknown[]>((res, rej) => {
        const open = indexedDB.open('evicap');
        open.onerror = () => rej(open.error);
        open.onsuccess = () => {
          if (!open.result.objectStoreNames.contains(s)) return rej(new Error(`no store ${s}`));
          const req = open.result.transaction(s).objectStore(s).getAll();
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        };
      }),
    store,
  ) as Promise<T[]>;
}

async function tabIdFor(url: string) {
  return (await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, url))!;
}

beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'evicap-e2e-plan-'));
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: BROWSER,
    headless: true,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--no-first-run',
    ],
    viewport: { width: 1200, height: 800 },
  });
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20_000 }));
  extId = new URL(sw.url()).host;
  dash = await ctx.newPage();
  await dash.goto(`chrome-extension://${extId}/dashboard.html`);
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Plan page</title><h1>Plan page</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">');
  });
  await new Promise<void>((r) =>
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
      r();
    }),
  );
});

afterAll(async () => {
  await ctx?.close();
  server?.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* locked briefly */
  }
});

describe('Free and Pro plans', () => {
  const ids: string[] = [];

  it('starts on Free, and allows two open cases', async () => {
    const p = await plan();
    expect(p.entitlement).toMatchObject({ plan: 'free', canStartTrial: true });
    for (const n of [1, 2]) ids.push((await rpc<{ id: string }>('createCase', { name: `Case ${n}`, autoCapture: false })).id);
    const err = await rpcError('createCase', { name: 'Case 3', autoCapture: false });
    expect(err).toMatch(/free plan allows 2 open cases/);
    expect(err).toMatch(/Settings → Plan/);
    expect((await plan()).usage.openCases).toBe(2);
  });

  it('lets a case be opened again only when there is room', async () => {
    await rpc('setCaseStatus', ids[1], 'closed');
    ids.push((await rpc<{ id: string }>('createCase', { name: 'Case 3', autoCapture: false })).id);
    expect(await rpcError('setCaseStatus', ids[1], 'open')).toMatch(/2 open cases/);
  });

  it('blocks the media picker and tab recording on Free, with the reason', async () => {
    await rpc('setActiveCase', ids[0]);
    const tab = await ctx.newPage();
    await tab.goto(`${base}/`);
    await tab.bringToFront();
    const tabId = await tabIdFor(`${base}/`);
    expect(await rpcError('pickMedia', tabId)).toMatch(/Picking several images and videos at once is part of EviCap Pro/);
    expect(await rpcError('startTabRecording', tabId)).toMatch(/Recording a tab as video is part of EviCap Pro/);
    await tab.close();
  });

  it('shows Free in the dashboard and greys out exhibit-only export', async () => {
    await dash.goto(`chrome-extension://${extId}/dashboard.html#/case/${ids[0]}`);
    await dash.getByRole('link', { name: 'Free', exact: true }).waitFor();
    await dash.getByRole('tab', { name: 'Export & verify' }).click();
    expect(await dash.getByRole('radio', { name: /Selected exhibits/ }).isDisabled()).toBe(true);
  });

  it('rejects tampered, expired and foreign licence keys', async () => {
    const good = await testLicenceKey();
    const [body = '', sig = ''] = good.slice('EVICAP1-'.length).split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = `EVICAP1-${Buffer.from(JSON.stringify({ ...payload, org: 'Someone else' })).toString('base64url')}.${sig}`;
    expect(await rpcError('activateLicence', forged)).toMatch(/signature does not check/);
    const old = await testLicenceKey({ months: 1, now: new Date('2024-01-01T00:00:00Z') });
    expect(await rpcError('activateLicence', old)).toMatch(/expired on 2024-02-01/);
    expect(await rpcError('activateLicence', 'not a key')).toMatch(/not an EviCap licence key/);
    expect((await plan()).entitlement.plan).toBe('free');
  });

  it('activates a licence key from Settings, unlocking Pro and recording it in open cases', async () => {
    await dash.goto(`chrome-extension://${extId}/dashboard.html#/settings`);
    await dash.getByRole('textbox', { name: 'Licence key' }).fill(await testLicenceKey());
    await dash.getByRole('button', { name: 'Activate licence' }).click();
    await dash.getByText('Licence activated. EviCap Pro is on.').waitFor();
    await dash.getByText(/Pro through a licence for tester@example.test/).waitFor();
    await dash.getByRole('link', { name: 'Pro', exact: true }).waitFor();

    const p = await plan();
    expect(p.entitlement).toMatchObject({ plan: 'pro', source: 'licence' });
    const events = await idbAll<AuditEvent>('audit');
    const changed = events.filter((e) => e.type === 'licence.changed');
    // Cases 1 and 3 are open; case 2 is closed and is left alone.
    expect(changed.map((e) => e.caseId).sort()).toEqual([ids[0], ids[2]].sort());
    expect(changed[0]?.payload).toMatchObject({ reason: 'licence key activated', plan: 'pro', source: 'licence', email: 'tester@example.test' });

    // Pro lifts the open-case limit.
    await rpc('setCaseStatus', ids[1], 'open');
    expect((await plan()).usage.openCases).toBe(3);
  });

  it('removes the licence, and the trial gives Pro once', async () => {
    await rpc('removeLicence');
    expect((await plan()).entitlement.plan).toBe('free');
    await dash.goto(`chrome-extension://${extId}/dashboard.html#/settings`);
    await dash.getByRole('button', { name: 'Start 14-day free trial' }).click();
    await dash.getByText('Your 14-day Pro trial has started.').waitFor();
    const p = await plan();
    expect(p.entitlement).toMatchObject({ plan: 'pro', source: 'trial', canStartTrial: false });
    expect(Date.parse(p.entitlement.trialEndsAtUtc!) - Date.now()).toBeGreaterThan(13.9 * 86_400_000);
    expect(await rpcError('startTrial')).toMatch(/already been used/);
    const reasons = (await idbAll<AuditEvent>('audit')).filter((e) => e.type === 'licence.changed' && e.caseId === ids[0]).sort((a, b) => a.seq - b.seq).map((e) => (e.payload as { reason: string }).reason);
    expect(reasons).toEqual(['licence key activated', 'licence key removed', '14-day trial started']);
  });

  it('stops forensic captures after ten in a month on Free', async () => {
    // End the trial by moving its start back, then stand in ten forensic captures for this month.
    await sw.evaluate(async () => {
      const { plan } = (await chrome.storage.local.get('plan')) as { plan: Record<string, unknown> };
      await chrome.storage.local.set({ plan: { ...plan, trialStartedAtUtc: '2020-01-01T00:00:00.000Z' } });
    });
    expect((await plan()).entitlement.plan).toBe('free');
    await dash.evaluate(
      (caseId) =>
        new Promise<void>((res, rej) => {
          const open = indexedDB.open('evicap');
          open.onsuccess = () => {
            const tx = open.result.transaction('captures', 'readwrite');
            for (let i = 0; i < 10; i++) {
              tx.objectStore('captures').put({ id: `fake-${i}`, caseId, type: 'forensic', startedAtUtc: new Date().toISOString(), files: [], deleted: false });
            }
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
          };
        }),
      ids[0],
    );
    expect((await plan()).usage.forensicThisMonth).toBe(10);
    const tab = await ctx.newPage();
    await tab.goto(`${base}/`);
    await tab.bringToFront();
    expect(await rpcError('forensicCapture', false, await tabIdFor(`${base}/`))).toMatch(/10 forensic captures a month/);
  });
});

describe('Stripe subscriptions (fake licence service)', () => {
  const ENV = { STRIPE_SECRET_KEY: '', SIGNING_KEY_JWK: JSON.stringify(TEST_LICENCE_PRIVATE_JWK), PRICE_IDS: 'price_month' };
  const DAY_S = 86_400;
  /** A Stripe subscription as the service would see it, paid up to `endsInDays` from now. */
  const sub = (endsInDays: number) => ({
    id: 'sub_e2e',
    status: 'active',
    items: { data: [{ price: { id: 'price_month' }, current_period_end: Math.floor(Date.now() / 1000) + endsInDays * DAY_S }] },
  });
  let service: Server;
  let state: 'active' | 'ended' | 'down' = 'active';
  const calls: string[] = [];

  beforeAll(async () => {
    service = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST' || req.url !== '/refresh') return send(404, { error: 'Not found' });
        const { key } = JSON.parse(raw) as { key: string };
        calls.push(key);
        if (state === 'down') return send(502, { error: 'Stripe could not be reached.' });
        if (state === 'ended') return send(200, { status: 'ended', reason: 'Your subscription has ended.' });
        const minted = await mintKey(ENV, sub(30), { email: 'jo@example.test', org: 'Jo Tester' });
        send(200, { status: 'active', key: minted.key, expiresAtUtc: minted.payload.expiresAtUtc });
      });
    });
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', () => r()));
    const a = service.address();
    await sw.evaluate((u) => chrome.storage.local.set({ e2eLicenceService: u }), `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
  });

  afterAll(() => service?.close());

  it('offers the Stripe checkout in Settings', async () => {
    expect((await plan()).entitlement.plan).toBe('free');
    await dash.goto(`chrome-extension://${extId}/dashboard.html#/settings`);
    expect(await dash.getByRole('link', { name: 'Buy monthly' }).getAttribute('href')).toBe('https://example.test/buy/monthly');
    expect(await dash.getByRole('link', { name: 'Buy yearly' }).getAttribute('href')).toBe('https://example.test/buy/yearly');
  });

  it('activates the key from the after-payment page without contacting anyone', async () => {
    const { key } = await mintKey(ENV, sub(30), { email: 'jo@example.test', org: 'Jo Tester' });
    await dash.getByRole('textbox', { name: 'Licence key' }).fill(key);
    await dash.getByRole('button', { name: 'Activate licence' }).click();
    await dash.getByText('Licence activated. EviCap Pro is on.').waitFor();
    await dash.getByText(/Pro through your subscription for jo@example.test/).waitFor();
    expect(calls).toHaveLength(0);
    const p = await plan();
    expect(p.entitlement).toMatchObject({ plan: 'pro', source: 'subscription', renewalDue: false });
    const ev = (await idbAll<AuditEvent>('audit')).filter((e) => e.type === 'licence.changed').sort((a, b) => a.seq - b.seq).at(-1);
    expect(ev?.payload).toMatchObject({ reason: 'subscription key activated', plan: 'pro', source: 'subscription', subscription: 'stripe', subscriptionId: 'sub_e2e' });
  });

  it('renews the key through the service, sending only the key', async () => {
    const before = (await sw.evaluate(async () => ((await chrome.storage.local.get('plan')) as { plan: { subscription: { key: string } } }).plan.subscription.key));
    await dash.getByRole('button', { name: 'Check now' }).click();
    await dash.getByText('Subscription checked.').waitFor();
    expect(calls).toEqual([before]);
    const after = (await sw.evaluate(async () => ((await chrome.storage.local.get('plan')) as { plan: { subscription: { key: string; checkedAtUtc: string } } }).plan.subscription));
    expect(after.key).not.toBe(before);
    expect(after.checkedAtUtc).toBeTruthy();
  });

  it('keeps Pro while the service is down', async () => {
    state = 'down';
    await rpc('checkSubscription');
    const p = await plan();
    expect(p.entitlement.plan).toBe('pro');
    expect(p.entitlement.subscription?.problem).toMatch(/Stripe could not be reached/);
  });

  it('drops to Free when the subscription ends', async () => {
    state = 'ended';
    await dash.getByRole('button', { name: 'Check now' }).click();
    await dash.getByText(/Your subscription has ended. Subscribe again/).waitFor();
    expect((await plan()).entitlement.plan).toBe('free');
  });

  it('renews an out-of-date key when it is pasted, and removes keys locally', async () => {
    state = 'active';
    const stale = await mintKey(ENV, sub(-20), { email: 'jo@example.test', org: 'Jo Tester' });
    const n = calls.length;
    await rpc('activateLicence', stale.key);
    expect(calls.length).toBe(n + 1);
    expect((await plan()).entitlement).toMatchObject({ plan: 'pro', source: 'subscription' });
    await rpc('removeLicence', 'subscription');
    expect(calls.length).toBe(n + 1);
    const p = await plan();
    expect(p.entitlement.plan).toBe('free');
    expect(p.entitlement.subscription).toBeNull();
  });
});
