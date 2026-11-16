import { appendEvent } from './audit';
import { renewSubscriptionKey } from './billing';
import { getDb, listCaptures } from './db';
import { checkLicence } from './licence';
import { FREE_LIMITS, getEntitlement, getPlanState, monthStartUtc, PlanError, setPlanState, type Entitlement } from './plan';
import { nowUtc } from './util';

/** Service-worker side of plans: limits, licence activation, the trial, and audit records. */

export interface PlanUsage {
  openCases: number;
  forensicThisMonth: number;
}

export async function usage(): Promise<PlanUsage> {
  const db = await getDb();
  const cases = await db.getAll('cases');
  const since = monthStartUtc();
  let forensicThisMonth = 0;
  let cursor = await db.transaction('captures').store.openCursor();
  while (cursor) {
    const c = cursor.value;
    if (c.type === 'forensic' && !c.parent && c.startedAtUtc >= since) forensicThisMonth++;
    cursor = await cursor.continue();
  }
  return { openCases: cases.filter((c) => c.status === 'open').length, forensicThisMonth };
}

export async function assertCanOpenCase(excludeId?: string) {
  if ((await getEntitlement()).plan === 'pro') return;
  const open = (await (await getDb()).getAll('cases')).filter((c) => c.status === 'open' && c.id !== excludeId).length;
  if (open >= FREE_LIMITS.openCases) {
    throw new PlanError(`The free plan allows ${FREE_LIMITS.openCases} open cases at a time. Close a case first (closed cases stay fully viewable and exportable).`);
  }
}

export async function assertForensicQuota() {
  if ((await getEntitlement()).plan === 'pro') return;
  const { forensicThisMonth } = await usage();
  if (forensicThisMonth >= FREE_LIMITS.forensicPerMonth) {
    throw new PlanError(`The free plan includes ${FREE_LIMITS.forensicPerMonth} forensic captures a month, and this month's are used. Screenshots and automatic captures still work.`);
  }
}

/** Free plan: up to 100 automatic captures per case. The first skip is logged in the case's audit log. */
export async function autoCaptureAllowed(caseId: string, url: string): Promise<boolean> {
  if ((await getEntitlement()).plan === 'pro') return true;
  const count = (await listCaptures(caseId)).filter((c) => c.type === 'auto' && !c.deleted).length;
  if (count < FREE_LIMITS.autoCapturesPerCase) return true;
  const key = 'autoLimitLogged';
  const logged = ((await chrome.storage.local.get(key))[key] as string[] | undefined) ?? [];
  if (!logged.includes(caseId)) {
    await appendEvent(caseId, 'capture.skipped', {
      url,
      reason: `free plan limit of ${FREE_LIMITS.autoCapturesPerCase} automatic captures per case reached; further pages in this case are logged but not captured automatically`,
    });
    await chrome.storage.local.set({ [key]: [...logged, caseId] });
  }
  return false;
}

function summary(e: Entitlement) {
  return {
    plan: e.plan,
    source: e.source,
    untilUtc: e.untilUtc,
    ...(e.licence ? { licenceId: e.licence.licenceId, org: e.licence.org, email: e.licence.email, licenceExpiresAtUtc: e.licence.expiresAtUtc } : {}),
    ...(e.source === 'subscription' && e.subscription
      ? { subscription: 'stripe', subscriptionId: e.subscription.subscriptionId, email: e.subscription.email, licenceExpiresAtUtc: e.subscription.expiresAtUtc }
      : {}),
  };
}

/**
 * Write a `licence.changed` event to every open case when the plan changes
 * (activation, removal, trial start, expiry). Closed cases are left as they are.
 */
export async function recordPlanChange(reason: string, force = false): Promise<Entitlement> {
  const e = await getEntitlement();
  const state = await getPlanState();
  const same = state.recorded?.plan === e.plan && state.recorded?.source === e.source;
  if (same && !force) return e;
  const cases = (await (await getDb()).getAll('cases')).filter((c) => c.status === 'open');
  for (const c of cases) await appendEvent(c.id, 'licence.changed', { reason, ...summary(e) });
  await setPlanState({ recorded: { plan: e.plan, source: e.source } });
  return e;
}

