import { useState } from 'react';
import { rpc } from '@/lib/messages';
import { FREE_LIMITS, PRICES } from '@/lib/plan';
import { Banner, ErrorText } from '@/ui/components';
import { useAction, useLive } from '@/ui/hooks';

const dateText = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—';

export function usePlan() {
  return useLive(() => rpc('planStatus'), ['state', 'cases', 'captures'])[0];
}

/** The plan, licence key and trial (SPEC §9). */
export function PlanCard() {
  const status = usePlan();
  const [key, setKey] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  if (!status) return null;
  const e = status.entitlement;
  const u = status.usage;
  const act = (fn: () => Promise<unknown>, msg: string) =>
    run(async () => {
      setDone(null);
      await fn();
      setDone(msg);
    });

  return (
    <div className="card stack" id="plan">
      <div className="spread">
        <h2 style={{ margin: 0 }}>Plan</h2>
        <span className={`badge ${e.plan === 'pro' ? 'ok' : ''}`}>{e.plan === 'pro' ? 'Pro' : 'Free'}</span>
      </div>
      {e.plan === 'pro' && e.source === 'licence' && e.licence && (
        <p style={{ margin: 0 }}>
          Pro through a licence for <strong>{e.licence.email}</strong> ({e.licence.org}), valid until <strong>{dateText(e.licence.expiresAtUtc)}</strong>.
        </p>
      )}
      {e.plan === 'pro' && e.source === 'trial' && (
        <p style={{ margin: 0 }}>
          Pro trial: ends on <strong>{dateText(e.trialEndsAtUtc)}</strong>.
        </p>
      )}
      {e.plan === 'pro' && e.source === 'subscription' && <p style={{ margin: 0 }}>Pro through your subscription.</p>}
      {e.plan === 'free' && (
        <>
          <p style={{ margin: 0 }}>
            Free plan: {u.openCases} of {FREE_LIMITS.openCases} open cases, {u.forensicThisMonth} of {FREE_LIMITS.forensicPerMonth} forensic captures this
            month, up to {FREE_LIMITS.autoCapturesPerCase} automatic captures per case.
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            Hashing, signing, the audit log, export, verification and the disk mirror are included on every plan. Your evidence is never locked.
          </p>
        </>
      )}
      {e.renewalDue && e.source === 'licence' && (
        <Banner kind="warn">Your licence ends on {dateText(e.untilUtc)}. Contact info@civildigital.co.uk to renew it.</Banner>
      )}
      {e.licenceProblem && <Banner kind="warn">{e.licenceProblem}</Banner>}

      {e.plan === 'free' && (
        <div className="plan-grid">
          <div className="plan-option">
            <h3>Pro</h3>
            <p className="price">
              {PRICES.monthly} <span className="muted small">or {PRICES.yearly}</span>
            </p>
            <ul className="small">
              <li>Unlimited open cases, automatic and forensic captures</li>
              <li>Pick several images and videos at once</li>
              <li>Record a tab as video, for streamed or protected video</li>
              <li>Export selected exhibits only</li>
            </ul>
            {e.canStartTrial ? (
              <button type="button" className="primary" disabled={busy} onClick={() => act(() => rpc('startTrial'), 'Your 14-day Pro trial has started.')}>
                Start 14-day free trial
              </button>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                The trial has been used on this computer{e.trialEndsAtUtc ? ` (ended ${dateText(e.trialEndsAtUtc)})` : ''}.
              </p>
            )}
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              The trial runs on this computer and sends nothing. To buy Pro for yourself or your team, email{' '}
              <a href="mailto:info@civildigital.co.uk?subject=EviCap%20Pro">info@civildigital.co.uk</a>. Civil Digital invoices organisations
              and sends each user a licence key.
            </p>
          </div>
        </div>
      )}

      <div className="stack">
        <h3 style={{ margin: 0 }}>Licence key</h3>
        <p className="small muted" style={{ margin: 0 }}>
          Paste the key Civil Digital sent you. It is checked on this computer; nothing is sent anywhere.
        </p>
        <textarea
          rows={3}
          className="mono small"
          placeholder="EVICAP1-…"
          value={key}
          onChange={(ev) => setKey(ev.target.value)}
          aria-label="Licence key"
          spellCheck={false}
        />
        <div className="row">
          <button
            type="button"
            className={e.source === 'licence' ? '' : 'primary'}
            disabled={busy || !key.trim()}
            onClick={() =>
              act(async () => {
                await rpc('activateLicence', key);
                setKey('');
              }, 'Licence activated. EviCap Pro is on.')
            }
          >
            {e.licence ? 'Replace licence' : 'Activate licence'}
          </button>
          {e.licence && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (confirm('Remove the licence key from this computer? Pro features switch off; your evidence is not affected.'))
                  void act(() => rpc('removeLicence'), 'Licence removed.');
              }}
            >
              Remove licence
            </button>
          )}
        </div>
      </div>
      <ErrorText error={error} />
      {done && <p className="small" style={{ color: 'var(--ok)', margin: 0 }}>{done}</p>}
    </div>
  );
}

/** A short "Pro" marker beside a feature the current plan doesn't include. */
export function ProTag() {
  return (
    <a href="#/settings" className="badge" title="Part of EviCap Pro. See Settings → Plan." style={{ textDecoration: 'none' }}>
      Pro
    </a>
  );
}
