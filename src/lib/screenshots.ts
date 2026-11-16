import { storeCapture, type NewCaptureFile } from './captures';
import {
  hideFixedElements,
  pageInfo,
  restoreFixedElements,
  scrollToY,
  selectElement,
  selectRegion,
  type PageInfo,
  type Rect,
} from './page-scripts';
import type { CaptureRecord } from './types';
import { nowUtc, sleep } from './util';

/** Screenshots (SPEC F5). The PNG is stored untouched; context goes in `meta`. */

export type ScreenshotMode = 'visible' | 'full' | 'region' | 'element';

async function run<T>(tabId: number, func: () => T | Promise<T>): Promise<T> {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func });
  return res?.result as T;
}

async function runArgs<A extends unknown[], T>(tabId: number, func: (...args: A) => T | Promise<T>, args: A): Promise<T> {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result as T;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let lastVisibleCapture = 0;
/** Chrome allows about two captureVisibleTab calls per second. */
export async function captureVisiblePng(windowId: number): Promise<Uint8Array> {
  const wait = 600 - (Date.now() - lastVisibleCapture);
  if (wait > 0) await sleep(wait);
  lastVisibleCapture = Date.now();
  const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  return dataUrlToBytes(url);
}

export async function cropPng(png: Uint8Array, rect: Rect, scale: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.min(bitmap.width - sx, Math.round(rect.width * scale));
  const sh = Math.min(bitmap.height - sy, Math.round(rect.height * scale));
  const canvas = new OffscreenCanvas(Math.max(1, sw), Math.max(1, sh));
  canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

async function prepare(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^(https?|file):/i.test(tab.url)) {
    throw new Error('EviCap can only capture web pages (not browser or extension pages).');
  }
  const info = await run(tabId, pageInfo);
  return { tab, info, startedAtUtc: nowUtc() };
}

function baseMeta(info: PageInfo, mode: ScreenshotMode, visitId: string | null) {
  return {
    mode,
    visitId,
    viewport: info.viewport,
    devicePixelRatio: info.devicePixelRatio,
    scroll: info.scroll,
    documentSize: info.document,
    canonicalUrl: info.canonicalUrl,
    pageMeta: info.meta,
    capturedTimeSource: 'system clock',
  };
}

export interface ScreenshotRequest {
  caseId: string;
  tabId: number;
  mode: ScreenshotMode;
  visitId: string | null;
}

export async function takeScreenshot(req: ScreenshotRequest): Promise<CaptureRecord | null> {
  switch (req.mode) {
    case 'visible':
      return visible(req);
    case 'full':
      return fullPage(req);
    case 'region':
      return region(req);
    case 'element':
      return element(req);
  }
}

async function visible(req: ScreenshotRequest) {
  const { tab, info, startedAtUtc } = await prepare(req.tabId);
  const png = await captureVisiblePng(tab.windowId);
  return storeCapture({
    caseId: req.caseId,
    type: 'screenshot',
    method: 'captureVisibleTab',
    url: info.url,
    title: info.title,
    startedAtUtc,
    files: [{ path: 'screenshot.png', data: png, mime: 'image/png', role: 'primary' }],
    meta: baseMeta(info, 'visible', req.visitId),
  });
}

async function region(req: ScreenshotRequest) {
  const { tab, info, startedAtUtc } = await prepare(req.tabId);
  await chrome.tabs.update(req.tabId, { active: true });
  const rect = await run(req.tabId, selectRegion);
  if (!rect) return null;
  const png = await captureVisiblePng(tab.windowId);
  const cropped = await cropPng(png, rect, info.devicePixelRatio);
  return storeCapture({
    caseId: req.caseId,
    type: 'screenshot',
    method: 'captureVisibleTab+crop',
    url: info.url,
    title: info.title,
    startedAtUtc,
    files: [
      { path: 'region.png', data: cropped, mime: 'image/png', role: 'primary' },
      { path: 'visible.png', data: png, mime: 'image/png', role: 'source' },
    ],
    meta: { ...baseMeta(info, 'region', req.visitId), regionCss: rect },
  });
}

async function element(req: ScreenshotRequest) {
  const { tab, info, startedAtUtc } = await prepare(req.tabId);
  await chrome.tabs.update(req.tabId, { active: true });
  const pick = await run(req.tabId, selectElement);
  if (!pick) return null;
  const after = await run(req.tabId, pageInfo);
  const meta = {
    ...baseMeta(after, 'element', req.visitId),
    element: { tag: pick.tag, path: pick.path, text: pick.text, docRect: pick.docRect },
  };
  if (pick.fitsViewport) {
    const png = await captureVisiblePng(tab.windowId);
    const cropped = await cropPng(png, pick.viewRect, after.devicePixelRatio);
    return storeCapture({
      caseId: req.caseId,
      type: 'screenshot',
      method: 'captureVisibleTab+crop',
      url: info.url,
      title: info.title,
      startedAtUtc,
      files: [
        { path: 'element.png', data: cropped, mime: 'image/png', role: 'primary' },
        { path: 'visible.png', data: png, mime: 'image/png', role: 'source' },
      ],
      meta,
    });
  }
  // Taller than the window: use the debugger to capture beyond the viewport.
  const shot = await withDebugger(req.tabId, (send) =>
    send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { ...pick.docRect, scale: 1 },
    }),
  );
  if ('error' in shot) throw new Error(`Could not capture the element: ${shot.error}`);
  return storeCapture({
    caseId: req.caseId,
    type: 'screenshot',
    method: 'cdp:Page.captureScreenshot(clip)',
    url: info.url,
    title: info.title,
    startedAtUtc,
    files: [{ path: 'element.png', data: base64ToBytes(shot.value.data), mime: 'image/png', role: 'primary' }],
    meta,
  });
}

