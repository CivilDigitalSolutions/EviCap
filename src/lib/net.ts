/**
 * The only module in the extension's own contexts that requests content from
 * the websites being captured (SPEC §10, row 3: re-fetching the originals the
 * user chose to capture, accepted in D5). It sends only the ordinary request
 * a browser sends to view the item: no case data, logs or captures.
 * tests/media.test.ts fails if `fetch` is used anywhere else (except
 * billing.ts, which talks to Civil Digital's licence service).
 */

import { sleep } from './util';

export interface FetchedHeaders {
  status: number;
  finalUrl: string;
  mime: string;
  headers: Record<string, string>;
}

export interface FetchedBytes extends FetchedHeaders {
  bytes: Uint8Array;
}

const MAX_IN_MEMORY = 512 * 1024 * 1024;

function headerRecord(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k !== 'set-cookie') out[k] = v;
  });
  return out;
}

function describe(res: Response): FetchedHeaders {
  return {
    status: res.status,
    finalUrl: res.url,
    mime: (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase(),
    headers: headerRecord(res),
  };
}

function checkUrl(url: string) {
  if (!/^https?:/i.test(url)) throw new Error(`Only http(s) addresses can be fetched (${url.slice(0, 40)})`);
}

/** Fetch a whole item (an image, poster or caption file) as the browser would, cookies included. */
export async function fetchOriginal(url: string): Promise<FetchedBytes> {
  checkUrl(url);
  const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_IN_MEMORY) throw new Error('Too large to fetch in one piece');
  return { ...describe(res), bytes: new Uint8Array(await res.arrayBuffer()) };
}

export interface FetchedStream extends FetchedHeaders {
  /** Total size from Content-Length, if the server sent it. */
  total: number | null;
  stream: ReadableStream<Uint8Array>;
  /** Byte offsets at which the download was resumed with a Range request. */
  resumedAt: number[];
}

/**
 * Open a large item (a video file, SPEC F7-A) as a stream. If the connection
 * drops and the server supports ranges, it resumes with `Range` (and
 * `If-Range`, so a changed file is not spliced onto the old one), up to three
 * times. Each resume offset is recorded.
 */
export async function fetchStream(url: string): Promise<FetchedStream> {
  checkUrl(url);
  const first = await fetch(url, { credentials: 'include', redirect: 'follow' });
  if (!first.ok || !first.body) throw new Error(`HTTP ${first.status}`);
  const info = describe(first);
  const total = first.headers.get('content-length') ? Number(first.headers.get('content-length')) : null;
  const canResume = first.status === 200 && first.headers.get('accept-ranges') === 'bytes';
  const validator = first.headers.get('etag') ?? first.headers.get('last-modified');
  const resumedAt: number[] = [];
  let reader = first.body.getReader();
  let received = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            if (total !== null && received !== total) throw new Error(`Download ended early (${received} of ${total} bytes)`);
            controller.close();
            return;
          }
          received += value.byteLength;
          controller.enqueue(value);
          return;
        } catch (err) {
          if (!canResume || resumedAt.length >= 3 || (total !== null && received >= total)) throw err;
          await sleep(1000 * (resumedAt.length + 1));
          const headers: Record<string, string> = { Range: `bytes=${received}-` };
          if (validator) headers['If-Range'] = validator;
          const res = await fetch(info.finalUrl || url, { credentials: 'include', headers });
          const range = res.headers.get('content-range') ?? '';
          if (res.status !== 206 || !res.body || !range.startsWith(`bytes ${received}-`)) throw err;
          resumedAt.push(received);
          reader = res.body.getReader();
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { ...info, total, stream, resumedAt };
}

/** Decode a `data:` URL without a network request. */
export function decodeDataUrl(url: string): { bytes: Uint8Array; mime: string } {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0) throw new Error('Not a data URL');
  const head = url.slice(5, comma);
  const body = url.slice(comma + 1);
  const mime = (head.split(';')[0] || 'text/plain').toLowerCase();
  if (/;base64$/i.test(head)) {
    const bin = atob(decodeURIComponent(body));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(body)), mime };
}

/** Identify common image and video formats from their first bytes. */
export function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes;
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand.startsWith('hei') || brand === 'mif1') return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  const head = ascii(0, Math.min(256, b.length)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  if (head.startsWith('WEBVTT')) return 'text/vtt';
  return null;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'text/vtt': 'vtt',
  'application/x-subrip': 'srt',
};

export function extensionFor(mime: string, url = ''): string {
  if (EXT[mime]) return EXT[mime]!;
  const m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url.startsWith('data:') ? '' : url);
  return m ? m[1]!.toLowerCase() : 'bin';
}
