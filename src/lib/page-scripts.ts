/**
 * Functions injected into pages with chrome.scripting.executeScript. Each one
 * must be self-contained: it is serialised and runs in the page, so it can't
 * use imports or variables from this module.
 */

export interface PageInfo {
  url: string;
  title: string;
  canonicalUrl: string | null;
  referrer: string;
  lastModified: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  scroll: { x: number; y: number };
  document: { width: number; height: number };
  meta: Record<string, string>;
}

export function pageInfo(): PageInfo {
  const meta: Record<string, string> = {};
  document.querySelectorAll('meta[name], meta[property]').forEach((m) => {
    const key = m.getAttribute('name') || m.getAttribute('property');
    const content = m.getAttribute('content');
    if (key && content && Object.keys(meta).length < 100) meta[key] = content.slice(0, 1000);
  });
  const canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  const el = document.documentElement;
  return {
    url: location.href,
    title: document.title,
    canonicalUrl: canonical?.href ?? null,
    referrer: document.referrer,
    lastModified: document.lastModified,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    scroll: { x: window.scrollX, y: window.scrollY },
    document: {
      width: Math.max(el.scrollWidth, document.body?.scrollWidth ?? 0, window.innerWidth),
      height: Math.max(el.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight),
    },
    meta,
  };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Drag a rectangle. Resolves with the rectangle in viewport CSS pixels, or null if cancelled (Esc). */
export function selectRegion(): Promise<Rect | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.setAttribute('data-evicap-overlay', '');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .layer { position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; background: rgba(0,0,0,.25); }
        .box { position: fixed; border: 2px solid #e11d48; background: rgba(225,29,72,.08); box-shadow: 0 0 0 9999px rgba(0,0,0,.25); display: none; }
        .hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #111; color: #fff;
                font: 13px/1.4 system-ui, sans-serif; padding: 6px 12px; border-radius: 4px; pointer-events: none; }
      </style>
      <div class="layer"></div><div class="box"></div>
      <div class="hint">EviCap: drag to select a region. Esc to cancel.</div>`;
    const layer = shadow.querySelector('.layer') as HTMLDivElement;
    const box = shadow.querySelector('.box') as HTMLDivElement;
    let start: { x: number; y: number } | null = null;
    let rect: { x: number; y: number; width: number; height: number } | null = null;
    const finish = (value: typeof rect) => {
      window.removeEventListener('keydown', onKey, true);
      host.remove();
      // Wait two frames so the overlay is gone before the screenshot.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(value)));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };
    layer.addEventListener('mousedown', (e) => {
      start = { x: e.clientX, y: e.clientY };
      layer.style.background = 'transparent';
      box.style.display = 'block';
    });
    layer.addEventListener('mousemove', (e) => {
      if (!start) return;
      rect = {
        x: Math.min(start.x, e.clientX),
        y: Math.min(start.y, e.clientY),
        width: Math.abs(e.clientX - start.x),
        height: Math.abs(e.clientY - start.y),
      };
      Object.assign(box.style, {
        left: rect.x + 'px',
        top: rect.y + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
      });
    });
    layer.addEventListener('mouseup', () => {
      finish(rect && rect.width > 4 && rect.height > 4 ? rect : null);
    });
    window.addEventListener('keydown', onKey, true);
    document.documentElement.appendChild(host);
  });
}

export interface ElementPick {
  /** Rectangle in document CSS pixels. */
  docRect: Rect;
  /** Rectangle in viewport CSS pixels, after scrolling it into view. */
  viewRect: Rect;
  fitsViewport: boolean;
  tag: string;
  path: string;
  text: string;
}

/** Hover to highlight an element, click to choose it. Resolves null on Esc. */
export function selectElement(): Promise<ElementPick | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.setAttribute('data-evicap-overlay', '');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .hl { position: fixed; z-index: 2147483647; pointer-events: none; border: 2px solid #e11d48; background: rgba(225,29,72,.1); }
        .hint { position: fixed; z-index: 2147483647; top: 12px; left: 50%; transform: translateX(-50%); background: #111; color: #fff;
                font: 13px/1.4 system-ui, sans-serif; padding: 6px 12px; border-radius: 4px; pointer-events: none; }
      </style>
      <div class="hl"></div><div class="hint">EviCap: click an element to capture it. Esc to cancel.</div>`;
    const hl = shadow.querySelector('.hl') as HTMLDivElement;
    let current: Element | null = null;
    const cssPath = (el: Element): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && node.nodeType === 1 && parts.length < 8) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift(`${part}#${CSS.escape(node.id)}`);
          break;
        }
        const parent: Element | null = node.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    };
    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === host) return;
      current = el;
      const r = el.getBoundingClientRect();
      Object.assign(hl.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    };
    const cleanup = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      host.remove();
    };
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = current;
      cleanup();
      if (!el) return resolve(null);
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const r = el.getBoundingClientRect();
          const viewRect = { x: r.left, y: r.top, width: r.width, height: r.height };
          resolve({
            viewRect,
            docRect: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
            fitsViewport: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
            tag: el.tagName.toLowerCase(),
            path: cssPath(el),
            text: (el.textContent ?? '').trim().slice(0, 500),
          });
        }),
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
        resolve(null);
      }
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    document.documentElement.appendChild(host);
  });
}

export function scrollToY(y: number): Promise<{ y: number; viewportHeight: number }> {
  window.scrollTo(window.scrollX, y);
  return new Promise((r) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => r({ y: window.scrollY, viewportHeight: window.innerHeight })),
    ),
  );
}

/** Hide fixed and sticky elements (used after the first tile of a stitched screenshot). */
export function hideFixedElements(): number {
  let n = 0;
  document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'sticky') {
      el.setAttribute('data-evicap-hidden', el.style.visibility || '-');
      el.style.visibility = 'hidden';
      n++;
    }
  });
  return n;
}

export function restoreFixedElements(scrollX: number, scrollY: number): void {
  document.querySelectorAll<HTMLElement>('[data-evicap-hidden]').forEach((el) => {
    const prev = el.getAttribute('data-evicap-hidden');
    el.style.visibility = prev === '-' ? '' : (prev ?? '');
    el.removeAttribute('data-evicap-hidden');
  });
  window.scrollTo(scrollX, scrollY);
}
