import { useEffect } from 'react';
import { rpc } from '@/lib/messages';
import { FREE_LIMITS, PRICES } from '@/lib/plan';
import { MirrorPanel } from './Mirror';
import { go } from './nav';

/** First-run tab (SPEC F13). */
export function Onboarding() {
  useEffect(() => {
    void navigator.storage.persist?.();
  }, []);

  const finish = async (path: string) => {
    await rpc('saveSettings', { onboardingDone: true });
    go(path);
  };

  return (
    <section className="stack" style={{ maxWidth: 720 }}>
      <h1>Welcome to EviCap</h1>
      <p className="muted">A few things to know before you start.</p>

      <div className="card step">
        <div className="step-num">1</div>
        <div>
          <h2>Your evidence stays on this computer</h2>
          <p>
            Cases, browsing logs and captures are stored only in this browser on this device. Nothing leaves it, except a hash
            if you later turn on trusted timestamping. Civil Digital can't see or recover your data.
          </p>
          <p>
            <strong>Uninstalling EviCap or clearing browser data deletes everything stored in the browser</strong>, unless you've
            exported it or set up the disk mirror below.
          </p>
        </div>
      </div>

      <div className="card step">
        <div className="step-num">2</div>
        <div>
          <h2>How evidence is protected</h2>
          <p>
            Every file gets a SHA-256 hash the moment it's captured. Each capture is signed with a key created on this computer,
            and every action goes into a hash-chained audit log, so any later change is detectable.
          </p>
          <p className="muted small">
            Times come from this computer's clock. Some full-page captures briefly use the browser's debugger, so Chrome shows
            "EviCap started debugging this browser" while it runs. That's expected.
          </p>
        </div>
      </div>

      <div className="card step">
        <div className="step-num">3</div>
        <div className="grow stack">
          <h2>Optional: keep a copy in a folder</h2>
          <MirrorPanel compact />
          <p className="small muted">You can do this later in Settings.</p>
        </div>
      </div>

      <div className="card step">
        <div className="step-num">4</div>
        <div>
          <h2>Free and Pro</h2>
          <p>
            The free plan covers {FREE_LIMITS.openCases} open cases at a time, {FREE_LIMITS.forensicPerMonth} forensic captures a month and
            single image capture. Pro ({PRICES.monthly} or {PRICES.yearly}) adds the media picker, tab recording and exhibit-only
            export, with no limits. Hashing, signing, export and verification are on every plan, and your evidence is never locked.
          </p>
          <p className="small muted">
            Try Pro free for 14 days from Settings → Plan. The trial runs on this computer and asks for nothing.
          </p>
        </div>
      </div>

      <div className="card step">
        <div className="step-num">5</div>
        <div>
          <h2>Start a case</h2>
          <p>
            Create a case, make it active and press <strong>Start recording</strong>. Every page you visit is logged. Capture
            screenshots from the toolbar button, the side panel or the keyboard shortcuts.
          </p>
          <p className="small">
            Read the full <a href="https://github.com/CivilDigitalSolutions/EviCap/blob/main/PRIVACY.md" target="_blank" rel="noreferrer">privacy policy</a>.
          </p>
          <div className="row">
            <button className="primary" type="button" onClick={() => void finish('/new')}>
              Create my first case
            </button>
            <button type="button" onClick={() => void finish('/')}>
              Skip for now
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
