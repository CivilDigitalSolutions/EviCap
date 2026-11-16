import { gunzipSync, gzipSync, strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { sha256 } from './hash';

/**
 * WARC 1.1 and WACZ 1.1.1 writing and reading (SPEC F4 step 5). Written here
 * rather than taken from Webrecorder's libraries, some of which are AGPL.
 *
 * Each WARC record is its own gzip member, so the CDXJ index can point at it
 * by offset and length; the WACZ ZIP stores every file uncompressed, so
 * readers can seek into it.
 */

export type WarcKind = 'response' | 'resource' | 'request' | 'metadata';

export interface WarcEntry {
  kind: WarcKind;
  url: string;
  /** ISO time the item was captured. */
  date: string;
  /** For responses: HTTP status, reason phrase and headers as captured. */
  status?: number;
  statusText?: string;
  headers?: [string, string][];
  /** For requests. */
  method?: string;
  /** Body (payload) bytes. */
  body: Uint8Array;
  /** Content type of a resource or metadata record. */
  mime?: string;
  /** Extra WARC headers, e.g. WARC-IP-Address. */
  warcHeaders?: Record<string, string>;
  /** Link a request to its response. */
  recordId?: string;
  concurrentTo?: string;
}

const CRLF = '\r\n';
const enc = (s: string) => strToU8(s);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 404: 'Not Found' };

/**
 * Bodies from the debugger are already decoded, so headers that describe the
 * wire encoding no longer apply: Content-Encoding is kept under another name,
 * Transfer-Encoding is dropped and Content-Length is set to the stored body.
 */
export function storableHeaders(headers: [string, string][], bodyLength: number): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of headers) {
    const l = k.toLowerCase();
    if (l.startsWith(':')) continue; // HTTP/2 pseudo-headers
    if (l === 'transfer-encoding' || l === 'content-length') continue;
    if (l === 'content-encoding') {
      out.push(['X-EviCap-Original-Content-Encoding', v]);
      continue;
    }
    for (const line of v.split('\n')) out.push([k, line]);
  }
  out.push(['Content-Length', String(bodyLength)]);
  return out;
}

function httpBlock(e: WarcEntry): Uint8Array {
  if (e.kind === 'response') {
    const head =
      `HTTP/1.1 ${e.status ?? 200} ${e.statusText || STATUS_TEXT[e.status ?? 200] || ''}`.trimEnd() +
      CRLF +
      storableHeaders(e.headers ?? [], e.body.length)
        .map(([k, v]) => `${k}: ${v}`)
        .join(CRLF) +
      CRLF +
      CRLF;
    return concat([enc(head), e.body]);
  }
  if (e.kind === 'request') {
    const u = new URL(e.url);
    const lines = [`${e.method ?? 'GET'} ${u.pathname}${u.search} HTTP/1.1`];
    const hdrs = (e.headers ?? []).filter(([k]) => !k.startsWith(':'));
    if (!hdrs.some(([k]) => k.toLowerCase() === 'host')) lines.push(`Host: ${u.host}`);
    for (const [k, v] of hdrs) lines.push(`${k}: ${v}`);
    return concat([enc(lines.join(CRLF) + CRLF + CRLF), e.body]);
  }
  return e.body;
}

