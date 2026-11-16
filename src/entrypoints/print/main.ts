import { readFile } from '@/lib/opfs';

/**
 * Shows an export's report.html so the service worker can print it to PDF
 * with Page.printToPDF (SPEC F10). The report has no scripts; this page copies
 * its styles and body in, waits for images, then sets `window.__evicapReady`.
 */
declare global {
  interface Window {
    __evicapReady?: Promise<boolean>;
  }
}

window.__evicapReady = (async () => {
  const path = decodeURIComponent(location.hash.slice(1));
  if (!path.startsWith('exports/')) throw new Error('Not an export path');
  const html = await (await readFile(path)).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script').forEach((s) => s.remove());
  document.title = doc.title;
  for (const el of Array.from(doc.head.querySelectorAll('style, meta[name]'))) document.head.append(document.adoptNode(el));
  document.body.replaceWith(document.adoptNode(doc.body));
  await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => undefined)));
  await document.fonts.ready;
  return true;
})();
