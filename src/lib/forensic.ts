import { strToU8 } from 'fflate';
import { storeCapture, type NewCaptureFile } from './captures';
import { getEnvironment } from './environment';
import { updateJob, startJob } from './jobs';
import { fetchOriginal } from './net';
import { pageInfo, type PageInfo } from './page-scripts';
import { base64ToBytes, captureVisiblePng, cdpFullPage, settleAfterAttach, type Send } from './screenshots';
import { getSettings } from './settings';
import type { CaptureRecord } from './types';
import { nowUtc, sleep, uuid } from './util';
import { buildWacz, type WarcEntry } from './wacz';

/**
 * Forensic page capture (SPEC F4): everything about the current page, through
 * the Chrome DevTools Protocol, packaged as WACZ with a full-page screenshot,
 * MHTML, the rendered DOM, the source HTML, the network log and TLS details.
 * The browser shows its "debugging" bar while this runs.
 */

export interface ForensicOptions {
  /** Reload with network recording on, so every request is captured from the start. */
  reload: boolean;
  autoScroll: boolean;
  maxScrollPx: number;
  maxScrollSec: number;
}

interface NetEntry {
  requestId: string;
  hop: number;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  resourceType: string;
  wallTime: number;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  mimeType?: string;
  remoteIPAddress?: string;
  remotePort?: number;
  protocol?: string;
  fromCache?: boolean;
  securityDetails?: Record<string, unknown>;
  timing?: Record<string, number>;
  encodedDataLength?: number;
  finished?: boolean;
  failed?: string;
  body?: Uint8Array;
  bodyUnavailable?: string;
  isRedirect?: boolean;
}

type CdpResponse = {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  mimeType: string;
  remoteIPAddress?: string;
  remotePort?: number;
  protocol?: string;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  fromPrefetchCache?: boolean;
  securityDetails?: Record<string, unknown>;
  timing?: Record<string, number>;
};

const MAX_BODIES_BYTES = 300 * 1024 * 1024;

export interface ForensicRequest {
  caseId: string;
  tabId: number;
  visitId: string | null;
  options?: Partial<ForensicOptions>;
}

export async function forensicCapture(req: ForensicRequest): Promise<CaptureRecord> {
  const settings = await getSettings();
  const opts: ForensicOptions = {
    reload: false,
    autoScroll: settings.forensicAutoScroll,
    maxScrollPx: 30000,
    maxScrollSec: 20,
    ...req.options,
  };
  const tab = await chrome.tabs.get(req.tabId);
  if (!tab.url || !/^(https?|file):/i.test(tab.url)) {
    throw new Error('EviCap can only capture web pages (not browser or extension pages).');
  }
  const jobId = uuid();
  const host = (() => {
    try {
      return new URL(tab.url!).host;
    } catch {
      return tab.url!;
    }
  })();
  await startJob({ id: jobId, label: `Forensic capture: ${host}`, caseId: req.caseId, total: null });
  const step = (message: string) => updateJob(jobId, { message }, true);
  try {
    const rec = await run(req, opts, step);
    await updateJob(jobId, { status: 'done', captureId: rec.id, message: null, bytes: rec.files.reduce((n, f) => n + f.bytes, 0) }, true);
    return rec;
  } catch (err) {
    await updateJob(jobId, { status: 'failed', message: (err as Error).message }, true);
    throw err;
  }
}

