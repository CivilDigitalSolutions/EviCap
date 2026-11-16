import { useMemo, useState } from 'react';
import { verifyChain, type ChainCheck } from '@/lib/audit';
import { getCase, listAudit, listCaptures, listNotes, listVisits } from '@/lib/db';
import { rpc } from '@/lib/messages';
import { capturePath } from '@/lib/opfs';
import type { CaptureRecord, CaseRecord, VisitRecord } from '@/lib/types';
import { Banner, captureLabel, ErrorText, groupChildren, Hash, hostLabel, LocalTime, Tags } from '@/ui/components';
import { useAction, useLive, useLiveState, useOpfsUrl } from '@/ui/hooks';
import { CaseForm } from './Cases';
import { ExportPanel } from './ExportPanel';
import { go } from './nav';

type Tab = 'timeline' | 'visits' | 'captures' | 'notes' | 'audit' | 'export';

export function CaseView({ caseId }: { caseId: string }) {
  const [c] = useLive(() => getCase(caseId), ['cases', 'visits', 'captures', 'notes'], [caseId]);
  const [tab, setTab] = useState<Tab>('timeline');
  const [editing, setEditing] = useState(false);
  if (c === undefined) return null;
  if (!c) return <Banner kind="warn">This case no longer exists.</Banner>;

  if (editing) {
    return (
      <section className="stack">
        <h1>Edit case</h1>
        <CaseForm
          initial={c}
          submitLabel="Save changes"
          onSubmit={async (input) => {
            await rpc('updateCase', c.id, input);
            setEditing(false);
          }}
        />
      </section>
    );
  }

  return (
    <section className="stack">
      <CaseHeader c={c} onEdit={() => setEditing(true)} />
      <div className="tabs" role="tablist">
        {(
          [
            ['timeline', 'Timeline'],
            ['visits', 'Visits'],
            ['captures', 'Captures'],
            ['notes', 'Notes'],
            ['audit', 'Audit log'],
            ['export', 'Export & verify'],
          ] as const
        ).map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'timeline' && <Timeline caseId={c.id} />}
      {tab === 'visits' && <Visits caseId={c.id} />}
      {tab === 'captures' && <Captures caseId={c.id} />}
      {tab === 'notes' && <Notes caseId={c.id} />}
      {tab === 'audit' && <Audit caseId={c.id} />}
      {tab === 'export' && <ExportPanel c={c} />}
    </section>
  );
}

function CaseHeader({ c, onEdit }: { c: CaseRecord; onEdit: () => void }) {
  const state = useLiveState();
  const { busy, error, run } = useAction();
  const active = state?.activeCaseId === c.id;
  return (
    <div className="card stack">
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <h1 style={{ marginBottom: 2 }}>{c.name}</h1>
          <div className="muted small">
            {[c.reference, c.investigator, c.organisation].filter(Boolean).join(' · ') || 'No reference'}
          </div>
        </div>
        <div className="row">
          {c.status === 'open' && !active && (
            <button className="primary" type="button" disabled={busy} onClick={() => run(() => rpc('setActiveCase', c.id))}>
              Make active
            </button>
          )}
          {active && (
            <button
              type="button"
              className={state?.recording ? '' : 'rec'}
              disabled={busy}
              onClick={() => run(() => rpc('setRecording', !state?.recording))}
            >
              {state?.recording ? 'Pause recording' : '● Start recording'}
            </button>
          )}
          <button type="button" onClick={onEdit}>
            Edit
          </button>
          {c.status === 'open' ? (
            <button type="button" disabled={busy} onClick={() => run(() => rpc('setCaseStatus', c.id, 'closed'))}>
              Close case
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => run(() => rpc('setCaseStatus', c.id, 'open'))}>
              Reopen
            </button>
          )}
          {c.status === 'closed' && (
            <button type="button" disabled={busy} onClick={() => run(() => rpc('setCaseStatus', c.id, 'archived'))}>
              Archive
            </button>
          )}
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              const typed = prompt(
                `Delete "${c.name}" and all its evidence from this browser? This can't be undone. Files in your disk mirror folder are not deleted.\n\nType DELETE to confirm.`,
              );
              if (typed === 'DELETE') void run(async () => {
                await rpc('deleteCase', c.id);
                go('/');
              });
            }}
          >
            Delete
          </button>
        </div>
      </div>
      {c.description && <p style={{ whiteSpace: 'pre-wrap' }}>{c.description}</p>}
      <dl className="kv">
        <dt>Status</dt>
        <dd>
          {c.status}
          {c.closedAtUtc && (
            <>
              {' '}
              (closed <LocalTime utc={c.closedAtUtc} />)
            </>
          )}
        </dd>
        <dt>Created</dt>
        <dd>
          <LocalTime utc={c.createdAtUtc} />
        </dd>
        <dt>Recording scope</dt>
        <dd>{c.scope.mode === 'all' ? 'All sites except the denylist' : `Only: ${c.scope.domains.join(', ') || '(none)'}`}</dd>
        <dt>Audit chain head</dt>
        <dd>
          <Hash value={c.chainHead} short /> <span className="muted small">({c.nextSeq} events)</span>
        </dd>
      </dl>
      <ErrorText error={error} />
    </div>
  );
}

