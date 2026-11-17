import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildEvent } from '../src/lib/audit';
import { verifyChain } from '../src/lib/chain';
import { exhibitNumbers, redactEvents, visitsCsv } from '../src/lib/export';
import { buildReportHtml, utcText } from '../src/lib/report';
import type { AuditEvent, CaptureRecord, CaseRecord, VisitRecord } from '../src/lib/types';
import { readZipEntries, ZipWriter, zipEntryBlob } from '../src/lib/zip';
import { buildVerifierHtml } from '../tools/verifier-plugin';

async function makeZip(files: [string, Uint8Array | Blob][], forceZip64 = false) {
  const parts: Uint8Array[] = [];
  const zip = new ZipWriter(async (c) => void parts.push(c.slice()), { forceZip64, date: new Date('2026-11-16T10:00:00Z') });
  for (const [p, d] of files) await zip.add(p, d);
  const total = await zip.finish();
  const blob = new Blob(parts as BlobPart[]);
  expect(blob.size).toBe(total);
  return blob;
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('ZIP writer and reader', () => {
  const files: [string, Uint8Array | Blob][] = [
    ['manifest.json', enc('{"a":1}')],
    ['captures/x/é-ü.txt', enc('unicode name')],
    ['empty.bin', new Uint8Array()],
    ['blob.bin', new Blob([new Uint8Array(70_000).map((_, i) => i % 251)])],
  ];

  it('writes standard ZIPs that other tools read', async () => {
    const zip = await makeZip(files);
    const out = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    expect(Object.keys(out).sort()).toEqual(['blob.bin', 'captures/x/é-ü.txt', 'empty.bin', 'manifest.json']);
    expect(strFromU8(out['manifest.json']!)).toBe('{"a":1}');
    expect(out['blob.bin']![69_999]).toBe(69_999 % 251);
  });

  for (const forceZip64 of [false, true]) {
    it(`reads its own entries back${forceZip64 ? ' (ZIP64)' : ''}`, async () => {
      const zip = await makeZip(files, forceZip64);
      const entries = await readZipEntries(zip);
      expect(entries.map((e) => e.name)).toEqual(files.map(([p]) => p));
      for (const [p, d] of files) {
        const e = entries.find((x) => x.name === p)!;
        const got = new Uint8Array(await (await zipEntryBlob(zip, e)).arrayBuffer());
        const want = d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : d;
        expect(got.length).toBe(want.length);
        expect(Buffer.from(got).equals(Buffer.from(want))).toBe(true);
      }
    });
  }

  it('rejects unsafe and duplicate paths', async () => {
    const zip = new ZipWriter(async () => undefined);
    await expect(zip.add('../x', enc('x'))).rejects.toThrow();
    await expect(zip.add('/abs', enc('x'))).rejects.toThrow();
    await zip.add('a.txt', enc('x'));
    await expect(zip.add('a.txt', enc('x'))).rejects.toThrow();
  });
});

describe('exhibit-only redaction', () => {
  it('leaves out unrelated payloads but the chain still checks', async () => {
    const caseId = 'case-1';
    const events: AuditEvent[] = [];
    const add = async (type: AuditEvent['type'], payload: Record<string, unknown>) =>
      events.push(await buildEvent(caseId, events.length, events.at(-1)?.hash ?? null, type, payload));
    await add('case.created', { name: 'X' });
    await add('visit.recorded', { visitId: 'v1', url: 'https://secret.example/' });
    await add('visit.recorded', { visitId: 'v2', url: 'https://shown.example/' });
    await add('capture.created', { captureId: 'c1', captureHash: 'sha256:aa' });
    await add('capture.created', { captureId: 'c2', captureHash: 'sha256:bb' });
    await add('note.created', { noteId: 'n1', targetKind: 'capture', targetId: 'c1', text: 'kept' });
    await add('note.created', { noteId: 'n2', targetKind: 'capture', targetId: 'c2', text: 'hidden' });

    const out = redactEvents(events, { captures: new Set(['c1']), visits: new Set(['v2']), notes: new Set(['n1']) });
    expect(out.filter((e) => e.redacted).map((e) => e.seq)).toEqual([1, 4, 6]);
    expect(JSON.stringify(out)).not.toContain('secret.example');
    expect(JSON.stringify(out)).not.toContain('hidden');
    const check = await verifyChain(out);
    expect(check.ok).toBe(true);
    expect(check.redacted).toBe(3);
    expect(check.head).toBe(events.at(-1)!.hash);

    // Changing a kept payload, or un-redacting with a different payload, is caught.
    const tampered = out.map((e) => (e.seq === 5 ? { ...e, payload: { ...e.payload, text: 'changed' } } : e));
    expect((await verifyChain(tampered)).ok).toBe(false);
    const faked = out.map((e) => (e.seq === 1 ? { ...e, payload: { visitId: 'v1', url: 'https://other.example/' }, redacted: undefined } : e));
    expect((await verifyChain(faked as never)).ok).toBe(false);
  });
});

describe('export helpers', () => {
  const cap = (id: string, at: string, parent: string | null = null) =>
    ({ id, startedAtUtc: at, parent, type: 'screenshot', method: 'x', meta: {}, files: [], degraded: [], tags: [], status: 'complete' }) as unknown as CaptureRecord;

  it('numbers exhibits in time order, with lettered children', () => {
    const n = exhibitNumbers([cap('b', '2026-01-02'), cap('a', '2026-01-01'), cap('a1', '2026-01-03', 'a'), cap('a2', '2026-01-04', 'a')]);
    expect(Object.fromEntries(n)).toEqual({ a: 'EV-001', b: 'EV-002', a1: 'EV-001a', a2: 'EV-001b' });
  });

  it('writes visits as CSV with formula-like cells defused', () => {
    const v = {
      seq: 0,
      navigatedAtUtc: '2026-11-16T10:00:00.000Z',
      leftAtUtc: null,
      focusedMs: 0,
      title: '=HYPERLINK("http://x")',
      url: 'https://a.example/',
      finalUrl: 'https://a.example/',
      redirectChain: ['https://a.example/'],
      transitionType: 'typed',
      referrer: null,
      spa: false,
      incognito: false,
      tags: ['one', 'two'],
      autoCaptureId: null,
      id: 'v1',
      auditEventHash: 'sha256:00',
    } as unknown as VisitRecord;
    const csv = visitsCsv([v]);
    expect(csv.startsWith('﻿seq,navigatedAtUtc')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain('"one; two"');
  });

  it('builds a script-free report', () => {
    const html = buildReportHtml({
      exportId: 'e1',
      kind: 'case',
      createdAtUtc: '2026-11-16T10:00:00.000Z',
      software: { name: 'EviCap', version: '0.1.0' },
      environment: { extension: '0.1.0', browser: 'Edge 157', os: 'Windows', userAgent: 'UA', tz: 'Europe/London', tzOffsetMinutes: 0 },
      case: { name: 'Case <A>', reference: 'R-1', investigator: 'I', organisation: 'O', description: '', status: 'open', createdAtUtc: '2026-11-01T00:00:00Z', closedAtUtc: null } as CaseRecord,
      fingerprint: 'sha256:ff',
      auditHead: { seq: 3, hash: 'sha256:ee' },
      auditEvents: 4,
      redactedEvents: 0,
      eventCounts: { 'case.created': 1 },
      exhibits: [],
      visits: [],
      caseNotes: [],
    });
    expect(html).toContain('Case &lt;A&gt;');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("default-src 'none'");
    expect(utcText('2026-11-16T10:42:07.123Z')).toBe('16 Nov 2026, 10:42:07 UTC');
  });

  it('names the checker and the exhibit folder in the report', () => {
    const exhibit = {
      exhibit: 'EV-001',
      capture: { id: 'c1', type: 'screenshot', method: 'x', meta: {}, url: 'https://a.example/', title: 'A', startedAtUtc: '2026-11-16T10:00:00Z', completedAtUtc: null, files: [], degraded: [], tags: [], status: 'complete', captureHash: null, deleted: null } as unknown as CaptureRecord,
      thumb: null,
      notes: [],
      parentExhibit: null,
      folder: 'Exhibits/EV-001 - Screenshot - A',
    };
    const html = buildReportHtml({
      exportId: 'e1',
      kind: 'case',
      createdAtUtc: '2026-11-16T10:00:00.000Z',
      software: { name: 'EviCap', version: '0.1.0' },
      environment: { extension: '0.1.0', browser: 'Edge 157', os: 'Windows', userAgent: 'UA', tz: 'Europe/London', tzOffsetMinutes: 0 },
      case: { name: 'C', reference: '', investigator: '', organisation: '', description: '', status: 'open', createdAtUtc: '2026-11-01T00:00:00Z', closedAtUtc: null } as CaseRecord,
      fingerprint: 'sha256:ff',
      auditHead: { seq: 0, hash: 'sha256:ee' },
      auditEvents: 1,
      redactedEvents: 0,
      eventCounts: {},
      exhibits: [exhibit],
      visits: [],
      caseNotes: [],
    });
    expect(html).toContain('Exhibits/EV-001 - Screenshot - A');
    expect(html).toContain('3 - Check nothing has been changed.html');
    expect(html).not.toContain('verify.html');
  });

  it('bundles the verifier into one file with no external references', async () => {
    const { html } = await buildVerifierHtml();
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    // No way to reach the network (a library licence comment may mention a URL).
    expect(html).not.toMatch(/(?<![\w-])fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|import\s*\(/);
    expect(html).not.toMatch(/(src|href|action)\s*=\s*["']?https?:/i);
    expect(html).toContain("default-src 'none'");
    expect(html.length).toBeLessThan(200_000);
  });
});
