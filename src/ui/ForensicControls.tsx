import { useState } from 'react';
import { rpc } from '@/lib/messages';
import { ErrorText } from './components';
import { useAction } from './hooks';

/** Forensic page capture (SPEC F4) buttons for the popup and side panel. */
export function ForensicControls({ onDone }: { onDone?: (captureId: string) => void }) {
  const { busy, error, run } = useAction();
  const [done, setDone] = useState(false);
  const go = (reload: boolean) =>
    run(async () => {
      setDone(false);
      const r = await rpc('forensicCapture', reload);
      setDone(true);
      onDone?.(r.captureId);
    });
  return (
    <div className="stack">
      <div className="capture-buttons">
        <button type="button" className="primary" disabled={busy} onClick={() => go(false)} title="Everything about the page as it is now, packaged as WACZ">
          Forensic capture
        </button>
        <button type="button" disabled={busy} onClick={() => go(true)} title="Reload the page with network recording on, so every request is captured from the start">
          Reload &amp; capture
        </button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        The browser shows a “debugging” bar while a forensic capture runs.
      </p>
      {busy && <p className="muted small">Capturing the page, its network traffic and certificates…</p>}
      {done && !busy && <p className="small" style={{ color: 'var(--ok)' }}>Forensic capture saved, hashed and signed.</p>}
      <ErrorText error={error} />
    </div>
  );
}
