import { beginCapture, completeCapture, failCapture } from './captures';
import { getCapture } from './db';
import type { Sha256 } from './hash';
import { mediaTool } from './media-scripts';
import { capturePath } from './opfs';
import { pageInfo, type PageInfo } from './page-scripts';
import { nowUtc } from './util';

/**
 * Tab recording (SPEC F7-C), service-worker side. The offscreen document runs
 * the MediaRecorder and writes the WebM into the capture's folder, hashing
 * each chunk as it goes; when it stops, this side re-hashes the file, checks
 * the two hashes match, and seals the capture. State lives in
 * chrome.storage.session so it survives the service worker restarting.
 */

export interface TabRecordingState {
  captureId: string;
  caseId: string;
  tabId: number;
  startedAtUtc: string;
  url: string;
  title: string;
  /** Every address the tab showed while it was being recorded. */
  urls: { url: string; atUtc: string }[];
  drm: boolean;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  visitId: string | null;
}

export interface TabRecordingResult {
  captureId: string;
  ok: boolean;
  error?: string;
  sha256?: Sha256;
  bytes?: number;
  mime?: string;
  stoppedAtUtc?: string;
  width?: number;
  height?: number;
  audio?: boolean;
  /** Why it stopped: the user, or the tab closing or navigating away from capture. */
  reason?: string;
}

const FILE = 'recording.webm';

export async function getTabRecording(): Promise<TabRecordingState | null> {
  const { tabRecording } = await chrome.storage.session.get('tabRecording');
  return (tabRecording as TabRecordingState | undefined) ?? null;
}

async function setTabRecording(s: TabRecordingState | null) {
  if (s) await chrome.storage.session.set({ tabRecording: s });
  else await chrome.storage.session.remove('tabRecording');
}

export async function startTabRecording(opts: {
  caseId: string;
  tabId: number;
  visitId: string | null;
  ensureOffscreen: () => Promise<void>;
}): Promise<{ captureId: string; drm: boolean }> {
  if (await getTabRecording()) throw new Error('A tab is already being recorded. Stop it first.');
  const tab = await chrome.tabs.get(opts.tabId);
  if (!tab.url || !/^(https?|file):/i.test(tab.url)) {
    throw new Error('EviCap can only record web pages (not browser or extension pages).');
  }
  const [infoRes] = await chrome.scripting.executeScript({ target: { tabId: opts.tabId }, func: pageInfo });
  const info = infoRes!.result as PageInfo;
  const drmRes = await chrome.scripting
    .executeScript({ target: { tabId: opts.tabId, allFrames: true }, func: mediaTool, args: ['drm', {}] })
    .catch(() => [] as chrome.scripting.InjectionResult<unknown>[]);
  const drm = drmRes.some((r) => r.result === true);

  let streamId: string;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: opts.tabId });
  } catch (err) {
    throw new Error(
      `The browser did not allow recording this tab (${(err as Error).message}). Click the EviCap toolbar button on the tab you want to record, then press "Record this tab".`,
    );
  }

  const startedAtUtc = nowUtc();
  const pending = await beginCapture({
    caseId: opts.caseId,
    type: 'video',
    method: 'tabCapture+MediaRecorder',
    url: info.url,
    title: info.title,
    startedAtUtc,
    degraded: drm ? ['DRM-protected media (EME) on the page: the recording may show black frames'] : [],
    meta: { visitId: opts.visitId },
  });
  await opts.ensureOffscreen();
  const res = (await chrome.runtime.sendMessage({
    kind: 'offscreen',
    action: 'start-tab-recording',
    streamId,
    path: capturePath(opts.caseId, pending.id, FILE),
    captureId: pending.id,
  })) as { ok: boolean; error?: string } | undefined;
  if (!res?.ok) {
    await failCapture(pending, `recording could not start: ${res?.error ?? 'no response'}`);
    throw new Error(`Recording could not start: ${res?.error ?? 'no response from the recorder'}`);
  }
  await setTabRecording({
    captureId: pending.id,
    caseId: opts.caseId,
    tabId: opts.tabId,
    startedAtUtc,
    url: info.url,
    title: info.title,
    urls: [{ url: info.url, atUtc: startedAtUtc }],
    drm,
    viewport: info.viewport,
    devicePixelRatio: info.devicePixelRatio,
    visitId: opts.visitId,
  });
  return { captureId: pending.id, drm };
}

/** Ask the recorder to stop. The capture is sealed when it reports back (finishTabRecording). */
export async function stopTabRecording(): Promise<void> {
  const s = await getTabRecording();
  if (!s) return;
  const res = (await chrome.runtime
    .sendMessage({ kind: 'offscreen', action: 'stop-tab-recording', captureId: s.captureId })
    .catch(() => undefined)) as { ok: boolean } | undefined;
  if (!res?.ok) {
    // The recorder is gone (the offscreen document was closed): keep what was written.
    await finishTabRecording({ captureId: s.captureId, ok: false, error: 'the recorder stopped unexpectedly', reason: 'recorder lost' });
  }
}

/** Log an address the recorded tab moved to (SPEC F7-C: "the visited URL(s) during recording"). */
export async function noteTabRecordingNavigation(tabId: number, url: string): Promise<void> {
  const s = await getTabRecording();
  if (!s || s.tabId !== tabId || s.urls[s.urls.length - 1]?.url === url) return;
  s.urls.push({ url, atUtc: nowUtc() });
  await setTabRecording(s);
}

let finishing: Promise<string | null> | null = null;

/** Seal the recording as a capture. Called once, when the offscreen recorder reports it has stopped. */
export function finishTabRecording(result: TabRecordingResult): Promise<string | null> {
  finishing ??= doFinish(result).finally(() => {
    finishing = null;
  });
  return finishing;
}

async function doFinish(result: TabRecordingResult): Promise<string | null> {
  const s = await getTabRecording();
  if (!s || s.captureId !== result.captureId) return null;
  await setTabRecording(null);
  const pending = await getCapture(s.captureId);
  if (!pending || pending.status !== 'pending') return null;
  const stoppedAtUtc = result.stoppedAtUtc ?? nowUtc();
  const degraded = [...pending.degraded];
  if (!result.ok) degraded.push(`recording ended abnormally: ${result.error ?? 'unknown error'}`);
  if (result.audio === false) degraded.push('tab audio could not be captured; video only');
  const meta = {
    ...pending.meta,
    recordedTab: { tabId: s.tabId, viewport: s.viewport, devicePixelRatio: s.devicePixelRatio },
    startedAtUtc: s.startedAtUtc,
    stoppedAtUtc,
    durationMs: Date.parse(stoppedAtUtc) - Date.parse(s.startedAtUtc),
    urlsDuringRecording: s.urls,
    drm: s.drm,
    mime: result.mime ?? 'video/webm',
    videoSize: result.width ? { width: result.width, height: result.height } : null,
    stopReason: result.reason ?? null,
    recorderSha256: result.sha256 ?? null,
    capturedTimeSource: 'system clock',
  };
  try {
    const rec = await completeCapture(
      pending,
      [
        {
          path: FILE,
          data: { prewritten: true, ...(result.ok && result.sha256 ? { expectSha256: result.sha256 } : {}) },
          mime: result.mime?.split(';')[0] ?? 'video/webm',
          role: 'primary',
        },
      ],
      { degraded, meta },
    );
    return rec.id;
  } catch (err) {
    await failCapture(pending, (err as Error).message ?? String(err));
    return null;
  }
}