async function run(req: ForensicRequest, opts: ForensicOptions, step: (m: string) => Promise<void>): Promise<CaptureRecord> {
  const startedAtUtc = nowUtc();
  const target = { tabId: req.tabId };
  await step('Attaching the debugger…');
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    return fallback(req, startedAtUtc, (err as Error).message || 'debugger unavailable');
  }

  const send: Send = (method, params) => chrome.debugger.sendCommand(target, method, params as Record<string, unknown>) as Promise<never>;
  const entries = new Map<string, NetEntry>();
  const hops = new Map<string, number>();
  const bodyJobs: Promise<void>[] = [];
  let bodyBytes = 0;
  let inFlight = 0;
  let lastNetActivity = Date.now();
  let loadFired = false;
  let securityState: Record<string, unknown> | null = null;

  const key = (id: string) => `${id}#${hops.get(id) ?? 0}`;
  const fromResponse = (e: NetEntry, r: CdpResponse) => {
    e.status = r.status;
    e.statusText = r.statusText;
    e.responseHeaders = r.headers;
    e.mimeType = r.mimeType;
    e.remoteIPAddress = r.remoteIPAddress;
    e.remotePort = r.remotePort;
    e.protocol = r.protocol;
    e.fromCache = !!(r.fromDiskCache || r.fromPrefetchCache || r.fromServiceWorker);
    e.securityDetails = r.securityDetails;
    e.timing = r.timing;
  };

  const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== req.tabId) return;
    const p = params as Record<string, any>;
    lastNetActivity = method.startsWith('Network.') ? Date.now() : lastNetActivity;
    switch (method) {
      case 'Network.requestWillBeSent': {
        const id = p.requestId as string;
        if (p.redirectResponse && entries.has(key(id))) {
          const prev = entries.get(key(id))!;
          fromResponse(prev, p.redirectResponse);
          prev.isRedirect = true;
          prev.finished = true;
          hops.set(id, (hops.get(id) ?? 0) + 1);
        } else {
          inFlight++;
        }
        entries.set(key(id), {
          requestId: id,
          hop: hops.get(id) ?? 0,
          url: p.request.url,
          method: p.request.method,
          requestHeaders: p.request.headers ?? {},
          postData: p.request.postData,
          resourceType: p.type ?? 'Other',
          wallTime: p.wallTime ? p.wallTime * 1000 : Date.now(),
        });
        break;
      }
      case 'Network.requestWillBeSentExtraInfo': {
        const e = entries.get(key(p.requestId));
        if (e && p.headers) e.requestHeaders = { ...e.requestHeaders, ...p.headers };
        break;
      }
      case 'Network.responseReceived': {
        const e = entries.get(key(p.requestId));
        if (e) {
          fromResponse(e, p.response);
          e.resourceType = p.type ?? e.resourceType;
        }
        break;
      }
      case 'Network.responseReceivedExtraInfo': {
        // Raw headers as sent on the wire (including Set-Cookie), when available.
        const e = entries.get(key(p.requestId));
        if (e && p.headers) e.responseHeaders = { ...(e.responseHeaders ?? {}), ...p.headers };
        break;
      }
      case 'Network.loadingFinished': {
        inFlight = Math.max(0, inFlight - 1);
        const e = entries.get(key(p.requestId));
        if (!e) break;
        e.finished = true;
        e.encodedDataLength = p.encodedDataLength;
        bodyJobs.push(
          (async () => {
            if (bodyBytes > MAX_BODIES_BYTES) {
              e.bodyUnavailable = 'capture size limit reached';
              return;
            }
            try {
              const b = await send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: p.requestId });
              e.body = b.base64Encoded ? base64ToBytes(b.body) : strToU8(b.body);
              bodyBytes += e.body.length;
            } catch (err) {
              e.bodyUnavailable = (err as Error).message || 'not available';
            }
          })(),
        );
        break;
      }
      case 'Network.loadingFailed': {
        inFlight = Math.max(0, inFlight - 1);
        const e = entries.get(key(p.requestId));
        if (e) {
          e.failed = p.errorText ?? 'failed';
          e.bodyUnavailable = `request failed: ${e.failed}`;
        }
        break;
      }
      case 'Page.loadEventFired':
        loadFired = true;
        break;
      case 'Security.visibleSecurityStateChanged':
        securityState = p.visibleSecurityState ?? null;
        break;
    }
  };

  const networkIdle = async (quietMs: number, maxMs: number) => {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (inFlight === 0 && Date.now() - lastNetActivity >= quietMs) return true;
      await sleep(150);
    }
    return false;
  };

  chrome.debugger.onEvent.addListener(onEvent);
  const degraded: string[] = [];
  let collected: Awaited<ReturnType<typeof collect>>;
  try {
    await settleAfterAttach(send);
    await send('Network.enable', { maxTotalBufferSize: 200 * 1024 * 1024, maxResourceBufferSize: 50 * 1024 * 1024, maxPostDataSize: 65536 });
    await send('Page.enable');
    await send('Security.enable').catch(() => undefined);

    if (opts.reload) {
      await step('Reloading with network recording on…');
      loadFired = false;
      await send('Page.reload', { ignoreCache: true });
      const t0 = Date.now();
      while (!loadFired && Date.now() - t0 < 30_000) await sleep(150);
      if (!loadFired) degraded.push('the page did not finish loading within 30 s');
      if (!(await networkIdle(1000, 15_000))) degraded.push('network still busy after 15 s; later requests not captured');
    }
    if (opts.autoScroll) {
      await step('Scrolling to load lazy content…');
      await autoScroll(send, opts);
      await networkIdle(800, 8000);
    }
    await step('Collecting the page…');
    collected = await collect(send, req.tabId, opts.reload);
    await Promise.all(bodyJobs);
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await chrome.debugger.detach(target).catch(() => undefined);
  }
  const completedClock = nowUtc();

  await step('Packaging WACZ and hashing…');
  const info = collected.info;
  const net = [...entries.values()].sort((a, b) => a.wallTime - b.wallTime);
  const warcEntries: WarcEntry[] = [];
  const seen = new Set<string>();
  let refetchedDocument: Uint8Array | null = null;
  for (const e of net) {
    if (!/^https?:/i.test(e.url) || e.status === undefined) continue;
    const date = new Date(e.wallTime).toISOString();
    const reqId = `<urn:uuid:${crypto.randomUUID()}>`;
    warcEntries.push({
      kind: 'request',
      url: e.url,
      date,
      method: e.method,
      headers: Object.entries(e.requestHeaders),
      body: e.postData ? strToU8(e.postData) : new Uint8Array(),
      recordId: reqId,
    });
    warcEntries.push({
      kind: 'response',
      url: e.url,
      date,
      status: e.status,
      statusText: e.statusText,
      headers: Object.entries(e.responseHeaders ?? {}),
      body: e.body ?? new Uint8Array(),
      concurrentTo: reqId,
      warcHeaders: {
        ...(e.remoteIPAddress ? { 'WARC-IP-Address': e.remoteIPAddress } : {}),
        ...(e.body === undefined && !e.isRedirect ? { 'WARC-Truncated': 'unspecified' } : {}),
        'WARC-Protocol': (e.protocol ?? 'http/1.1').toLowerCase(),
      },
    });
    if (e.body || e.isRedirect) seen.add(e.url);
  }
  // The browser often drops a page's own HTML from memory (always, for no-store pages).
  // Without a reload, download it again now so the archive replays, and say so.
  const pageKey = info.url.split('#')[0]!;
  if (!seen.has(pageKey) && !collected.resources.some((r) => r.url === pageKey)) {
    try {
      const again = await fetchOriginal(pageKey);
      warcEntries.push({
        kind: 'response',
        url: pageKey,
        date: nowUtc(),
        status: again.status,
        headers: Object.entries(again.headers),
        body: again.bytes,
        warcHeaders: { 'WARC-EviCap-Refetched': 'true' },
      });
      seen.add(pageKey);
      refetchedDocument = again.bytes;
      degraded.push(
        "the page's original HTML was no longer in the browser's memory, so it was downloaded again at capture time and may differ from what was on screen (dom.html is the page as displayed)",
      );
    } catch (err) {
      degraded.push(`the page's original HTML could not be stored: ${(err as Error).message}`);
    }
  }
  // Without a reload, resources already loaded come from the page's memory, without HTTP headers.
  for (const r of collected.resources) {
    if (seen.has(r.url) || !/^https?:/i.test(r.url)) continue;
    warcEntries.push({ kind: 'resource', url: r.url, date: startedAtUtc, mime: r.mimeType, body: r.body });
    seen.add(r.url);
  }
  const wacz = await buildWacz({
    title: info.title || info.url,
    software: `EviCap ${chrome.runtime.getManifest().version}`,
    entries: warcEntries,
    pages: [{ url: info.url, ts: startedAtUtc, title: info.title, text: collected.text.slice(0, 500_000) }],
    warcInfo: {
      software: `EviCap ${chrome.runtime.getManifest().version}`,
      format: 'WARC File Format 1.1',
      'evicap-capture-mode': opts.reload ? 'reload' : 'current-state',
      'http-header-user-agent': navigator.userAgent,
    },
  });

  const mainDoc = net.find((e) => e.resourceType === 'Document' && !e.isRedirect && e.url.split('#')[0] === info.url.split('#')[0]);
  const bodyUnavailable = net
    .filter((e) => e.status !== undefined && !e.isRedirect && e.body === undefined)
    .map((e) => ({ url: e.url, reason: e.bodyUnavailable ?? 'not available' }));
  const networkLog = net.map((e) => ({
    url: e.url,
    method: e.method,
    resourceType: e.resourceType,
    startedAtUtc: new Date(e.wallTime).toISOString(),
    status: e.status ?? null,
    statusText: e.statusText ?? null,
    mimeType: e.mimeType ?? null,
    protocol: e.protocol ?? null,
    remoteIPAddress: e.remoteIPAddress ?? null,
    remotePort: e.remotePort ?? null,
    fromCache: e.fromCache ?? false,
    redirect: e.isRedirect ?? false,
    failed: e.failed ?? null,
    encodedDataLength: e.encodedDataLength ?? null,
    bodyBytes: e.body?.length ?? null,
    bodyUnavailable: e.body ? null : (e.bodyUnavailable ?? (e.isRedirect ? null : 'not available')),
    requestHeaders: e.requestHeaders,
    responseHeaders: e.responseHeaders ?? null,
    timing: e.timing ?? null,
    securityDetails: e.securityDetails ?? null,
  }));
  if (!opts.reload) {
    degraded.push(
      'captured the page as already loaded (no reload): resources loaded before the capture are stored without their original HTTP headers',
    );
  }

  const enc = (s: string) => new TextEncoder().encode(s);
  const files: NewCaptureFile[] = [
    { path: 'page.wacz', data: wacz, mime: 'application/wacz', role: 'primary' },
    ...collected.screenshot.files,
    { path: 'page.mhtml', data: enc(collected.mhtml), mime: 'multipart/related', role: 'mhtml' },
    { path: 'dom.html', data: enc(collected.dom), mime: 'text/html;charset=utf-8', role: 'dom' },
  ];
  const source = mainDoc?.body ?? collected.resources.find((r) => r.url === info.url)?.body ?? refetchedDocument;
  if (source) files.push({ path: 'source.html', data: source, mime: 'text/html', role: 'source' });
  else degraded.push('original source HTML not available');
  files.push({ path: 'network.json', data: enc(JSON.stringify(networkLog, null, 1)), mime: 'application/json', role: 'network' });
  if (collected.certificatePem) files.push({ path: 'tls/chain.pem', data: enc(collected.certificatePem), mime: 'application/x-pem-file', role: 'certificate' });
  files.push({ path: 'links.json', data: enc(JSON.stringify(collected.links, null, 1)), mime: 'application/json', role: 'links' });
  files.push({ path: 'text.txt', data: enc(collected.text), mime: 'text/plain;charset=utf-8', role: 'text' });

  const env = await getEnvironment();
  return storeCapture({
    caseId: req.caseId,
    type: 'forensic',
    method: `cdp(${opts.reload ? 'reload' : 'current-state'})+wacz`,
    url: info.url,
    title: info.title,
    startedAtUtc,
    degraded,
    files,
    meta: {
      mode: 'forensic',
      visitId: req.visitId,
      options: opts,
      viewport: info.viewport,
      devicePixelRatio: info.devicePixelRatio,
      scroll: info.scroll,
      documentSize: info.document,
      canonicalUrl: info.canonicalUrl,
      referrer: info.referrer,
      lastModified: info.lastModified,
      pageMeta: info.meta,
      screen: collected.screen,
      clock: { startUtc: startedAtUtc, endUtc: completedClock, timezone: env.tz, tzOffsetMinutes: env.tzOffsetMinutes },
      screenshot: { method: collected.screenshot.method, ...collected.screenshot.meta },
      mainDocument: mainDoc
        ? { status: mainDoc.status, protocol: mainDoc.protocol, remoteIPAddress: mainDoc.remoteIPAddress, remotePort: mainDoc.remotePort }
        : null,
      tls: collected.tls ?? securitySummary(securityState) ?? (mainDoc?.securityDetails ? pickTls(mainDoc.securityDetails) : null),
      counts: {
        requests: net.length,
        responsesWithBody: net.filter((e) => e.body).length,
        resourcesFromPage: collected.resources.length,
        links: collected.links.length,
        warcRecords: warcEntries.length,
      },
      bodyUnavailable: bodyUnavailable.slice(0, 200),
      bodyUnavailableCount: bodyUnavailable.length,
      refetchedDocument: !!refetchedDocument,
      capturedTimeSource: 'system clock',
    },
  });
}

