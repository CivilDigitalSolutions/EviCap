import { createStreamingSha256 } from './hash';
import { openWritable } from './opfs';
import type { TabRecordingResult } from './tab-recording';

/**
 * Tab recording (SPEC F7-C), offscreen-document side: a MediaRecorder on the
 * tab's stream writes WebM chunks straight into the capture's folder in
 * OPFS, hashing each chunk before it is written.
 */

interface Active {
  captureId: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  audioCtx: AudioContext | null;
  reason: string;
  error: string | null;
}

let active: Active | null = null;

const TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm'];

async function tabStream(streamId: string, withAudio: boolean): Promise<MediaStream> {
  const source = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
  return navigator.mediaDevices.getUserMedia({
    audio: withAudio ? source : false,
    video: { mandatory: { ...source.mandatory, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 30 } },
  } as unknown as MediaStreamConstraints);
}

export async function startTabRecorder(streamId: string, path: string, captureId: string): Promise<{ ok: boolean; error?: string }> {
  if (active) return { ok: false, error: 'already recording' };
  let stream: MediaStream;
  let audio = true;
  try {
    stream = await tabStream(streamId, true);
  } catch {
    audio = false;
    try {
      stream = await tabStream(streamId, false);
    } catch (err) {
      return { ok: false, error: (err as Error).message || String(err) };
    }
  }
  // Capturing a tab mutes it; play the audio back so the user can still hear the page.
  let audioCtx: AudioContext | null = null;
  if (audio && stream.getAudioTracks().length) {
    audioCtx = new AudioContext();
    audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  }
  const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 4_000_000 });
  const writable = await openWritable(path);
  const hasher = await createStreamingSha256();
  const settings = stream.getVideoTracks()[0]?.getSettings();
  let writing: Promise<void> = Promise.resolve();
  const me: Active = { captureId, recorder, stream, audioCtx, reason: 'stopped by the user', error: null };
  active = me;

  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    writing = writing.then(async () => {
      const chunk = new Uint8Array(await e.data.arrayBuffer());
      hasher.update(chunk);
      await writable.write(chunk as FileSystemWriteChunkType);
    });
    writing.catch((err: Error) => {
      me.error = `writing failed: ${err.message}`;
      if (recorder.state !== 'inactive') recorder.stop();
    });
  };
  recorder.onerror = (e) => {
    me.error = `recorder error: ${(e as unknown as { error?: Error }).error?.message ?? 'unknown'}`;
  };
  recorder.onstop = async () => {
    let result: TabRecordingResult;
    try {
      await writing;
      await writable.close();
      result = {
        captureId,
        ok: !me.error,
        ...(me.error ? { error: me.error } : {}),
        sha256: hasher.digest(),
        bytes: hasher.bytes,
        mime: recorder.mimeType || mimeType || 'video/webm',
        stoppedAtUtc: new Date().toISOString(),
        width: settings?.width,
        height: settings?.height,
        audio,
        reason: me.reason,
      };
    } catch (err) {
      await writable.abort().catch(() => undefined);
      result = { captureId, ok: false, error: (err as Error).message, reason: me.reason, stoppedAtUtc: new Date().toISOString() };
    }
    stream.getTracks().forEach((t) => t.stop());
    void audioCtx?.close();
    active = null;
    void chrome.runtime.sendMessage({ kind: 'tab-recording-ended', result });
  };
  // The tab closed, or the browser ended the capture.
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    me.reason = 'the tab closed or the browser ended the capture';
    if (recorder.state !== 'inactive') recorder.stop();
  });
  recorder.start(1000);
  return { ok: true };
}

export function stopTabRecorder(captureId: string): { ok: boolean } {
  if (!active || active.captureId !== captureId) return { ok: false };
  if (active.recorder.state !== 'inactive') active.recorder.stop();
  return { ok: true };
}
