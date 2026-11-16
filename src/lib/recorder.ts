import { appendEvent } from './audit';
import { getDb } from './db';
import { isMirrorEnabled, notifyMirror } from './mirror-queue';
import { getSettings, getState } from './settings';
import type { CaseRecord, VisitRecord } from './types';
import { hostMatches, hostOf, nowUtc, tzOffsetMinutes, uuid } from './util';

/**
 * Running log of sites visited (SPEC F2). Per-tab state lives in
 * chrome.storage.session so it survives the service worker being stopped.
 */

export function isRecordableUrl(url: string): boolean {
  return /^(https?|file):/i.test(url);
}

/** Should this URL be logged for this case? (F1 denylist, domain scope, incognito.) */
export function shouldRecord(
  url: string,
  incognito: boolean,
  c: Pick<CaseRecord, 'scope' | 'recordIncognito' | 'status'>,
  denylist: string[],
): boolean {
  if (c.status !== 'open' || !isRecordableUrl(url)) return false;
  if (incognito && !c.recordIncognito) return false;
  const host = hostOf(url);
  if (denylist.some((d) => hostMatches(host, d))) return false;
  if (c.scope.mode === 'listed') return c.scope.domains.some((d) => hostMatches(host, d));
  return true;
}

interface TabVisit {
  visitId: string;
  caseId: string;
  url: string;
  focusedMs: number;
}

interface SessionState {
  tabs: Record<string, TabVisit>;
  /** Redirect chains collected from webRequest before the navigation commits. */
  chains: Record<string, string[]>;
  focus: { tabId: number; since: number } | null;
}

async function loadSession(): Promise<SessionState> {
  const { recorder } = await chrome.storage.session.get('recorder');
  return (recorder as SessionState | undefined) ?? { tabs: {}, chains: {}, focus: null };
}

async function saveSession(s: SessionState) {
  await chrome.storage.session.set({ recorder: s });
}

// All recorder updates are serialised, because events arrive in bursts.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch((err) => console.warn('[EviCap recorder]', err));
  return next;
}

export type VisitListener = (v: VisitRecord) => void;
let onVisitRecorded: VisitListener = () => undefined;
export function setVisitListener(fn: VisitListener) {
  onVisitRecorded = fn;
}

// ---- Event handlers (wired up in background.ts) ----

export function onMainFrameRequest(tabId: number, url: string) {
  return serial(async () => {
    const s = await loadSession();
    // A redirect raises a new request for its target; keep the chain in that case.
    const chain = s.chains[tabId];
    if (!chain || chain[chain.length - 1] !== url) s.chains[tabId] = [url];
    await saveSession(s);
  });
}

export function onRedirect(tabId: number, fromUrl: string, toUrl: string) {
  return serial(async () => {
    const s = await loadSession();
    const chain = s.chains[tabId] ?? [fromUrl];
    if (chain[chain.length - 1] !== fromUrl) chain.push(fromUrl);
    chain.push(toUrl);
    s.chains[tabId] = chain;
    await saveSession(s);
  });
}

export interface CommitDetails {
  tabId: number;
  url: string;
  transitionType: string;
  transitionQualifiers: string[];
  spa: boolean;
}

export function onCommitted(d: CommitDetails) {
  return serial(async () => {
    const state = await getState();
    const s = await loadSession();
    const chain = s.chains[d.tabId];
    delete s.chains[d.tabId];
    const current = s.tabs[d.tabId];
    // Ignore repeated SPA updates to the same address.
    if (d.spa && current && current.url === d.url) {
      await saveSession(s);
      return;
    }
    if (current) await closeVisit(s, d.tabId);

    if (!state.recording || !state.activeCaseId) {
      await saveSession(s);
      return;
    }
    const db = await getDb();
    const c = await db.get('cases', state.activeCaseId);
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(d.tabId);
    } catch {
      /* tab already gone */
    }
    const settings = await getSettings();
    if (!c || !tab || !shouldRecord(d.url, tab.incognito, c, settings.denylist)) {
      await saveSession(s);
      return;
    }

    const redirectChain = chain && chain.length > 1 ? chain : [];
    const visit: Omit<VisitRecord, 'auditEventHash' | 'seq'> = {
      id: uuid(),
      caseId: c.id,
      url: redirectChain[0] ?? d.url,
      finalUrl: d.url,
      redirectChain,
      title: tab.title && tab.title !== d.url ? tab.title : '',
      tabId: d.tabId,
      windowId: tab.windowId,
      openerTabId: tab.openerTabId ?? null,
      transitionType: d.transitionType,
      transitionQualifiers: d.transitionQualifiers,
      referrer: null,
      navigatedAtUtc: nowUtc(),
      tzOffsetMinutes: tzOffsetMinutes(),
      leftAtUtc: null,
      focusedMs: 0,
      spa: d.spa,
      incognito: tab.incognito,
      autoCaptureId: null,
      tags: [],
    };
    const mirrorOn = await isMirrorEnabled();
    let saved: VisitRecord | null = null;
    await appendEvent(
      c.id,
      'visit.recorded',
      {
        visitId: visit.id,
        seq: c.nextVisitSeq,
        url: visit.url,
        finalUrl: visit.finalUrl,
        redirectChain: visit.redirectChain,
        tabId: visit.tabId,
        windowId: visit.windowId,
        openerTabId: visit.openerTabId,
        transitionType: visit.transitionType,
        transitionQualifiers: visit.transitionQualifiers,
        navigatedAtUtc: visit.navigatedAtUtc,
        tzOffsetMinutes: visit.tzOffsetMinutes,
        spa: visit.spa,
        incognito: visit.incognito,
      },
      {
        stores: ['visits'],
        mutateCase: (cur) => ({ ...cur, nextVisitSeq: cur.nextVisitSeq + 1 }),
        alsoWrite(tx, event) {
          saved = { ...visit, seq: c.nextVisitSeq, auditEventHash: event.hash };
          void tx.objectStore('visits').add(saved);
          if (mirrorOn) {
            void tx.objectStore('mirrorQueue').add({
              caseId: c.id,
              kind: 'append',
              destPath: `${c.mirrorFolder}/visits.jsonl`,
              text: JSON.stringify(saved) + '\n',
              attempts: 0,
            });
          }
        },
      },
    );
    s.tabs[d.tabId] = { visitId: visit.id, caseId: c.id, url: d.url, focusedMs: 0 };
    if (tab.active && s.focus?.tabId !== d.tabId) s.focus = { tabId: d.tabId, since: Date.now() };
    await saveSession(s);
    if (saved) onVisitRecorded(saved);
  });
}

