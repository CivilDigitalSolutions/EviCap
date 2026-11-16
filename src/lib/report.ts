import { captureLabel } from './labels';
import type { CaptureRecord, CaseRecord, Environment, NoteRecord, VisitRecord } from './types';

/**
 * The human-readable export report (SPEC F10): one self-contained HTML file
 * with no scripts and no external resources, laid out for A4 printing.
 */

export interface ReportExhibit {
  exhibit: string;
  capture: CaptureRecord;
  /** A small JPEG preview as a data: URL, if the capture has an image. */
  thumb: string | null;
  notes: NoteRecord[];
  parentExhibit: string | null;
}

export interface ReportInput {
  exportId: string;
  kind: 'case' | 'exhibits';
  createdAtUtc: string;
  software: { name: string; version: string };
  environment: Environment;
  case: CaseRecord;
  fingerprint: string;
  auditHead: { seq: number; hash: string | null };
  auditEvents: number;
  redactedEvents: number;
  eventCounts: Record<string, number>;
  exhibits: ReportExhibit[];
  visits: VisitRecord[];
  caseNotes: NoteRecord[];
  /** Pro: organisation name and logo on the cover (SPEC §9.3). */
  branding?: { organisation?: string; logoDataUrl?: string | null } | null;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** "16 Nov 2026, 10:42:07 UTC" from an ISO time. */
export function utcText(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

const bytesText = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

const STYLE = `
@page { size: A4; margin: 16mm 14mm 18mm; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.45 "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif; color: #1c2430; margin: 0; background: #fff; }
main { max-width: 190mm; margin: 0 auto; padding: 8mm 0; }
h1 { font-size: 20pt; margin: 0 0 2mm; }
h2 { font-size: 13pt; margin: 8mm 0 3mm; padding-bottom: 1.5mm; border-bottom: 1.5px solid #1f4e8c; color: #1f4e8c; break-after: avoid; }
h3 { font-size: 11pt; margin: 0 0 2mm; }
p { margin: 0 0 2.5mm; }
.muted { color: #5d6877; }
.mono { font-family: Consolas, "Cascadia Mono", ui-monospace, monospace; font-size: 8.5pt; overflow-wrap: anywhere; }
.cover { border-bottom: 3px solid #1f4e8c; padding-bottom: 5mm; margin-bottom: 4mm; display: flex; justify-content: space-between; gap: 6mm; align-items: flex-end; }
.cover img { max-height: 18mm; max-width: 60mm; }
.kicker { text-transform: uppercase; letter-spacing: .08em; font-size: 8.5pt; color: #5d6877; margin-bottom: 1mm; }
table { width: 100%; border-collapse: collapse; margin: 0 0 3mm; }
th, td { text-align: left; vertical-align: top; padding: 1.4mm 2mm; border-bottom: 1px solid #d9dee5; }
th { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .04em; color: #5d6877; font-weight: 600; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
table.kv th { width: 42mm; text-transform: none; letter-spacing: 0; font-size: 9.5pt; }
.small { font-size: 8.5pt; }
.box { border: 1px solid #d9dee5; border-left: 3px solid #1f4e8c; padding: 3mm 4mm; margin: 3mm 0; background: #f6f8fb; }
.exhibit { border: 1px solid #d9dee5; border-radius: 3px; padding: 4mm; margin: 0 0 4mm; break-inside: avoid; }
.exhibit .head { display: flex; justify-content: space-between; gap: 4mm; margin-bottom: 2mm; }
.exhibit .tag { font-weight: 700; color: #1f4e8c; white-space: nowrap; }
.exhibit .grid { display: grid; grid-template-columns: 58mm 1fr; gap: 4mm; }
.exhibit .thumb { width: 58mm; border: 1px solid #d9dee5; }
.exhibit .nothumb { width: 58mm; height: 30mm; border: 1px dashed #c3cad3; display: flex; align-items: center; justify-content: center; color: #8a94a1; font-size: 8.5pt; }
.warn { color: #8a5a00; }
.note { border-left: 2px solid #c3cad3; padding-left: 3mm; margin: 1.5mm 0; white-space: pre-wrap; }
footer { break-before: avoid; margin-top: 4mm; font-size: 8.5pt; color: #5d6877; border-top: 1px solid #d9dee5; padding-top: 2mm; }
`;

function filesTable(c: CaptureRecord) {
  return `<table class="small"><thead><tr><th>File</th><th>Size</th><th>SHA-256</th></tr></thead><tbody>${c.files
    .map((f) => `<tr><td class="mono">${esc(f.path)}</td><td>${bytesText(f.bytes)}</td><td class="mono">${esc(f.sha256)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function exhibitBlock(x: ReportExhibit) {
  const c = x.capture;
  const status = c.deleted
    ? `<p class="warn">Deleted ${utcText(c.deleted.atUtc)}. Reason: ${esc(c.deleted.reason)}. Its files are not included; the audit log keeps their hashes.</p>`
    : c.status !== 'complete'
      ? `<p class="warn">This capture is ${esc(c.status)}: it was interrupted before every step finished.</p>`
      : '';
  return `<section class="exhibit" id="${esc(x.exhibit)}">
    <div class="head"><div><span class="tag">${esc(x.exhibit)}</span> · ${esc(captureLabel(c))}${x.parentExhibit ? ` <span class="muted">(part of ${esc(x.parentExhibit)})</span>` : ''}</div><div class="muted small">${utcText(c.startedAtUtc)}</div></div>
    <h3>${esc(c.title || '(no title)')}</h3>
    <div class="mono" style="margin-bottom:2mm">${esc(c.url)}</div>
    <div class="grid">
      ${x.thumb ? `<img class="thumb" src="${x.thumb}" alt="Preview of ${esc(x.exhibit)}">` : '<div class="nothumb">No image preview</div>'}
      <div>
        <table class="kv small">
          <tr><th>Method</th><td class="mono">${esc(c.method)}</td></tr>
          <tr><th>Started</th><td>${utcText(c.startedAtUtc)}</td></tr>
          <tr><th>Completed</th><td>${utcText(c.completedAtUtc)}</td></tr>
          <tr><th>Capture hash</th><td class="mono">${esc(c.captureHash ?? '—')}</td></tr>
          <tr><th>Folder in export</th><td class="mono">captures/${esc(c.id)}/</td></tr>
          ${c.tags.length ? `<tr><th>Tags</th><td>${c.tags.map(esc).join(', ')}</td></tr>` : ''}
        </table>
        ${status}
        ${c.degraded.length ? `<p class="warn small"><strong>Captured with limitations:</strong> ${c.degraded.map(esc).join('; ')}</p>` : ''}
      </div>
    </div>
    ${c.files.length ? filesTable(c) : ''}
    ${x.notes.map((n) => `<div class="note small">${esc(n.text)}<div class="muted">Note, ${utcText(n.updatedAtUtc)}${n.versions.length ? `, edited ${n.versions.length} time(s)` : ''}</div></div>`).join('')}
  </section>`;
}

export function buildReportHtml(r: ReportInput): string {
  const c = r.case;
  const org = r.branding?.organisation || c.organisation;
  const counts = Object.entries(r.eventCounts).sort(([a], [b]) => a.localeCompare(b));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidence report: ${esc(c.name)}${c.reference ? ` (${esc(c.reference)})` : ''}</title>
<style>${STYLE}</style></head>
<body><main>
<div class="cover">
  <div>
    <div class="kicker">${r.kind === 'exhibits' ? 'Evidence report · selected exhibits' : 'Evidence report'}</div>
    <h1>${esc(c.name)}</h1>
    <div class="muted">${[c.reference ? `Reference ${esc(c.reference)}` : '', esc(org || '')].filter(Boolean).join(' · ')}</div>
  </div>
  ${r.branding?.logoDataUrl ? `<img src="${r.branding.logoDataUrl}" alt="${esc(org)}">` : ''}
</div>

<table class="kv">
  <tr><th>Investigator</th><td>${esc(c.investigator) || '—'}</td></tr>
  <tr><th>Organisation</th><td>${esc(c.organisation) || '—'}</td></tr>
  ${c.description ? `<tr><th>Description</th><td>${esc(c.description)}</td></tr>` : ''}
  <tr><th>Case opened</th><td>${utcText(c.createdAtUtc)}</td></tr>
  <tr><th>Case status</th><td>${esc(c.status)}${c.closedAtUtc ? `, closed ${utcText(c.closedAtUtc)}` : ''}</td></tr>
  <tr><th>Report created</th><td>${utcText(r.createdAtUtc)}</td></tr>
  <tr><th>Export</th><td>${r.kind === 'exhibits' ? `${r.exhibits.length} selected exhibit(s)` : 'Whole case'} · <span class="mono">${esc(r.exportId)}</span></td></tr>
  <tr><th>Exhibits</th><td>${r.exhibits.length}</td></tr>
  ${r.kind === 'case' ? `<tr><th>Sites visited</th><td>${r.visits.length} page visit(s) logged</td></tr>` : ''}
</table>

<h2>About this report</h2>
<p>This report was produced by ${esc(r.software.name)} ${esc(r.software.version)}, a browser extension that records web pages for investigations. Every file it saved was given a SHA-256 hash when it was captured, each capture's list of files and hashes (its manifest) was signed with a key held by this installation of EviCap, and every action in the case was written to an audit log in which each entry includes the hash of the one before it.</p>
<div class="box">
  <p><strong>What this shows.</strong> That the files in this export are the same files EviCap saved, unchanged since, at the times recorded by this computer's clock; and that the audit log of the case is complete and in order up to the head hash below.</p>
  <p style="margin:0"><strong>What it does not show on its own.</strong> Who was using the computer, whether the computer's clock was right, or that a website showed the same content to other people. The signing key is created by the EviCap installation itself, so it links the evidence to that installation, not to a named person. Record the key fingerprint below in your notes or statement to make that link.</p>
</div>

<h2>Integrity</h2>
<table class="kv">
  <tr><th>Signing key fingerprint</th><td class="mono">${esc(r.fingerprint)}</td></tr>
  <tr><th>Audit log</th><td>${r.auditEvents} events${r.redactedEvents ? `, of which ${r.redactedEvents} unrelated to the selected exhibits have their details left out (their hashes are kept, so the chain still checks)` : ''}</td></tr>
  <tr><th>Audit chain head</th><td class="mono">${esc(r.auditHead.hash ?? '—')} (event ${r.auditHead.seq})</td></tr>
  <tr><th>Time source</th><td>This computer's clock (time zone ${esc(r.environment.tz)})</td></tr>
</table>
<p class="small">To check this export, open <strong>verify.html</strong> from the export in a web browser and choose the export ZIP file or its folder. It works offline. The SHA-256 of the export ZIP itself is shown when the export is made and is recorded in the case's audit log as an <span class="mono">export.created</span> event.</p>

<h2>Environment</h2>
<table class="kv small">
  <tr><th>EviCap</th><td>${esc(r.environment.extension)}</td></tr>
  <tr><th>Browser</th><td>${esc(r.environment.browser)}</td></tr>
  <tr><th>Operating system</th><td>${esc(r.environment.os) || '—'}</td></tr>
  <tr><th>User agent</th><td class="mono">${esc(r.environment.userAgent)}</td></tr>
  <tr><th>Time zone</th><td>${esc(r.environment.tz)} (UTC${r.environment.tzOffsetMinutes >= 0 ? '+' : '−'}${Math.abs(r.environment.tzOffsetMinutes / 60)})</td></tr>
</table>
<p class="small muted">The environment recorded with each capture is in its manifest.json.</p>

<h2>Exhibit index</h2>
${
  r.exhibits.length
    ? `<table class="small"><thead><tr><th>Exhibit</th><th>Captured</th><th>Type</th><th>Address</th></tr></thead><tbody>${r.exhibits
        .map(
          (x) =>
            `<tr><td><strong>${esc(x.exhibit)}</strong></td><td style="white-space:nowrap">${utcText(x.capture.startedAtUtc)}</td><td>${esc(captureLabel(x.capture))}</td><td class="mono">${esc(x.capture.url)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">No captures in this export.</p>'
}

<h2>Exhibits</h2>
${r.exhibits.map(exhibitBlock).join('')}

${
  r.visits.length
    ? `<h2>Sites visited</h2>
<table class="small"><thead><tr><th>#</th><th>Visited</th><th>Page</th><th>How</th><th>In focus</th></tr></thead><tbody>${[...r.visits]
        .sort((a, b) => a.seq - b.seq)
        .map(
          (v) =>
            `<tr><td>${v.seq + 1}</td><td style="white-space:nowrap">${utcText(v.navigatedAtUtc)}</td><td><div>${esc(v.title || '(no title)')}</div><div class="mono">${esc(v.finalUrl)}</div>${
              v.redirectChain.length > 1 ? `<div class="muted">via ${v.redirectChain.slice(0, -1).map(esc).join(' → ')}</div>` : ''
            }</td><td>${esc(v.transitionType)}${v.spa ? ' (in-page)' : ''}</td><td>${v.leftAtUtc ? `${Math.round(v.focusedMs / 1000)} s` : 'open'}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''
}

${
  r.caseNotes.length
    ? `<h2>Case notes</h2>${r.caseNotes.map((n) => `<div class="note">${esc(n.text)}<div class="muted small">${utcText(n.updatedAtUtc)}</div></div>`).join('')}`
    : ''
}

<section style="break-inside: avoid">
<h2>Audit log summary</h2>
<table class="small"><thead><tr><th>Event</th><th>Count</th></tr></thead><tbody>${counts.map(([t, n]) => `<tr><td class="mono">${esc(t)}</td><td>${n}</td></tr>`).join('')}</tbody></table>
<p class="small muted">The full log is in audit-log.jsonl, one event per line.</p>
<footer>Generated by ${esc(r.software.name)} ${esc(r.software.version)} on ${utcText(r.createdAtUtc)}. Export ${esc(r.exportId)}.</footer>
</section>
</main></body></html>`;
}
