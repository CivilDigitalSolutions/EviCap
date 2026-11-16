import { beginCapture, completeCapture, failCapture, storeCapture, type NewCaptureFile } from './captures';
import { readExif } from './exif';
import { updateJob, startJob } from './jobs';
import { mediaTool, type MediaItem, type PageFetch, type ScrollResult } from './media-scripts';
import { decodeDataUrl, extensionFor, fetchOriginal, fetchStream, sniffMime } from './net';
import { pageInfo, type PageInfo } from './page-scripts';
import { captureVisiblePng } from './screenshots';
import { getSettings } from './settings';
import type { CaptureRecord } from './types';
import { formatBytes, nowUtc, uuid } from './util';

/** Image and video capture (SPEC F6, F7-A). Tab recording (F7-C) is in tab-recording.ts. */

export interface MediaContext {
  caseId: string;
  tabId: number;
  frameId?: number;
  visitId: string | null;
}

export interface MediaResult {
  captured: { captureId: string; kind: string }[];
  /** Items that can't be downloaded as a file (streamed or DRM video): record the tab instead. */
  needsTabRecording: { src: string; reason: string }[];
  failed: { src: string; error: string }[];
}

const LARGE_VIDEO = 2 * 1024 ** 3;

async function tool<T>(ctx: MediaContext, ...call: [string, Record<string, unknown>]): Promise<T> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: ctx.tabId, ...(ctx.frameId ? { frameIds: [ctx.frameId] } : {}) },
    func: mediaTool,
    args: call,
  });
  return res?.result as T;
}

async function topPageInfo(tabId: number): Promise<PageInfo> {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: pageInfo });
  return res!.result as PageInfo;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function assertCapturable(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^(https?|file):/i.test(tab.url)) {
    throw new Error('EviCap can only capture media on web pages (not browser or extension pages).');
  }
  return tab;
}

/** Right-click "Capture image" / "Capture video" (SPEC F6, F7). */
export async function captureMediaAt(
  ctx: MediaContext,
  srcUrl: string,
  mediaType: 'image' | 'video' | 'audio',
): Promise<MediaResult> {
  await assertCapturable(ctx.tabId);
  const prefer = (await getSettings()).imageSource;
  let item = await tool<MediaItem | null>(ctx, 'at', { srcUrl, mediaType, prefer }).catch(() => null);
  if (!item) {
    // The element couldn't be found again (e.g. it was replaced): capture the URL alone.
    item = bareItem(srcUrl, mediaType);
  }
  return captureItems(ctx, [item]);
}

/** Media picker (SPEC F6): the user ticks items on the page, then they are captured in turn. */
export async function pickAndCapture(ctx: MediaContext): Promise<MediaResult | null> {
  await assertCapturable(ctx.tabId);
  await chrome.tabs.update(ctx.tabId, { active: true });
  const prefer = (await getSettings()).imageSource;
  const items = await tool<MediaItem[] | null>(ctx, 'pick', { prefer });
  if (!items) return null;
  return captureItems(ctx, items);
}

function bareItem(src: string, mediaType: string): MediaItem {
  return {
    pickId: '',
    kind: mediaType === 'image' ? 'image' : mediaType === 'audio' ? 'audio' : 'video',
    tag: '',
    src,
    sourceChoice: 'context-menu',
    candidates: { currentSrc: src, src, srcset: [], lazy: {}, sources: [] },
    alt: null,
    title: null,
    ariaLabel: null,
    natural: null,
    rendered: { width: 0, height: 0 },
    docRect: { x: 0, y: 0, width: 0, height: 0 },
    domPath: '',
    snippet: '',
    frameUrl: '',
    video:
      mediaType === 'image'
        ? null
        : {
            duration: null,
            currentTime: 0,
            paused: true,
            poster: null,
            tracks: [],
            encrypted: false,
            streamed: src.startsWith('blob:') || !src,
            videoWidth: 0,
            videoHeight: 0,
          },
  };
}

