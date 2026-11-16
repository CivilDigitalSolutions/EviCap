/**
 * Issue EviCap Pro licence keys for invoiced organisations (SPEC §9.6).
 * Run offline, on the computer that holds Civil Digital's licence-signing key.
 *
 *   node tools/issue-licence.ts init
 *       Create the signing key in tools/keys/ (once). Prints the public key to
 *       put in src/lib/licence.ts. Back up tools/keys/ somewhere safe and offline.
 *
 *   node tools/issue-licence.ts init-service
 *       Create the licence service's signing key (once), in tools/keys/. Prints the
 *       public key for src/lib/licence.ts (SERVICE_KEY). The private key goes to the
 *       service as its SIGNING_KEY_JWK secret (see service/README.md).
 *
 *   node tools/issue-licence.ts issue --org "Acme Ltd" --email jo@acme.example [--months 12] [--key path]
 *       Print a licence key for one user and record it in tools/keys/issued-licences.csv.
 *
 * Needs Node 22.18 or later (runs TypeScript directly).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { canonicalBytes } from '../src/lib/jcs.ts';

const here = dirname(fileURLToPath(import.meta.url));
const KEY_DIR = join(here, 'keys');
const DEFAULT_KEY = join(KEY_DIR, 'licence-signing-key.private.jwk');
const LOG = join(KEY_DIR, 'issued-licences.csv');
const SERVICE_KEY = join(KEY_DIR, 'service-signing-key.private.jwk');
const subtle = webcrypto.subtle;

const b64url = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

export async function signLicence(privateJwk: JsonWebKey, input: { org: string; email: string; months?: number; now?: Date; licenceId?: string }) {
  const now = input.now ?? new Date();
  const expires = new Date(now);
  expires.setUTCMonth(expires.getUTCMonth() + (input.months ?? 12));
  const payload = {
    schema: 'evicap.licence/1',
    licenceId: input.licenceId ?? webcrypto.randomUUID(),
    org: input.org,
    email: input.email,
    plan: 'pro',
    issuedAtUtc: now.toISOString(),
    expiresAtUtc: expires.toISOString(),
  };
  const key = await subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, canonicalBytes(payload));
  return { payload, key: `EVICAP1-${b64url(canonicalBytes(payload))}.${b64url(sig)}` };
}

async function init(path = DEFAULT_KEY, name = 'PRODUCTION_KEY') {
  if (existsSync(path)) {
    console.error(`A signing key already exists at ${path}. Not replacing it.`);
    process.exit(1);
  }
  mkdirSync(KEY_DIR, { recursive: true });
  const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const priv = await subtle.exportKey('jwk', pair.privateKey);
  const pub = await subtle.exportKey('jwk', pair.publicKey);
  writeFileSync(path, JSON.stringify(priv, null, 2) + '\n', { mode: 0o600 });
  console.log(`Signing key written to ${path}. Back it up offline; never commit it.`);
  console.log(`Public key for src/lib/licence.ts (${name}):`);
  console.log(JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, null, 2));
}

async function issue() {
  const org = arg('org');
  const email = arg('email');
  const months = Number(arg('months') ?? 12);
  if (!org || !email || !/^[^@\s]+@[^@\s]+$/.test(email) || !(months > 0 && months <= 36)) {
    console.error('Usage: node tools/issue-licence.ts issue --org "Organisation" --email user@example.com [--months 12]');
    process.exit(1);
  }
  const keyPath = arg('key') ?? DEFAULT_KEY;
  const jwk = JSON.parse(readFileSync(keyPath, 'utf8')) as JsonWebKey;
  const { payload, key } = await signLicence(jwk, { org, email, months });
  if (!existsSync(LOG)) writeFileSync(LOG, 'issuedAtUtc,expiresAtUtc,licenceId,org,email\n');
  const csv = (s: string) => `"${s.replace(/"/g, '""')}"`;
  appendFileSync(LOG, [payload.issuedAtUtc, payload.expiresAtUtc, payload.licenceId, csv(org), csv(email)].join(',') + '\n');
  console.log(`Licence for ${email} (${org}), valid until ${payload.expiresAtUtc.slice(0, 10)}:\n`);
  console.log(key);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2];
  if (cmd === 'init') await init();
  else if (cmd === 'init-service') await init(SERVICE_KEY, 'SERVICE_KEY');
  else if (cmd === 'issue') await issue();
  else {
    console.log('Commands: init | init-service | issue --org "Organisation" --email user@example.com [--months 12]');
    process.exit(cmd ? 1 : 0);
  }
}
