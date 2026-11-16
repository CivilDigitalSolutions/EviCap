import type { OffscreenMessage } from '@/lib/messages';
import { drainMirror } from '@/lib/mirror-worker';

// Offscreen document: work the service worker can't do (SPEC §5.1).
chrome.runtime.onMessage.addListener((msg: OffscreenMessage) => {
  if (msg?.kind === 'offscreen' && msg.action === 'drain-mirror') void drainMirror();
  return false;
});

void drainMirror();
