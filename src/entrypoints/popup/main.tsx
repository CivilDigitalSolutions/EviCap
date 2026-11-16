import { createRoot } from 'react-dom/client';
import { CaptureButtons, openDashboard } from '@/ui/components';
import { useLiveState } from '@/ui/hooks';
import { ForensicControls } from '@/ui/ForensicControls';
import { MediaControls } from '@/ui/MediaControls';
import { Logo } from '@/ui/Logo';
import { RecordControls } from '@/ui/RecordControls';
import '@/ui/styles.css';

function Popup() {
  const state = useLiveState();
  return (
    <main className="stack" style={{ padding: 14 }}>
      <div className="spread">
        <h1 style={{ margin: 0 }}>
          <Logo size={26} />
        </h1>
        <button className="small" type="button" onClick={() => openDashboard()}>
          Dashboard
        </button>
      </div>
      <RecordControls />
      {state?.activeCaseId && (
        <section className="stack">
          <h3 style={{ margin: 0 }}>Page</h3>
          <ForensicControls />
          <h3 style={{ margin: 0 }}>Screenshot</h3>
          <CaptureButtons disabled={!state.activeCaseId} onBeforeInteractive={() => window.close()} />
          <h3 style={{ margin: 0 }}>Images and video</h3>
          <MediaControls onBeforeInteractive={() => window.close()} />
        </section>
      )}
      <button
        type="button"
        style={{ width: '100%', justifyContent: 'center' }}
        onClick={async () => {
          const win = await chrome.windows.getCurrent();
          await chrome.sidePanel.open({ windowId: win.id! });
          window.close();
        }}
      >
        Open side panel
      </button>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Popup />);
