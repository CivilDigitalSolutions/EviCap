import { useState } from 'react';
import { getCase } from '@/lib/db';
import { rpc } from '@/lib/messages';
import { formatBytes } from '@/lib/util';
import { Banner, ErrorText } from '@/ui/components';
import { useAction } from '@/ui/hooks';
import { folderSource, verifyBundle, zipSource, type BundleSource, type VerifyReport } from '../../verifier/core';

const MARK = { pass: '✓', fail: '✗', warn: '!' } as const;

/** Verify an export bundle (F11), with the same checks as its verify.html. */
export function VerifyPage() {
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [pct, setPct] = useState(0);
  const [logged, setLogged] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const check = (src: () => Promise<BundleSource>) =>
    run(async () => {
      setReport(null);
      setLogged(null);
      setPct(0);
      const r = await verifyBundle(await src(), (d, t) => setPct(t ? d / t : 1));
      setReport(r);
      // A bundle from a case in this browser: note the check in that case's audit log.
      const id = r.manifest?.case.id;
      if (id && (await getCase(id))) {
        await rpc('recordVerify', id, {
          ok: r.ok,
          scope: 'bundle',
          checked: r.files.length,
          problems: r.checks.filter((c) => c.status === 'fail').map((c) => `${c.label}: ${c.detail ?? ''}`),
          chainHead: r.manifest?.auditHead.hash ?? null,
        });
        setLogged(r.manifest!.case.name);
      }
    });

  return (
    <section className="stack">
      <h1>Verify an export</h1>
      <div className="card stack">
        <p style={{ margin: 0 }}>Choose an EviCap export ZIP file, or the folder it was unzipped to. Checking happens on this computer.</p>
        <div className="row">
          <label className="btn primary">
            Choose ZIP file
            <input
              type="file"
              accept=".zip,application/zip"
              className="visually-hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void check(() => zipSource(f));
              }}
            />
          </label>
          <label className="btn">
            Choose folder
            <input
              type="file"
              className="visually-hidden"
              // @ts-expect-error non-standard but widely supported
              webkitdirectory=""
              multiple
              onChange={(e) => {
                const list = Array.from(e.target.files ?? []);
                if (list.length) void check(async () => folderSource(list));
              }}
            />
          </label>
          {busy && <span className="small muted">Checking… {Math.round(pct * 100)}%</span>}
        </div>
      </div>
      <ErrorText error={error} />
      {report && (
        <>
          {report.ok ? (
            <Banner kind="ok">Verified: every file matches its hash, the signatures check and the audit chain is unbroken.</Banner>
          ) : (
            <Banner kind="error">Verification failed. See the checks below.</Banner>
          )}
          {logged && <p className="small muted">This check was recorded in the audit log of the case “{logged}”.</p>}
          {report.manifest && (
            <div className="card">
              <dl className="kv">
                <dt>Case</dt>
                <dd>
                  {report.manifest.case.name}
                  {report.manifest.case.reference && ` (${report.manifest.case.reference})`}
                </dd>
                <dt>Export</dt>
                <dd>
                  {report.manifest.kind === 'exhibits' ? 'Selected exhibits' : 'Whole case'}, {report.manifest.createdAtUtc} UTC
                </dd>
                <dt>Key fingerprint</dt>
                <dd className="mono">{report.manifest.publicKey.fingerprint}</dd>
              </dl>
            </div>
          )}
          <div className="card">
            <h2>Checks</h2>
            <ul className="check-list">
              {report.checks.map((c, i) => (
                <li key={i} className={c.status}>
                  <span className="mark">{MARK[c.status]}</span>
                  <div>
                    <strong>{c.label}</strong>
                    {c.detail && <div className="small muted">{c.detail}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          {report.files.length > 0 && (
            <details className="card table-wrap" open={report.files.some((f) => f.status === 'fail')}>
              <summary>Files ({report.files.length})</summary>
              <table className="data small">
                <thead>
                  <tr>
                    <th />
                    <th>File</th>
                    <th>Size</th>
                    <th>SHA-256</th>
                  </tr>
                </thead>
                <tbody>
                  {report.files.map((f) => (
                    <tr key={f.path}>
                      <td>{MARK[f.status]}</td>
                      <td className="mono">{f.path}</td>
                      <td>{formatBytes(f.bytes)}</td>
                      <td className="mono">
                        {f.expected}
                        {f.status === 'fail' && <div style={{ color: 'var(--danger)' }}>found: {f.actual ?? 'missing'}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </section>
  );
}
