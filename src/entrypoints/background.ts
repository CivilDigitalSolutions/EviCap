import { appendEvent } from '@/lib/audit';
import { cancelAutoCapture, scheduleAutoCapture, setAutoCaptureListener } from '@/lib/autocapture';
import { markInterruptedCaptures } from '@/lib/captures';
import {
  addNote,
  backfillMirror,
  createCase,
  deleteCase,
  editNote,
  setActiveCase,
  setCaseStatus,
  setRecording,
  setTag,
  updateCase,
  type CaseInput,
} from '@/lib/cases';
import { getDb, setMeta } from '@/lib/db';
import { getInstallKey } from '@/lib/keys';
import { broadcast, type RpcMethods, type RpcRequest, type RpcResponse } from '@/lib/messages';
import { invalidateMirrorCache, MIRROR_OFF, setMirrorNotifier } from '@/lib/mirror-queue';
import { storageStatus } from '@/lib/opfs';
import * as recorder from '@/lib/recorder';
import { takeScreenshot, type ScreenshotMode } from '@/lib/screenshots';
import { getSettings, getState, saveSettings, type LiveState, type Settings } from '@/lib/settings';
import { dismissJob, markInterruptedJobs } from '@/lib/jobs';
import { forensicCapture } from '@/lib/forensic';
import { captureMediaAt, pickAndCapture, type MediaResult } from '@/lib/media';
import type { TabRecordingEndedMessage } from '@/lib/messages';
import {
  finishTabRecording,
  getTabRecording,
  noteTabRecordingNavigation,
  startTabRecording,
  stopTabRecording,
} from '@/lib/tab-recording';