function base64ToBytes(b64: string): Uint8Array {
  return dataUrlToBytes(',' + b64);
}

type Send = <T>(method: string, params?: object) => Promise<T>;

/**
 * Attach chrome.debugger for one operation (Chrome shows its "debugging" bar
 * while attached) and always detach. Returns `{error}` if it can't attach,
 * for example when DevTools is already open on the tab.
 */
export async function withDebugger<T>(tabId: number, fn: (send: Send) => Promise<T>): Promise<{ value: T } | { error: string }> {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    return { error: (err as Error).message || 'debugger unavailable' };
  }
  const send: Send = (method, params) =>
    chrome.debugger.sendCommand(target, method, params as Record<string, unknown>) as Promise<never>;
  try {
    await settleAfterAttach(send);
    return { value: await fn(send) };
  } catch (err) {
    return { error: (err as Error).message || String(err) };
  } finally {
    await chrome.debugger.detach(target).catch(() => undefined);
  }
}

/**
 * Attaching the debugger shows the browser's "debugging" bar, which resizes
 * the page. Capturing beyond the viewport before that settles gives an image
 * that repeats the first screen down the page (seen in Edge 157). Wait until
 * the viewport size is stable, then two animation frames.
 */
async function settleAfterAttach(send: Send) {
  type Metrics = { cssVisualViewport?: { clientWidth: number; clientHeight: number } };
  const size = async () => {
    const m = await send<Metrics>('Page.getLayoutMetrics');
    return `${m.cssVisualViewport?.clientWidth}x${m.cssVisualViewport?.clientHeight}`;
  };
  const start = Date.now();
  let last = await size();
  let stableSince = Date.now();
  while (Date.now() - start < 2000) {
    await sleep(100);
    const now = await size();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 300 && Date.now() - start >= 300) {
      break;
    }
  }
  await send('Runtime.evaluate', {
    expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
    awaitPromise: true,
  }).catch(() => undefined);
}

const MAX_SINGLE_SHOT_CSS = 8000;
const TILE_CSS = 4000;
const MAX_STITCH_PX = 32000;

