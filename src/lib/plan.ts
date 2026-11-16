import type { LemonLicence } from './billing';
import { checkLicence, type LicenceCheck, type LicencePayload } from './licence';

/**
 * Free and Pro (SPEC §9.3). Pro comes from an invoice licence key (§9.6), a
 * Lemon Squeezy subscription key (§9.2) or the 14-day trial. Checks run on this device only
 * (§9.4). Losing Pro never locks existing data: closed cases, exports and
 * verification always work.
 */

export const FREE_LIMITS = { openCases: 2, autoCapturesPerCase: 100, forensicPerMonth: 10 } as const;
export const TRIAL_DAYS = 14;
export const OFFLINE_GRACE_DAYS = 14;
export const RENEWAL_NOTICE_DAYS = 30;
export const PRICES = { monthly: '£4 per month', yearly: '£40 per year' } as const;

export type ProFeature = 'mediaPicker' | 'tabRecording' | 'exhibitExport' | 'brandedReports' | 'timestamping' | 'search';

const FEATURE_NAMES: Record<ProFeature, string> = {
  mediaPicker: 'Picking several images and videos at once',
  tabRecording: 'Recording a tab as video',
  exhibitExport: 'Exporting selected exhibits',
  brandedReports: 'Branded reports',
  timestamping: 'Trusted timestamps',
  search: 'Search',
};

export interface PlanState {
  trialStartedAtUtc: string | null;
  licenceKey: string | null;
  /** A Lemon Squeezy subscription key activated on this computer. */
  subscription: LemonLicence | null;
  /** The plan last recorded in the audit log, to notice changes such as expiry. */
  recorded: { plan: 'free' | 'pro'; source: Entitlement['source'] } | null;
}

export interface Entitlement {
  plan: 'free' | 'pro';
  source: 'licence' | 'subscription' | 'trial' | null;
  /** When the current Pro access ends, if known. */
  untilUtc: string | null;
  licence: LicencePayload | null;
  /** Why a stored licence key is not giving Pro (expired, invalid). */
  licenceProblem: string | null;
  trialStartedAtUtc: string | null;
  trialEndsAtUtc: string | null;
  canStartTrial: boolean;
  /** Within 30 days of the licence expiring. */
  renewalDue: boolean;
  subscription: LemonLicence | null;
  /** Why a stored subscription key is not giving Pro (ended, disabled, not checked for too long). */
  subscriptionProblem: string | null;
}

export const EMPTY_PLAN: PlanState = { trialStartedAtUtc: null, licenceKey: null, subscription: null, recorded: null };

const DAY = 86_400_000;

export function computeEntitlement(state: PlanState, licence: LicenceCheck | null, now = new Date()): Entitlement {
  const t = now.getTime();
  const trialEnds = state.trialStartedAtUtc ? new Date(Date.parse(state.trialStartedAtUtc) + TRIAL_DAYS * DAY).toISOString() : null;
  const base = {
    licence: licence?.ok ? licence.payload : null,
    licenceProblem: licence && !licence.ok ? licence.reason : licence?.ok && licence.expired ? `This licence expired on ${licence.payload.expiresAtUtc.slice(0, 10)}.` : null,
    trialStartedAtUtc: state.trialStartedAtUtc,
    trialEndsAtUtc: trialEnds,
    canStartTrial: !state.trialStartedAtUtc,
    renewalDue: false,
    subscription: state.subscription,
    subscriptionProblem: subscriptionProblem(state.subscription, t),
  };
  if (licence?.ok && !licence.expired) {
    const until = licence.payload.expiresAtUtc;
    return { ...base, plan: 'pro', source: 'licence', untilUtc: until, renewalDue: Date.parse(until) - t < RENEWAL_NOTICE_DAYS * DAY };
  }
  const sub = state.subscription;
  if (sub && !base.subscriptionProblem) {
    return { ...base, plan: 'pro', source: 'subscription', untilUtc: sub.expiresAtUtc };
  }
  if (trialEnds && Date.parse(trialEnds) > t) return { ...base, plan: 'pro', source: 'trial', untilUtc: trialEnds };
  return { ...base, plan: 'free', source: null, untilUtc: null };
}

function subscriptionProblem(sub: LemonLicence | null, t: number): string | null {
  if (!sub) return null;
  if (sub.status === 'expired') return 'Your subscription has ended. Renew it from your Lemon Squeezy account to use Pro again.';
  if (sub.status === 'disabled') return 'This subscription key has been disabled. Contact info@civildigital.co.uk.';
  if (sub.status === 'invalid') return sub.problem ?? 'This subscription key is no longer valid.';
  if (t - Date.parse(sub.lastOkAtUtc) >= OFFLINE_GRACE_DAYS * DAY) {
    return `EviCap has not been able to check your subscription for ${OFFLINE_GRACE_DAYS} days. Connect to the internet and press Check now.`;
  }
  return null;
}

/** Thrown when a free-plan limit or a Pro feature stops an action. The UI offers the upgrade. */
export class PlanError extends Error {
  constructor(message: string) {
    super(`${message} Start a free 14-day trial or upgrade in Settings → Plan.`);
    this.name = 'PlanError';
  }
}

export function proRequired(feature: ProFeature): PlanError {
  return new PlanError(`${FEATURE_NAMES[feature]} is part of EviCap Pro.`);
}

// ---- Storage (chrome.storage.local; readable from every extension page) ----

const KEY = 'plan';

export async function getPlanState(): Promise<PlanState> {
  const v = (await chrome.storage.local.get(KEY))[KEY] as Partial<PlanState> | undefined;
  return { ...EMPTY_PLAN, ...(v ?? {}) };
}

export async function setPlanState(patch: Partial<PlanState>): Promise<PlanState> {
  const next = { ...(await getPlanState()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function getEntitlement(now = new Date()): Promise<Entitlement> {
  const state = await getPlanState();
  const licence = state.licenceKey ? await checkLicence(state.licenceKey, now) : null;
  return computeEntitlement(state, licence, now);
}

export async function isPro(): Promise<boolean> {
  return (await getEntitlement()).plan === 'pro';
}

export async function requirePro(feature: ProFeature): Promise<void> {
  if (!(await isPro())) throw proRequired(feature);
}

/** Start of the current calendar month, UTC. */
export function monthStartUtc(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