export async function captureItems(ctx: MediaContext, items: MediaItem[]): Promise<MediaResult> {
  const result: MediaResult = { captured: [], needsTabRecording: [], failed: [] };
  try {
    for (const item of items) {
      try {
        if (item.kind === 'video' || item.kind === 'audio') {
          const v = item.video;
          if (!item.src || v?.streamed || v?.encrypted || !/^https?:/i.test(item.src)) {
            result.needsTabRecording.push({
              src: item.src,
              reason: v?.encrypted
                ? 'This media is DRM-protected (EME). A tab recording may show black frames.'
                : 'This video is streamed, so there is no single file to download. Use "Record this tab".',
            });
            continue;
          }
          const rec = await captureVideoFile(ctx, item);
          result.captured.push({ captureId: rec.id, kind: item.kind });
        } else {
          if (!item.src) throw new Error('No image source found');
          const rec = await captureImage(ctx, item);
          result.captured.push({ captureId: rec.id, kind: item.kind });
        }
      } catch (err) {
        result.failed.push({ src: item.src, error: (err as Error).message ?? String(err) });
      }
    }
  } finally {
    await tool(ctx, 'clear', {}).catch(() => undefined);
  }
  return result;
}

interface ContextShot {
  png: Uint8Array;
  scroll: ScrollResult | null;
  startedAtUtc: string;
}

/** In-context screenshot (SPEC F6 step 5): the element scrolled into view, then the visible area. */
async function contextShot(ctx: MediaContext, item: MediaItem): Promise<ContextShot | { error: string }> {
  try {
    const tab = await chrome.tabs.get(ctx.tabId);
    const scroll = item.pickId ? await tool<ScrollResult | null>(ctx, 'scroll', { pickId: item.pickId }) : null;
    const startedAtUtc = nowUtc();
    return { png: await captureVisiblePng(tab.windowId), scroll, startedAtUtc };
  } catch (err) {
    return { error: (err as Error).message ?? String(err) };
  }
}

async function storeContextShot(ctx: MediaContext, parent: CaptureRecord, shot: ContextShot, info: PageInfo) {
  return storeCapture({
    caseId: ctx.caseId,
    type: 'screenshot',
    method: 'captureVisibleTab',
    url: info.url,
    title: info.title,
    startedAtUtc: shot.startedAtUtc,
    parent: parent.id,
    files: [{ path: 'context.png', data: shot.png, mime: 'image/png', role: 'primary' }],
    meta: {
      mode: 'context',
      visitId: ctx.visitId,
      contextOf: parent.id,
      elementRectCss: shot.scroll?.viewRect ?? null,
      elementInFrame: shot.scroll?.inFrame ?? false,
      viewport: shot.scroll?.viewport ?? info.viewport,
      devicePixelRatio: shot.scroll?.devicePixelRatio ?? info.devicePixelRatio,
      scroll: shot.scroll?.scroll ?? info.scroll,
      capturedTimeSource: 'system clock',
    },
  });
}

interface Retrieved {
  bytes: Uint8Array;
  mime: string;
  method: string;
  status: number | null;
  finalUrl: string;
  headers: Record<string, string> | null;
  degraded: string[];
  attempts: { method: string; error: string }[];
}

/**
 * Get the image's original bytes (SPEC F6 step 2), trying in order:
 * the extension's own request (with the site's cookies), a request from the
 * page itself, and last a canvas re-encode (marked as degraded).
 */
