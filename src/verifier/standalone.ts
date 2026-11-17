import { folderSource, verifyBundle, zipSource, type BundleSource, type VerifyReport } from './core';

/**
 * The offline verifier shipped as verify.html in every export. It is one
 * self-contained file with no network access; open it from disk.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const MARK = { pass: '✓', fail: '✗', warn: '!' } as const;

function render(r: VerifyReport) {
  const m = r.manifest;
  const out = $('result');
  out.innerHTML = `
    <div class="verdict ${r.ok ? 'pass' : 'fail'}">
      <strong>${r.ok ? 'Verified' : 'Verification failed'}</strong>
      <span>${
        r.ok
          ? 'Nothing has been changed. Every file matches its hash, the signatures check and the audit chain is unbroken.'
          : 'Something is missing or has been changed since the export was made. See the details below.'
      }</span>
    </div>
    ${
      m
        ? `<dl class="kv">
      <dt>Case</dt><dd>${esc(m.case.name)}${m.case.reference ? ` (${esc(m.case.reference)})` : ''}</dd>
      <dt>Investigator</dt><dd>${esc(m.case.investigator) || '—'}${m.case.organisation ? `, ${esc(m.case.organisation)}` : ''}</dd>
      <dt>Export</dt><dd>${m.kind === 'exhibits' ? 'Selected exhibits' : 'Whole case'}, created ${esc(m.createdAtUtc)} (UTC)</dd>
      <dt>Made with</dt><dd>${esc(m.software.name)} ${esc(m.software.version)}</dd>
      <dt>Key fingerprint</dt><dd class="mono">${esc(m.publicKey.fingerprint)}</dd>
    </dl>`
        : ''
    }
    <h2>Checks</h2>
    <ul class="checks">${r.checks
      .map((c) => `<li class="${c.status}"><span class="mark">${MARK[c.status]}</span><div><strong>${esc(c.label)}</strong>${c.detail ? `<div class="detail">${esc(c.detail)}</div>` : ''}</div></li>`)
      .join('')}</ul>
    ${
      r.files.length
        ? `<details${r.files.some((f) => f.status === 'fail') ? ' open' : ''}><summary>Files (${r.files.length})</summary>
      <table><thead><tr><th></th><th>File</th><th>Size</th><th>SHA-256</th></tr></thead><tbody>${r.files
        .map(
          (f) =>
            `<tr class="${f.status}"><td>${MARK[f.status]}</td><td class="mono">${esc(f.path)}</td><td>${f.bytes.toLocaleString()}</td><td class="mono small">${esc(f.expected)}${
              f.status === 'fail' ? `<br>found: ${esc(f.actual ?? 'missing')}` : ''
            }</td></tr>`,
        )
        .join('')}</tbody></table></details>`
        : ''
    }`;
  document.body.dataset.result = r.ok ? 'pass' : 'fail';
}

async function run(src: Promise<BundleSource>) {
  const out = $('result');
  const progress = $<HTMLProgressElement>('progress');
  out.innerHTML = '<p>Checking…</p>';
  progress.hidden = false;
  progress.value = 0;
  try {
    const report = await verifyBundle(await src, (d, t) => (progress.value = t ? d / t : 1));
    render(report);
  } catch (err) {
    out.innerHTML = `<div class="verdict fail"><strong>Could not check this export</strong><span>${esc((err as Error).message)}</span></div>`;
    document.body.dataset.result = 'error';
  } finally {
    progress.hidden = true;
  }
}

$<HTMLInputElement>('zip').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void run(zipSource(f));
});
$<HTMLInputElement>('folder').addEventListener('change', (e) => {
  const list = Array.from((e.target as HTMLInputElement).files ?? []);
  if (list.length) void run(Promise.resolve(folderSource(list)));
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) void run(zipSource(f));
});
