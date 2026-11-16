import { describe, expect, it } from 'vitest';
import { mirrorFolderName } from '../src/lib/mirror-queue';
import { isRecordableUrl, shouldRecord } from '../src/lib/recorder';
import { DEFAULT_DENYLIST } from '../src/lib/settings';
import { hostMatches, KeyedMutex } from '../src/lib/util';

const openAll = { status: 'open' as const, recordIncognito: false, scope: { mode: 'all' as const, domains: [] } };

describe('shouldRecord', () => {
  it('records ordinary pages', () => {
    expect(shouldRecord('https://example.com/a', false, openAll, DEFAULT_DENYLIST)).toBe(true);
  });

  it('skips browser and extension pages', () => {
    expect(isRecordableUrl('chrome://settings')).toBe(false);
    expect(isRecordableUrl('chrome-extension://abc/x.html')).toBe(false);
    expect(shouldRecord('about:blank', false, openAll, [])).toBe(false);
  });

  it('never logs denylisted domains or their subdomains', () => {
    expect(shouldRecord('https://mail.google.com/mail/u/0', false, openAll, DEFAULT_DENYLIST)).toBe(false);
    expect(shouldRecord('https://www.paypal.com/', false, openAll, DEFAULT_DENYLIST)).toBe(false);
    expect(shouldRecord('https://notpaypal.com/', false, openAll, DEFAULT_DENYLIST)).toBe(true);
  });

  it('respects a listed-domains scope', () => {
    const scoped = { ...openAll, scope: { mode: 'listed' as const, domains: ['example.org'] } };
    expect(shouldRecord('https://www.example.org/p', false, scoped, [])).toBe(true);
    expect(shouldRecord('https://example.com/p', false, scoped, [])).toBe(false);
  });

  it('needs a per-case opt-in for incognito', () => {
    expect(shouldRecord('https://example.com', true, openAll, [])).toBe(false);
    expect(shouldRecord('https://example.com', true, { ...openAll, recordIncognito: true }, [])).toBe(true);
  });

  it('does not record into a closed case', () => {
    expect(shouldRecord('https://example.com', false, { ...openAll, status: 'closed' }, [])).toBe(false);
  });
});

describe('helpers', () => {
  it('matches hosts and subdomains only', () => {
    expect(hostMatches('a.b.example.com', 'example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(true);
    expect(hostMatches('badexample.com', 'example.com')).toBe(false);
  });

  it('makes safe mirror folder names', () => {
    expect(mirrorFolderName('Smith / profile: "x"', 'OP-HAWK 1', '1a2b3c4d-0000')).toBe('EviCap_OP-HAWK-1_Smith-profile-x_1a2b3c4d');
  });

  it('runs keyed work one at a time, in order, even after a failure', async () => {
    const m = new KeyedMutex();
    const order: number[] = [];
    const slow = (n: number, ms: number) => () => new Promise<void>((r) => setTimeout(() => (order.push(n), r()), ms));
    const p1 = m.run('k', slow(1, 30));
    const p2 = m.run('k', async () => {
      throw new Error('boom');
    });
    const p3 = m.run('k', slow(3, 1));
    await Promise.allSettled([p1, p2, p3]);
    expect(order).toEqual([1, 3]);
    await expect(p2).rejects.toThrow('boom');
  });
});
