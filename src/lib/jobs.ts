/**
 * Long-running work (video downloads) shown in the popup and side panel.
 * Kept in chrome.storage.session. Progress writes are extension API calls,
 * which also keep the service worker alive during a long download.
 */

export interface Job {
  id: string;
  label: string;
  caseId: string;
  bytes: number;
  total: number | null;
  status: 'running' | 'done' | 'failed';
  message: string | null;
  captureId: string | null;
  startedAtUtc: string;
}

let jobs: Job[] | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<Job[]> {
  if (!jobs) {
    const { jobs: stored } = await chrome.storage.session.get('jobs');
    jobs = (stored as Job[] | undefined) ?? [];
  }
  return jobs;
}

function flush(now = false) {
  if (now) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    return chrome.storage.session.set({ jobs: jobs ?? [] });
  }
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    void chrome.storage.session.set({ jobs: jobs ?? [] });
  }, 500);
  return Promise.resolve();
}

export async function startJob(job: Omit<Job, 'bytes' | 'status' | 'message' | 'captureId' | 'startedAtUtc'>): Promise<void> {
  const list = await load();
  list.unshift({ ...job, bytes: 0, status: 'running', message: null, captureId: null, startedAtUtc: new Date().toISOString() });
  list.splice(10);
  await flush(true);
}

export async function updateJob(id: string, patch: Partial<Job>, now = false): Promise<void> {
  const list = await load();
  const j = list.find((x) => x.id === id);
  if (!j) return;
  Object.assign(j, patch);
  await flush(now);
}

export async function dismissJob(id: string): Promise<void> {
  const list = await load();
  jobs = list.filter((j) => j.id !== id);
  await flush(true);
}

/** On service-worker start-up, a job still marked running was cut off. */
export async function markInterruptedJobs(): Promise<void> {
  const list = await load();
  let changed = false;
  for (const j of list) {
    if (j.status === 'running') {
      j.status = 'failed';
      j.message = 'Interrupted (the browser stopped EviCap part-way).';
      changed = true;
    }
  }
  if (changed) await flush(true);
}