async function retrieveImage(ctx: MediaContext, item: MediaItem): Promise<Retrieved> {
  const attempts: Retrieved['attempts'] = [];
  const src = item.src;
  if (src.startsWith('data:')) {
    const { bytes, mime } = decodeDataUrl(src);
    return { bytes, mime, method: 'data-url', status: null, finalUrl: '', headers: null, degraded: [], attempts };
  }
  if (/^https?:/i.test(src)) {
    try {
      const r = await fetchOriginal(src);
      return { ...r, method: 'extension-fetch', degraded: [], attempts };
    } catch (err) {
      attempts.push({ method: 'extension-fetch', error: (err as Error).message ?? String(err) });
    }
  }
  if (/^(https?|blob):/i.test(src)) {
    const r = await tool<PageFetch>(ctx, 'fetch', { url: src }).catch((e: Error) => ({ ok: false, error: e.message }) as PageFetch);
    if (r.ok && r.b64) {
      return {
        bytes: b64ToBytes(r.b64),
        mime: r.mime ?? '',
        method: src.startsWith('blob:') ? 'page-fetch(blob)' : 'page-fetch',
        status: r.status ?? null,
        finalUrl: r.finalUrl ?? src,
        headers: r.headers ?? null,
        degraded: [],
        attempts,
      };
    }
    attempts.push({ method: 'page-fetch', error: r.error ?? 'failed' });
  }
  if (item.pickId) {
    const r = await tool<PageFetch>(ctx, 'canvas', { pickId: item.pickId }).catch((e: Error) => ({ ok: false, error: e.message }) as PageFetch);
    if (r.ok && r.b64) {
      return {
        bytes: b64ToBytes(r.b64),
        mime: 'image/png',
        method: 'canvas-reencode',
        status: null,
        finalUrl: '',
        headers: null,
        degraded: ['re-encoded: original bytes unavailable (embedded metadata such as EXIF is lost)'],
        attempts,
      };
    }
    attempts.push({ method: 'canvas-reencode', error: r.error ?? 'failed' });
  }
  throw new Error(`Could not get the image (${attempts.map((a) => `${a.method}: ${a.error}`).join('; ')})`);
}

function itemMeta(ctx: MediaContext, item: MediaItem, info: PageInfo) {
  return {
    visitId: ctx.visitId,
    pageUrl: info.url,
    pageTitle: info.title,
    frameUrl: item.frameUrl && item.frameUrl !== info.url ? item.frameUrl : null,
    sourceUrl: item.src,
    sourceChoice: item.sourceChoice,
    candidates: item.candidates,
    element: {
      tag: item.tag,
      domPath: item.domPath,
      alt: item.alt,
      title: item.title,
      ariaLabel: item.ariaLabel,
      rendered: item.rendered,
      natural: item.natural,
      docRect: item.docRect,
    },
    snippet: item.snippet,
    capturedTimeSource: 'system clock',
  };
}

export async function captureImage(ctx: MediaContext, item: MediaItem): Promise<CaptureRecord> {
  const startedAtUtc = nowUtc();
  const info = await topPageInfo(ctx.tabId);
  const shot = await contextShot(ctx, item);
  const got = await retrieveImage(ctx, item);
  const mime = sniffMime(got.bytes) ?? (got.mime || 'application/octet-stream');
  const exif = mime.startsWith('image/') ? readExif(got.bytes) : null;
  const degraded = [...got.degraded];
  if ('error' in shot) degraded.push(`in-context screenshot failed: ${shot.error}`);
  if (got.mime && got.mime !== mime && !got.mime.startsWith('image/')) {
    degraded.push(`server said ${got.mime}, but the bytes are ${mime}`);
  }
  const parent = await storeCapture({
    caseId: ctx.caseId,
    type: 'image',
    method: got.method,
    url: info.url,
    title: info.title,
    startedAtUtc,
    degraded,
    files: [{ path: `image.${extensionFor(mime, got.finalUrl || item.src)}`, data: got.bytes, mime, role: 'primary' }],
    meta: {
      ...itemMeta(ctx, item, info),
      kind: item.kind,
      mime,
      finalUrl: got.finalUrl || null,
      httpStatus: got.status,
      responseHeaders: got.headers,
      retrieval: { method: got.method, failedAttempts: got.attempts },
      exif: exif && (Object.keys(exif.tags).length || exif.gps || exif.hasXmp || exif.hasIptc) ? exif : null,
    },
  });
  if (!('error' in shot)) await storeContextShot(ctx, parent, shot, info).catch((e) => console.warn('[EviCap] context shot', e));
  return parent;
}

