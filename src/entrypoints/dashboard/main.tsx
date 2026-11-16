import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getMeta } from '@/lib/db';
import { MIRROR_OFF, type MirrorStatus } from '@/lib/mirror-queue';
import { storageStatus } from '@/lib/opfs';
import { Banner, RecordingIndicator } from '@/ui/components';
import { Logo } from '@/ui/Logo';
import { useLive, useLiveState, useSettings } from '@/ui/hooks';
import '@/ui/styles.css';
import './dashboard.css';
import { CaptureView } from './CaptureView';
import { CaseList, NewCase } from './Cases';
import { CaseView } from './CaseView';
import { Onboarding } from './Onboarding';
import { SnapshotView } from './PageCards';
import { usePlan } from './Plan';
import { SettingsPage } from './Settings';
import { VerifyPage } from './Verify';

function useRoute(): string[] {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}

function GlobalBanners() {
  const settings = useSettings();
  const [mirror] = useLive(async () => (await getMeta<MirrorStatus>('mirrorStatus')) ?? MIRROR_OFF, ['mirror']);
  const [storage] = useLive(storageStatus, ['captures']);
  const plan = usePlan();
  const e = plan?.entitlement;
  return (
    <>
      {storage?.level === 'block' && (
        <Banner kind="error">Storage is 95% full. New captures are blocked until you free up space.</Banner>
      )}
      {storage?.level === 'warn' && <Banner kind="warn">Storage is over 80% full. Export and remove old cases soon.</Banner>}
      {mirror?.state === 'needs-permission' && (
        <Banner kind="warn">
          EviCap needs permission again to write to your disk mirror folder. <a href="#/settings">Reconnect it in Settings</a>.
          New files are queued until then.
        </Banner>
      )}
      {e?.renewalDue && e.source === 'licence' && (
        <Banner kind="warn">
          Your EviCap Pro licence ends on {new Date(e.untilUtc!).toLocaleDateString()}. Contact info@civildigital.co.uk to renew it.
        </Banner>
      )}
      {e?.source === 'trial' && e.trialEndsAtUtc && Date.parse(e.trialEndsAtUtc) - Date.now() < 3 * 86_400_000 && (
        <Banner>
          Your Pro trial ends on {new Date(e.trialEndsAtUtc).toLocaleDateString()}. <a href="#/settings">See plans</a>.
        </Banner>
      )}
      {mirror?.state === 'error' && <Banner kind="error">Disk mirror problem: {mirror.lastError}</Banner>}
      {mirror?.state === 'off' && settings && !settings.mirrorReminderDismissed && (
        <Banner>
          Your evidence is stored only inside this browser. Uninstalling EviCap or clearing browser data deletes it.{' '}
          <a href="#/settings">Set up a disk mirror</a> to keep a copy in a folder on your computer.
        </Banner>
      )}
    </>
  );
}

function PlanBadge() {
  const plan = usePlan();
  if (!plan) return null;
  const pro = plan.entitlement.plan === 'pro';
  return (
    <a href="#/settings" className={`badge ${pro ? 'ok' : ''}`} style={{ textDecoration: 'none' }} title={pro ? 'EviCap Pro' : 'Free plan: see Settings → Plan'}>
      {pro ? (plan.entitlement.source === 'trial' ? 'Pro trial' : 'Pro') : 'Free'}
    </a>
  );
}

function App() {
  const route = useRoute();
  const state = useLiveState();
  const [section, a, b, c, d] = route;

  let page;
  if (section === 'onboarding') page = <Onboarding />;
  else if (section === 'new') page = <NewCase />;
  else if (section === 'settings') page = <SettingsPage />;
  else if (section === 'verify') page = <VerifyPage />;
  else if (section === 'case' && a && b === 'capture' && c && d === 'snapshot') page = <SnapshotView caseId={a} captureId={c} />;
  else if (section === 'case' && a && b === 'capture' && c) page = <CaptureView caseId={a} captureId={c} />;
  else if (section === 'case' && a) page = <CaseView caseId={a} />;
  else page = <CaseList />;

  return (
    <div className="shell">
      <header className="topbar">
        <a href="#/" className="brand" aria-label="EviCap: all cases">
          <Logo size={30} tone="dark" />
        </a>
        <nav className="row">
          <a href="#/" aria-current={!section || section === 'case' || section === 'new' ? 'page' : undefined}>
            Cases
          </a>
          <a href="#/verify" aria-current={section === 'verify' ? 'page' : undefined}>
            Verify
          </a>
          <a href="#/settings" aria-current={section === 'settings' ? 'page' : undefined}>
            Settings
          </a>
        </nav>
        <div className="grow" />
        <PlanBadge />
        {state && <RecordingIndicator active={!!state.activeCaseId} recording={state.recording} />}
      </header>
      <main className="content stack">
        {section !== 'onboarding' && <GlobalBanners />}
        {page}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