export default defineBackground(() => {
  // ---------- Recording: visit log (F2) ----------
  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      if (d.tabId >= 0) void recorder.onMainFrameRequest(d.tabId, d.url);
      return undefined;
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
  );
  chrome.webRequest.onBeforeRedirect.addListener(
    (d) => {
      if (d.tabId >= 0) void recorder.onRedirect(d.tabId, d.url, d.redirectUrl);
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
  );
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    void noteTabRecordingNavigation(d.tabId, d.url);
    void recorder.onCommitted({
      tabId: d.tabId,
      url: d.url,
      transitionType: d.transitionType,
      transitionQualifiers: d.transitionQualifiers,
      spa: false,
    });
  });
  const onSpa = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
    if (d.frameId !== 0) return;
    void noteTabRecordingNavigation(d.tabId, d.url);
    void recorder.onCommitted({
      tabId: d.tabId,
      url: d.url,
      transitionType: d.transitionType,
      transitionQualifiers: d.transitionQualifiers,
      spa: true,
    });
  };
  chrome.webNavigation.onHistoryStateUpdated.addListener(onSpa);
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSpa);

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.title) void recorder.onPageDetails(tabId, { title: info.title });
    if (info.status === 'complete' && tab.url && recorder.isRecordableUrl(tab.url)) {
      void readReferrer(tabId);
    }
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => void recorder.onFocusChange(tabId));
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return void recorder.onFocusChange(null);
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    void recorder.onFocusChange(tab?.id ?? null);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    cancelAutoCapture(tabId);
    void recorder.onTabRemoved(tabId);
  });
  setAutoCaptureListener((rec, caseId) => {
    if (!rec) return;
    broadcast({ scope: 'captures', caseId });
    broadcast({ scope: 'visits', caseId });
  });

  let visitsTimer: ReturnType<typeof setTimeout> | null = null;
  recorder.setVisitListener((v, isNew) => {
    if (isNew) void scheduleAutoCapture(v.tabId, v.id, v.caseId);
    if (visitsTimer) return;
    visitsTimer = setTimeout(() => {
      visitsTimer = null;
      broadcast({ scope: 'visits', caseId: v.caseId });
    }, 300);
  });

  async function readReferrer(tabId: number) {
    if (!(await recorder.currentVisitId(tabId))) return;
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({ referrer: document.referrer, title: document.title }),
      });
      if (r?.result) await recorder.onPageDetails(tabId, r.result as { referrer: string; title: string });
    } catch {
      /* page not scriptable */
    }
  }

  // ---------- State: badge and visit closing ----------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.tabRecording) {
      void updateBadge();
      void updateRecordTabMenu(!!changes.tabRecording.newValue);
      return;
    }
    if (area !== 'local' || !changes.state) return;
    const prev = (changes.state.oldValue ?? {}) as Partial<LiveState>;
    const next = (changes.state.newValue ?? {}) as Partial<LiveState>;
    void updateBadge(next);
    if (prev.recording && (!next.recording || prev.activeCaseId !== next.activeCaseId)) {
      void recorder.closeAllVisits();
    }
    broadcast({ scope: 'state' });
  });

  async function updateBadge(state?: Partial<LiveState>) {
    const s = state ?? (await getState());
    if (await getTabRecording()) {
      await chrome.action.setBadgeText({ text: 'REC' });
      await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
      await chrome.action.setTitle({ title: 'EviCap: recording this tab. Open EviCap to stop.' });
      return;
    }
    if (!s.activeCaseId) {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'EviCap: no active case' });
      return;
    }
    await chrome.action.setBadgeText({ text: '●' });
    await chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
    await chrome.action.setBadgeBackgroundColor({ color: s.recording ? '#dc2626' : '#6b7280' });
    await chrome.action.setTitle({ title: s.recording ? 'EviCap: recording' : 'EviCap: paused' });
  }

  // ---------- Disk mirror ----------
  let creatingOffscreen: Promise<void> | null = null;
  async function ensureOffscreen() {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (contexts.length > 0) return;
    creatingOffscreen ??= chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.USER_MEDIA],
        justification:
          'Write evidence files to the folder the user chose for the disk mirror and hash them, and record a tab the user asked to record.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
    await creatingOffscreen;
  }
  let kickTimer: ReturnType<typeof setTimeout> | null = null;
  function kickMirror() {
    if (kickTimer) return;
    kickTimer = setTimeout(async () => {
      kickTimer = null;
      try {
        await ensureOffscreen();
        await chrome.runtime.sendMessage({ kind: 'offscreen', action: 'drain-mirror' });
      } catch (err) {
        console.warn('[EviCap] mirror kick failed', err);
      }
    }, 150);
  }
  setMirrorNotifier(kickMirror);

  // ---------- Commands (keyboard shortcuts) ----------
  chrome.commands.onCommand.addListener(async (command, tab) => {
    try {
      if (command === 'toggle-recording') {
        const s = await getState();
        await setRecording(!s.recording);
        return;
      }
      if (command === 'capture-forensic') {
        await forensic(false, tab?.id);
        flashBadge('+1');
        return;
      }
      if (command === 'open-media-picker') {
        report(await pickMedia(tab?.id));
        return;
      }
      if (command === 'record-tab') {
        if (await getTabRecording()) await stopTabRecording();
        else await recordTab(tab?.id);
        return;
      }
      const mode = ({ 'capture-visible': 'visible', 'capture-full': 'full', 'capture-region': 'region' } as const)[
        command as 'capture-visible'
      ];
      if (mode) await screenshot(mode, tab?.id);
    } catch (err) {
      notifyError(err);
    }
  });

  function notifyError(err: unknown) {
    console.warn('[EviCap]', err);
    void chrome.action.setBadgeText({ text: '!' });
    void chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
    void chrome.action.setTitle({ title: `EviCap: ${(err as Error).message ?? err}` });
    setTimeout(() => void updateBadge(), 4000);
  }

  async function targetTab(tabId?: number): Promise<number> {
    if (tabId !== undefined) return tabId;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('No tab to capture');
    return tab.id;
  }

  async function screenshot(mode: ScreenshotMode, tabId?: number) {
    const state = await getState();
    if (!state.activeCaseId) throw new Error('Choose or create a case before capturing.');
    const id = await targetTab(tabId);
    const record = await takeScreenshot({
      caseId: state.activeCaseId,
      tabId: id,
      mode,
      visitId: await recorder.currentVisitId(id),
    });
    if (record) broadcast({ scope: 'captures', caseId: record.caseId });
    return record ? { captureId: record.id } : null;
  }

  // ---------- Media (F6, F7) ----------
  async function activeCase(): Promise<string> {
    const state = await getState();
    if (!state.activeCaseId) throw new Error('Choose or create a case before capturing.');
    return state.activeCaseId;
  }

  async function pickMedia(tabId?: number) {
    const id = await targetTab(tabId);
    const r = await pickAndCapture({ caseId: await activeCase(), tabId: id, visitId: await recorder.currentVisitId(id) });
    broadcast({ scope: 'captures' });
    return r;
  }

  async function forensic(reload: boolean, tabId?: number) {
    const id = await targetTab(tabId);
    const rec = await forensicCapture({ caseId: await activeCase(), tabId: id, visitId: await recorder.currentVisitId(id), options: { reload } });
    broadcast({ scope: 'captures', caseId: rec.caseId });
    return { captureId: rec.id };
  }

  async function recordTab(tabId?: number) {
    const id = await targetTab(tabId);
    const r = await startTabRecording({
      caseId: await activeCase(),
      tabId: id,
      visitId: await recorder.currentVisitId(id),
      ensureOffscreen,
    });
    broadcast({ scope: 'captures' });
    return r;
  }

  /** Show the outcome of a capture started without a page open (menu or shortcut) on the badge. */
  function report(r: MediaResult | null) {
    if (!r) return;
    if (r.failed.length) notifyError(new Error(r.failed.map((f) => f.error).join(' · ')));
    else if (r.needsTabRecording.length && !r.captured.length) notifyError(new Error(r.needsTabRecording[0]!.reason));
    else if (r.captured.length) flashBadge(`+${r.captured.length}`);
  }

  function flashBadge(text: string) {
    void chrome.action.setBadgeText({ text });
    void chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    setTimeout(() => void updateBadge(), 2500);
  }

  const MENU = {
    image: 'evicap-capture-image',
    video: 'evicap-capture-video',
    picker: 'evicap-media-picker',
    element: 'evicap-screenshot-element',
    forensic: 'evicap-forensic',
    recordTab: 'evicap-record-tab',
  } as const;

  function createMenus() {
    chrome.contextMenus.removeAll(() => {
      const pages = ['http://*/*', 'https://*/*', 'file://*/*'];
      type Ctx = NonNullable<chrome.contextMenus.CreateProperties['contexts']>;
      const add = (id: string, title: string, contexts: Ctx) =>
        chrome.contextMenus.create({ id, title, contexts, documentUrlPatterns: pages });
      add(MENU.image, 'EviCap: Capture image', ['image']);
      add(MENU.video, 'EviCap: Capture video', ['video', 'audio']);
      add(MENU.picker, 'EviCap: Pick images and videos…', ['page', 'image', 'video', 'link']);
      add(MENU.element, 'EviCap: Screenshot an element…', ['page', 'image', 'link']);
      add(MENU.forensic, 'EviCap: Forensic capture of this page', ['page']);
      add(MENU.recordTab, 'EviCap: Record this tab', ['page', 'video']);
      void getTabRecording().then((s) => updateRecordTabMenu(!!s));
    });
  }

  async function updateRecordTabMenu(recording: boolean) {
    await chrome.contextMenus
      .update(MENU.recordTab, { title: recording ? 'EviCap: Stop recording the tab' : 'EviCap: Record this tab' })
      .catch(() => undefined);
  }

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    try {
      const tabId = tab?.id;
      if (tabId === undefined || tabId < 0) return;
      if (info.menuItemId === MENU.image || info.menuItemId === MENU.video) {
        if (!info.srcUrl) throw new Error('No media address found for that item.');
        const r = await captureMediaAt(
          { caseId: await activeCase(), tabId, frameId: info.frameId, visitId: await recorder.currentVisitId(tabId) },
          info.srcUrl,
          info.menuItemId === MENU.image ? 'image' : ((info.mediaType as 'video' | 'audio' | undefined) ?? 'video'),
        );
        broadcast({ scope: 'captures' });
        report(r);
      } else if (info.menuItemId === MENU.picker) {
        report(await pickMedia(tabId));
      } else if (info.menuItemId === MENU.forensic) {
        await forensic(false, tabId);
        flashBadge('+1');
      } else if (info.menuItemId === MENU.element) {
        await screenshot('element', tabId);
      } else if (info.menuItemId === MENU.recordTab) {
        if (await getTabRecording()) await stopTabRecording();
        else await recordTab(tabId);
      }
    } catch (err) {
      notifyError(err);
    }
  });

  // ---------- RPC ----------
  const handlers: { [K in keyof RpcMethods]: (...args: Parameters<RpcMethods[K]>) => Promise<unknown> } = {
    async createCase(input: CaseInput) {
      const c = await createCase(input);
      broadcast({ scope: 'cases', caseId: c.id });
      return { id: c.id };
    },
    async updateCase(id, patch) {
      await updateCase(id, patch);
      broadcast({ scope: 'cases', caseId: id });
    },
    async setCaseStatus(id, status) {
      await setCaseStatus(id, status);
      broadcast({ scope: 'cases', caseId: id });
    },
    async deleteCase(id) {
      await deleteCase(id);
      broadcast({ scope: 'cases', caseId: id });
    },
    async setActiveCase(id) {
      await setActiveCase(id);
    },
    async setRecording(on) {
      await setRecording(on);
    },
    screenshot: (mode, tabId) => screenshot(mode, tabId),
    pickMedia: (tabId) => pickMedia(tabId),
    forensicCapture: (reload, tabId) => forensic(reload, tabId),
    async captureMediaUrl(srcUrl, mediaType, tabId) {
      const id = await targetTab(tabId);
      const r = await captureMediaAt(
        { caseId: await activeCase(), tabId: id, visitId: await recorder.currentVisitId(id) },
        srcUrl,
        mediaType,
      );
      broadcast({ scope: 'captures' });
      return r;
    },
    startTabRecording: (tabId) => recordTab(tabId),
    async stopTabRecording() {
      await stopTabRecording();
    },
    async dismissJob(id) {
      await dismissJob(id);
    },
    async addNote(caseId, kind, targetId, text) {
      await addNote(caseId, kind, targetId, text);
      broadcast({ scope: 'notes', caseId });
    },
    async editNote(noteId, text) {
      await editNote(noteId, text);
      broadcast({ scope: 'notes' });
    },
    async setTag(caseId, kind, targetId, tag, add) {
      await setTag(caseId, kind, targetId, tag, add);
      broadcast({ scope: kind === 'visit' ? 'visits' : 'captures', caseId });
    },
    async saveSettings(patch: Partial<Settings>) {
      const before = await getSettings();
      const after = await saveSettings(patch);
      const state = await getState();
      const changed = Object.keys(patch).filter(
        (k) => JSON.stringify(before[k as keyof Settings]) !== JSON.stringify(after[k as keyof Settings]),
      );
      const audited = changed.filter((k) => k !== 'mirrorReminderDismissed' && k !== 'onboardingDone');
      if (state.activeCaseId && audited.length) {
        await appendEvent(state.activeCaseId, 'settings.changed', {
          changes: Object.fromEntries(
            audited.map((k) => [k, { from: before[k as keyof Settings], to: after[k as keyof Settings] }]),
          ),
        });
      }
      return after;
    },
    async mirrorConnected() {
      invalidateMirrorCache();
      await backfillMirror();
      kickMirror();
      broadcast({ scope: 'mirror' });
    },
    async mirrorDisconnect() {
      const db = await getDb();
      await db.delete('meta', 'mirrorDir');
      await db.clear('mirrorQueue');
      await setMeta('mirrorStatus', MIRROR_OFF);
      invalidateMirrorCache();
      broadcast({ scope: 'mirror' });
    },
    async mirrorKick() {
      kickMirror();
    },
    async status() {
      const key = await getInstallKey();
      return { storage: await storageStatus(), fingerprint: key.fingerprint, version: chrome.runtime.getManifest().version };
    },
  };

  chrome.runtime.onMessage.addListener((msg: RpcRequest | TabRecordingEndedMessage, _sender, sendResponse) => {
    if (msg?.kind === 'tab-recording-ended') {
      void finishTabRecording(msg.result).then((id) => {
        broadcast({ scope: 'captures' });
        if (id) flashBadge('+1');
      });
      return false;
    }
    if (msg?.kind !== 'rpc') return false;
    const handler = handlers[msg.method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
    if (!handler) {
      sendResponse({ ok: false, error: `Unknown method ${msg.method}` } satisfies RpcResponse);
      return false;
    }
    handler(...msg.args).then(
      (value) => sendResponse({ ok: true, value: value ?? null } satisfies RpcResponse),
      (err: unknown) => sendResponse({ ok: false, error: (err as Error)?.message ?? String(err) } satisfies RpcResponse),
    );
    return true;
  });

  // ---------- Clock anomalies (SPEC §7.6) ----------
  chrome.alarms.create('clock-check', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'clock-check') return;
    const drift = Date.now() - (performance.timeOrigin + performance.now());
    const { lastDrift } = await chrome.storage.session.get('lastDrift');
    await chrome.storage.session.set({ lastDrift: drift });
    if (typeof lastDrift !== 'number' || Math.abs(drift - lastDrift) < 120_000) return;
    const state = await getState();
    if (state.activeCaseId) {
      await appendEvent(state.activeCaseId, 'clock.anomaly', {
        jumpMs: Math.round(drift - lastDrift),
        note: 'The system clock changed by more than two minutes while EviCap was running.',
      }).catch(() => undefined);
    }
  });

  // ---------- Install and start-up ----------
  chrome.runtime.onInstalled.addListener(async (details) => {
    createMenus();
    await getInstallKey();
    if (details.reason === 'install') {
      await chrome.tabs.create({ url: chrome.runtime.getURL('/dashboard.html#/onboarding') });
    }
  });

  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => undefined);

  void (async () => {
    await updateBadge();
    await markInterruptedJobs();
    // A tab recording survives a service-worker restart if its recorder is still running.
    const rec = await getTabRecording();
    const offscreen = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
    if (rec && offscreen.length === 0) {
      await finishTabRecording({ captureId: rec.captureId, ok: false, error: 'the recorder was closed', reason: 'recorder lost' });
    }
    const n = await markInterruptedCaptures(rec && offscreen.length ? [rec.captureId] : []);
    if (n) broadcast({ scope: 'captures' });
    kickMirror();
  })();
});
