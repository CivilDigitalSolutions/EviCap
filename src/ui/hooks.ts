import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangedMessage } from '@/lib/messages';
import { getSettings, getState, type LiveState, type Settings } from '@/lib/settings';

type Scope = ChangedMessage['scope'];

/**
 * Load data and reload it whenever the service worker reports a change in one
 * of `scopes` (or chrome.storage changes, for 'state').
 */
export function useLive<T>(load: () => Promise<T>, scopes: Scope[], deps: unknown[] = []): [T | undefined, () => void] {
  const [value, setValue] = useState<T>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => {
    loadRef.current().then(setValue, (err) => console.warn('[EviCap]', err));
  }, []);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        reload();
      }, 120);
    };
    const onMsg = (msg: ChangedMessage) => {
      if (msg?.kind === 'changed' && scopes.includes(msg.scope)) schedule();
    };
    const onStorage = (_: unknown, area: string) => {
      if (area === 'local' && (scopes.includes('state') || scopes.includes('cases'))) schedule();
    };
    chrome.runtime.onMessage.addListener(onMsg);
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.storage.onChanged.removeListener(onStorage);
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopes.join(',')]);

  return [value, reload];
}

export function useLiveState(): LiveState | undefined {
  return useLive(getState, ['state'])[0];
}

export function useSettings(): Settings | undefined {
  return useLive(getSettings, ['state'])[0];
}

/** Run an async action, tracking busy state and the last error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError((err as Error).message ?? String(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

/** Object URL for an OPFS file, revoked on unmount. */
export function useOpfsUrl(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let revoked = false;
    let u: string | null = null;
    import('@/lib/opfs')
      .then(({ readFile }) => readFile(path))
      .then((file) => {
        if (revoked) return;
        u = URL.createObjectURL(file);
        setUrl(u);
      })
      .catch(() => setUrl(null));
    return () => {
      revoked = true;
      if (u) URL.revokeObjectURL(u);
    };
  }, [path]);
  return url;
}
