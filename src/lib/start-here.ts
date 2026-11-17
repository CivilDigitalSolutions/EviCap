import { MARK_ON_LIGHT, markSvg } from './brand';
import { cleanBranding, DEFAULT_ACCENT, type Branding } from './branding';
import { href, LAYOUT, tech, viewableFiles } from './export-layout';
import { captureLabel } from './labels';
import { utcText } from './report';
import type { CaptureRecord, CaseRecord } from './types';

/**
 * "1 - START HERE.html": the first thing anyone opens in an export. It says in
 * plain words what to open, in what order, and links straight to each
 * exhibit's picture, video or saved page. No scripts, no external resources.
 */

export interface StartHereExhibit {
  exhibit: string;
  capture: CaptureRecord;
  thumb: string | null;
  /** The exhibit's folder in the export, e.g. "Exhibits/EV-001 - Screenshot - Home". */
  folder: string;
  parentExhibit: string | null;
}

export interface StartHereInput {
  kind: 'case' | 'exhibits';
  exportId: string;
  createdAtUtc: string;
  software: { name: string; version: string };
  case: CaseRecord;
  exhibits: StartHereExhibit[];
  /** The report's file name at the top level (PDF, or HTML if printing failed). */
  reportFile: string;
  visits: number;
  branding?: Partial<Branding> | null;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
* { box-sizing: border-box; }
body { margin: 0; background: #edf2f4; color: #14213d; font: 17px/1.55 "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 24px 16px 56px; }
a { color: var(--accent); }
h1 { font-size: 30px; line-height: 1.2; margin: 4px 0 6px; letter-spacing: -.01em; }
h2 { font-size: 22px; margin: 36px 0 12px; }
p { margin: 0 0 10px; }
.muted { color: #56627a; }
.marking { text-align: center; font-weight: 700; letter-spacing: .06em; margin: 0 0 12px; }
.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.top img { max-height: 56px; max-width: 200px; }
.kicker { text-transform: uppercase; letter-spacing: .08em; font-size: 14px; font-weight: 700; color: var(--accent); }
.logo { display: flex; align-items: center; gap: 8px; font-weight: 800; font-size: 20px; }
.unzip { background: #fff4d6; border: 2px solid #e0b100; border-radius: 8px; padding: 12px 16px; margin: 20px 0; font-size: 16px; }
.steps { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; }
.step { background: #fff; border: 2px solid #cdd7de; border-radius: 10px; padding: 18px 20px; display: grid; grid-template-columns: 56px 1fr; gap: 4px 16px; align-items: start; }
.step .n { grid-row: span 3; width: 56px; height: 56px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 30px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
.step h3 { margin: 6px 0 2px; font-size: 21px; }
.step p { margin: 0; }
.step.optional { border-style: dashed; }
.step.optional .n { background: #56627a; }
.btn { display: inline-block; margin-top: 10px; padding: 10px 18px; border-radius: 8px; background: var(--accent); color: #fff; text-decoration: none; font-weight: 700; font-size: 17px; }
.btn:hover, .btn:focus-visible { filter: brightness(1.12); }
.btn.secondary { background: #fff; color: var(--accent); border: 2px solid var(--accent); padding: 8px 16px; }
.btn.small { font-size: 15px; padding: 7px 14px; margin: 6px 6px 0 0; }
.btn.secondary.small { padding: 5px 12px; }
.file { font-weight: 700; background: #fff; border: 1px solid #cdd7de; border-radius: 4px; padding: 0 6px; white-space: nowrap; }
.ex { background: #fff; border: 1px solid #cdd7de; border-radius: 10px; padding: 16px; margin: 0 0 14px; display: grid; grid-template-columns: 200px 1fr; gap: 18px; }
.ex.child { margin-left: 40px; }
.ex .thumb { width: 200px; border: 1px solid #cdd7de; border-radius: 4px; display: block; }
.ex .nothumb { width: 200px; height: 120px; border: 2px dashed #c3cad3; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #8a94a1; font-size: 14px; text-align: center; padding: 8px; }
.ex .num { font-size: 24px; font-weight: 800; color: var(--accent); }
.ex .what { font-weight: 600; }
.ex h3 { margin: 4px 0; font-size: 18px; overflow-wrap: anywhere; }
.ex .url { font-family: Consolas, "Cascadia Mono", ui-monospace, monospace; font-size: 14px; overflow-wrap: anywhere; color: #3b4a66; }
.ex .hint { font-size: 13px; color: #56627a; }
.warn { color: #8a5a00; font-weight: 600; }
table.contents { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #cdd7de; border-radius: 10px; overflow: hidden; }
table.contents td { padding: 12px 14px; border-top: 1px solid #e2e8ec; vertical-align: top; }
table.contents td:first-child { width: 42%; font-weight: 700; overflow-wrap: anywhere; }
.icon { display: inline-block; width: 1.4em; }
footer { margin-top: 40px; font-size: 14px; color: #56627a; border-top: 1px solid #cdd7de; padding-top: 12px; display: flex; gap: 8px; align-items: center; }
@media (max-width: 640px) {
  .ex, .ex.child { grid-template-columns: 1fr; margin-left: 0; }
  .ex .thumb, .ex .nothumb { width: 100%; max-width: 320px; }
  .step { grid-template-columns: 44px 1fr; }
  .step .n { width: 44px; height: 44px; font-size: 24px; }
  table.contents, table.contents tbody, table.contents tr, table.contents td { display: block; width: auto; }
  table.contents td:first-child { width: auto; padding-bottom: 0; }
  table.contents td + td { border-top: 0; padding-top: 4px; }
}
@media print { body { background: #fff; } .unzip { display: none; } .btn { border: 1px solid var(--accent); } }
`;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function exhibitCard(x: StartHereExhibit) {
  const c = x.capture;
  const views = c.deleted ? [] : viewableFiles(c);
  const link = (p: string) => href(`${x.folder}/${p}`);
  const status = c.deleted
    ? `<p class="warn">This exhibit was deleted from the case (${esc(c.deleted.reason)}). Its files are not included.</p>`
    : c.status !== 'complete'
      ? `<p class="warn">This capture was interrupted before it finished, so it may be incomplete.</p>`
      : '';
  const thumb = x.thumb
    ? `<a href="${views[0] ? link(views[0].file.path) : href(x.folder)}"><img class="thumb" src="${x.thumb}" alt="Preview of exhibit ${esc(x.exhibit)}"></a>`
    : `<div class="nothumb">${c.type === 'video' ? 'Video: use the Play button' : 'No preview'}</div>`;
  return `<section class="ex${x.parentExhibit ? ' child' : ''}" id="${esc(x.exhibit)}">
  ${thumb}
  <div>
    <div><span class="num">${esc(x.exhibit)}</span> <span class="what">· ${esc(cap(captureLabel(c)))}</span>${x.parentExhibit ? ` <span class="muted">(belongs with ${esc(x.parentExhibit)})</span>` : ''}</div>
    <h3>${esc(c.title || '(page had no title)')}</h3>
    <div class="url">${esc(c.url)}</div>
    <div class="muted" style="font-size:15px;margin-top:4px">Captured ${utcText(c.startedAtUtc)}</div>
    ${status}
    <div>${views
      .map(
        (v, i) =>
          `<a class="btn small${i ? ' secondary' : ''}" href="${link(v.file.path)}">${esc(v.label)}</a>${v.hint ? `<span class="hint">${esc(v.hint)}</span>` : ''}`,
      )
      .join('')}${c.deleted ? '' : `<a class="btn small secondary" href="${href(x.folder)}/">Open its folder</a>`}</div>
  </div>
</section>`;
}

export function buildStartHereHtml(r: StartHereInput): string {
  const c = r.case;
  let brand: Branding | null = null;
  try {
    brand = r.branding ? cleanBranding(r.branding) : null;
  } catch {
    brand = null;
  }
  const accent = brand?.accent ?? DEFAULT_ACCENT;
  const isPdf = r.reportFile.endsWith('.pdf');
  const count = r.exhibits.filter((x) => !x.parentExhibit).length;
  const prepared = [c.investigator, c.organisation].filter(Boolean).map(esc).join(', ');
  const first = r.exhibits.find((x) => !x.capture.deleted);

  const contents: [string, string, string, string | null][] = [
    ['📄', LAYOUT.startHere, 'This page.', null],
    ['📄', r.reportFile, `The evidence report. Read or print this.${isPdf ? '' : ' (Open it in a web browser; use Print to make a PDF.)'}`, href(r.reportFile)],
    ['📄', LAYOUT.verifier, 'Checks that no file in this export has been changed since it was made. Optional.', href(LAYOUT.verifier)],
    ['📁', LAYOUT.exhibits, `One folder for each exhibit, named by its number${first ? `, for example <span class="file">${esc(first.folder.slice(LAYOUT.exhibits.length + 1))}</span>` : ''}. Each folder holds the original files that were captured.`, `${href(LAYOUT.exhibits)}/`],
    ...(r.kind === 'case' && r.visits
      ? ([['📊', 'visits.csv', `A spreadsheet of every web page visited (${r.visits}), which opens in Excel. It is in the technical files folder.`, href(tech('visits.csv'))]] as [string, string, string, string][])
      : []),
    [
      '📁',
      LAYOUT.technical,
      'Data used by the checker and by specialist tools: the signed list of every file with its SHA-256 fingerprint, the audit log of every action, and the public key. You do not need to open anything in this folder to see the evidence.',
      null,
    ],
  ];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>START HERE: evidence for ${esc(c.name)}${c.reference ? ` (${esc(c.reference)})` : ''}</title>
<style>:root { --accent: ${accent}; }${STYLE}</style></head>
<body><main>
${brand?.marking ? `<div class="marking">${esc(brand.marking)}</div>` : ''}
<div class="top">
  <div>
    <div class="kicker">Start here · ${r.kind === 'exhibits' ? 'Selected evidence' : 'Evidence'}</div>
    <h1>${esc(c.name)}</h1>
    <p class="muted">${[c.reference ? `Reference <strong>${esc(c.reference)}</strong>` : '', prepared ? `Prepared by ${prepared}` : '', `Exported ${utcText(r.createdAtUtc)}`].filter(Boolean).join(' · ')}</p>
  </div>
  ${brand?.logoDataUrl ? `<img src="${brand.logoDataUrl}" alt="${esc(brand.organisation || 'Logo')}">` : brand?.organisation ? `<strong>${esc(brand.organisation)}</strong>` : `<div class="logo">${markSvg(MARK_ON_LIGHT, { size: 36 })}EviCap</div>`}
</div>

<div class="unzip"><strong>Buttons on this page not working?</strong> The ZIP file has not been unzipped yet. Close this page, right-click the ZIP file and choose <strong>Extract All</strong> (on a Mac, double-click it). Then open <span class="file">${esc(LAYOUT.startHere)}</span> from the new folder.</div>

<h2>What to do</h2>
<ol class="steps">
  <li class="step"><span class="n" aria-hidden="true">1</span>
    <h3>Read the report</h3>
    <p>It lists all ${count} exhibit${count === 1 ? '' : 's'} with a picture of each, the web address and the date and time it was captured.</p>
    <div><a class="btn" href="${href(r.reportFile)}">Open the report</a> <span class="muted" style="font-size:15px">${esc(r.reportFile)}</span></div>
  </li>
  <li class="step"><span class="n" aria-hidden="true">2</span>
    <h3>Look at the exhibits</h3>
    <p>Every exhibit is listed below with buttons to open it. They are also in the <span class="file">${esc(LAYOUT.exhibits)}</span> folder, one folder each.</p>
    <div><a class="btn" href="#exhibits">Go to the exhibits</a></div>
  </li>
  <li class="step optional"><span class="n" aria-hidden="true">3</span>
    <h3>Check nothing has been changed <span class="muted" style="font-weight:400">(optional)</span></h3>
    <p>Opens a checker in your web browser. Choose the ZIP file you were sent, or this folder, and it confirms every file is exactly as it was when exported. It works offline and sends nothing anywhere.</p>
    <div><a class="btn secondary" href="${href(LAYOUT.verifier)}">Open the checker</a></div>
  </li>
</ol>

<h2 id="exhibits">The exhibits (${count})</h2>
${r.exhibits.length ? r.exhibits.map(exhibitCard).join('\n') : '<p class="muted">This export has no exhibits.</p>'}

<h2>What is in this folder</h2>
<table class="contents">${contents
    .map(([icon, name, what, link]) => `<tr><td><span class="icon" aria-hidden="true">${icon}</span>${link ? `<a href="${link}">${esc(name)}</a>` : esc(name)}</td><td>${what}</td></tr>`)
    .join('')}</table>
<p class="muted" style="margin-top:12px;font-size:15px">Keep all of these together. If you pass the evidence on, send the whole ZIP file unchanged, so it can still be checked.</p>

<footer>${markSvg(MARK_ON_LIGHT, { size: 16 })}<span>Made with ${esc(r.software.name)} ${esc(r.software.version)}, ${utcText(r.createdAtUtc)}. Export ${esc(r.exportId)}.</span></footer>
</main></body></html>`;
}
