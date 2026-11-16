import { useEffect, useState } from 'react';
import { getCapture } from '@/lib/db';
import { capturePath, readFile } from '@/lib/opfs';
import { buildSnapshot, type SnapshotResult } from '@/lib/snapshot';
import type { CaptureFile, CaptureRecord } from '@/lib/types';
import { formatBytes } from '@/lib/util';
import { readWacz } from '@/lib/wacz';
import { Banner, LocalTime } from '@/ui/components';
import { useLive } from '@/ui/hooks';

type Meta = Record<string, any>;

/** Save one stored file to the user's computer (a normal browser download). */
export function SaveFile({ c, f, label }: { c: CaptureRecord; f: CaptureFile; label?: string }) {
  return (
    <button
      type="button"
      className="small"
      onClick={async () => {
        const file = await readFile(capturePath(c.caseId, c.id, f.path));
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${c.id.slice(0, 8)}_${f.path.replace(/\//g, '_')}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }}
    >
      {label ?? 'Save'}
    </button>
  );
}

interface NetRow {
  url: string;
  method: string;
  resourceType: string;
  status: number | null;
  mimeType: string | null;
  protocol: string | null;
  remoteIPAddress: string | null;
  bodyBytes: number | null;
  bodyUnavailable: string | null;
  redirect: boolean;
  failed: string | null;
  fromCache: boolean;
}

/** Forensic capture (F4): page, connection and network details. */
export function ForensicCards({ c }: { c: CaptureRecord }) {
  const m = c.meta as Meta;
  const [rows, setRows] = useState<NetRow[] | null>(null);
  const [filter, setFilter] = useState('');
  const netFile = c.files.find((f) => f.role === 'network');
  useEffect(() => {
    if (!netFile) return;
    readFile(capturePath(c.caseId, c.id, netFile.path))
      .then(async (f) => setRows(JSON.parse(await f.text())))
      .catch(() => setRows([]));
  }, [c.id]);
  if (c.type !== 'forensic') return null;
  const wacz = c.files.find((f) => f.path === 'page.wacz');
  const tls = m.tls as Meta | null;
  const shown = rows?.filter((r) => !filter || r.url.toLowerCase().includes(filter.toLowerCase())) ?? [];

  return (
    <>
      <div className="card stack">
        <h2>Forensic capture</h2>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {wacz && (
            <a className="btn primary" href={`#/case/${c.caseId}/capture/${c.id}/snapshot`}>
              View offline snapshot
            </a>
          )}
          {wacz && <SaveFile c={c} f={wacz} label="Save WACZ" />}
          {c.files
            .filter((f) => ['mhtml', 'dom', 'source', 'certificate'].includes(f.role))
            .map((f) => (
              <SaveFile key={f.path} c={c} f={f} label={`Save ${f.path}`} />
            ))}
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          The WACZ file opens in any Web Archive viewer, such as ReplayWeb.page, for full replay.
        </p>
        <dl className="kv">
          <dt>Mode</dt>
          <dd>{m.options?.reload ? 'Reloaded with network recording on' : 'Page as already loaded (no reload)'}</dd>
          {m.mainDocument && (
            <>
              <dt>Server</dt>
              <dd className="mono">
                {m.mainDocument.remoteIPAddress ?? '—'}
                {m.mainDocument.remotePort ? `:${m.mainDocument.remotePort}` : ''} · {m.mainDocument.protocol ?? ''} · HTTP{' '}
                {m.mainDocument.status}
              </dd>
            </>
          )}
          <dt>Requests</dt>
          <dd>
            {m.counts?.requests ?? 0} recorded, {m.counts?.responsesWithBody ?? 0} with bodies
            {m.counts?.resourcesFromPage ? `, ${m.counts.resourcesFromPage} from the page's memory` : ''}
          </dd>
          {m.bodyUnavailableCount > 0 && (
            <>
              <dt>Bodies missing</dt>
              <dd>{m.bodyUnavailableCount} (listed in the network log)</dd>
            </>
          )}
          <dt>Links on page</dt>
          <dd>{m.counts?.links ?? 0}</dd>
          {m.clock && (
            <>
              <dt>Clock</dt>
              <dd>
                <LocalTime utc={m.clock.startUtc} /> to <LocalTime utc={m.clock.endUtc} /> ({m.clock.timezone})
              </dd>
            </>
          )}
          {m.screen && (
            <>
              <dt>Screen</dt>
              <dd>
                {m.screen.width} × {m.screen.height}, window {m.screen.innerWidth} × {m.screen.innerHeight} at {m.screen.devicePixelRatio}×
              </dd>
            </>
          )}
        </dl>
      </div>
      {tls && (
        <div className="card">
          <h2>Secure connection (TLS)</h2>
          <dl className="kv">
            {tls.securityState && (
              <>
                <dt>State</dt>
                <dd>{tls.securityState}</dd>
              </>
            )}
            <dt>Protocol</dt>
            <dd className="mono">
              {tls.protocol} {tls.cipher ? `· ${tls.cipher}` : ''} {tls.keyExchange ? `· ${tls.keyExchange}` : ''}
            </dd>
            <dt>Certificate for</dt>
            <dd className="mono">{tls.subjectName}</dd>
            <dt>Issued by</dt>
            <dd className="mono">{tls.issuer}</dd>
            <dt>Valid</dt>
            <dd>
              <LocalTime utc={tls.validFromUtc} withSeconds={false} /> to <LocalTime utc={tls.validToUtc} withSeconds={false} />
            </dd>
            {Array.isArray(tls.sanList) && (
              <>
                <dt>Also covers</dt>
                <dd className="mono small">{tls.sanList.slice(0, 20).join(', ')}</dd>
              </>
            )}
            {tls.certificateTransparencyCompliance && (
              <>
                <dt>Certificate transparency</dt>
                <dd>{tls.certificateTransparencyCompliance}</dd>
              </>
            )}
            {tls.certificateNetworkError && (
              <>
                <dt>Certificate error</dt>
                <dd>{tls.certificateNetworkError}</dd>
              </>
            )}
          </dl>
        </div>
      )}
      {rows && rows.length > 0 && (
        <details className="card">
          <summary>Network log ({rows.length} requests)</summary>
          <input placeholder="Filter by address" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ margin: '8px 0' }} />
          <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
            <table className="data small">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Type</th>
                  <th>Address</th>
                  <th>Server</th>
                  <th>Body</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 1000).map((r, i) => (
                  <tr key={i}>
                    <td>{r.failed ? 'failed' : (r.status ?? '—')}</td>
                    <td>{r.resourceType}</td>
                    <td className="mono" style={{ maxWidth: 420, wordBreak: 'break-all' }}>
                      {r.method !== 'GET' && <strong>{r.method} </strong>}
                      {r.url}
                    </td>
                    <td className="mono">{r.remoteIPAddress ?? (r.fromCache ? 'cache' : '—')}</td>
                    <td>{r.bodyBytes !== null ? formatBytes(r.bodyBytes) : r.redirect ? 'redirect' : <span title={r.bodyUnavailable ?? ''}>missing</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}

/** Auto-capture (F3): what was saved and how to open it. */
export function AutoCard({ c }: { c: CaptureRecord }) {
  const [text, setText] = useState<string | null>(null);
  const textFile = c.files.find((f) => f.role === 'text');
  const mhtml = c.files.find((f) => f.path === 'page.mhtml');
  if (c.type !== 'auto') return null;
  return (
    <div className="card stack">
      <h2>Automatic capture</h2>
      <p className="small" style={{ margin: 0 }}>
        Saved when the page finished loading: the page as MHTML (open the saved file in Chrome or Edge to view it), its text, and a
        screenshot if the tab was on screen.
      </p>
      <div className="row" style={{ gap: 8 }}>
        {mhtml && <SaveFile c={c} f={mhtml} label="Save MHTML" />}
        {textFile && (
          <button
            type="button"
            className="small"
            onClick={async () => setText(await (await readFile(capturePath(c.caseId, c.id, textFile.path))).text())}
          >
            Show page text
          </button>
        )}
      </div>
      {text !== null && (
        <pre className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto', margin: 0 }}>
          {text || '(no text)'}
        </pre>
      )}
    </div>
  );
}

/** Offline, script-free snapshot of a forensic capture, built from its WACZ. */
export function SnapshotView({ caseId, captureId }: { caseId: string; captureId: string }) {
  const [c] = useLive(() => getCapture(captureId), ['captures'], [captureId]);
  const [snap, setSnap] = useState<SnapshotResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!c) return;
    (async () => {
      const wacz = readWacz(new Uint8Array(await (await readFile(capturePath(c.caseId, c.id, 'page.wacz'))).arrayBuffer()));
      const dom = await (await readFile(capturePath(c.caseId, c.id, 'dom.html'))).text();
      setSnap(buildSnapshot(dom, c.url, wacz));
    })().catch((err) => setError((err as Error).message));
  }, [c?.id]);
  if (!c) return null;
  return (
    <section className="stack">
      <div>
        <a href={`#/case/${caseId}/capture/${captureId}`} className="small">
          ← Back to capture
        </a>
        <h1 className="truncate" style={{ marginTop: 4 }}>
          Snapshot: {c.title || c.url}
        </h1>
        <div className="mono truncate small">{c.url}</div>
      </div>
      <Banner>
        Offline view rebuilt from the archive, with scripts turned off and links disabled. Nothing is loaded from the internet.
        {snap && ` ${snap.inlined} resources from the archive${snap.missing.length ? `; ${snap.missing.length} not in the archive are left blank` : ''}.`}
      </Banner>
      {error && <Banner kind="error">Could not build the snapshot: {error}</Banner>}
      {snap && <iframe className="snapshot-frame" title="Offline snapshot" sandbox="" srcDoc={snap.html} />}
    </section>
  );
}
