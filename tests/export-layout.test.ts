import { describe, expect, it } from 'vitest';
import { buildEvent } from '../src/lib/audit';
import { exhibitFolder, href, LAYOUT, safeTitle, tech, viewableFiles } from '../src/lib/export-layout';
import { sha256 } from '../src/lib/hash';
import { canonicalBytes } from '../src/lib/jcs';
import { buildStartHereHtml, type StartHereExhibit } from '../src/lib/start-here';
import type { AuditEvent, CaptureFile, CaptureRecord, CaseRecord } from '../src/lib/types';
import { base64url } from '../src/lib/util';
import { folderSource, verifyBundle, type BundleSource, type ExportManifest } from '../src/verifier/core';

const file = (path: string, mime: string, role: string): CaptureFile => ({ path, mime, role, bytes: 1, sha256: 'sha256:00' });

describe('export layout', () => {
  it('makes plain, safe folder names from page titles', () => {
    expect(safeTitle('John Smith | Facebook')).toBe('John Smith Facebook');
    expect(safeTitle('Café: "special" offers?')).toBe('Cafe special offers');
    expect(safeTitle('A really long page title that goes on and on well past the limit')).toBe('A really long page title that goes on');
    expect(safeTitle('ends with dots...')).toBe('ends with dots');
    expect(safeTitle('../../etc/passwd')).toBe('etc passwd');
    expect(safeTitle('日本語')).toBe('');
  });

  it('names exhibit folders by number, kind and title, falling back to the site', () => {
    expect(exhibitFolder('EV-001', { type: 'screenshot', title: 'Page /one', url: 'https://a.example/one' })).toBe('Exhibits/EV-001 - Screenshot - Page one');
    expect(exhibitFolder('EV-002a', { type: 'forensic', title: '日本語', url: 'https://www.shop.example/x' })).toBe('Exhibits/EV-002a - Web page - shop.example');
    expect(exhibitFolder('EV-003', { type: 'video', title: '', url: 'not a url' })).toBe('Exhibits/EV-003 - Video');
  });

  it('encodes links to files with spaces and symbols', () => {
    expect(href('Exhibits/EV-001 - Screenshot - A#B/shot.png')).toBe('Exhibits/EV-001%20-%20Screenshot%20-%20A%23B/shot.png');
  });

  it('offers the files a reader can open, most useful first', () => {
    const forensic = viewableFiles({
      files: [
        file('page.wacz', 'application/wacz', 'primary'),
        file('page.mhtml', 'multipart/related', 'mhtml'),
        file('network.json', 'application/json', 'network'),
        file('text.txt', 'text/plain;charset=utf-8', 'text'),
        file('screenshot.png', 'image/png', 'screenshot'),
      ],
    });
    expect(forensic.map((v) => [v.label, v.file.path])).toEqual([
      ['Open the screenshot', 'screenshot.png'],
      ['Open the saved web page', 'page.mhtml'],
      ['Read the text of the page', 'text.txt'],
    ]);
    const region = viewableFiles({ files: [file('visible.png', 'image/png', 'source'), file('region.png', 'image/png', 'primary')] });
    expect(region.map((v) => v.file.path)).toEqual(['region.png', 'visible.png']);
    expect(viewableFiles({ files: [file('video.webm', 'video/webm', 'primary')] })[0]!.label).toBe('Play the video');
  });
});

describe('START HERE page', () => {
  const cap = (over: Partial<CaptureRecord>): CaptureRecord =>
    ({
      id: 'c1',
      type: 'screenshot',
      method: 'x',
      status: 'complete',
      url: 'https://a.example/one',
      title: 'Page <one>',
      startedAtUtc: '2026-11-16T10:00:00.000Z',
      files: [file('screenshot.png', 'image/png', 'primary')],
      degraded: [],
      parent: null,
      meta: { mode: 'visible' },
      tags: [],
      deleted: null,
      ...over,
    }) as CaptureRecord;
  const ex = (exhibit: string, capture: CaptureRecord, parentExhibit: string | null = null): StartHereExhibit => ({
    exhibit,
    capture,
    thumb: null,
    folder: exhibitFolder(exhibit, capture),
    parentExhibit,
  });
  const html = buildStartHereHtml({
    kind: 'case',
    exportId: 'e1',
    createdAtUtc: '2026-11-17T09:00:00.000Z',
    software: { name: 'EviCap', version: '0.1.0' },
    case: { name: 'Case <A>', reference: 'R-1', investigator: 'A. Tester', organisation: 'Org' } as CaseRecord,
    exhibits: [
      ex('EV-001', cap({})),
      ex('EV-001a', cap({ id: 'c2', parent: 'c1', files: [file('poster.png', 'image/png', 'poster')] }), 'EV-001'),
      ex('EV-002', cap({ id: 'c3', deleted: { atUtc: '2026-11-16T11:00:00Z', reason: 'duplicate' } })),
    ],
    reportFile: LAYOUT.reportPdf,
    visits: 12,
  });

  it('says what to open, in order, and links to each exhibit', () => {
    expect(html).toContain('Read the report');
    expect(html).toContain('Look at the exhibits');
    expect(html).toContain('Check nothing has been changed');
    expect(html).toContain(`href="${href(LAYOUT.reportPdf)}"`);
    expect(html).toContain(`href="${href(LAYOUT.verifier)}"`);
    expect(html).toContain('href="Exhibits/EV-001%20-%20Screenshot%20-%20Page%20one/screenshot.png"');
    expect(html).toContain('The exhibits (2)'); // EV-001a belongs with EV-001
    expect(html).toContain('belongs with EV-001');
    expect(html).toContain(`href="${href(tech('visits.csv'))}"`);
    expect(html).toContain('Extract All');
  });

  it('escapes what came from web pages and runs no scripts', () => {
    expect(html).toContain('Case &lt;A&gt;');
    expect(html).toContain('Page &lt;one&gt;');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("default-src 'none'");
  });

  it('says a deleted exhibit has no files, and gives it no buttons', () => {
    const card = html.slice(html.indexOf('id="EV-002"'));
    expect(card).toContain('was deleted from the case');
    expect(card.slice(0, card.indexOf('</section>'))).not.toContain('class="btn');
  });
});

