import { useState } from 'react';
import type { CaseInput } from '@/lib/cases';
import { listCases } from '@/lib/db';
import { rpc } from '@/lib/messages';
import type { CaseRecord } from '@/lib/types';
import { ErrorText, Field, LocalTime } from '@/ui/components';
import { useAction, useLive, useLiveState, useSettings } from '@/ui/hooks';
import { go } from './nav';

export function CaseList() {
  const [cases] = useLive(listCases, ['cases']);
  const state = useLiveState();
  const [show, setShow] = useState<'open' | 'closed' | 'archived'>('open');
  if (!cases) return null;
  const shown = cases.filter((c) => c.status === show);
  return (
    <section className="stack">
      <div className="spread">
        <h1>Cases</h1>
        <button className="primary" type="button" onClick={() => go('/new')}>
          New case
        </button>
      </div>
      <div className="tabs" role="tablist">
        {(['open', 'closed', 'archived'] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={show === s} onClick={() => setShow(s)}>
            {s[0]!.toUpperCase() + s.slice(1)} ({cases.filter((c) => c.status === s).length})
          </button>
        ))}
      </div>
      {shown.length === 0 && (
        <div className="card muted">
          {show === 'open' ? 'No open cases. Create one to start recording.' : `No ${show} cases.`}
        </div>
      )}
      <div className="grid-cards">
        {shown.map((c) => (
          <a key={c.id} href={`#/case/${c.id}`} className="card" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="spread">
              <strong className="truncate">{c.name}</strong>
              {state?.activeCaseId === c.id && (
                <span className={`badge ${state.recording ? 'rec' : ''}`}>{state.recording ? 'Recording' : 'Active'}</span>
              )}
            </div>
            {c.reference && <div className="small muted">{c.reference}</div>}
            <div className="small muted" style={{ marginTop: 6 }}>
              Created <LocalTime utc={c.createdAtUtc} withSeconds={false} />
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

export function CaseForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial: Partial<CaseRecord>;
  submitLabel: string;
  onSubmit: (input: CaseInput) => Promise<void>;
}) {
  const [f, setF] = useState({
    name: initial.name ?? '',
    reference: initial.reference ?? '',
    investigator: initial.investigator ?? '',
    organisation: initial.organisation ?? '',
    description: initial.description ?? '',
    scopeMode: initial.scope?.mode ?? 'all',
    domains: (initial.scope?.domains ?? []).join('\n'),
    recordIncognito: initial.recordIncognito ?? false,
    autoCapture: initial.autoCapture ?? true,
  });
  const { busy, error, run } = useAction();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  return (
    <form
      className="card"
      style={{ maxWidth: 640 }}
      onSubmit={(e) => {
        e.preventDefault();
        void run(() =>
          onSubmit({
            name: f.name,
            reference: f.reference,
            investigator: f.investigator,
            organisation: f.organisation,
            description: f.description,
            scope: {
              mode: f.scopeMode as 'all' | 'listed',
              domains: f.domains
                .split(/[\s,]+/)
                .map((d) => d.trim().toLowerCase())
                .filter(Boolean),
            },
            recordIncognito: f.recordIncognito,
            autoCapture: f.autoCapture,
          }),
        );
      }}
    >
      <Field label="Case name (required)">
        <input required value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus />
      </Field>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <Field label="Reference or case number">
            <input value={f.reference} onChange={(e) => set('reference', e.target.value)} />
          </Field>
        </div>
        <div className="grow">
          <Field label="Investigator">
            <input value={f.investigator} onChange={(e) => set('investigator', e.target.value)} />
          </Field>
        </div>
      </div>
      <Field label="Organisation">
        <input value={f.organisation} onChange={(e) => set('organisation', e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea value={f.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
      <Field label="What to record">
        <select value={f.scopeMode} onChange={(e) => set('scopeMode', e.target.value as 'all' | 'listed')}>
          <option value="all">Every site, except the denylist in Settings</option>
          <option value="listed">Only these domains</option>
        </select>
      </Field>
      {f.scopeMode === 'listed' && (
        <Field label="Domains, one per line (subdomains are included)">
          <textarea value={f.domains} onChange={(e) => set('domains', e.target.value)} placeholder="example.com" />
        </Field>
      )}
      <label className="check">
        <input type="checkbox" checked={f.autoCapture} onChange={(e) => set('autoCapture', e.target.checked)} />
        <span>
          Auto-capture each page visited
          <br />
          <span className="small muted">Saves a page archive and a screenshot of every page logged (coming in a later build).</span>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={f.recordIncognito} onChange={(e) => set('recordIncognito', e.target.checked)} />
        <span>
          Also record in incognito windows
          <br />
          <span className="small muted">Only works if you've allowed EviCap in incognito in the browser's extension settings.</span>
        </span>
      </label>
      <ErrorText error={error} />
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>
          {submitLabel}
        </button>
        <button type="button" onClick={() => history.back()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function NewCase() {
  const settings = useSettings();
  const [activate, setActivate] = useState(true);
  if (!settings) return null;
  return (
    <section className="stack">
      <h1>New case</h1>
      <CaseForm
        initial={{ autoCapture: settings.autoCaptureDefault }}
        submitLabel="Create case"
        onSubmit={async (input) => {
          const { id } = await rpc('createCase', input);
          if (activate) await rpc('setActiveCase', id);
          go(`/case/${id}`);
        }}
      />
      <label className="check" style={{ maxWidth: 640 }}>
        <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
        <span>Make it the active case</span>
      </label>
    </section>
  );
}
