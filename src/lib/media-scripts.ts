/**
 * Page-side media tool (SPEC F6, F7), injected with chrome.scripting.executeScript.
 * It must be self-contained: it is serialised and runs in the page's isolated
 * world, so it can't use imports. Picked elements are remembered in the
 * isolated world (not marked in the page's DOM) between calls.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MediaItem {
  pickId: string;
  kind: 'image' | 'video' | 'audio' | 'background';
  tag: string;
  /** The source EviCap will capture. */
  src: string;
  sourceChoice: 'srcset-largest' | 'currentSrc' | 'src' | 'lazy-attribute' | 'css-background' | 'context-menu';
  candidates: {
    currentSrc: string | null;
    src: string | null;
    srcset: { url: string; descriptor: string }[];
    lazy: Record<string, string>;
    sources: string[];
  };
  alt: string | null;
  title: string | null;
  ariaLabel: string | null;
  natural: { width: number; height: number } | null;
  rendered: { width: number; height: number };
  docRect: Rect;
  domPath: string;
  snippet: string;
  frameUrl: string;
  video: {
    duration: number | null;
    currentTime: number;
    paused: boolean;
    poster: string | null;
    tracks: { kind: string; label: string; srclang: string; src: string }[];
    /** EME: `mediaKeys` is set, so a tab recording may show black frames. */
    encrypted: boolean;
    /** blob:/MediaSource or srcObject: no file to download, so record the tab. */
    streamed: boolean;
    videoWidth: number;
    videoHeight: number;
  } | null;
}

export interface ScrollResult {
  viewRect: Rect;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  devicePixelRatio: number;
  inFrame: boolean;
}

export interface PageFetch {
  ok: boolean;
  error?: string;
  status?: number;
  finalUrl?: string;
  mime?: string;
  b64?: string;
  headers?: Record<string, string>;
}

export type MediaToolCall =
  | ['at', { srcUrl: string; mediaType: string; prefer: 'largest' | 'displayed' }]
  | ['pick', { prefer: 'largest' | 'displayed' }]
  | ['scroll', { pickId: string }]
  | ['fetch', { url: string }]
  | ['canvas', { pickId: string }]
  | ['drm', Record<string, never>]
  | ['clear', Record<string, never>];

