import { strFromU8 } from 'fflate';
import type { WaczReader } from './wacz';

/**
 * Builds an offline, script-free view of a forensic capture: the rendered DOM
 * with every image, stylesheet and font replaced by a data: URL taken from
 * the archive. Anything not in the archive is blanked, and a Content Security
 * Policy blocks all network access, so viewing a capture never contacts a
 * website. It is a reading aid; the WACZ is the evidence.
 */

const MAX_INLINE = 8 * 1024 * 1024;

function toDataUrl(mime: string, body: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < body.length; i += 0x8000) bin += String.fromCharCode(...body.subarray(i, i + 0x8000));
  return `data:${mime || 'application/octet-stream'};base64,${btoa(bin)}`;
}

export interface SnapshotResult {
  html: string;
  inlined: number;
  missing: string[];
}

export function buildSnapshot(domHtml: string, pageUrl: string, wacz: WaczReader): SnapshotResult {
  const doc = new DOMParser().parseFromString(domHtml, 'text/html');
  const missing = new Set<string>();
  let inlined = 0;
  const cache = new Map<string, string | null>();

  const resolve = (raw: string, base: string): string | null => {
    try {
      return new URL(raw.trim(), base).href;
    } catch {
      return null;
    }
  };

  const lookup = (url: string, rewriteCss = false): string | null => {
    if (url.startsWith('data:')) return url;
    if (cache.has(url)) return cache.get(url)!;
    const rec = wacz.get(url);
    let out: string | null = null;
    if (rec && rec.body.length && rec.body.length <= MAX_INLINE && rec.status < 400) {
      if (rewriteCss || rec.mime === 'text/css') {
        out = toDataUrl('text/css', new TextEncoder().encode(rewriteCssText(strFromU8(rec.body), url)));
      } else {
        out = toDataUrl(rec.mime, rec.body);
      }
      inlined++;
    } else {
      missing.add(url);
    }
    cache.set(url, out);
    return out;
  };

  const rewriteCssText = (css: string, base: string): string =>
    css
      .replace(/@import\s+(?:url\()?["']?([^"')\s;]+)["']?\)?[^;]*;/g, (_m, u: string) => {
        const abs = resolve(u, base);
        const d = abs ? lookup(abs, true) : null;
        return d ? `@import url("${d}");` : '';
      })
      .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (m, _q, u: string) => {
        if (u.startsWith('data:') || u.startsWith('#')) return m;
        const abs = resolve(u, base);
        const d = abs ? lookup(abs) : null;
        return d ? `url("${d}")` : 'url("")';
      });

  const baseEl = doc.querySelector('base[href]');
  const base = (baseEl && resolve(baseEl.getAttribute('href')!, pageUrl)) || pageUrl;
  doc.querySelectorAll('base, script, noscript, iframe, frame, object, embed, meta[http-equiv]').forEach((el) => el.remove());

  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  });
  doc.querySelectorAll('link').forEach((link) => {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase();
    const href = link.getAttribute('href');
    const abs = href ? resolve(href, base) : null;
    if (rel.includes('stylesheet') && abs) {
      const d = lookup(abs, true);
      if (d) link.setAttribute('href', d);
      else link.remove();
    } else if (rel.includes('icon') && abs) {
      const d = lookup(abs);
      if (d) link.setAttribute('href', d);
      else link.remove();
    } else {
      link.remove();
    }
  });
  doc.querySelectorAll('style').forEach((s) => (s.textContent = rewriteCssText(s.textContent ?? '', base)));
  doc.querySelectorAll('[style]').forEach((el) => el.setAttribute('style', rewriteCssText(el.getAttribute('style')!, base)));
  for (const attr of ['src', 'poster', 'data']) {
    doc.querySelectorAll(`[${attr}]`).forEach((el) => {
      const abs = resolve(el.getAttribute(attr)!, base);
      const d = abs ? lookup(abs) : null;
      el.setAttribute(attr, d ?? '');
    });
  }
  doc.querySelectorAll('[srcset]').forEach((el) => {
    // Use one archived candidate; srcset with data: URLs is unreliable.
    const first = el
      .getAttribute('srcset')!
      .split(/,\s+/)
      .map((c) => c.trim().split(/\s+/)[0]!)
      .map((u) => resolve(u, base))
      .find((u) => u && wacz.get(u));
    el.removeAttribute('srcset');
    if (first && el.tagName === 'IMG' && !el.getAttribute('src')) el.setAttribute('src', lookup(first) ?? '');
    if (el.tagName === 'SOURCE') el.remove();
  });
  doc.querySelectorAll('a[href]').forEach((a) => {
    const abs = resolve(a.getAttribute('href')!, base);
    if (abs) a.setAttribute('title', abs);
    a.setAttribute('href', '#');
  });
  doc.querySelectorAll('form').forEach((f) => f.removeAttribute('action'));

  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', "default-src 'none'; img-src data:; style-src data: 'unsafe-inline'; font-src data:; media-src data:");
  doc.head.prepend(csp);
  const html = '<!doctype html>\n' + doc.documentElement.outerHTML;
  return { html, inlined, missing: [...missing] };
}
