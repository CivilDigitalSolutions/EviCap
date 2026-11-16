import { useEffect, useState } from 'react';
import { getDb } from '@/lib/db';
import { shortFingerprint } from '@/lib/keys';
import { rpc } from '@/lib/messages';
import { storageStatus } from '@/lib/opfs';
import { DEFAULT_DENYLIST } from '@/lib/settings';
import { formatBytes } from '@/lib/util';
import { ErrorText, Hash } from '@/ui/components';
import { useAction, useLive, useSettings } from '@/ui/hooks';
import { MirrorPanel } from './Mirror';

export function SettingsPage() {
  const settings = useSettings();
  const [storage] = useLive(storageStatus, ['captures']);
  const [key] = useLive(async () => (await getDb()).get('keys', 'install'), []);
  const [denylist, setDenylist] = useState('');
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) setDenylist(settings.denylist.join('\n'));
  }, [settings?.denylist.join('\n')]);

  if (!settings) return null;
  const save = (patch: Parameters<typeof rpc<'saveSettings'>>[1]) =>
    run(async () => {
      await rpc('saveSettings', patch);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });

  return (
    <section className="stack" style={{ maxWidth: 760 }}>
      <h1>Settings</h1>
      <ErrorText error={error} />
      {saved && <p className="small" style={{ color: 'var(--ok)' }}>Saved.</p>}

      <div className="card stack">
        <h2>Disk mirror</h2>
        <MirrorPanel />
        {!settings.mirrorReminderDismissed && (
          <label className="check">
            <input type="checkbox" onChange={(e) => e.target.checked && void save({ mirrorReminderDismissed: true })} />
            <span>Stop reminding me to set up a disk mirror</span>
          </label>
        )}
      </div>

      <div className="card stack">
        <h2>Recording</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.autoCaptureDefault}
            onChange={(e) => void save({ autoCaptureDefault: e.target.checked })}
          />
          <span>Turn on auto-capture for new cases</span>
        </label>
        <label className="field">
          <span>Never log these domains (one per line; subdomains included)</span>
          <textarea rows={8} value={denylist} onChange={(e) => setDenylist(e.target.value)} />
        </label>
        <div className="row">
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={() =>
              void save({
                denylist: denylist
                  .split(/[\s,]+/)
                  .map((d) => d.trim().toLowerCase())
                  .filter(Boolean),
              })
            }
          >
            Save denylist
          </button>
          <button type="button" onClick={() => setDenylist(DEFAULT_DENYLIST.join('\n'))}>
            Reset to defaults
          </button>
        </div>
      </div>

      <div className="card stack">
        <h2>Images</h2>
        <label className="field">
          <span>When a page offers several sizes of an image, capture</span>
          <select
            value={settings.imageSource}
            onChange={(e) => void save({ imageSource: e.target.value as 'largest' | 'displayed' })}
          >
            <option value="largest">the largest version (recommended)</option>
            <option value="displayed">the version shown on screen</option>
          </select>
        </label>
        <p className="small muted">Either way, every version the page offered is listed in the capture's metadata.</p>
      </div>

      <div className="card stack">
        <h2>Keyboard shortcuts</h2>
        <p>
          Visible area <kbd>Alt+Shift+S</kbd> · Full page <kbd>Alt+Shift+F</kbd> · Region <kbd>Alt+Shift+R</kbd> · Pick images and videos{' '}
          <kbd>Alt+Shift+M</kbd>. Start or pause recording, and record this tab, have no default shortcut.
        </p>
        <div>
          <button type="button" onClick={() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
            Change shortcuts
          </button>
        </div>
      </div>

      <div className="card stack">
        <h2>Signing key</h2>
        <p className="small muted">
          Created on this computer when EviCap was installed. It signs every capture. Record the fingerprint in your notes or
          statement to link this installation's evidence to you.
        </p>
        {key && (
          <dl className="kv">
            <dt>Fingerprint</dt>
            <dd>
              <strong className="mono">{shortFingerprint(key.fingerprint)}</strong>
            </dd>
            <dt>Full</dt>
            <dd>
              <Hash value={key.fingerprint} />
            </dd>
            <dt>Algorithm</dt>
            <dd>ECDSA P-256, SHA-256</dd>
          </dl>
        )}
      </div>

      <div className="card stack">
        <h2>Trusted timestamping</h2>
        <p className="small muted">
          A Pro feature, coming in a later build. When turned on, EviCap sends only a fingerprint (hash) of your evidence to
          FreeTSA and stores the signed timestamp it returns. Off by default.
        </p>
      </div>

      <div className="card stack">
        <h2>Storage</h2>
        {storage && (
          <dl className="kv">
            <dt>Used</dt>
            <dd>
              {formatBytes(storage.usage)} of {formatBytes(storage.quota)} ({(storage.ratio * 100).toFixed(1)}%)
            </dd>
            <dt>Persistent</dt>
            <dd>{storage.persisted ? 'Yes' : 'No'}</dd>
          </dl>
        )}
      </div>

      <div className="card stack">
        <h2>Licence</h2>
        <p className="small muted">Free plan. Pro upgrades and licence keys arrive with billing in a later build.</p>
      </div>

      <div className="card stack">
        <h2>Privacy</h2>
        <p className="small">
          Everything EviCap records stays on this computer. Nothing leaves it except billing, and timestamp hashes if you turn
          timestamping on.
        </p>
      </div>
    </section>
  );
}
