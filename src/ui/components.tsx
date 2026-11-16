import { useState, type ReactNode } from 'react';
import { rpc } from '@/lib/messages';
import type { ScreenshotMode } from '@/lib/screenshots';
import type { CaseRecord } from '@/lib/types';
import { useAction } from './hooks';

export function LocalTime({ utc, withSeconds = true }: { utc: string | null | undefined; withSeconds?: boolean }) {
  if (!utc) return <span className="muted">—</span>;
  const d = new Date(utc);
  const text = d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
  });
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return (
    <time dateTime={utc} title={`${utc} (UTC)`}>
      {text} <span className="muted small">UTC{sign}{hh}:{mm}</span>
    </time>
  );
}

export function Hash({ value, short = false }: { value: string | null | undefined; short?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">—</span>;
  const hex = value.replace(/^sha256:/, '');
  return (
    <span className="mono" title={value}>
      {short ? `${hex.slice(0, 12)}…${hex.slice(-6)}` : value}{' '}
      <button
        className="small"
        type="button"
        aria-label="Copy hash"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

export function Banner({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return (
    <div className={`banner ${kind === 'info' ? '' : kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <Banner kind="error">{error}</Banner> : null;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function RecordingIndicator({ active, recording }: { active: boolean; recording: boolean }) {
  if (!active) return <span className="badge">No active case</span>;
  return recording ? (
    <span className="row small" style={{ gap: 6 }}>
      <span className="dot rec" aria-hidden /> <strong>Recording</strong>
    </span>
  ) : (
    <span className="row small" style={{ gap: 6 }}>
      <span className="dot" aria-hidden /> Paused
    </span>
  );
}

export function CaseSelect({
  cases,
  activeCaseId,
  onError,
}: {
  cases: CaseRecord[];
  activeCaseId: string | null;
  onError?: (msg: string) => void;
}) {
  const open = cases.filter((c) => c.status === 'open');
  return (
    <select
      aria-label="Active case"
      value={activeCaseId ?? ''}
      onChange={(e) => rpc('setActiveCase', e.target.value || null).catch((err) => onError?.(err.message))}
    >
      <option value="">— No active case —</option>
      {open.map((c) => (
        <option key={c.id} value={c.id}>
          {c.reference ? `${c.reference} · ` : ''}
          {c.name}
        </option>
      ))}
    </select>
  );
}

const MODES: { mode: ScreenshotMode; label: string; key?: string }[] = [
  { mode: 'visible', label: 'Visible area', key: 'Alt+Shift+S' },
  { mode: 'full', label: 'Full page', key: 'Alt+Shift+F' },
  { mode: 'region', label: 'Region', key: 'Alt+Shift+R' },
  { mode: 'element', label: 'Element' },
];

export function CaptureButtons({
  disabled,
  onBeforeInteractive,
}: {
  disabled: boolean;
  /** Called before region/element capture, e.g. to close the popup so the page can be used. */
  onBeforeInteractive?: () => void;
}) {
  const { busy, error, run } = useAction();
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="stack">
      <div className="capture-buttons">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            disabled={disabled || busy}
            title={m.key ? `Shortcut: ${m.key}` : undefined}
            onClick={() =>
              run(async () => {
                setDone(null);
                const interactive = m.mode === 'region' || m.mode === 'element';
                const p = rpc('screenshot', m.mode);
                if (interactive) onBeforeInteractive?.();
                const r = await p;
                if (r) setDone(`${m.label} captured and hashed.`);
              })
            }
          >
            {m.label}
          </button>
        ))}
      </div>
      {busy && <p className="muted small">Capturing…</p>}
      {done && !busy && <p className="small" style={{ color: 'var(--ok)' }}>{done}</p>}
      <ErrorText error={error} />
    </div>
  );
}

export function openDashboard(hash = '') {
  const url = chrome.runtime.getURL(`/dashboard.html${hash ? '#' + hash : ''}`);
  void chrome.tabs.create({ url });
}

export function Tags({ tags, onAdd, onRemove }: { tags: string[]; onAdd: (t: string) => void; onRemove: (t: string) => void }) {
  const [draft, setDraft] = useState('');
  return (
    <div className="row" style={{ gap: 4 }}>
      {tags.map((t) => (
        <span className="tag" key={t}>
          {t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onRemove(t)}>
            ×
          </button>
        </span>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) onAdd(draft);
          setDraft('');
        }}
      >
        <input
          aria-label="Add tag"
          placeholder="+ tag"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ width: 90, padding: '2px 6px', fontSize: 12 }}
        />
      </form>
    </div>
  );
}

export function hostLabel(url: string) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
}