function warcDate(iso: string) {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function ts14(iso: string) {
  return new Date(iso).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** Sort-friendly URL key (SURT) for the CDXJ index. */
export function surt(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url.toLowerCase();
  }
  if (!/^https?:$/.test(u.protocol)) return url.toLowerCase();
  const host = u.hostname.toLowerCase().replace(/^www\d*\./, '');
  const key = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') ? host : host.split('.').reverse().join(',');
  const defaultPort = (u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443');
  const port = u.port && !defaultPort ? `:${u.port}` : '';
  const params = [...new URLSearchParams(u.search)].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  const query = params.length ? '?' + params.map(([k, v]) => (v ? `${k}=${v}` : k)).join('&') : '';
  return `${key}${port})${u.pathname || '/'}${query}`.toLowerCase();
}

const uuidUrn = () => `<urn:uuid:${crypto.randomUUID()}>`;

export interface BuiltWarc {
  /** Concatenated gzip members. */
  bytes: Uint8Array;
  /** CDXJ lines, sorted. */
  cdxj: string[];
}

/** Build a gzipped WARC (one gzip member per record) and its CDXJ index. */
export async function buildWarc(entries: WarcEntry[], info: Record<string, string>, filename = 'data.warc.gz'): Promise<BuiltWarc> {
  const members: Uint8Array[] = [];
  const cdxj: string[] = [];
  let offset = 0;

  const add = async (type: string, url: string | null, date: string, contentType: string, block: Uint8Array, extra: Record<string, string>, payload?: Uint8Array) => {
    const headers: [string, string][] = [
      ['WARC-Type', type],
      ['WARC-Record-ID', extra['WARC-Record-ID'] ?? uuidUrn()],
      ['WARC-Date', warcDate(date)],
    ];
    if (url) headers.push(['WARC-Target-URI', url]);
    for (const [k, v] of Object.entries(extra)) if (k !== 'WARC-Record-ID') headers.push([k, v]);
    headers.push(['Content-Type', contentType]);
    headers.push(['WARC-Block-Digest', await sha256(block)]);
    if (payload) headers.push(['WARC-Payload-Digest', await sha256(payload)]);
    headers.push(['Content-Length', String(block.length)]);
    const record = concat([enc('WARC/1.1' + CRLF + headers.map(([k, v]) => `${k}: ${v}`).join(CRLF) + CRLF + CRLF), block, enc(CRLF + CRLF)]);
    const gz = gzipSync(record, { level: 6 });
    members.push(gz);
    const at = offset;
    offset += gz.length;
    return { offset: at, length: gz.length };
  };

  const infoBody = enc(Object.entries(info).map(([k, v]) => `${k}: ${v}`).join(CRLF) + CRLF);
  await add('warcinfo', null, new Date().toISOString(), 'application/warc-fields', infoBody, { 'WARC-Filename': filename });

  for (const e of entries) {
    const extra: Record<string, string> = { ...(e.warcHeaders ?? {}) };
    if (e.recordId) extra['WARC-Record-ID'] = e.recordId;
    if (e.concurrentTo) extra['WARC-Concurrent-To'] = e.concurrentTo;
    const block = httpBlock(e);
    if (e.kind === 'request') {
      await add('request', e.url, e.date, 'application/http; msgtype=request', block, extra);
      continue;
    }
    if (e.kind === 'metadata') {
      await add('metadata', e.url, e.date, e.mime ?? 'application/json', block, extra);
      continue;
    }
    const contentType = e.kind === 'response' ? 'application/http; msgtype=response' : e.mime ?? 'application/octet-stream';
    const pos = await add(e.kind, e.url, e.date, contentType, block, extra, e.body);
    const mime =
      e.kind === 'response'
        ? (e.headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '').split(';')[0]!.trim()
        : (e.mime ?? '').split(';')[0]!.trim();
    cdxj.push(
      `${surt(e.url)} ${ts14(e.date)} ${JSON.stringify({
        url: e.url,
        mime: mime || 'application/octet-stream',
        status: String(e.kind === 'response' ? e.status ?? 200 : 200),
        digest: await sha256(e.body),
        length: String(pos.length),
        offset: String(pos.offset),
        filename,
        ...(e.kind === 'resource' ? { recordType: 'resource' } : {}),
      })}`,
    );
  }
  cdxj.sort();
  return { bytes: concat(members), cdxj };
}

export interface WaczPage {
  url: string;
  ts: string;
  title: string;
  text?: string;
}

export interface WaczInput {
  title: string;
  software: string;
  entries: WarcEntry[];
  pages: WaczPage[];
  warcInfo: Record<string, string>;
}

/** Package a WACZ: archive/, indexes/, pages/, datapackage.json and datapackage-digest.json. */
export async function buildWacz(input: WaczInput): Promise<Uint8Array> {
  const warc = await buildWarc(input.entries, input.warcInfo);
  const pagesJsonl =
    [
      JSON.stringify({ format: 'json-pages-1.0', id: 'pages', title: 'All Pages', hasText: input.pages.some((p) => !!p.text) }),
      ...input.pages.map((p, i) => JSON.stringify({ id: `page-${i + 1}`, url: p.url, ts: p.ts, title: p.title, ...(p.text ? { text: p.text } : {}) })),
    ].join('\n') + '\n';
  const files: Record<string, Uint8Array> = {
    'archive/data.warc.gz': warc.bytes,
    'indexes/index.cdx': enc(warc.cdxj.join('\n') + '\n'),
    'pages/pages.jsonl': enc(pagesJsonl),
  };
  const now = new Date().toISOString();
  const resources = [];
  for (const [path, bytes] of Object.entries(files)) {
    resources.push({ name: path.split('/').pop(), path, hash: await sha256(bytes), bytes: bytes.length });
  }
  const main = input.pages[0];
  const datapackage = enc(
    JSON.stringify(
      {
        profile: 'data-package',
        wacz_version: '1.1.1',
        title: input.title,
        created: now,
        modified: now,
        software: input.software,
        ...(main ? { mainPageURL: main.url, mainPageDate: main.ts } : {}),
        resources,
      },
      null,
      2,
    ),
  );
  const digest = enc(JSON.stringify({ path: 'datapackage.json', hash: await sha256(datapackage) }, null, 2));
  const zip: Zippable = {};
  const mtime = new Date();
  for (const [path, bytes] of Object.entries({ ...files, 'datapackage.json': datapackage, 'datapackage-digest.json': digest })) {
    zip[path] = [bytes, { level: 0, mtime }];
  }
  return zipSync(zip, { level: 0 });
}

// ---------- Reading ----------

export interface ParsedRecord {
  warcHeaders: Record<string, string>;
  type: string;
  url: string;
  status: number;
  httpHeaders: [string, string][];
  mime: string;
  body: Uint8Array;
}

function indexOfSeq(hay: Uint8Array, seq: number[], from = 0) {
  outer: for (let i = from; i <= hay.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (hay[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}
const CRLF2 = [13, 10, 13, 10];

function parseHeaderLines(text: string): [string, string][] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string];
    });
}

/** Parse one (decompressed) WARC record. */
export function parseWarcRecord(rec: Uint8Array): ParsedRecord {
  const headEnd = indexOfSeq(rec, CRLF2);
  const headLines = strFromU8(rec.subarray(0, headEnd)).split(/\r?\n/).slice(1);
  const warcHeaders = Object.fromEntries(parseHeaderLines(headLines.join('\n')));
  const len = Number(warcHeaders['Content-Length'] ?? 0);
  const block = rec.subarray(headEnd + 4, headEnd + 4 + len);
  const type = warcHeaders['WARC-Type'] ?? '';
  const url = warcHeaders['WARC-Target-URI'] ?? '';
  if (type === 'response') {
    const he = indexOfSeq(block, CRLF2);
    const lines = strFromU8(block.subarray(0, he)).split(/\r?\n/);
    const status = Number(lines[0]?.split(' ')[1] ?? 0);
    const httpHeaders = parseHeaderLines(lines.slice(1).join('\n'));
    const mime = (httpHeaders.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '').split(';')[0]!.trim();
    return { warcHeaders, type, url, status, httpHeaders, mime, body: block.subarray(he + 4) };
  }
  return { warcHeaders, type, url, status: 200, httpHeaders: [], mime: (warcHeaders['Content-Type'] ?? '').split(';')[0]!.trim(), body: block };
}

export interface WaczReader {
  files: Record<string, Uint8Array>;
  index: { url: string; ts: string; mime: string; status: number; offset: number; length: number; filename: string }[];
  pages: WaczPage[];
  datapackage: { resources: { path: string; hash: string; bytes: number }[] } & Record<string, unknown>;
  /** The archived response for a URL (the latest capture of it). */
  get(url: string): ParsedRecord | null;
  /** Check every file listed in datapackage.json against its hash. */
  verify(): Promise<{ path: string; ok: boolean }[]>;
}

export function readWacz(zip: Uint8Array): WaczReader {
  const files = unzipSync(zip);
  const index = strFromU8(files['indexes/index.cdx'] ?? new Uint8Array())
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [, ts, ...rest] = line.split(' ');
      const j = JSON.parse(rest.join(' ')) as Record<string, string>;
      return {
        url: j.url!,
        ts: ts!,
        mime: j.mime ?? '',
        status: Number(j.status ?? 200),
        offset: Number(j.offset),
        length: Number(j.length),
        filename: j.filename ?? 'data.warc.gz',
      };
    });
  const pages = strFromU8(files['pages/pages.jsonl'] ?? new Uint8Array())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((p) => p.url) as WaczPage[];
  const datapackage = JSON.parse(strFromU8(files['datapackage.json'] ?? strToU8('{"resources":[]}')));
  const byUrl = new Map<string, (typeof index)[number]>();
  for (const e of index) {
    const prev = byUrl.get(e.url);
    if (!prev || prev.ts <= e.ts) byUrl.set(e.url, e);
  }
  return {
    files,
    index,
    pages,
    datapackage,
    get(url: string) {
      const e = byUrl.get(url) ?? byUrl.get(url.replace(/#.*$/, ''));
      if (!e) return null;
      const warc = files[`archive/${e.filename}`];
      if (!warc) return null;
      return parseWarcRecord(gunzipSync(warc.subarray(e.offset, e.offset + e.length)));
    },
    async verify() {
      const out: { path: string; ok: boolean }[] = [];
      for (const r of datapackage.resources as { path: string; hash: string }[]) {
        const f = files[r.path];
        out.push({ path: r.path, ok: !!f && (await sha256(f)) === r.hash });
      }
      return out;
    },
  };
}
