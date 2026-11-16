import { useState } from 'react';
import { listCases } from '@/lib/db';
import { rpc } from '@/lib/messages';
import { CaseSelect, ErrorText, openDashboard, RecordingIndicator } from './components';
import { useLive, useLiveState } from './hooks';

/** Case switcher and Record/Pause, shared by the popup and side panel (F1). */
export function RecordControls() {
  const state = useLiveState();
  const [cases] = useLive(listCases, ['cases']);
  const [error, setError] = useState<string | null>(null);
  if (!state || !cases) return null;

  const openCases = cases.filter((c) => c.status === 'open');
  if (openCases.length === 0) {
    return (
      <div className="stack">
        <p className="muted">Create a case to start recording and capturing.</p>
        <button className="primary" type="button" onClick={() => openDashboard('/new')}>
          New case
        </button>
      </div>
    );
  }

  const active = !!state.activeCaseId;
  return (
    <div className="stack">
      <div className="spread">
        <RecordingIndicator active={active} recording={state.recording} />
        <button className="small" type="button" onClick={() => openDashboard('/new')}>
          New case
        </button>
      </div>
      <CaseSelect cases={cases} activeCaseId={state.activeCaseId} onError={setError} />
      {active && (
        <button
          type="button"
          className={state.recording ? '' : 'rec'}
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={() => rpc('setRecording', !state.recording).catch((e) => setError(e.message))}
        >
          {state.recording ? 'Pause recording' : '● Start recording'}
        </button>
      )}
      <ErrorText error={error} />
    </div>
  );
}
