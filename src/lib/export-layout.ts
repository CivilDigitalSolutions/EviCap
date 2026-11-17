import type { CaptureFile, CaptureRecord } from './types';

/**
 * Where things go inside an export (SPEC F10). The top level holds only what a
 * reader needs, numbered in the order to open them; the data files that the
 * verifier and specialist tools use sit in one clearly labelled folder.
 *
 * Kept free of browser-storage imports: the offline verifier uses it too.
 */
export const LAYOUT = {
  startHere: '1 - START HERE.html',
  reportPdf: '2 - Evidence report.pdf',
  /** The report at the top level when it could not be printed to PDF. */
  reportHtml: '2 - Evidence report.html',
  verifier: '3 - Check nothing has been changed.html',
  exhibits: 'Exhibits',
  technical: 'Technical files (you can ignore these)',
} as const;

/** A path inside the technical folder. */
export const tech = (name: string) => `${LAYOUT.technical}/${name}`;

/** A one-word kind for folder names: Screenshot, Video, Image or Web page. */
export function captureKind(c: Pick<CaptureRecord, 'type'>): string {
  return { screenshot: 'Screenshot', video: 'Video', image: 'Image', auto: 'Web page', forensic: 'Web page' }[c.type] ?? 'Capture';
}

/**
 * Plain ASCII for a file or folder name that opens the same on Windows, macOS
 * and Linux, and in every ZIP tool: no reserved characters, no control
 * characters, no trailing dots or spaces.
 */
export function safeTitle(s: string, max = 40): string {
  const ascii = s
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[<>:"/\\|?*#%&{}$!`=@+^~[\];]/g, ' ')
    .replace(/(^|\s)\.+(?=\s|$)/g, ' ') // lone dots, e.g. from "../"
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .trim();
  let out = ascii.slice(0, max).trim();
  if (ascii.length > max) out = out.replace(/\s+\S*$/, '') || out; // end on a whole word
  return out.replace(/[. ]+$/, '');
}

/** "Exhibits/EV-001 - Screenshot - Page title" */
export function exhibitFolder(exhibit: string, c: Pick<CaptureRecord, 'type' | 'title' | 'url'>): string {
  let host = '';
  try {
    host = new URL(c.url).hostname.replace(/^www\./, '');
  } catch {
    /* not a URL */
  }
  const title = safeTitle(c.title) || safeTitle(host);
  return `${LAYOUT.exhibits}/${[exhibit, captureKind(c), title].filter(Boolean).join(' - ')}`;
}

/** A relative link to a file in the export, safe for href. */
export const href = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export interface Viewable {
  /** The button text, e.g. "Open the picture". */
  label: string;
  file: CaptureFile;
  /** Shown under the button, e.g. "Opens in Chrome or Edge". */
  hint?: string;
}

/**
 * The files in a capture an ordinary reader can open by double-clicking, with
 * a plain label for each, most useful first. Archives and data files are left
 * to specialists.
 */
export function viewableFiles(c: Pick<CaptureRecord, 'files'>): Viewable[] {
  const out: (Viewable & { rank: number })[] = [];
  for (const f of c.files) {
    const primary = f.role === 'primary';
    if (f.mime.startsWith('image/')) {
      if (f.role === 'source') out.push({ label: 'Open the whole screen it was cut from', file: f, rank: 3 });
      else if (f.role === 'poster') out.push({ label: 'Open the still picture', file: f, rank: 2 });
      else out.push({ label: primary ? 'Open the picture' : 'Open the screenshot', file: f, rank: primary ? 0 : 1 });
    } else if (f.mime.startsWith('video/')) out.push({ label: 'Play the video', file: f, rank: 0 });
    else if (f.mime.startsWith('audio/')) out.push({ label: 'Play the audio', file: f, rank: 0 });
    else if (f.mime === 'multipart/related') out.push({ label: 'Open the saved web page', file: f, hint: 'Opens in Chrome or Edge', rank: 4 });
    else if (f.mime === 'application/pdf') out.push({ label: 'Open the PDF', file: f, rank: 1 });
    else if (f.mime.startsWith('text/plain')) out.push({ label: 'Read the text of the page', file: f, rank: 5 });
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ rank: _, ...v }) => v);
}