/** Close the open visit in a tab: record dwell time, final title and referrer. */
async function closeVisit(s: SessionState, tabId: number) {
  const tv = s.tabs[tabId];
  if (!tv) return;
  delete s.tabs[tabId];
  let focusedMs = tv.focusedMs;
  if (s.focus?.tabId === tabId) {
    focusedMs += Date.now() - s.focus.since;
    s.focus = { tabId, since: Date.now() };
  }
  const db = await getDb();
  const v = await db.get('visits', tv.visitId);
  const c = await db.get('cases', tv.caseId);
  if (!v || !c) return;
  const leftAtUtc = nowUtc();
  const mirrorOn = await isMirrorEnabled();
  await appendEvent(
    tv.caseId,
    'visit.closed',
    { visitId: v.id, leftAtUtc, focusedMs, title: v.title, referrer: v.referrer },
    {
      stores: ['visits'],
      alsoWrite(tx) {
        void tx.objectStore('visits').put({ ...v, leftAtUtc, focusedMs });
        if (mirrorOn) {
          void tx.objectStore('mirrorQueue').add({
            caseId: c.id,
            kind: 'append',
            destPath: `${c.mirrorFolder}/visits.jsonl`,
            text: JSON.stringify({ closed: v.id, leftAtUtc, focusedMs, title: v.title, referrer: v.referrer }) + '\n',
            attempts: 0,
          });
        }
      },
    },
  ).catch((err) => console.warn('[EviCap] could not close visit', err));
  if (mirrorOn) notifyMirror();
}

/** Title and referrer arrive after the commit; they are stored, then sealed into `visit.closed`. */
export function onPageDetails(tabId: number, details: { title?: string; referrer?: string | null }) {
  return serial(async () => {
    const s = await loadSession();
    const tv = s.tabs[tabId];
    if (!tv) return;
    const db = await getDb();
    const v = await db.get('visits', tv.visitId);
    if (!v) return;
    const next = { ...v };
    if (details.title && details.title !== v.title) next.title = details.title;
    if (details.referrer !== undefined && details.referrer !== v.referrer) next.referrer = details.referrer || null;
    if (next.title !== v.title || next.referrer !== v.referrer) {
      await db.put('visits', next);
      onVisitRecorded(next);
    }
  });
}

export function onFocusChange(tabId: number | null) {
  return serial(async () => {
    const s = await loadSession();
    const now = Date.now();
    if (s.focus) {
      const prev = s.tabs[s.focus.tabId];
      if (prev) prev.focusedMs += now - s.focus.since;
    }
    s.focus = tabId === null ? null : { tabId, since: now };
    await saveSession(s);
  });
}

export function onTabRemoved(tabId: number) {
  return serial(async () => {
    const s = await loadSession();
    delete s.chains[tabId];
    if (s.tabs[tabId]) await closeVisit(s, tabId);
    if (s.focus?.tabId === tabId) s.focus = null;
    await saveSession(s);
  });
}

/** Close every open visit, e.g. when recording is paused or the case changes. */
export function closeAllVisits() {
  return serial(async () => {
    const s = await loadSession();
    for (const tabId of Object.keys(s.tabs)) await closeVisit(s, Number(tabId));
    s.focus = null;
    await saveSession(s);
  });
}

export async function currentVisitId(tabId: number): Promise<string | null> {
  const s = await loadSession();
  return s.tabs[tabId]?.visitId ?? null;
}
