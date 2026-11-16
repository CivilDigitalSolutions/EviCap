import { useEffect, useState } from 'react';
import { getCapture, getDb } from '@/lib/db';
import { sha256Blob, sha256Json } from '@/lib/hash';
import { canonicalize } from '@/lib/jcs';
import { importPublicJwk, verifyJson } from '@/lib/keys';
import { rpc } from '@/lib/messages';
import { capturePath, readFile } from '@/lib/opfs';
import type { CaptureRecord } from '@/lib/types';
import { formatBytes } from '@/lib/util';
import { Banner, captureLabel, Hash, LocalTime, Tags } from '@/ui/components';
import { useLive, useOpfsUrl } from '@/ui/hooks';
import { NoteList } from './CaseView';
import { ExifCard, MediaPreview, RelatedCard, SourceCard } from './MediaCards';

interface Integrity {
  files: Record<string, 'ok' | 'mismatch' | 'missing'>;
  manifest: 'ok' | 'mismatch' | 'missing';
  signature: 'ok' | 'invalid' | 'missing';
}

/** Re-hash on view (SPEC §7.1): recompute every file hash and check the signed manifest. */
async function checkIntegrity(c: CaptureRecord): Promise<Integrity> {
  const files: Integrity['files'] = {};
  for (const f of c.files) {
    try {
      const h = await sha256Blob(await readFile(capturePath(c.caseId, c.id, f.path)));
      files[f.path] = h === f.sha256 ? 'ok' : 'mismatch';
    } catch {
      files[f.path] = 'missing';
    }
  }
  let manifest: Integrity['manifest'] = 'missing';
  let signature: Integrity['signature'] = 'missing';
  try {
    const parsed = JSON.parse(await (await readFile(capturePath(c.caseId, c.id, 'manifest.json'))).text());
    const fileMatch = canonicalize(parsed.files) === canonicalize(c.files);
    manifest = (await sha256Json(parsed)) === c.captureHash && fileMatch ? 'ok' : 'mismatch';
    const sig = await (await readFile(capturePath(c.caseId, c.id, 'manifest.sig'))).text();
    const key = await (await getDb()).get('keys', 'install');
    if (key) signature = (await verifyJson(await importPublicJwk(key.publicJwk), parsed, sig.trim())) ? 'ok' : 'invalid';
  } catch {
    /* leave as missing */
  }
  return { files, manifest, signature };
}

export function CaptureView({ caseId, captureId }: { caseId: string; captureId: string }) {
  const [c] = useLive(() => getCapture(captureId), ['captures'], [captureId]);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const primary = c?.files.find((f) => f.role === 'primary');
  const url = useOpfsUrl(c && primary ? capturePath(c.caseId, c.id, primary.path) : null);

  useEffect(() => {
    if (c?.status === 'complete') void checkIntegrity(c).then(setIntegrity);
  }, [c?.id, c?.status]);

  if (c === undefined) return null;
  if (!c) return <Banner kind="warn">This capture no longer exists.</Banner>;

  const allOk =
    integrity &&
    Object.values(integrity.files).every((v) => v === 'ok') &&
    integrity.manifest === 'ok' &&
    integrity.signature === 'ok';
  const meta = c.meta as Record<string, unknown>;

  return (
    <section className="stack">
      <div className="spread">
        <div className="grow">
          <a href={`#/case/${caseId}`} className="small">
            ← Back to case
          </a>
          <h1 className="truncate" style={{ marginTop: 4 }}>
            {c.title || c.url}
          </h1>
          <div className="mono truncate">{c.url}</div>
        </div>
      </div>
      {c.status !== 'complete' && (
        <Banner kind="warn">This capture is {c.status}. It was interrupted before every step finished.</Banner>
      )}
      {c.degraded.length > 0 && (
        <Banner kind="warn">
          Captured with limitations:
          <ul style={{ margin: '4px 0 0' }}>
            {c.degraded.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </Banner>
      )}
      {integrity &&
        (allOk ? (
          <Banner kind="ok">Verified: every file matches its SHA-256 hash, and the signed manifest is intact.</Banner>
        ) : (
          <Banner kind="error">Integrity check failed. See the file list below.</Banner>
        ))}
      <div className="two-col">
        <div className="card">
          <MediaPreview c={c} primary={primary} url={url} />
        </div>
        <div className="stack">
          <div className="card">
            <h2>Details</h2>
            <dl className="kv">
              <dt>Type</dt>
              <dd>{captureLabel(c)}</dd>
              <dt>Method</dt>
              <dd className="mono">{c.method}</dd>
              <dt>Started</dt>
              <dd>
                <LocalTime utc={c.startedAtUtc} />
              </dd>
              <dt>Completed</dt>
              <dd>
                <LocalTime utc={c.completedAtUtc} />
              </dd>
              <dt>Time source</dt>
              <dd>This computer's clock</dd>
              {meta.viewport != null && (
                <>
                  <dt>Viewport</dt>
                  <dd>
                    {(meta.viewport as { width: number }).width} × {(meta.viewport as { height: number }).height} CSS px at{' '}
                    {String(meta.devicePixelRatio)}×
                  </dd>
                </>
              )}
              <dt>Capture hash</dt>
              <dd>
                <Hash value={c.captureHash} short />
              </dd>
              <dt>Signed manifest</dt>
              <dd>{integrity ? (integrity.signature === 'ok' ? '✓ valid signature' : `✗ ${integrity.signature}`) : 'checking…'}</dd>
              <dt>Audit event</dt>
              <dd>
                <Hash value={c.auditEventHash} short />
              </dd>
            </dl>
          </div>
          <RelatedCard c={c} />
          <SourceCard c={c} />
          <ExifCard c={c} primary={primary} />
          <div className="card">
            <h2>Tags</h2>
            <Tags
              tags={c.tags}
              onAdd={(t) => void rpc('setTag', caseId, 'capture', c.id, t, true)}
              onRemove={(t) => void rpc('setTag', caseId, 'capture', c.id, t, false)}
            />
          </div>
        </div>
      </div>
      <div className="card table-wrap">
        <h2>Files</h2>
        <table className="data">
          <thead>
            <tr>
              <th>File</th>
              <th>Role</th>
              <th>Size</th>
              <th>SHA-256</th>
              <th>Check</th>
            </tr>
          </thead>
          <tbody>
            {c.files.map((f) => (
              <tr key={f.path}>
                <td className="mono">{f.path}</td>
                <td>{f.role}</td>
                <td>{formatBytes(f.bytes)}</td>
                <td>
                  <Hash value={f.sha256} />
                </td>
                <td>{integrity ? (integrity.files[f.path] === 'ok' ? '✓' : `✗ ${integrity.files[f.path]}`) : '…'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Notes on this capture</h2>
        <NoteList caseId={caseId} targetKind="capture" targetId={c.id} />
      </div>
      <details className="card">
        <summary>All capture metadata</summary>
        <pre className="mono small" style={{ whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(c.meta, null, 2)}
        </pre>
      </details>
    </section>
  );
}
