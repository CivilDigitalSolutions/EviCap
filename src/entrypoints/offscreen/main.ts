import type { OffscreenMessage } from '@/lib/messages';
import { drainMirror } from '@/lib/mirror-worker';
import { startTabRecorder, stopTabRecorder } from '@/lib/tab-recorder';

// Offscreen document: work the service worker can't do (SPEC §5.1): writing
// the disk mirror, and recording a tab with MediaRecorder (F7-C).
chrome.runtime.onMessage.addListener((msg: OffscreenMessage, _sender, sendResponse) => {
  if (msg?.kind !== 'offscreen') return false;
  if (msg.action === 'drain-mirror') {
    void drainMirror();
    return false;
  }
  if (msg.action === 'start-tab-recording') {
    startTabRecorder(msg.streamId, msg.path, msg.captureId).then(sendResponse, (err: Error) =>
      sendResponse({ ok: false, error: err.message }),
    );
    return true;
  }
  if (msg.action === 'stop-tab-recording') {
    sendResponse(stopTabRecorder(msg.captureId));
    return false;
  }
  return false;
});

void drainMirror();