function Timeline({ caseId }: { caseId: string }) {
  const [visits] = useLive(() => listVisits(caseId), ['visits'], [caseId]);
  const [captures] = useLive(() => listCaptures(caseId), ['captures'], [caseId]);
  const items = useMemo(() => {
    const all: { at: string; kind: 'visit' | 'capture'; v?: VisitRecord; c?: CaptureRecord }[] = [
      ...(visits ?? []).map((v) => ({ at: v.navigatedAtUtc, kind: 'visit' as const, v })),
      ...(captures ?? []).map((c) => ({ at: c.startedAtUtc, kind: 'capture' as const, c })),
    ];
    return all.sort((a, b) => b.at.localeCompare(a.at));
  }, [visits, captures]);
  if (!visits || !captures) return null;
  if (items.length === 0) return <div className="card muted">Nothing recorded yet.</div>;
  return (
    <div className="card">
      {items.map((it) =>
        it.kind === 'visit' ? (
          <div className="timeline-item" key={'v' + it.v!.id}>
            <LocalTime utc={it.at} />
            <span className="badge">visit</span>
            <span className="truncate" title={it.v!.finalUrl}>
              {it.v!.title || hostLabel(it.v!.finalUrl)} <span className="muted small">{hostLabel(it.v!.finalUrl)}</span>
            </span>
          </div>
        ) : (
          <div className="timeline-item" key={'c' + it.c!.id}>
            <LocalTime utc={it.at} />
            <span className="badge ok">{captureLabel(it.c!)}</span>
            <a className="truncate" href={`#/case/${caseId}/capture/${it.c!.id}`}>
              {it.c!.title || hostLabel(it.c!.url)}
            </a>
          </div>
        ),
      )}
    </div>
  );
}