export async function activateLicence(text: string): Promise<Entitlement> {
  const clean = text.replace(/\s+/g, '');
  const check = await checkLicence(clean);
  if (!check.ok) throw new Error(check.reason);
  if (check.payload.subscriptionId) return activateSubscription(clean, check.expired);
  if (check.expired) throw new Error(`This licence expired on ${check.payload.expiresAtUtc.slice(0, 10)}. Contact info@civildigital.co.uk to renew it.`);
  const previous = (await getPlanState()).licenceKey;
  await setPlanState({ licenceKey: clean });
  return recordPlanChange(previous ? 'licence key replaced' : 'licence key activated', true);
}

/** A subscription key from the licence service's page. Checked on this computer; renewed online only if it has run out. */
async function activateSubscription(key: string, expired: boolean): Promise<Entitlement> {
  const previous = (await getPlanState()).subscription;
  let current = key;
  if (expired) {
    const r = await renewSubscriptionKey(key);
    if (r.status === 'ended') throw new Error(`${r.reason} Subscribe again from Settings → Plan to use Pro.`);
    current = r.key;
  }
  await setPlanState({ subscription: { key: current, checkedAtUtc: expired ? nowUtc() : null, problem: null, ended: null } });
  return recordPlanChange(previous ? 'subscription key replaced' : 'subscription key activated', true);
}

/** Remove the invoice licence, the subscription key, or both, from this computer. Nothing is sent. */
export async function removeLicence(kind: 'licence' | 'subscription' | 'all' = 'all'): Promise<Entitlement> {
  const state = await getPlanState();
  const removed: string[] = [];
  if (kind !== 'subscription' && state.licenceKey) {
    await setPlanState({ licenceKey: null });
    removed.push('licence key');
  }
  if (kind !== 'licence' && state.subscription) {
    await setPlanState({ subscription: null });
    removed.push('subscription key');
  }
  if (!removed.length) return getEntitlement();
  return recordPlanChange(`${removed.join(' and ')} removed`, true);
}

const RECHECK_MS = 20 * 3_600_000;

/**
 * Renew the subscription key through the licence service: about once a day,
 * or now when `force` is set. A failure leaves the current key in place; it
 * stays valid until the end of the paid period plus 14 days.
 */
export async function checkSubscription(force = false): Promise<void> {
  const sub = (await getPlanState()).subscription;
  if (!sub || (sub.ended && !force)) return;
  if (!force && sub.checkedAtUtc && Date.now() - Date.parse(sub.checkedAtUtc) < RECHECK_MS) return;
  let next = { ...sub, checkedAtUtc: nowUtc() };
  try {
    const r = await renewSubscriptionKey(sub.key);
    if (r.status === 'ended') next = { ...next, ended: r.reason, problem: null };
    else {
      const [was, now] = [await checkLicence(sub.key), await checkLicence(r.key)];
      if (!now.ok || now.payload.subscriptionId !== (was.ok ? was.payload.subscriptionId : undefined)) {
        next = { ...next, problem: 'The licence service sent a key that does not match this subscription.' };
      } else next = { ...next, key: r.key, problem: null, ended: null };
    }
  } catch (e) {
    next = { ...next, problem: e instanceof Error ? e.message : String(e) };
  }
  // The key may have been removed or replaced while the check ran.
  if ((await getPlanState()).subscription?.key === sub.key) await setPlanState({ subscription: next });
}

export async function startTrial(): Promise<Entitlement> {
  const state = await getPlanState();
  if (state.trialStartedAtUtc) throw new Error('The free trial has already been used on this computer.');
  await setPlanState({ trialStartedAtUtc: nowUtc() });
  return recordPlanChange('14-day trial started', true);
}

/** On start-up and every 6 hours: notice the end of a licence, trial or subscription. */
export async function refreshPlan(): Promise<Entitlement> {
  await checkSubscription().catch(() => undefined);
  return recordPlanChange('plan changed');
}
