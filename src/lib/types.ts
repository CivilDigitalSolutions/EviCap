import type { Sha256 } from './hash';

export type Uuid = string;
export type IsoUtc = string; // ISO-8601, UTC, milliseconds

export type CaseStatus = 'open' | 'closed' | 'archived';

export interface CaseRecord {
  id: Uuid;
  name: string;
  reference: string;
  investigator: string;
  organisation: string;
  description: string;
  status: CaseStatus;
  createdAtUtc: IsoUtc;
  closedAtUtc: IsoUtc | null;
  /** Per-case domain scope (F1). `all` records every site not on the global denylist. */
  scope: { mode: 'all' | 'listed'; domains: string[] };
  /** Recording in incognito needs a separate opt-in per case (F1). */
  recordIncognito: boolean;
  /** Auto-capture (F3); on by default (D7). */
  autoCapture: boolean;
  /** Head of the hash-chained audit log, and the next sequence number. */
  chainHead: Sha256 | null;
  nextSeq: number;
  nextVisitSeq: number;
  lastExportedAtUtc: IsoUtc | null;
  /** Folder name inside the disk mirror; fixed at creation so renames don't move files. */
  mirrorFolder: string;
}

export interface VisitRecord {
  id: Uuid;
  caseId: Uuid;
  seq: number;
  url: string;
  finalUrl: string;
  redirectChain: string[];
  title: string;
  tabId: number;
  windowId: number;
  openerTabId: number | null;
  transitionType: string;
  transitionQualifiers: string[];
  referrer: string | null;
  navigatedAtUtc: IsoUtc;
  tzOffsetMinutes: number;
  leftAtUtc: IsoUtc | null;
  focusedMs: number;
  spa: boolean;
  incognito: boolean;
  autoCaptureId: Uuid | null;
  tags: string[];
  auditEventHash: Sha256;
}

export type CaptureType = 'forensic' | 'auto' | 'screenshot' | 'image' | 'video';
export type CaptureStatus = 'pending' | 'complete' | 'incomplete';

export interface CaptureFile {
  /** Path inside the capture folder, e.g. `screenshot.png`. */
  path: string;
  bytes: number;
  sha256: Sha256;
  mime: string;
  role: string;
}

export interface CaptureManifest {
  schema: 'evicap.capture/1';
  captureId: Uuid;
  caseId: Uuid;
  type: CaptureType;
  method: string;
  degraded: string[];
  url: string;
  title: string;
  startedAtUtc: IsoUtc;
  completedAtUtc: IsoUtc;
  environment: Environment;
  files: CaptureFile[];
  parent: Uuid | null;
  meta: Record<string, unknown>;
}

export interface CaptureRecord {
  id: Uuid;
  caseId: Uuid;
  type: CaptureType;
  method: string;
  status: CaptureStatus;
  url: string;
  title: string;
  startedAtUtc: IsoUtc;
  completedAtUtc: IsoUtc | null;
  files: CaptureFile[];
  degraded: string[];
  parent: Uuid | null;
  meta: Record<string, unknown>;
  tags: string[];
  /** SHA-256 of JCS(manifest) — the capture hash (§7.2). */
  captureHash: Sha256 | null;
  /** Base64url ECDSA P-256 signature over JCS(manifest). */
  signature: string | null;
  auditEventHash: Sha256 | null;
  deleted: { atUtc: IsoUtc; reason: string } | null;
}

export interface Environment {
  extension: string;
  browser: string;
  os: string;
  userAgent: string;
  tz: string;
  tzOffsetMinutes: number;
}

export type NoteTargetKind = 'case' | 'visit' | 'capture';

export interface NoteRecord {
  id: Uuid;
  caseId: Uuid;
  targetKind: NoteTargetKind;
  targetId: Uuid;
  text: string;
  createdAtUtc: IsoUtc;
  updatedAtUtc: IsoUtc;
  /** Previous versions, oldest first. Edits never discard text (F8). */
  versions: { text: string; atUtc: IsoUtc }[];
}

export type AuditEventType =
  | 'case.created'
  | 'case.updated'
  | 'case.closed'
  | 'case.reopened'
  | 'recording.started'
  | 'recording.paused'
  | 'visit.recorded'
  | 'visit.closed'
  | 'capture.created'
  | 'capture.incomplete'
  | 'capture.skipped'
  | 'capture.reused'
  | 'artefact.derived'
  | 'artefact.deleted'
  | 'note.created'
  | 'note.edited'
  | 'tag.added'
  | 'tag.removed'
  | 'selector.hit'
  | 'export.created'
  | 'verify.run'
  | 'settings.changed'
  | 'licence.changed'
  | 'timestamp.obtained'
  | 'timestamp.failed'
  | 'mirror.connected'
  | 'clock.anomaly';

export interface AuditEvent {
  caseId: Uuid;
  seq: number;
  type: AuditEventType;
  atUtc: IsoUtc;
  payload: Record<string, unknown>;
  payloadHash: Sha256;
  prevHash: Sha256 | null;
  hash: Sha256;
}

export interface InstallKey {
  id: 'install';
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JsonWebKey;
  /** SHA-256 of the SPKI encoding of the public key. */
  fingerprint: Sha256;
  createdAtUtc: IsoUtc;
}

export type MirrorJob =
  | { id?: number; caseId: Uuid; kind: 'copy'; opfsPath: string; destPath: string; sha256: Sha256; attempts: number }
  | { id?: number; caseId: Uuid; kind: 'append'; destPath: string; text: string; attempts: number }
  | { id?: number; caseId: Uuid; kind: 'write'; destPath: string; text: string; attempts: number };
