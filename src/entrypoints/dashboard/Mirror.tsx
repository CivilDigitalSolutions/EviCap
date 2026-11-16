import { getDb, getMeta, setMeta } from '@/lib/db';
import { rpc } from '@/lib/messages';
import { MIRROR_OFF, type MirrorStatus } from '@/lib/mirror-queue';
import { Banner, ErrorText, LocalTime } from '@/ui/components';
import { useAction, useLive } from '@/ui/hooks';

type PickerWindow = Window & {
  showDirectoryPicker(o: { id?: string; mode: 'readwrite'; startIn?: string }): Promise<FileSystemDirectoryHandle>;
};
type PermHandle = FileSystemDirectoryHandle & {
  requestPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
};

export const CLOUD_WARNING =
  "Don't choose a folder that OneDrive, Dropbox, Google Drive or iCloud Drive syncs. On Windows, Documents and Desktop are often synced by OneDrive. A synced folder uploads your evidence, which takes it off this computer.";

/** Disk mirror setup and status (SPEC §5.2). The folder must be picked here, in a page, with a click. */
export function MirrorPanel({ compact = false }: { compact?: boolean }) {
  const [status, reload] = useLive(async () => (await getMeta<MirrorStatus>('mirrorStatus')) ?? MIRROR_OFF, ['mirror']);
  const [queued] = useLive(async () => (await getDb()).count('mirrorQueue'), ['mirror', 'captures', 'visits']);
  const { busy, error, run } = useAction();

  const choose = () =>
    run(async () => {
      let dir: FileSystemDirectoryHandle;
      try {
        dir = await (window as unknown as PickerWindow).showDirectoryPicker({ id: 'evicap-mirror', mode: 'readwrite' });
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') return; // the user cancelled
        throw err;
      }
      await setMeta('mirrorDir', dir);
      await setMeta('mirrorStatus', { ...MIRROR_OFF, state: 'working', folderName: dir.name });
      await rpc('mirrorConnected');
      reload();
    }).catch(() => undefined);

  const reconnect = () =>
    run(async () => {
      const dir = await getMeta<PermHandle>('mirrorDir');
      if (!dir) return;
      const p = await dir.requestPermission({ mode: 'readwrite' });
      if (p !== 'granted') throw new Error('Permission was not granted.');
      await rpc('mirrorKick');
    });

  const s = status ?? MIRROR_OFF;
  return (
    <div className="stack">
      {s.state === 'off' ? (
        <>
          <p>
            EviCap can save a copy of every case as ordinary files in a folder on this computer. These files survive
            uninstalling the extension or clearing browser data.
          </p>
          <Banner kind="warn">{CLOUD_WARNING}</Banner>
          <div>
            <button className="primary" type="button" disabled={busy} onClick={choose}>
              Choose a folder…
            </button>
          </div>
        </>
      ) : (
        <>
          <dl className="kv">
            <dt>Folder</dt>
            <dd>
              <strong>{s.folderName}</strong>
            </dd>
            <dt>Status</dt>
            <dd>
              {s.state === 'ok' && <span className="badge ok">Up to date</span>}
              {s.state === 'working' && <span className="badge">Writing…</span>}
              {s.state === 'needs-permission' && <span className="badge warn">Needs permission</span>}
              {s.state === 'error' && <span className="badge warn">Problem</span>}
            </dd>
            <dt>Waiting to write</dt>
            <dd>{queued ?? s.queued} file operation(s)</dd>
            <dt>Last write</dt>
            <dd>
              <LocalTime utc={s.lastWriteUtc} />
            </dd>
          </dl>
          {s.lastError && <Banner kind="warn">{s.lastError}</Banner>}
          {s.state === 'needs-permission' && (
            <Banner kind="warn">
              The browser needs your permission again to write to this folder. Until then, new files are queued.
              <div style={{ marginTop: 6 }}>
                <button className="primary" type="button" disabled={busy} onClick={reconnect}>
                  Allow access to {s.folderName}
                </button>
              </div>
            </Banner>
          )}
          {!compact && (
            <div className="row">
              <button type="button" disabled={busy} onClick={choose}>
                Change folder…
              </button>
              <button type="button" disabled={busy} onClick={() => run(() => rpc('mirrorKick'))}>
                Write now
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => {
                  if (confirm('Stop mirroring? Files already in the folder are kept.')) void run(() => rpc('mirrorDisconnect'));
                }}
              >
                Stop mirroring
              </button>
            </div>
          )}
        </>
      )}
      <ErrorText error={error} />
    </div>
  );
}