function pickTls(d: Record<string, any>) {
  return {
    protocol: d.protocol,
    cipher: d.cipher,
    keyExchange: d.keyExchange || d.keyExchangeGroup,
    subjectName: d.subjectName,
    issuer: d.issuer,
    sanList: d.sanList,
    validFromUtc: d.validFrom ? new Date(d.validFrom * 1000).toISOString() : null,
    validToUtc: d.validTo ? new Date(d.validTo * 1000).toISOString() : null,
    certificateTransparencyCompliance: d.certificateTransparencyCompliance,
    signedCertificateTimestampCount: Array.isArray(d.signedCertificateTimestampList) ? d.signedCertificateTimestampList.length : null,
  };
}

function securitySummary(s: Record<string, any> | null) {
  const c = s?.certificateSecurityState;
  if (!c) return null;
  return {
    securityState: s!.securityState,
    protocol: c.protocol,
    cipher: c.cipher,
    keyExchange: c.keyExchange || c.keyExchangeGroup,
    subjectName: c.certificateSubjectName ?? c.subjectName,
    issuer: c.issuer,
    validFromUtc: c.validFrom ? new Date(c.validFrom * 1000).toISOString() : null,
    validToUtc: c.validTo ? new Date(c.validTo * 1000).toISOString() : null,
    certificateHasWeakSignature: c.certificateHasWeakSignature,
    certificateNetworkError: c.certificateNetworkError ?? null,
  };
}

