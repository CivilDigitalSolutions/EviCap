import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getCase, getMeta, listCaptures, listNotes, listVisits } from '@/lib/db';
import { rpc } from '@/lib/messages';
import { MIRROR_OFF, type MirrorStatus } from '@/lib/mirror-queue';
import { capturePath } from '@/lib/opfs';
import type { CaptureRecord } from '@/lib/types';
import { Banner, CaptureButtons, ErrorText, hostLabel, LocalTime, openDashboard } from '@/ui/components';
import { useAction, useLive, useLiveState, useOpfsUrl, useSettings } from '@/ui/hooks';
import { RecordControls } from '@/ui/RecordControls';
import '@/ui/styles.css';

function Thumb({ c }: { c: CaptureRecord }) {
  const img = c.files.find((f) => f.role === 'primary' && f.mime.startsWith('image/'));
  const url = useOpfsUrl(img ? capturePath(c.caseId, c.id, img.path) : null);
  return url ? <img className="thumb" src={url} alt="" style={{ maxHeight: 90 }} /> : null;
}

function LiveCase({ caseId }: { caseId: string }) {
  const [tab, setTab] = useState<'visits' | 'captures' | 'notes'>('visits');
  const [visits] = useLive(() => listVisits(caseId, 100), ['visits'], [caseId]);
  const [captures] = useLive(() => listCaptures(caseId, 20), ['captures'], [caseId]);
  const [notes] = useLive(() => listNotes(caseId), ['notes'], [caseId]);
  const [c] = useLive(() => getCase(caseId), ['cases'], [caseId]);
  const [draft, setDraft] = useState('');
  const { busy, error, run } = useAction();

  return (
    <section>
      <div className="spread" style={{ marginBottom: 6 }}>
        <h2 className="truncate" style={{ margin: 0 }} title={c?.name}>
          {c?.reference ? `${c.reference} · ` : ''}
          {c?.name}
        </h2>
        <button className="small" type="button" onClick={() => openDashboard(`/case/${caseId}`)}>
          Open
        </button>
      </div>
      <div className="tabs" role="tablist">
        {(['visits', 'captures', 'notes'] as const).map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'visits' ? `Visits (${visits?.length ?? 0}${visits?.length === 100 ? '+' : ''})` : t === 'captures' ? 'Captures' : 'Notes'}
          </button>
        ))}
      </div>

      {tab === 'visits' && (
        <ul className="list" aria-live="polite">
          {visits?.length === 0 && <li className="muted">No visits logged yet. Start recording and browse.</li>}
          {visits?.map((v) => (
            <li key={v.id}>
              <div className="truncate" title={v.finalUrl}>
                <strong>{v.title || hostLabel(v.finalUrl)}</strong>
              </div>
              <div className="truncate small muted" title={v.finalUrl}>
                {hostLabel(v.finalUrl)}
              </div>
              <div className="small muted">
                <LocalTime utc={v.navigatedAtUtc} />
                {v.spa && ' · in-page'}
                {v.redirectChain.length > 0 && ` · ${v.redirectChain.length - 1} redirect(s)`}
              </div>
            </li>
          ))}
        </ul>
      )}

      {tab === 'captures' && (
        <ul className="list">
          {captures?.length === 0 && <li className="muted">No captures yet.</li>}
          {captures?.map((cap) => (
            <li key={cap.id}>
              <button
                type="button"
                className="grow"
                style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, padding: 0, background: 'none' }}
                onClick={() => openDashboard(`/case/${caseId}/capture/${cap.id}`)}
              >
                <Thumb c={cap} />
                <div className="small" style={{ marginTop: 4 }}>
                  <strong>{String(cap.meta.mode ?? cap.type)}</strong> · <LocalTime utc={cap.startedAtUtc} />
                  {cap.status !== 'complete' && <span className="badge warn"> {cap.status}</span>}
                </div>
                <div className="small muted truncate">{cap.title || hostLabel(cap.url)}</div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === 'notes' && (
        <div className="stack">
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await rpc('addNote', caseId, 'case', caseId, draft);
                setDraft('');
              });
            }}
          >
            <textarea
              aria-label="New case note"
              placeholder="Add a note to this case…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button className="primary" type="submit" disabled={busy || !draft.trim()}>
              Add note
            </button>
            <ErrorText error={error} />
          </form>
          <ul className="list">
            {notes
              ?.slice()
              .reverse()
              .map((n) => (
                <li key={n.id}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
                  <div className="small muted">
                    <LocalTime utc={n.updatedAtUtc} /> {n.versions.length > 0 && '· edited'}
                    {n.targetKind !== 'case' && ` · on a ${n.targetKind}`}
                  </div>
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function SidePanel() {
  const state = useLiveState();
  const settings = useSettings();
  const [mirror] = useLive(async () => (await getMeta<MirrorStatus>('mirrorStatus')) ?? MIRROR_OFF, ['mirror']);
  return (
    <main className="stack" style={{ padding: 12 }}>
      <div className="spread">
        <h1 style={{ margin: 0 }}>EviCap</h1>
        <button className="small" type="button" onClick={() => openDashboard()}>
          Dashboard
        </button>
      </div>
      {mirror?.state === 'needs-permission' && (
        <Banner kind="warn">
          EviCap can't write to your disk mirror folder. <a href="#" onClick={() => openDashboard('/settings')}>Reconnect it</a>.
        </Banner>
      )}
      {mirror?.state === 'off' && settings && !settings.mirrorReminderDismissed && (
        <Banner>
          Evidence is only stored in this browser. <a href="#" onClick={() => openDashboard('/settings')}>Set up a disk mirror</a>{' '}
          to keep a copy in a folder on your computer.
        </Banner>
      )}
      <RecordControls />
      {state?.activeCaseId && (
        <>
          <CaptureButtons disabled={false} />
          <LiveCase caseId={state.activeCaseId} />
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<SidePanel />);
