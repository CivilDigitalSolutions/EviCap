import { useEffect, useMemo, useState } from 'react';
import { verifyChain } from '@/lib/audit';
import { listAudit, listCaptures } from '@/lib/db';
import { downloadExport, exhibitNumbers, exportCase, exportExists, type ExportProgress, type ExportResult } from '@/lib/export';
import type { ExportRecord } from '@/lib/export-sw';
import { checkIntegrity, integrityProblems } from '@/lib/integrity';
import { rpc } from '@/lib/messages';
import { removePath } from '@/lib/opfs';
import type { CaseRecord } from '@/lib/types';
import { formatBytes } from '@/lib/util';
import { Banner, captureLabel, ErrorText, Hash, LocalTime } from '@/ui/components';
import { useAction, useLive } from '@/ui/hooks';
import { ProTag, usePlan } from './Plan';

/** Export (F10) and case verification (F11) for one case. */
export function ExportPanel({ c }: { c: CaseRecord }) {
  return (
    <div className="stack">
      <ExportCard c={c} />
      <PreviousExports caseId={c.id} />
      <CheckCase caseId={c.id} />
      <div className="card">
        <h2>Check an export file</h2>
        <p className="small" style={{ margin: '0 0 8px' }}>
          Every export contains <strong>3 - Check nothing has been changed.html</strong>, which checks it offline in any browser. You can also check an
          export here.
        </p>
        <a className="btn" href="#/verify">
          Open the verifier
        </a>
      </div>
    </div>
  );
}