describe('verifier finds the export', () => {
  /** A minimal signed export with no captures, in the new or the old layout. */
  async function bundle(layout: 'new' | 'old', prefix = '') {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', keys.publicKey));
    const fingerprint = await sha256(await crypto.subtle.exportKey('spki', keys.publicKey));
    const ev: AuditEvent = await buildEvent('case-1', 0, null, 'case.created', { name: 'X' });
    const dir = layout === 'new' ? `${LAYOUT.technical}/` : '';
    const content: Record<string, string> = {
      [layout === 'new' ? LAYOUT.startHere : 'report.html']: '<p>hello</p>',
      [`${dir}audit-log.jsonl`]: JSON.stringify(ev) + '\n',
      [`${dir}public-key.jwk`]: jwk,
    };
    const files = await Promise.all(
      Object.entries(content).map(async ([path, text]) => ({ path, bytes: new TextEncoder().encode(text).length, sha256: await sha256(text) })),
    );
    const manifest: ExportManifest = {
      schema: 'evicap.export/1',
      exportId: 'e1',
      kind: 'case',
      createdAtUtc: '2026-11-17T09:00:00.000Z',
      software: { name: 'EviCap', version: '0.1.0' },
      environment: {},
      case: { id: 'case-1', name: 'X', reference: '', investigator: '', organisation: '', status: 'open' },
      ...(layout === 'new' ? { layout: { technical: LAYOUT.technical, startHere: LAYOUT.startHere } } : {}),
      publicKey: { file: `${dir}public-key.jwk`, fingerprint },
      auditHead: { seq: 0, hash: ev.hash, redactedEvents: 0 },
      captures: [],
      reportPdf: 'included',
      files,
    };
    const sig = base64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, canonicalBytes(manifest) as BufferSource));
    const all: Record<string, string> = { ...content, [`${dir}manifest.json`]: JSON.stringify(manifest), [`${dir}manifest.sig`]: sig };
    const map = new Map(Object.entries(all).map(([k, v]) => [prefix + k, new Blob([v])]));
    const src: BundleSource = { name: 'test', paths: [...map.keys()], open: async (p) => map.get(p) ?? null };
    return { src, map };
  }

  it('checks an export in the new layout', async () => {
    const r = await verifyBundle((await bundle('new')).src);
    expect(r.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('still checks exports made in the old layout', async () => {
    const r = await verifyBundle((await bundle('old')).src);
    expect(r.checks.filter((c) => c.status !== 'pass')).toEqual([]);
  });

  it('finds the export inside a folder that holds it', async () => {
    for (const layout of ['new', 'old'] as const) {
      const { map } = await bundle(layout, 'EviCap_R-1_20261117T090000Z/');
      // As picked in a browser: every path starts with the chosen folder's name.
      const picked = [...map].map(([p, b]) => Object.assign(new File([b], p.split('/').at(-1)!), { webkitRelativePath: `Downloads/${p}` }));
      const r = await verifyBundle(folderSource(picked));
      expect(r.ok, layout).toBe(true);
    }
  });

  it('notices a changed file and an added one', async () => {
    const { src, map } = await bundle('new');
    map.set(LAYOUT.startHere, new Blob(['<p>changed</p>']));
    map.set('extra.txt', new Blob(['x']));
    const r = await verifyBundle({ ...src, paths: [...map.keys()] });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.label === 'File hashes')!.status).toBe('fail');
    expect(r.checks.find((c) => c.label === 'Unlisted files')!.detail).toContain('extra.txt');
  });

  it('says plainly when what was chosen is not an export', async () => {
    const r = await verifyBundle({ name: 'x', paths: ['a.txt'], open: async () => new Blob(['a']) });
    expect(r.ok).toBe(false);
    expect(r.checks[0]!.detail).toContain('Choose the ZIP file you were sent');
  });
});