/** Direct video file download (SPEC F7-A): streamed into storage and hashed as it arrives. */
export async function captureVideoFile(ctx: MediaContext, item: MediaItem): Promise<CaptureRecord> {
  const startedAtUtc = nowUtc();
  const info = await topPageInfo(ctx.tabId);
  const shot = await contextShot(ctx, item);
  const res = await fetchStream(item.src).catch((err: Error) => {
    throw new Error(`Couldn't download the video directly (${err.message}). Use "Record this tab" instead.`);
  });
  const mime = res.mime.startsWith('video/') || res.mime.startsWith('audio/') ? res.mime : item.kind === 'audio' ? 'audio/mpeg' : 'video/mp4';
  const degraded: string[] = [];
  if ('error' in shot) degraded.push(`in-context screenshot failed: ${shot.error}`);

  // Small companions first: poster and caption tracks (SPEC F7).
  const extra: NewCaptureFile[] = [];
  const companions: Record<string, unknown>[] = [];
  const v = item.video;
  if (v?.poster && /^https?:/i.test(v.poster)) {
    try {
      const p = await fetchOriginal(v.poster);
      const pm = sniffMime(p.bytes) ?? p.mime;
      extra.push({ path: `poster.${extensionFor(pm, v.poster)}`, data: p.bytes, mime: pm, role: 'poster' });
      companions.push({ role: 'poster', url: v.poster });
    } catch (err) {
      degraded.push(`poster not saved: ${(err as Error).message}`);
    }
  }
  for (const [i, t] of (v?.tracks ?? []).entries()) {
    if (!/^https?:/i.test(t.src)) continue;
    try {
      const r = await fetchOriginal(t.src);
      const name = `tracks/${String(i + 1).padStart(2, '0')}-${(t.srclang || t.kind || 'track').replace(/[^a-z0-9-]/gi, '')}.${extensionFor(r.mime || 'text/vtt', t.src)}`;
      extra.push({ path: name, data: r.bytes, mime: r.mime || 'text/vtt', role: 'track' });
      companions.push({ role: 'track', url: t.src, kind: t.kind, label: t.label, srclang: t.srclang });
    } catch (err) {
      degraded.push(`caption track ${t.src} not saved: ${(err as Error).message}`);
    }
  }

  const jobId = uuid();
  const label = (item.src.split('/').pop() || 'video').split('?')[0]!.slice(0, 60);
  const meta = {
    ...itemMeta(ctx, item, info),
    kind: item.kind,
    mime,
    finalUrl: res.finalUrl,
    httpStatus: res.status,
    responseHeaders: res.headers,
    contentLength: res.total,
    video: v,
    companions,
  };
  const pending = await beginCapture({
    caseId: ctx.caseId,
    type: 'video',
    method: 'extension-fetch(stream)',
    url: info.url,
    title: info.title,
    startedAtUtc,
    degraded,
    meta,
  });
  await startJob({ id: jobId, label, caseId: ctx.caseId, total: res.total });
  if (res.total && res.total > LARGE_VIDEO) {
    await updateJob(jobId, { message: `Large file (${formatBytes(res.total)}). Make sure there is enough free space.` });
  }
  let lastBeat = 0;
  try {
    const rec = await completeCapture(
      pending,
      [
        {
          path: `video.${extensionFor(mime, res.finalUrl)}`,
          data: {
            stream: res.stream,
            onProgress(bytes) {
              const now = Date.now();
              if (now - lastBeat < 1000) return;
              lastBeat = now;
              void updateJob(jobId, { bytes });
            },
          },
          mime,
          role: 'primary',
        },
        ...extra,
      ],
      { meta: { ...meta, resumedAt: res.resumedAt } },
    );
    await updateJob(jobId, { status: 'done', bytes: rec.files[0]!.bytes, captureId: rec.id, message: null }, true);
    if (!('error' in shot)) await storeContextShot(ctx, rec, shot, info).catch((e) => console.warn('[EviCap] context shot', e));
    return rec;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    await failCapture(pending, `download failed: ${msg}`);
    await updateJob(jobId, { status: 'failed', message: msg }, true);
    throw err;
  }
}
