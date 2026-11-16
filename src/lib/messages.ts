import type { CaseInput } from './cases';
import type { StorageStatus } from './opfs';
import type { ScreenshotMode } from './screenshots';
import type { Settings } from './settings';
import type { CaseStatus, NoteTargetKind } from './types';

/**
 * UI pages read IndexedDB directly but every write goes through the service
 * worker, so each case's audit chain has a single writer.
 */
export interface RpcMethods {
  createCase(input: CaseInput): { id: string };
  updateCase(id: string, patch: Partial<CaseInput>): void;
  setCaseStatus(id: string, status: CaseStatus): void;
  deleteCase(id: string): void;
  setActiveCase(id: string | null): void;
  setRecording(on: boolean): void;
  screenshot(mode: ScreenshotMode, tabId?: number): { captureId: string } | null;
  addNote(caseId: string, kind: NoteTargetKind, targetId: string, text: string): void;
  editNote(noteId: string, text: string): void;
  setTag(caseId: string, kind: 'visit' | 'capture', targetId: string, tag: string, add: boolean): void;
  saveSettings(patch: Partial<Settings>): Settings;
  mirrorConnected(): void;
  mirrorDisconnect(): void;
  mirrorKick(): void;
  status(): { storage: StorageStatus; fingerprint: string; version: string };
}

export type RpcName = keyof RpcMethods;

export interface RpcRequest<K extends RpcName = RpcName> {
  kind: 'rpc';
  method: K;
  args: Parameters<RpcMethods[K]>;
}

export type RpcResponse = { ok: true; value: unknown } | { ok: false; error: string };

export async function rpc<K extends RpcName>(method: K, ...args: Parameters<RpcMethods[K]>): Promise<ReturnType<RpcMethods[K]>> {
  const res = (await chrome.runtime.sendMessage({ kind: 'rpc', method, args } satisfies RpcRequest<K>)) as
    | RpcResponse
    | undefined;
  if (!res) throw new Error('EviCap background is not responding. Try again.');
  if (!res.ok) throw new Error(res.error);
  return res.value as ReturnType<RpcMethods[K]>;
}

/** Broadcast after data changes so open pages refresh. */
export interface ChangedMessage {
  kind: 'changed';
  scope: 'cases' | 'visits' | 'captures' | 'notes' | 'mirror' | 'state';
  caseId?: string;
}

export function broadcast(msg: Omit<ChangedMessage, 'kind'>) {
  chrome.runtime.sendMessage({ kind: 'changed', ...msg } satisfies ChangedMessage).catch(() => undefined);
}

/** Message from the service worker to the offscreen document. */
export interface OffscreenMessage {
  kind: 'offscreen';
  action: 'drain-mirror';
}
