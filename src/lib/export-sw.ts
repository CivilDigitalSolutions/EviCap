import { appendEvent } from './audit';
import type { Sha256 } from './hash';
import { writeFile } from './opfs';
import { base64ToBytes, type Send } from './screenshots';
import { sleep } from './util';

/** Service-worker side of export (SPEC F10) and verification (F11). */

export interface ExportRecord {
  exportId: string;
  kind: 'case' | 'exhibits';
  fileName: string;
  path: string;
  bytes: number;
  sha256: Sha256;
  manifestHash: Sha256;
  captureIds: string[];
  reportPdf: string;
}

/** Log the export and its file hash. It can't be inside the ZIP it describes. */
export async function recordExport(caseId: string, rec: ExportRecord) {
  if (!/^exports\/[0-9a-f-]{36}\/[^/]+\.zip$/.test(rec.path)) throw new Error('Not an export path');
  await appendEvent(caseId, 'export.created', { ...rec }, { mutateCase: (c) => ({ ...c, lastExportedAtUtc: new Date().toISOString() }) });
}

export interface VerifyRecord {
  ok: boolean;
  scope: 'case' | 'capture' | 'bundle';
  checked: number;
  problems: string[];
  chainHead?: string | null;
}

export async function recordVerify(caseId: string, rec: VerifyRecord) {
  await appendEvent(caseId, 'verify.run', { ...rec, problems: rec.problems.slice(0, 50) });
}

/**
 * Print report.html to PDF with Page.printToPDF in a background tab showing
 * the print page. The browser's "debugging" bar appears briefly.
 */
export async function printReportPdf(htmlPath: string, pdfPath: string) {
  if (!/^exports\/[0-9a-f-]{36}\/report\.html$/.test(htmlPath) || !/^exports\/[0-9a-f-]{36}\/report\.pdf$/.test(pdfPath)) {
    throw new Error('Not an export path');
  }
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`print.html#${encodeURIComponent(htmlPath)}`), active: false });
  if (!tab.id) throw new Error('Could not open the report');
  try {
    const start = Date.now();
    for (;;) {
      const t = await chrome.tabs.get(tab.id);
      if (t.status === 'complete') break;
      if (Date.now() - start > 30_000) throw new Error('The report took too long to open');
      await sleep(150);
    }
    const target = { tabId: tab.id };
    // Attach directly: the tab is in the background, so no animation-frame settling.
    await chrome.debugger.attach(target, '1.3');
    const send: Send = (method, params) => chrome.debugger.sendCommand(target, method, params as Record<string, unknown>) as Promise<never>;
    let pdfBytes: Uint8Array;
    try {
      const ready = await send<{ result: { value?: boolean }; exceptionDetails?: { text: string } }>('Runtime.evaluate', {
        expression: 'window.__evicapReady',
        awaitPromise: true,
        returnByValue: true,
        timeout: 60_000,
      });
      if (ready.exceptionDetails || ready.result.value !== true) throw new Error(ready.exceptionDetails?.text ?? 'The report did not load');
      const pdf = await send<{ data: string }>('Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate:
          '<div style="font: 8px sans-serif; color: #5d6877; width: 100%; padding: 0 14mm; display: flex; justify-content: space-between;"><span class="title"></span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
      });
      pdfBytes = base64ToBytes(pdf.data);
    } finally {
      await chrome.debugger.detach(target).catch(() => undefined);
    }
    await writeFile(pdfPath, pdfBytes);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}