function Visits({ caseId }: { caseId: string }) {
  const [visits] = useLive(() => listVisits(caseId), ['visits'], [caseId]);
  const [filter, setFilter] = useState('');
  if (!visits) return null;
  const f = filter.trim().toLowerCase();
  const shown = f
    ? visits.filter((v) => v.finalUrl.toLowerCase().includes(f) || v.title.toLowerCase().includes(f) || v.tags.includes(f))
    : visits;
  return (
    <div className="stack">
      <input placeholder="Filter by address, title or tag" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Visited</th>
              <th>Page</th>
              <th>How</th>
              <th>In focus</th>
              <th>Capture</th>
              <th>Tags</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((v) => (
              <tr key={v.id}>
                <td className="muted">{v.seq + 1}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <LocalTime utc={v.navigatedAtUtc} />
                </td>
                <td style={{ maxWidth: 420 }}>
                  <div className="truncate">
                    <strong>{v.title || '(no title)'}</strong>
                  </div>
                  <div className="mono truncate" title={v.finalUrl}>
                    {v.finalUrl}
                  </div>
                  {v.redirectChain.length > 1 && (
                    <details className="small">
                      <summary>{v.redirectChain.length - 1} redirect(s)</summary>
                      <ol className="mono">
                        {v.redirectChain.map((u, i) => (
                          <li key={i}>{u}</li>
                        ))}
                      </ol>
                    </details>
                  )}
                </td>
                <td className="small">
                  {v.transitionType}
                  {v.spa && ' (in-page)'}
                  {v.incognito && ' · incognito'}
                </td>
                <td className="small">{v.leftAtUtc ? `${Math.round(v.focusedMs / 1000)} s` : 'open'}</td>
                <td className="small">
                  {v.autoCaptureId ? <a href={`#/case/${caseId}/capture/${v.autoCaptureId}`}>View</a> : <span className="muted">—</span>}
                </td>
                <td>
                  <Tags
                    tags={v.tags}
                    onAdd={(t) => void rpc('setTag', caseId, 'visit', v.id, t, true)}
                    onRemove={(t) => void rpc('setTag', caseId, 'visit', v.id, t, false)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="muted">No visits{f ? ' match' : ' yet'}.</p>}
      </div>
    </div>
  );
}

function CaptureCard({ c, children = 0 }: { c: CaptureRecord; children?: number }) {
  const img =
    c.files.find((f) => f.role === 'primary' && f.mime.startsWith('image/')) ?? c.files.find((f) => f.role === 'poster');
  const url = useOpfsUrl(img ? capturePath(c.caseId, c.id, img.path) : null);
  return (
    <a href={`#/case/${c.caseId}/capture/${c.id}`} className="card" style={{ color: 'inherit', textDecoration: 'none', padding: 10 }}>
      {url ? (
        <img className="thumb" src={url} alt="" />
      ) : (
        <div className="thumb placeholder" style={{ height: 120 }}>
          {c.type === 'video' ? '▶ video' : ''}
        </div>
      )}
      <div className="small" style={{ marginTop: 6 }}>
        <strong>{captureLabel(c)}</strong> · <LocalTime utc={c.startedAtUtc} />
        {children > 0 && <span className="muted"> · +{children} related</span>}
      </div>
      <div className="small muted truncate">{c.title || hostLabel(c.url)}</div>
      {c.status !== 'complete' && <span className="badge warn">{c.status}</span>}
      {c.degraded.length > 0 && <span className="badge warn">degraded</span>}
    </a>
  );
}

function Captures({ caseId }: { caseId: string }) {
  const [captures] = useLive(() => listCaptures(caseId), ['captures'], [caseId]);
  if (!captures) return null;
  if (captures.length === 0) return <div className="card muted">No captures yet. Use the toolbar button, a keyboard shortcut or right-click an image or video.</div>;
  return (
    <div className="grid-cards">
      {groupChildren(captures).map(({ c, children }) => (
        <CaptureCard key={c.id} c={c} children={children} />
      ))}
    </div>
  );
}

export function NoteList({ caseId, targetKind, targetId }: { caseId: string; targetKind?: 'case' | 'visit' | 'capture'; targetId?: string }) {
  const [notes] = useLive(() => listNotes(caseId), ['notes'], [caseId]);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const { busy, error, run } = useAction();
  const shown = (notes ?? []).filter((n) => !targetId || (n.targetKind === targetKind && n.targetId === targetId));
  return (
    <div className="stack">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await rpc('addNote', caseId, targetKind ?? 'case', targetId ?? caseId, draft);
            setDraft('');
          });
        }}
      >
        <textarea aria-label="New note" placeholder="Add a note…" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div>
          <button className="primary" type="submit" disabled={busy || !draft.trim()}>
            Add note
          </button>
        </div>
      </form>
      <ErrorText error={error} />
      <ul className="list">
        {shown
          .slice()
          .reverse()
          .map((n) => (
            <li key={n.id}>
              {editing?.id === n.id ? (
                <form
                  className="stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await rpc('editNote', n.id, editing.text);
                      setEditing(null);
                    });
                  }}
                >
                  <textarea value={editing.text} onChange={(e) => setEditing({ id: n.id, text: e.target.value })} />
                  <div className="row">
                    <button className="primary small" type="submit">
                      Save
                    </button>
                    <button className="small" type="button" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
                  <div className="row small muted">
                    <LocalTime utc={n.updatedAtUtc} />
                    {!targetId && n.targetKind !== 'case' && (
                      <span>
                        · on a{' '}
                        {n.targetKind === 'capture' ? <a href={`#/case/${caseId}/capture/${n.targetId}`}>capture</a> : n.targetKind}
                      </span>
                    )}
                    <button className="small" type="button" onClick={() => setEditing({ id: n.id, text: n.text })}>
                      Edit
                    </button>
                  </div>
                  {n.versions.length > 0 && (
                    <details className="small muted">
                      <summary>{n.versions.length} earlier version(s)</summary>
                      {n.versions.map((v, i) => (
                        <div key={i} style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
                          <LocalTime utc={v.atUtc} />: {v.text}
                        </div>
                      ))}
                    </details>
                  )}
                </>
              )}
            </li>
          ))}
      </ul>
    </div>
  );
}

function Notes({ caseId }: { caseId: string }) {
  return (
    <div className="card">
      <NoteList caseId={caseId} />
    </div>
  );
}

function Audit({ caseId }: { caseId: string }) {
  const [events] = useLive(() => listAudit(caseId), ['cases', 'visits', 'captures', 'notes'], [caseId]);
  const [check, setCheck] = useState<ChainCheck | null>(null);
  const { busy, run } = useAction();
  if (!events) return null;
  return (
    <div className="stack">
      <div className="row">
        <button type="button" disabled={busy} onClick={() => run(async () => setCheck(await verifyChain(events)))}>
          Verify chain
        </button>
        <span className="muted small">Recomputes every event hash and checks each link to the previous event.</span>
      </div>
      {check &&
        (check.ok ? (
          <Banner kind="ok">
            Chain intact: {check.count} events, head <span className="mono">{check.head}</span>
          </Banner>
        ) : (
          <Banner kind="error">
            Chain broken:
            <ul>
              {check.errors.map((e, i) => (
                <li key={i}>
                  Event {e.seq}: {e.problem}
                </li>
              ))}
            </ul>
          </Banner>
        ))}
      <div className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>Event</th>
              <th>Details</th>
              <th>Hash</th>
            </tr>
          </thead>
          <tbody>
            {events
              .slice()
              .reverse()
              .map((e) => (
                <tr key={e.seq}>
                  <td className="muted">{e.seq}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <LocalTime utc={e.atUtc} />
                  </td>
                  <td className="mono">{e.type}</td>
                  <td>
                    <details>
                      <summary className="small">payload</summary>
                      <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                        {JSON.stringify(e.payload, null, 2)}
                      </pre>
                    </details>
                  </td>
                  <td>
                    <span className="mono small" title={e.hash}>
                      {e.hash.slice(7, 19)}…
                    </span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
