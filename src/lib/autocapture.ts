import { appendEvent } from './audit';
import { storeCapture, type NewCaptureFile } from './captures';
import { getDb } from './db';
import { sha256 } from './hash';
import { normalizeMhtml } from './mhtml';
import { pageInfo, type PageInfo } from './page-scripts';
import { currentVisitId, isRecordableUrl } from './recorder';
import { captureVisiblePng } from './screenshots';
import { getSettings, getState } from './settings';
import type { CaptureRecord } from './types';
import { formatBytes, nowUtc, sleep } from './util';

/**
 * Automatic page capture (SPEC F3). Each logged page gets an MHTML snapshot,
 * its visible text and, if the tab is on screen, a screenshot, once it has
 * loaded and been idle for about 1.5 s. It never attaches the debugger.
 */

const IDLE_MS = 1500;
const LOAD_TIMEOUT_MS = 20_000;
const MAX_TEXT = 2_000_000;

const pending = new Map<number, ReturnType<typeof setTimeout>>();
const lastRun = new Map<number, number>();
let onCaptured: (c: CaptureRecord | null, caseId: string) => void = () => undefined;

export function setAutoCaptureListener(fn: typeof onCaptured) {
  onCaptured = fn;
}

/** Called for each new visit. A newer visit in the same tab replaces a pending one. */
export async function scheduleAutoCapture(tabId: number, visitId: string, caseId: string) {
  const c = await (await getDb()).get('cases', caseId);
  if (!c?.autoCapture || c.status !== 'open') return;
  const settings = await getSettings();
  const since = Date.now() - (lastRun.get(tabId) ?? 0);
  const throttle = Math.max(0, settings.autoCaptureThrottleSec * 1000 - since);
  clearTimeout(pending.get(tabId));
  pending.set(
    tabId,
    setTimeout(() => {
      pending.delete(tabId);
      void runWhenLoaded(tabId, visitId, caseId).catch((err) => console.warn('[EviCap] auto-capture', err));
    }, Math.max(IDLE_MS, throttle)),
  );
}

export function cancelAutoCapture(tabId: number) {
  clearTimeout(pending.get(tabId));
  pending.delete(tabId);
}

async function runWhenLoaded(tabId: number, visitId: string, caseId: string) {
  const start = Date.now();
  let waited = false;
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === 'complete') break;
    waited = true;
    if (Date.now() - start > LOAD_TIMEOUT_MS) break; // capture what has loaded so far
    await sleep(300);
  }
  if (waited) await sleep(IDLE_MS);
  const rec = await autoCapture(tabId, visitId, caseId);
  onCaptured(rec, caseId);
}

async function stillCurrent(tabId: number, visitId: string, caseId: string) {
  const state = await getState();
  return state.recording && state.activeCaseId === caseId && (await currentVisitId(tabId)) === visitId;
}

async function previousAuto(caseId: string, url: string): Promise<CaptureRecord | null> {
  const db = await getDb();
  const all = await db.getAllFromIndex('captures', 'byCaseUrl', [caseId, url]);
  return (
    all
      .filter((c) => c.type === 'auto' && c.status === 'complete' && !c.deleted)
      .sort((a, b) => b.startedAtUtc.localeCompare(a.startedAtUtc))[0] ?? null
  );
}

export async function autoCapture(tabId: number, visitId: string, caseId: string): Promise<CaptureRecord | null> {
  if (!(await stillCurrent(tabId, visitId, caseId))) return null;
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !isRecordableUrl(tab.url)) return null;
  lastRun.set(tabId, Date.now());
  const startedAtUtc = nowUtc();
  const settings = await getSettings();

  const [infoRes] = await chrome.scripting.executeScript({ target: { tabId }, func: pageInfo }).catch(() => []);
  const info = (infoRes?.result as PageInfo | undefined) ?? null;
  const [textRes] = await chrome.scripting
    .executeScript({ target: { tabId }, func: (max: number) => (document.body?.innerText ?? '').slice(0, max), args: [MAX_TEXT] })
    .catch(() => []);
  const text = (textRes?.result as string | undefined) ?? '';
  const url = info?.url ?? tab.url;

  const mhtml = await chrome.pageCapture.saveAsMHTML({ tabId });
  if (!mhtml) throw new Error('The browser returned no MHTML');
  const maxBytes = settings.autoCaptureMaxMhtmlMb * 1024 * 1024;
  if (mhtml.size > maxBytes) {
    await appendEvent(caseId, 'capture.skipped', {
      visitId,
      url,
      reason: `page is ${formatBytes(mhtml.size)}, over the ${settings.autoCaptureMaxMhtmlMb} MB auto-capture limit`,
      bytes: mhtml.size,
    });
    return null;
  }
  const textSha256 = await sha256(text);
  const mhtmlNormalizedSha256 = await sha256(normalizeMhtml(await mhtml.text()));

  // Deduplication: an unchanged page links to its earlier capture instead of storing a copy.
  const prev = await previousAuto(caseId, url);
  if (prev && prev.meta.textSha256 === textSha256 && prev.meta.mhtmlNormalizedSha256 === mhtmlNormalizedSha256) {
    await appendEvent(
      caseId,
      'capture.reused',
      { visitId, captureId: prev.id, url, textSha256, mhtmlNormalizedSha256, reason: 'page unchanged since the earlier capture' },
      {
        stores: ['visits'],
        alsoWrite(tx) {
          const visits = tx.objectStore('visits');
          void visits.get(visitId).then((v) => v && visits.put({ ...v, autoCaptureId: prev.id }));
        },
      },
    );
    return prev;
  }

  if (!(await stillCurrent(tabId, visitId, caseId))) return null;
  const degraded: string[] = [];
  const files: NewCaptureFile[] = [];
  const current = await chrome.tabs.get(tabId).catch(() => null);
  const win = current ? await chrome.windows.get(current.windowId).catch(() => null) : null;
  if (current?.active && win && win.state !== 'minimized') {
    try {
      files.push({ path: 'screenshot.png', data: await captureVisiblePng(current.windowId), mime: 'image/png', role: 'primary' });
    } catch (err) {
      degraded.push(`no screenshot: ${(err as Error).message}`);
    }
  } else {
    degraded.push('no screenshot: the tab was not on screen');
  }
  files.push({ path: 'page.mhtml', data: mhtml, mime: 'multipart/related', role: files.length ? 'mhtml' : 'primary' });
  files.push({ path: 'text.txt', data: new TextEncoder().encode(text), mime: 'text/plain;charset=utf-8', role: 'text' });
  if (!info) degraded.push('page details unavailable (the page could not be scripted)');

  return storeCapture({
    caseId,
    type: 'auto',
    method: files[0]!.path === 'screenshot.png' ? 'pageCapture+captureVisibleTab' : 'pageCapture',
    url,
    title: info?.title ?? tab.title ?? '',
    startedAtUtc,
    degraded,
    files,
    linkVisitId: visitId,
    meta: {
      mode: 'auto',
      visitId,
      textSha256,
      mhtmlNormalizedSha256,
      textTruncated: text.length >= MAX_TEXT,
      ...(info
        ? {
            viewport: info.viewport,
            devicePixelRatio: info.devicePixelRatio,
            scroll: info.scroll,
            documentSize: info.document,
            canonicalUrl: info.canonicalUrl,
            lastModified: info.lastModified,
            pageMeta: info.meta,
          }
        : {}),
      capturedTimeSource: 'system clock',
    },
  });
}