async function autoScroll(send: Send, opts: ForensicOptions) {
  await send('Runtime.evaluate', {
    awaitPromise: true,
    expression: `(async () => {
      const start = Date.now();
      const maxPx = ${Number(opts.maxScrollPx)};
      const maxMs = ${Number(opts.maxScrollSec) * 1000};
      let y = 0;
      while (Date.now() - start < maxMs && y < maxPx) {
        const before = document.scrollingElement.scrollHeight;
        y = Math.min(y + innerHeight * 0.9, maxPx);
        scrollTo(0, y);
        await new Promise(r => setTimeout(r, 350));
        if (y + innerHeight >= document.scrollingElement.scrollHeight && document.scrollingElement.scrollHeight === before) break;
      }
      scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 300));
      return y;
    })()`,
  });
}

interface Collected {
  info: PageInfo;
  screenshot: Awaited<ReturnType<typeof cdpFullPage>>;
  mhtml: string;
  dom: string;
  text: string;
  links: { href: string; text: string }[];
  screen: Record<string, unknown>;
  resources: { url: string; mimeType: string; body: Uint8Array }[];
  tls: ReturnType<typeof pickTls> | null;
  certificatePem: string | null;
}

async function evaluate<T>(send: Send, expression: string): Promise<T> {
  const r = await send<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

async function collect(send: Send, tabId: number, reloaded: boolean): Promise<Collected> {
  const [infoRes] = await chrome.scripting.executeScript({ target: { tabId }, func: pageInfo });
  const info = infoRes!.result as PageInfo;
  const screenshot = await cdpFullPage(send, info.devicePixelRatio, 'screenshot');
  const { data: mhtml } = await send<{ data: string }>('Page.captureSnapshot', { format: 'mhtml' });
  const dom = await evaluate<string>(
    send,
    `(document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\\n' : '') + document.documentElement.outerHTML`,
  );
  const text = await evaluate<string>(send, `(document.body ? document.body.innerText : '').slice(0, 5000000)`);
  const links = await evaluate<{ href: string; text: string }[]>(
    send,
    `Array.from(document.links).slice(0, 10000).map(a => ({ href: a.href, text: (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200) }))`,
  );
  const screen = await evaluate<Record<string, unknown>>(
    send,
    `({ width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, innerWidth, innerHeight, devicePixelRatio })`,
  );

  // Resources already in the page (needed when it was not reloaded under capture).
  const resources: Collected['resources'] = [];
  if (!reloaded) {
    type Frame = { frame: { id: string; url: string; mimeType: string }; resources: { url: string; mimeType: string }[]; childFrames?: Frame[] };
    const { frameTree } = await send<{ frameTree: Frame }>('Page.getResourceTree');
    const walk = async (f: Frame) => {
      const items = [{ url: f.frame.url, mimeType: f.frame.mimeType }, ...f.resources];
      for (const r of items) {
        if (!/^https?:/i.test(r.url) || resources.some((x) => x.url === r.url)) continue;
        try {
          const c = await send<{ content: string; base64Encoded: boolean }>('Page.getResourceContent', { frameId: f.frame.id, url: r.url });
          resources.push({ url: r.url, mimeType: r.mimeType, body: c.base64Encoded ? base64ToBytes(c.content) : strToU8(c.content) });
        } catch {
          /* not in memory */
        }
      }
      for (const child of f.childFrames ?? []) await walk(child);
    };
    await walk(frameTree);
  }

  let tls: Collected['tls'] = null;
  let certificatePem: string | null = null;
  if (info.url.startsWith('https:')) {
    try {
      const { tableNames } = await send<{ tableNames: string[] }>('Network.getCertificate', { origin: new URL(info.url).origin });
      if (tableNames?.length) {
        certificatePem = tableNames
          .map((b64) => `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`)
          .join('');
      }
    } catch {
      /* certificate not available */
    }
  }
  return { info, screenshot, mhtml, dom, text, links, screen, resources, tls, certificatePem };
}

/** Without the debugger (e.g. DevTools is open): the auto-capture method, marked as degraded (F4 failure handling). */
async function fallback(req: ForensicRequest, startedAtUtc: string, reason: string): Promise<CaptureRecord> {
  const tab = await chrome.tabs.get(req.tabId);
  const [infoRes] = await chrome.scripting.executeScript({ target: { tabId: req.tabId }, func: pageInfo });
  const info = infoRes!.result as PageInfo;
  const [textRes] = await chrome.scripting.executeScript({ target: { tabId: req.tabId }, func: () => document.body?.innerText ?? '' });
  const mhtml = await chrome.pageCapture.saveAsMHTML({ tabId: req.tabId });
  const files: NewCaptureFile[] = [];
  if (tab.active) files.push({ path: 'screenshot.png', data: await captureVisiblePng(tab.windowId), mime: 'image/png', role: 'screenshot' });
  if (mhtml) files.push({ path: 'page.mhtml', data: mhtml, mime: 'multipart/related', role: 'primary' });
  files.push({ path: 'text.txt', data: new TextEncoder().encode(String(textRes?.result ?? '')), mime: 'text/plain;charset=utf-8', role: 'text' });
  return storeCapture({
    caseId: req.caseId,
    type: 'forensic',
    method: 'fallback:pageCapture+captureVisibleTab',
    url: info.url,
    title: info.title,
    startedAtUtc,
    degraded: [`debugger unavailable (${reason}): saved MHTML, a visible-area screenshot and the page text instead of a WACZ`],
    files,
    meta: { mode: 'forensic', visitId: req.visitId, viewport: info.viewport, devicePixelRatio: info.devicePixelRatio, pageMeta: info.meta, capturedTimeSource: 'system clock' },
  });
}
