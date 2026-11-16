import { appendEvent } from './audit';
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
  const check = await checkLicence(text);
  if (!check.ok) throw new Error(check.reason);
  if (check.expired) throw new Error(`This licence expired on ${check.payload.expiresAtUtc.slice(0, 10)}. Contact info@civildigital.co.uk to renew it.`);
  const previous = (await getPlanState()).licenceKey;
  await setPlanState({ licenceKey: text.replace(/\s+/g, '') });
  return recordPlanChange(previous ? 'licence key replaced' : 'licence key activated', true);
}

export async function removeLicence(): Promise<Entitlement> {
  await setPlanState({ licenceKey: null });
  return recordPlanChange('licence key removed', true);
}

export async function startTrial(): Promise<Entitlement> {
  const state = await getPlanState();
  if (state.trialStartedAtUtc) throw new Error('The free trial has already been used on this computer.');
  await setPlanState({ trialStartedAtUtc: nowUtc() });
  return recordPlanChange('14-day trial started', true);
}

/** On start-up and daily: notice expiry of a licence, trial or subscription. */
export async function refreshPlan(): Promise<Entitlement> {
  return recordPlanChange('plan changed');
}