function ExportCard({ c }: { c: CaseRecord }) {
  const [captures] = useLive(() => listCaptures(c.id), ['captures'], [c.id]);
  const [mode, setMode] = useState<'case' | 'pick'>('case');
  const plan = usePlan();
  const pro = plan?.entitlement.plan === 'pro';
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const { busy, error, run } = useAction();
  const numbers = useMemo(() => exhibitNumbers(captures ?? []), [captures]);
  const ids = new Set((captures ?? []).map((x) => x.id));
  const top = (captures ?? []).filter((x) => !x.parent || !ids.has(x.parent));
  const totalBytes = (captures ?? []).reduce((n, x) => n + x.files.reduce((m, f) => m + f.bytes, 0), 0);

  const start = () =>
    run(async () => {
      setResult(null);
      const r = await exportCase(c.id, mode === 'pick' ? { captureIds: [...picked] } : {}, setProgress);
      setProgress(null);
      setResult(r);
      await downloadExport(r.path, r.fileName);
    }).finally(() => setProgress(null));

  return (
    <div className="card stack">
      <h2>Export</h2>
      <p className="small" style={{ margin: 0 }}>
        One ZIP file, laid out for whoever receives it: a <strong>1 - START HERE</strong> page that says what to open, the PDF report, an offline
        checker and one folder per exhibit. The visit log, notes, audit log and signed manifest are in a separate technical folder. Nothing is
        uploaded: the file is saved to your computer.
      </p>
      <div className="row" role="radiogroup" aria-label="What to export">
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={mode === 'case'} onChange={() => setMode('case')} /> Whole case
          <span className="muted small">
            ({captures?.length ?? 0} captures, {formatBytes(totalBytes)})
          </span>
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={mode === 'pick'} disabled={!pro} onChange={() => setMode('pick')} /> Selected exhibits
          {plan && !pro && <ProTag />}
        </label>
      </div>
      {mode === 'pick' && (
        <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
          <table className="data small">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={top.length > 0 && top.every((x) => picked.has(x.id))}
                    onChange={(e) => setPicked(new Set(e.target.checked ? top.map((x) => x.id) : []))}
                  />
                </th>
                <th>Exhibit</th>
                <th>Captured</th>
                <th>Type</th>
                <th>Page</th>
              </tr>
            </thead>
            <tbody>
              {top.map((x) => (
                <tr key={x.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Include ${numbers.get(x.id)}`}
                      checked={picked.has(x.id)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(x.id);
                        else next.delete(x.id);
                        setPicked(next);
                      }}
                    />
                  </td>
                  <td className="mono">{numbers.get(x.id)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <LocalTime utc={x.startedAtUtc} />
                  </td>
                  <td>{captureLabel(x)}</td>
                  <td className="truncate" style={{ maxWidth: 360 }}>
                    {x.title || x.url}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mode === 'pick' && (
        <p className="small muted" style={{ margin: 0 }}>
          The audit log is included in full so it can still be checked, but events that are not about the selected exhibits have their details left out.
          Related screenshots and posters are included with their exhibit.
        </p>
      )}
      <div className="row">
        <button type="button" className="primary" disabled={busy || (mode === 'pick' && picked.size === 0)} onClick={start}>
          {mode === 'pick' ? `Export ${picked.size} exhibit${picked.size === 1 ? '' : 's'}` : 'Export case'}
        </button>
        {busy && progress && (
          <span className="small muted">
            {progress.stage}
            {progress.total > 1 ? ` (${progress.done + 1} of ${progress.total})` : ''}…
          </span>
        )}
      </div>
      {busy && (
        <p className="small muted" style={{ margin: 0 }}>
          Keep this tab open until the export finishes. The browser shows a “debugging” bar for a moment while the report is printed to PDF.
        </p>
      )}
      <ErrorText error={error} />
      {result && (
        <Banner kind="ok">
          Export saved as <strong>{result.fileName}</strong> ({formatBytes(result.bytes)}). SHA-256 of the ZIP: <span className="mono">{result.sha256}</span>.
          This is recorded in the audit log. {result.reportPdf !== 'included' && ` The PDF report is missing: ${result.reportPdf}`}
          <br />
          Send the whole ZIP file unchanged. Whoever receives it should unzip it and open <strong>1 - START HERE.html</strong>.
        </Banner>
      )}
    </div>
  );
}

function PreviousExports({ caseId }: { caseId: string }) {
  const [events] = useLive(() => listAudit(caseId), ['cases', 'captures'], [caseId]);
  const exports = (events ?? []).filter((e) => e.type === 'export.created').reverse();
  const [present, setPresent] = useState<Record<string, boolean>>({});
  const [tick, setTick] = useState(0);
  const { busy, error, run } = useAction();
  useEffect(() => {
    void Promise.all(exports.map(async (e) => [String(e.payload.path), await exportExists(String(e.payload.path))] as const)).then((l) =>
      setPresent(Object.fromEntries(l)),
    );
  }, [exports.length, tick]);
  if (!exports.length) return null;
  return (
    <div className="card table-wrap">
      <h2>Previous exports</h2>
      <table className="data small">
        <thead>
          <tr>
            <th>Created</th>
            <th>File</th>
            <th>Size</th>
            <th>SHA-256</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {exports.map((e) => {
            const p = e.payload as unknown as ExportRecord;
            return (
              <tr key={e.seq}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <LocalTime utc={e.atUtc} />
                </td>
                <td>
                  <div className="mono">{p.fileName}</div>
                  <div className="muted">{p.kind === 'exhibits' ? `${p.captureIds.length} exhibit(s)` : 'Whole case'}</div>
                </td>
                <td>{formatBytes(p.bytes)}</td>
                <td>
                  <Hash value={p.sha256} short />
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {present[p.path] ? (
                    <>
                      <button type="button" className="small" disabled={busy} onClick={() => run(() => downloadExport(p.path, p.fileName))}>
                        Save again
                      </button>{' '}
                      <button
                        type="button"
                        className="small"
                        disabled={busy}
                        title="Remove EviCap's own copy of this export to free space. The record of the export stays in the audit log."
                        onClick={() =>
                          run(async () => {
                            await removePath(p.path.slice(0, p.path.lastIndexOf('/')));
                            setTick((t) => t + 1);
                          })
                        }
                      >
                        Remove copy
                      </button>
                    </>
                  ) : (
                    <span className="muted">copy removed</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ErrorText error={error} />
    </div>
  );
}

function CheckCase({ caseId }: { caseId: string }) {
  const [result, setResult] = useState<{ ok: boolean; checked: number; problems: string[]; head: string | null } | null>(null);
  const [step, setStep] = useState('');
  const { busy, error, run } = useAction();
  const go = () =>
    run(async () => {
      setResult(null);
      const captures = (await listCaptures(caseId)).filter((x) => !x.deleted && x.status === 'complete');
      const problems: string[] = [];
      let n = 0;
      for (const x of captures) {
        setStep(`Checking capture ${++n} of ${captures.length}`);
        problems.push(...integrityProblems(x, await checkIntegrity(x)));
      }
      setStep('Checking the audit log');
      const chain = await verifyChain(await listAudit(caseId));
      problems.push(...chain.errors.map((e) => `audit event ${e.seq}: ${e.problem}`));
      const files = captures.reduce((m, x) => m + x.files.length, 0);
      const r = { ok: problems.length === 0, checked: files, problems, head: chain.head };
      setResult(r);
      await rpc('recordVerify', caseId, { ok: r.ok, scope: 'case', checked: files, problems, chainHead: chain.head });
    }).finally(() => setStep(''));
  return (
    <div className="card stack">
      <h2>Check this case</h2>
      <p className="small" style={{ margin: 0 }}>
        Re-hashes every stored file, checks each capture's signed manifest and walks the audit chain. The result is recorded in the audit log.
      </p>
      <div className="row">
        <button type="button" disabled={busy} onClick={go}>
          Check every file
        </button>
        {busy && <span className="small muted">{step}…</span>}
      </div>
      <ErrorText error={error} />
      {result &&
        (result.ok ? (
          <Banner kind="ok">
            Verified: {result.checked} files match their hashes, every capture manifest is signed and intact, and the audit chain is unbroken (head{' '}
            <span className="mono">{result.head}</span>).
          </Banner>
        ) : (
          <Banner kind="error">
            {result.problems.length} problem(s) found:
            <ul style={{ margin: '4px 0 0' }}>
              {result.problems.slice(0, 20).map((p, i) => (
                <li key={i} className="mono small">
                  {p}
                </li>
              ))}
            </ul>
          </Banner>
        ))}
    </div>
  );
}
