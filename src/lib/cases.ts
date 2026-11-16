import { appendEvent, appendEventLocked, withCaseLock } from './audit';
import { captureMirrorJobs } from './captures';
import { getDb, listAudit } from './db';
import { getInstallKey } from './keys';
import { isMirrorEnabled, mirrorFolderName, notifyMirror } from './mirror-queue';
import { removePath } from './opfs';
import { closeAllVisits } from './recorder';
import { getSettings, getState, saveState } from './settings';
import type { CaseRecord, CaseStatus, MirrorJob, NoteRecord, NoteTargetKind } from './types';
import { nowUtc, uuid } from './util';

export interface CaseInput {
  name: string;
  reference?: string;
  investigator?: string;
  organisation?: string;
  description?: string;
  scope?: CaseRecord['scope'];
  recordIncognito?: boolean;
  autoCapture?: boolean;
}

const EDITABLE: (keyof CaseInput)[] = [
  'name',
  'reference',
  'investigator',
  'organisation',
  'description',
  'scope',
  'recordIncognito',
  'autoCapture',
];

export async function createCase(input: CaseInput): Promise<CaseRecord> {
  const name = input.name.trim();
  if (!name) throw new Error('A case needs a name');
  const settings = await getSettings();
  const id = uuid();
  const reference = (input.reference ?? '').trim();
  const record: CaseRecord = {
    id,
    name,
    reference,
    investigator: (input.investigator ?? '').trim(),
    organisation: (input.organisation ?? '').trim(),
    description: (input.description ?? '').trim(),
    status: 'open',
    createdAtUtc: nowUtc(),
    closedAtUtc: null,
    scope: input.scope ?? { mode: 'all', domains: [] },
    recordIncognito: input.recordIncognito ?? false,
    autoCapture: input.autoCapture ?? settings.autoCaptureDefault,
    chainHead: null,
    nextSeq: 0,
    nextVisitSeq: 0,
    lastExportedAtUtc: null,
    mirrorFolder: mirrorFolderName(name, reference, id),
  };
  const db = await getDb();
  await db.add('cases', record);
  const key = await getInstallKey();
  await withCaseLock(id, async () => {
    await appendEventLocked(id, 'case.created', {
      ...caseDetails(record),
      publicKeyFingerprint: key.fingerprint,
    });
    if (await isMirrorEnabled()) await queueCaseFiles(id);
  });
  return (await db.get('cases', id))!;
}

function caseDetails(c: CaseRecord) {
  return {
    name: c.name,
    reference: c.reference,
    investigator: c.investigator,
    organisation: c.organisation,
    description: c.description,
    scope: c.scope,
    recordIncognito: c.recordIncognito,
    autoCapture: c.autoCapture,
  };
}

export async function updateCase(id: string, patch: Partial<CaseInput>): Promise<void> {
  const db = await getDb();
  const before = await db.get('cases', id);
  if (!before) throw new Error('Case not found');
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const next = { ...before };
  for (const k of EDITABLE) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (typeof v === 'string') v = v.trim();
    if (k === 'name' && !v) throw new Error('A case needs a name');
    if (JSON.stringify(v) !== JSON.stringify(before[k])) {
      changes[k] = { from: before[k], to: v };
      (next as Record<string, unknown>)[k] = v;
    }
  }
  if (Object.keys(changes).length === 0) return;
  await appendEvent(id, 'case.updated', { changes }, { mutateCase: (c) => ({ ...c, ...pick(next, EDITABLE) }) });
  await queueCaseJson(id);
}

function pick<T extends object>(obj: T, keys: (keyof CaseInput)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = (obj as Record<string, unknown>)[k];
  return out;
}

export async function setCaseStatus(id: string, status: CaseStatus): Promise<void> {
  const db = await getDb();
  const c = await db.get('cases', id);
  if (!c || c.status === status) return;
  if (status !== 'open') {
    const state = await getState();
    if (state.activeCaseId === id) await saveState({ activeCaseId: null, recording: false });
  }
  const type = status === 'open' ? 'case.reopened' : 'case.closed';
  await appendEvent(
    id,
    type,
    { from: c.status, to: status },
    {
      mutateCase: (cur) => ({
        ...cur,
        status,
        closedAtUtc: status === 'open' ? null : (cur.closedAtUtc ?? nowUtc()),
      }),
    },
  );
  await queueCaseJson(id);
}

/**
 * Delete a whole case from the browser. Files in the disk mirror and exports
 * are the user's and are left alone.
 */
export async function deleteCase(id: string): Promise<void> {
  const state = await getState();
  if (state.activeCaseId === id) await saveState({ activeCaseId: null, recording: false });
  await withCaseLock(id, async () => {
    const db = await getDb();
    const tx = db.transaction(['cases', 'visits', 'captures', 'notes', 'audit', 'mirrorQueue'], 'readwrite');
    const del = async (store: 'visits' | 'captures', index: 'byCase') => {
      const range =
        store === 'visits'
          ? IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])
          : IDBKeyRange.bound([id, ''], [id, '￿']);
      let cur = await tx.objectStore(store).index(index).openCursor(range);
      while (cur) {
        await cur.delete();
        cur = await cur.continue();
      }
    };
    await del('visits', 'byCase');
    await del('captures', 'byCase');
    let n = await tx.objectStore('notes').index('byCase').openCursor(id);
    while (n) {
      await n.delete();
      n = await n.continue();
    }
    let q = await tx.objectStore('mirrorQueue').index('byCase').openCursor(id);
    while (q) {
      await q.delete();
      q = await q.continue();
    }
    await tx.objectStore('audit').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    await tx.objectStore('cases').delete(id);
    await tx.done;
  });
  await removePath(`cases/${id}`);
}

