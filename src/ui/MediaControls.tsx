import { useState } from 'react';
import type { Job } from '@/lib/jobs';
import type { MediaResult } from '@/lib/media';
import { rpc } from '@/lib/messages';
import type { TabRecordingState } from '@/lib/tab-recording';
import { formatBytes } from '@/lib/util';
import { Banner, ErrorText } from './components';
import { useAction, useSessionValue, useTicker } from './hooks';

function elapsed(fromUtc: string) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(fromUtc)) / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function summarise(r: MediaResult): { kind: 'ok' | 'warn' | 'error'; text: string } {
  const parts: string[] = [];
  if (r.captured.length) parts.push(`${r.captured.length} item${r.captured.length > 1 ? 's' : ''} captured and hashed.`);
  for (const n of r.needsTabRecording) parts.push(n.reason);
  for (const f of r.failed) parts.push(`Not captured: ${f.error}`);
  return { kind: r.failed.length ? 'error' : r.needsTabRecording.length ? 'warn' : 'ok', text: parts.join(' ') };
}

/** Media picker and tab recording (SPEC F6, F7), for the popup and side panel. */
export function MediaControls({ onBeforeInteractive }: { onBeforeInteractive?: () => void }) {
  const rec = useSessionValue<TabRecordingState | null>('tabRecording');
  useTicker(!!rec);
  const { busy, error, run } = useAction();
  const [result, setResult] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  return (
    <div className="stack">
      <div className="capture-buttons">
        <button
          type="button"
          disabled={busy}
          title="Shortcut: Alt+Shift+M"
          onClick={() =>
            run(async () => {
              setResult(null);
              const p = rpc('pickMedia');
              onBeforeInteractive?.();
              const r = await p;
              if (r) setResult(summarise(r));
            })
          }
        >
          Pick images &amp; videos
        </button>
        {rec ? (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => run(() => rpc('stopTabRecording'))}
            aria-label={`Stop recording the tab, ${elapsed(rec.startedAtUtc)} recorded`}
          >
            <span className="dot rec" aria-hidden /> Stop recording · {elapsed(rec.startedAtUtc)}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            title="Records the current tab as video, with its sound"
            onClick={() =>
              run(async () => {
                setResult(null);
                const r = await rpc('startTabRecording');
                if (r.drm) {
                  setResult({ kind: 'warn', text: 'This page plays DRM-protected media. The recording may show black frames.' });
                }
              })
            }
          >
            Record this tab
          </button>
        )}
      </div>
      {rec && (
        <p className="small muted" style={{ margin: 0 }}>
          Recording <span className="mono">{rec.url}</span>. Every address the tab shows is logged
          {rec.urls.length > 1 ? ` (${rec.urls.length} so far)` : ''}.
        </p>
      )}
      {result && <Banner kind={result.kind}>{result.text}</Banner>}
      <ErrorText error={error} />
      <JobList />
    </div>
  );
}

/** Downloads in progress (direct video files, F7-A). */
export function JobList() {
  const jobs = useSessionValue<Job[]>('jobs');
  if (!jobs?.length) return null;
  return (
    <ul className="list" aria-label="Downloads" aria-live="polite">
      {jobs.map((j) => (
        <li key={j.id}>
          <div className="spread">
            <span className="truncate small">
              <strong>{j.label}</strong>
            </span>
            {j.status !== 'running' && (
              <button className="small" type="button" onClick={() => void rpc('dismissJob', j.id)} aria-label="Dismiss">
                ×
              </button>
            )}
          </div>
          {j.status === 'running' && (
            <progress
              max={j.total ?? undefined}
              value={j.total ? j.bytes : undefined}
              style={{ width: '100%' }}
              aria-label={`Downloading ${j.label}`}
            />
          )}
          <div className="small muted">
            {j.status === 'running' && `${formatBytes(j.bytes)}${j.total ? ` of ${formatBytes(j.total)}` : ''}`}
            {j.status === 'done' && <span style={{ color: 'var(--ok)' }}>Saved and hashed ({formatBytes(j.bytes)})</span>}
            {j.status === 'failed' && <span style={{ color: 'var(--danger)' }}>Failed</span>}
            {j.message && ` · ${j.message}`}
          </div>
        </li>
      ))}
    </ul>
  );
}