async function fullPage(req: ScreenshotRequest) {
  const { tab, info, startedAtUtc } = await prepare(req.tabId);
  const meta = baseMeta(info, 'full', req.visitId);

  const cdp = await withDebugger(req.tabId, async (send) => {
    const m = await send<{ cssContentSize?: { width: number; height: number }; contentSize: { width: number; height: number } }>(
      'Page.getLayoutMetrics',
    );
    const size = m.cssContentSize ?? m.contentSize;
    const width = Math.ceil(size.width);
    const height = Math.ceil(size.height);
    const tiles: { y: number; h: number; png: Uint8Array }[] = [];
    const step = height <= MAX_SINGLE_SHOT_CSS ? height : TILE_CSS;
    for (let y = 0; y < height; y += step) {
      const h = Math.min(step, height - y);
      const r = await send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        fromSurface: true,
        clip: { x: 0, y, width, height: h, scale: 1 },
      });
      tiles.push({ y, h, png: base64ToBytes(r.data) });
    }
    return { width, height, tiles };
  });

  if ('value' in cdp) {
    const { width, height, tiles } = cdp.value;
    const files: NewCaptureFile[] = [];
    let method = 'cdp:Page.captureScreenshot(captureBeyondViewport)';
    if (tiles.length === 1) {
      files.push({ path: 'fullpage.png', data: tiles[0]!.png, mime: 'image/png', role: 'primary' });
    } else {
      method += '+tiles';
      const stitched = await stitch(tiles.map((t) => ({ png: t.png, yCss: t.y })), info.devicePixelRatio, height);
      if (stitched) files.push({ path: 'fullpage.png', data: stitched, mime: 'image/png', role: 'primary' });
      tiles.forEach((t, i) =>
        files.push({
          path: `tiles/tile-${String(i + 1).padStart(3, '0')}.png`,
          data: t.png,
          mime: 'image/png',
          role: stitched ? 'tile' : i === 0 ? 'primary' : 'tile',
        }),
      );
    }
    return storeCapture({
      caseId: req.caseId,
      type: 'screenshot',
      method,
      url: info.url,
      title: info.title,
      startedAtUtc,
      files,
      meta: { ...meta, pageCss: { width, height }, tiles: tiles.map((t) => ({ yCss: t.y, heightCss: t.h })) },
    });
  }

  // Fallback without the debugger: scroll and stitch (marked as degraded).
  const degraded = [`debugger unavailable (${cdp.error}); scrolled and stitched`];
  const tiles: { png: Uint8Array; yCss: number }[] = [];
  const totalHeight = info.document.height;
  let hidden = 0;
  try {
    for (let y = 0; y < totalHeight; ) {
      const pos = await runArgs(req.tabId, scrollToY, [y]);
      await sleep(250);
      tiles.push({ png: await captureVisiblePng(tab.windowId), yCss: pos.y });
      if (tiles.length === 1) hidden = await run(req.tabId, hideFixedElements);
      if (pos.y + pos.viewportHeight >= totalHeight) break;
      y = pos.y + pos.viewportHeight;
      if (tiles.length > 200) {
        degraded.push('stopped after 200 screens');
        break;
      }
    }
  } finally {
    await runArgs(req.tabId, restoreFixedElements, [info.scroll.x, info.scroll.y]);
  }
  if (hidden) degraded.push(`${hidden} fixed or sticky elements hidden after the first screen`);
  const stitched = await stitch(tiles, info.devicePixelRatio, totalHeight, info.viewport.height);
  const files: NewCaptureFile[] = [];
  if (stitched) files.push({ path: 'fullpage.png', data: stitched, mime: 'image/png', role: 'primary' });
  tiles.forEach((t, i) =>
    files.push({
      path: `tiles/tile-${String(i + 1).padStart(3, '0')}.png`,
      data: t.png,
      mime: 'image/png',
      role: stitched ? 'tile' : i === 0 ? 'primary' : 'tile',
    }),
  );
  return storeCapture({
    caseId: req.caseId,
    type: 'screenshot',
    method: 'captureVisibleTab+scroll-stitch',
    url: info.url,
    title: info.title,
    startedAtUtc,
    files,
    degraded,
    meta: { ...meta, tiles: tiles.map((t) => ({ yCss: t.yCss })) },
  });
}

/** Stitch tiles vertically. Returns null if the result would be too large for a canvas. */
async function stitch(
  tiles: { png: Uint8Array; yCss: number }[],
  dpr: number,
  totalHeightCss: number,
  viewportHeightCss?: number,
): Promise<Uint8Array | null> {
  if (tiles.length === 0) return null;
  const bitmaps = await Promise.all(
    tiles.map((t) => createImageBitmap(new Blob([t.png as BlobPart], { type: 'image/png' }))),
  );
  try {
    const width = bitmaps[0]!.width;
    const heightPx = Math.round(totalHeightCss * dpr);
    if (heightPx > MAX_STITCH_PX || width * heightPx > 268_000_000) return null;
    const canvas = new OffscreenCanvas(width, heightPx);
    const ctx = canvas.getContext('2d')!;
    bitmaps.forEach((b, i) => {
      const y = Math.round(tiles[i]!.yCss * dpr);
      const h = viewportHeightCss ? Math.min(b.height, heightPx - y) : b.height;
      ctx.drawImage(b, 0, 0, b.width, h, 0, y, b.width, h);
    });
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  } finally {
    bitmaps.forEach((b) => b.close());
  }
}