// ---- Recording state ----

export async function setActiveCase(id: string | null): Promise<void> {
  const state = await getState();
  if (state.activeCaseId === id) return;
  if (state.activeCaseId && state.recording) await setRecording(false);
  if (id) {
    const c = await (await getDb()).get('cases', id);
    if (!c || c.status !== 'open') throw new Error('Only an open case can be active');
  }
  await saveState({ activeCaseId: id, recording: false });
}

export async function setRecording(on: boolean): Promise<void> {
  const state = await getState();
  if (!state.activeCaseId) throw new Error('Choose or create a case first');
  if (state.recording === on) return;
  await saveState({ recording: on });
  // Close open visits first, so their `visit.closed` events come before the pause.
  if (!on) await closeAllVisits();
  await appendEvent(state.activeCaseId, on ? 'recording.started' : 'recording.paused', {});
}

// ---- Notes and tags (F8) ----

export async function addNote(caseId: string, targetKind: NoteTargetKind, targetId: string, text: string) {
  const body = text.trim();
  if (!body) throw new Error('The note is empty');
  const note: NoteRecord = {
    id: uuid(),
    caseId,
    targetKind,
    targetId,
    text: body,
    createdAtUtc: nowUtc(),
    updatedAtUtc: nowUtc(),
    versions: [],
  };
  await appendEvent(
    caseId,
    'note.created',
    { noteId: note.id, targetKind, targetId, text: body },
    { stores: ['notes'], alsoWrite: (tx) => void tx.objectStore('notes').add(note) },
  );
  return note;
}

export async function editNote(noteId: string, text: string) {
  const db = await getDb();
  const note = await db.get('notes', noteId);
  if (!note) throw new Error('Note not found');
  const body = text.trim();
  if (!body || body === note.text) return;
  const at = nowUtc();
  const next: NoteRecord = {
    ...note,
    text: body,
    updatedAtUtc: at,
    versions: [...note.versions, { text: note.text, atUtc: note.updatedAtUtc }],
  };
  await appendEvent(
    note.caseId,
    'note.edited',
    { noteId, previousText: note.text, text: body },
    { stores: ['notes'], alsoWrite: (tx) => void tx.objectStore('notes').put(next) },
  );
}

export async function setTag(
  caseId: string,
  targetKind: 'visit' | 'capture',
  targetId: string,
  tag: string,
  add: boolean,
) {
  const t = tag.trim().toLowerCase();
  if (!t) return;
  const db = await getDb();
  const store = targetKind === 'visit' ? 'visits' : 'captures';
  const rec = await db.get(store, targetId);
  if (!rec) throw new Error('Item not found');
  const has = rec.tags.includes(t);
  if (has === add) return;
  const tags = add ? [...rec.tags, t] : rec.tags.filter((x) => x !== t);
  await appendEvent(
    caseId,
    add ? 'tag.added' : 'tag.removed',
    { targetKind, targetId, tag: t },
    { stores: [store], alsoWrite: (tx) => void tx.objectStore(store).put({ ...rec, tags } as never) },
  );
}

// ---- Disk mirror back-fill ----

async function queueCaseJson(caseId: string) {
  if (!(await isMirrorEnabled())) return;
  const db = await getDb();
  const c = await db.get('cases', caseId);
  if (!c) return;
  const key = await getInstallKey();
  const jobs: MirrorJob[] = [
    { caseId, kind: 'write', destPath: `${c.mirrorFolder}/case.json`, text: JSON.stringify(c, null, 2), attempts: 0 },
    {
      caseId,
      kind: 'write',
      destPath: `${c.mirrorFolder}/public-key.jwk`,
      text: JSON.stringify(key.publicJwk, null, 2),
      attempts: 0,
    },
  ];
  const tx = db.transaction('mirrorQueue', 'readwrite');
  for (const j of jobs) void tx.store.add(j);
  await tx.done;
  notifyMirror();
}

/**
 * Queue every file of a case for the mirror: case details, the full audit log,
 * visits and every capture. Called when the mirror is first connected, or for
 * a new case. Must run under the case lock so no event slips between the
 * snapshot and later appends.
 */
export async function queueCaseFiles(caseId: string): Promise<void> {
  const db = await getDb();
  const c = await db.get('cases', caseId);
  if (!c) return;
  await queueCaseJson(caseId);
  const audit = await listAudit(caseId);
  const visits = await db.getAllFromIndex(
    'visits',
    'byCase',
    IDBKeyRange.bound([caseId, 0], [caseId, Number.MAX_SAFE_INTEGER]),
  );
  const captures = await db.getAllFromIndex('captures', 'byCase', IDBKeyRange.bound([caseId, ''], [caseId, '￿']));
  const jobs: MirrorJob[] = [
    {
      caseId,
      kind: 'write',
      destPath: `${c.mirrorFolder}/audit-log.jsonl`,
      text: audit.map((e) => JSON.stringify(e) + '\n').join(''),
      attempts: 0,
    },
    {
      caseId,
      kind: 'write',
      destPath: `${c.mirrorFolder}/visits.jsonl`,
      text: visits.map((v) => JSON.stringify(v) + '\n').join(''),
      attempts: 0,
    },
  ];
  for (const cap of captures) if (cap.status === 'complete') jobs.push(...captureMirrorJobs(c.mirrorFolder, cap));
  const tx = db.transaction('mirrorQueue', 'readwrite');
  for (const j of jobs) void tx.store.add(j);
  await tx.done;
  notifyMirror();
}

export async function backfillMirror(): Promise<void> {
  const db = await getDb();
  await db.clear('mirrorQueue');
  for (const c of await db.getAll('cases')) {
    await withCaseLock(c.id, () => queueCaseFiles(c.id));
  }
}