export function mediaTool(action: string, arg: Record<string, unknown>): unknown {
  type W = typeof window & { __evicapPicks?: Map<string, Element>; __evicapPickSeq?: number };
  const w = window as W;
  w.__evicapPicks ??= new Map();
  const picks = w.__evicapPicks;
  const LAZY = [
    'data-src',
    'data-original',
    'data-lazy-src',
    'data-lazy',
    'data-srcset',
    'data-full-src',
    'data-large-src',
    'data-hires',
    'data-zoom-image',
    'data-url',
  ];

  const abs = (u: string | null | undefined): string | null => {
    if (!u) return null;
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return null;
    }
  };

  const parseSrcset = (s: string | null): { url: string; descriptor: string; size: number }[] => {
    if (!s) return [];
    const out: { url: string; descriptor: string; size: number }[] = [];
    // HTML srcset parsing: a URL runs to whitespace (so data: URLs keep their commas);
    // a URL ending in a comma has no descriptor; otherwise the descriptor runs to the next comma.
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /[\s,]/.test(s[i]!)) i++;
      let j = i;
      while (j < s.length && !/\s/.test(s[j]!)) j++;
      let rawUrl = s.slice(i, j);
      let d = '';
      if (rawUrl.endsWith(',')) {
        rawUrl = rawUrl.replace(/,+$/, '');
        i = j;
      } else {
        const k = s.indexOf(',', j);
        d = s.slice(j, k < 0 ? s.length : k).trim();
        i = k < 0 ? s.length : k + 1;
      }
      const url = abs(rawUrl);
      if (!url) continue;
      const desc = d || '1x';
      const n = parseFloat(desc);
      out.push({ url, descriptor: desc, size: desc.endsWith('w') ? n : (Number.isFinite(n) ? n : 1) * 100000 });
    }
    return out;
  };

  const isPlaceholder = (u: string | null, el?: HTMLImageElement) =>
    !u || (u.startsWith('data:') && u.length < 300) || (el ? el.complete && el.naturalWidth <= 2 : false);

  const domPath = (el: Element): string => {
    const parts: string[] = [];
    let e: Element | null = el;
    while (e && e !== document.documentElement && parts.length < 12) {
      let s = e.tagName.toLowerCase();
      if (e.id) {
        parts.unshift(`${s}#${CSS.escape(e.id)}`);
        break;
      }
      const parent: Element | null = e.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === e!.tagName);
        if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
      }
      parts.unshift(s);
      e = parent;
    }
    return parts.join(' > ');
  };

  const snippet = (el: Element): string => {
    const fig = el.closest('figure');
    const cap = fig?.querySelector('figcaption')?.textContent?.trim();
    const block = el.closest('p, li, article, section, figure, td, div') ?? el.parentElement;
    const text = ((cap ? cap + ' — ' : '') + (block?.textContent ?? '')).replace(/\s+/g, ' ').trim();
    return text.slice(0, 400);
  };

  const bgUrl = (el: Element): string | null => {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg !== 'none' ? /url\(["']?(.*?)["']?\)/.exec(bg) : null;
    return m ? abs(m[1]) : null;
  };

  const describe = (el: Element, prefer: string, forcedSrc?: string): MediaItem => {
    const seq = (w.__evicapPickSeq = (w.__evicapPickSeq ?? 0) + 1);
    const pickId = `p${seq}`;
    picks.set(pickId, el);
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const lazy: Record<string, string> = {};
    for (const a of LAZY) {
      const v = el.getAttribute(a);
      if (v) lazy[a] = v.slice(0, 2000);
    }
    const base = {
      pickId,
      tag,
      alt: el.getAttribute('alt'),
      title: el.getAttribute('title'),
      ariaLabel: el.getAttribute('aria-label'),
      rendered: { width: Math.round(r.width), height: Math.round(r.height) },
      docRect: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height },
      domPath: domPath(el),
      snippet: snippet(el),
      frameUrl: location.href,
    };
    if (el instanceof HTMLImageElement) {
      const sets = [...parseSrcset(el.getAttribute('srcset'))];
      if (el.parentElement instanceof HTMLPictureElement) {
        el.parentElement.querySelectorAll('source[srcset]').forEach((s) => sets.push(...parseSrcset(s.getAttribute('srcset'))));
      }
      const largest = sets.sort((a, b) => b.size - a.size)[0];
      const current = el.currentSrc || null;
      const src = abs(el.getAttribute('src'));
      let chosen: string | null = null;
      let choice: MediaItem['sourceChoice'] = 'currentSrc';
      if (forcedSrc) {
        chosen = forcedSrc;
        choice = 'context-menu';
      } else if (prefer === 'largest' && largest && !isPlaceholder(largest.url)) {
        chosen = largest.url;
        choice = 'srcset-largest';
      } else if (current && !isPlaceholder(current, el)) {
        chosen = current;
      } else if (src && !isPlaceholder(src, el)) {
        chosen = src;
        choice = 'src';
      }
      const lazyUrl = abs(lazy['data-src'] ?? lazy['data-original'] ?? lazy['data-lazy-src'] ?? lazy['data-lazy'] ?? lazy['data-hires'] ?? lazy['data-full-src'] ?? lazy['data-large-src'] ?? null);
      if (!chosen && lazyUrl) {
        chosen = lazyUrl;
        choice = 'lazy-attribute';
      }
      return {
        ...base,
        kind: 'image',
        src: chosen ?? current ?? src ?? '',
        sourceChoice: choice,
        candidates: { currentSrc: current, src, srcset: sets.map(({ url, descriptor }) => ({ url, descriptor })), lazy, sources: [] },
        natural: { width: el.naturalWidth, height: el.naturalHeight },
        video: null,
      };
    }
    if (el instanceof HTMLMediaElement) {
      const sources = Array.from(el.querySelectorAll('source'))
        .map((s) => abs(s.getAttribute('src')))
        .filter((s): s is string => !!s);
      const current = el.currentSrc || null;
      const src = abs(el.getAttribute('src'));
      const chosen = forcedSrc ?? current ?? src ?? sources[0] ?? '';
      const isVideo = el instanceof HTMLVideoElement;
      return {
        ...base,
        kind: isVideo ? 'video' : 'audio',
        src: chosen,
        sourceChoice: forcedSrc ? 'context-menu' : current ? 'currentSrc' : 'src',
        candidates: { currentSrc: current, src, srcset: [], lazy, sources },
        natural: isVideo ? { width: el.videoWidth, height: el.videoHeight } : null,
        video: {
          duration: Number.isFinite(el.duration) ? el.duration : null,
          currentTime: el.currentTime,
          paused: el.paused,
          poster: isVideo ? abs(el.getAttribute('poster')) : null,
          tracks: Array.from(el.querySelectorAll('track')).map((t) => ({
            kind: t.kind,
            label: t.label,
            srclang: t.srclang,
            src: abs(t.getAttribute('src')) ?? '',
          })),
          encrypted: !!el.mediaKeys,
          streamed: !!el.srcObject || !chosen || chosen.startsWith('blob:') || chosen.startsWith('mediasource:'),
          videoWidth: isVideo ? el.videoWidth : 0,
          videoHeight: isVideo ? el.videoHeight : 0,
        },
      };
    }
    const bg = forcedSrc ?? bgUrl(el) ?? '';
    return {
      ...base,
      kind: 'background',
      src: bg,
      sourceChoice: 'css-background',
      candidates: { currentSrc: null, src: null, srcset: [], lazy, sources: [] },
      natural: null,
      video: null,
    };
  };

  const visible = (el: Element, min: number) => {
    const r = el.getBoundingClientRect();
    if (r.width < min || r.height < min) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };

  const collect = (): Element[] => {
    const out: Element[] = [];
    document.querySelectorAll('img, video, audio[controls]').forEach((el) => {
      if (visible(el, el.tagName === 'AUDIO' ? 8 : 24)) out.push(el);
    });
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < all.length && i < 8000; i++) {
      const el = all[i]!;
      if (el instanceof HTMLImageElement || el instanceof HTMLMediaElement) continue;
      if (bgUrl(el) && visible(el, 48)) out.push(el);
    }
    return out;
  };

  const sameUrl = (a: string | null | undefined, b: string) => !!a && (a === b || abs(a) === b);

  if (action === 'at') {
    const { srcUrl, mediaType, prefer } = arg as { srcUrl: string; mediaType: string; prefer: string };
    const sel = mediaType === 'image' ? 'img' : mediaType === 'audio' ? 'audio' : 'video';
    const els = Array.from(document.querySelectorAll(sel));
    const el =
      els.find((e) => {
        const m = e as HTMLImageElement & HTMLMediaElement;
        return sameUrl(m.currentSrc, srcUrl) || sameUrl(e.getAttribute('src'), srcUrl) ||
          Array.from(e.querySelectorAll('source')).some((s) => sameUrl(s.getAttribute('src'), srcUrl));
      }) ?? null;
    if (!el) return null;
    // A right-clicked image is captured as the URL the browser reported.
    return describe(el, prefer, mediaType === 'image' ? srcUrl : undefined);
  }

  if (action === 'pick') {
    const { prefer } = arg as { prefer: string };
    return new Promise<MediaItem[] | null>((resolve) => {
      const els = collect();
      const selected = new Set<number>();
      const host = document.createElement('div');
      host.setAttribute('data-evicap-overlay', '');
      const docW = Math.max(document.documentElement.scrollWidth, innerWidth);
      const docH = Math.max(document.documentElement.scrollHeight, innerHeight);
      host.style.cssText = `position:absolute;left:0;top:0;width:${docW}px;height:${docH}px;z-index:2147483647;pointer-events:none;`;
      const shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `
        <style>
          .box{position:absolute;box-sizing:border-box;border:2px dashed #2563eb;background:rgba(37,99,235,.08);pointer-events:auto;cursor:pointer;border-radius:3px}
          .box:hover{background:rgba(37,99,235,.18)}
          .box.on{border:3px solid #16a34a;background:rgba(22,163,74,.22)}
          .box .lbl{position:absolute;left:0;top:0;font:600 11px system-ui,sans-serif;color:#fff;background:#2563eb;padding:1px 5px;border-radius:0 0 4px 0}
          .box.on .lbl{background:#16a34a}
          .bar{position:fixed;left:50%;top:12px;transform:translateX(-50%);display:flex;gap:8px;align-items:center;pointer-events:auto;
               font:14px system-ui,sans-serif;background:#111827;color:#fff;padding:8px 10px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
          .bar button{font:inherit;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;background:#374151;color:#fff}
          .bar button.go{background:#16a34a}
          .bar button:disabled{opacity:.5;cursor:default}
        </style>
        <div class="bar" role="toolbar" aria-label="EviCap media picker">
          <span class="count">EviCap: click images and videos to select them</span>
          <button type="button" class="all">Select all</button>
          <button type="button" class="go" disabled>Capture selected</button>
          <button type="button" class="cancel">Cancel (Esc)</button>
        </div>`;
      const count = shadow.querySelector('.count')!;
      const go = shadow.querySelector('.go') as HTMLButtonElement;
      const boxes: HTMLDivElement[] = [];
      const kindLabel = (el: Element) =>
        el instanceof HTMLVideoElement ? 'video' : el instanceof HTMLAudioElement ? 'audio' : el instanceof HTMLImageElement ? 'image' : 'background';
      const refresh = () => {
        boxes.forEach((b, i) => b.classList.toggle('on', selected.has(i)));
        go.disabled = selected.size === 0;
        go.textContent = `Capture selected (${selected.size})`;
        count.textContent = `${els.length} found · ${selected.size} selected`;
      };
      els.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const b = document.createElement('div');
        b.className = 'box';
        b.style.cssText = `left:${r.left + scrollX}px;top:${r.top + scrollY}px;width:${r.width}px;height:${r.height}px`;
        b.innerHTML = `<span class="lbl"></span>`;
        b.querySelector('.lbl')!.textContent = kindLabel(el);
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (selected.has(i)) selected.delete(i);
          else selected.add(i);
          refresh();
        });
        shadow.appendChild(b);
        boxes.push(b);
      });
      const finish = (ok: boolean) => {
        removeEventListener('keydown', onKey, true);
        host.remove();
        resolve(ok ? [...selected].sort((a, b) => a - b).map((i) => describe(els[i]!, prefer)) : null);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        } else if (e.key === 'Enter' && selected.size) {
          e.preventDefault();
          e.stopPropagation();
          finish(true);
        }
      };
      shadow.querySelector('.all')!.addEventListener('click', () => {
        els.forEach((_, i) => selected.add(i));
        refresh();
      });
      go.addEventListener('click', () => finish(true));
      shadow.querySelector('.cancel')!.addEventListener('click', () => finish(false));
      addEventListener('keydown', onKey, true);
      document.documentElement.appendChild(host);
      refresh();
      if (els.length === 0) count.textContent = 'EviCap: no images or videos found on this page';
    });
  }

  if (action === 'scroll') {
    const el = picks.get((arg as { pickId: string }).pickId);
    if (!el || !el.isConnected) return null;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    return new Promise<ScrollResult>((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          setTimeout(() => {
            const r = el.getBoundingClientRect();
            resolve({
              viewRect: { x: r.left, y: r.top, width: r.width, height: r.height },
              viewport: { width: innerWidth, height: innerHeight },
              scroll: { x: scrollX, y: scrollY },
              devicePixelRatio,
              inFrame: window.top !== window,
            });
          }, 150),
        ),
      ),
    );
  }

  if (action === 'fetch') {
    const { url } = arg as { url: string };
    return (async (): Promise<PageFetch> => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
        const blob = await res.blob();
        if (blob.size > 256 * 1024 * 1024) return { ok: false, error: 'Too large to fetch in the page' };
        const b64 = await new Promise<string>((res2, rej) => {
          const fr = new FileReader();
          fr.onload = () => res2(String(fr.result).slice(String(fr.result).indexOf(',') + 1));
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(blob);
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = v));
        return { ok: true, status: res.status, finalUrl: res.url || url, mime: blob.type, b64, headers };
      } catch (err) {
        return { ok: false, error: (err as Error).message || String(err) };
      }
    })();
  }

  if (action === 'canvas') {
    const el = picks.get((arg as { pickId: string }).pickId);
    try {
      if (!(el instanceof HTMLImageElement) && !(el instanceof HTMLVideoElement)) return { ok: false, error: 'not an image' };
      const width = el instanceof HTMLImageElement ? el.naturalWidth : el.videoWidth;
      const height = el instanceof HTMLImageElement ? el.naturalHeight : el.videoHeight;
      if (!width || !height) return { ok: false, error: 'image not loaded' };
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      c.getContext('2d')!.drawImage(el, 0, 0);
      const url = c.toDataURL('image/png');
      return { ok: true, mime: 'image/png', b64: url.slice(url.indexOf(',') + 1) } satisfies PageFetch;
    } catch (err) {
      return { ok: false, error: (err as Error).message || 'canvas is tainted (cross-origin image)' } satisfies PageFetch;
    }
  }

  if (action === 'drm') {
    return Array.from(document.querySelectorAll('video, audio')).some((m) => !!(m as HTMLMediaElement).mediaKeys);
  }

  if (action === 'clear') {
    picks.clear();
    return true;
  }
  return null;
}
