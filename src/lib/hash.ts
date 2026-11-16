import { createSHA256 } from 'hash-wasm';
import { canonicalBytes } from './jcs';

/** Hashes are stored as lowercase hex with a `sha256:` prefix (SPEC §7.1). */
export type Sha256 = `sha256:${string}`;

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i++) out += view[i]!.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('sha256:') ? hex.slice(7) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error('Invalid hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** SHA-256 of a complete buffer, via WebCrypto. */
export async function sha256(data: ArrayBuffer | Uint8Array | string): Promise<Sha256> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return `sha256:${toHex(digest)}`;
}

/** SHA-256 of the RFC 8785 canonical JSON of a value. */
export function sha256Json(value: unknown): Promise<Sha256> {
  return sha256(canonicalBytes(value));
}

/**
 * Streaming SHA-256 for large inputs (WebCrypto can't stream). Feed chunks with
 * `update`, then call `digest` once.
 */
export async function createStreamingSha256() {
  const hasher = await createSHA256();
  hasher.init();
  let bytes = 0;
  return {
    update(chunk: Uint8Array) {
      hasher.update(chunk);
      bytes += chunk.byteLength;
    },
    get bytes() {
      return bytes;
    },
    digest(): Sha256 {
      return `sha256:${hasher.digest('hex')}`;
    },
  };
}

/** Hash a Blob or File by streaming it, without loading it all into memory. */
export async function sha256Blob(blob: Blob): Promise<Sha256> {
  const h = await createStreamingSha256();
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
  }
  return h.digest();
}
