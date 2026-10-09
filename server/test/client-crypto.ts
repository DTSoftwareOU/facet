/**
 * Reference implementation of the CLIENT side of docs/SECURITY.md.
 * Used by the end-to-end tests and to generate docs/test-vectors.json.
 */
import { createCipheriv, createDecipheriv, hkdfSync, pbkdf2Sync, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const DEFAULT_ITERATIONS = 600_000;
export const COMPRESS_THRESHOLD = 1024;

export const INFO = {
  auth: 'facet:auth:v1',
  wrap: 'facet:wrap:v1',
  recoveryAuth: 'facet:recovery-auth:v1',
  recoveryWrap: 'facet:recovery-wrap:v1',
} as const;

export const AAD = {
  vaultKey: 'facet:vault-key:v1',
  vaultKeyRecovery: 'facet:vault-key-recovery:v1',
  record: (type: string, id: string) => `facet:rec:v1:${type}:${id}`,
  blob: (blobId: string) => `facet:blob:v1:${blobId}`,
} as const;

export function normalizePassword(password: string): Buffer {
  return Buffer.from(password.normalize('NFKC'), 'utf8');
}

export function deriveMasterKey(password: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(normalizePassword(password), salt, iterations, 32, 'sha256');
}

/** HKDF-SHA256, empty salt (= 32 zero bytes), 32-byte output. */
export function hkdf(ikm: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(32), Buffer.from(info, 'ascii'), 32));
}

export interface PasswordKeys {
  masterKey: Buffer;
  authKey: Buffer;
  wrapKey: Buffer;
}

export function passwordKeys(password: string, salt: Buffer, iterations: number): PasswordKeys {
  const masterKey = deriveMasterKey(password, salt, iterations);
  return { masterKey, authKey: hkdf(masterKey, INFO.auth), wrapKey: hkdf(masterKey, INFO.wrap) };
}

function gcmSeal(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: string): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'ascii'));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function gcmOpen(key: Buffer, nonce: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < 16) throw new Error('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'ascii'));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
}

/** version(0x01) || nonce(12) || GCM(key, vaultKey, aad) → 61 bytes. */
export function wrapVaultKey(key: Buffer, vaultKey: Buffer, aad: string, nonce: Buffer = randomBytes(12)): Buffer {
  return Buffer.concat([Buffer.from([0x01]), nonce, gcmSeal(key, nonce, vaultKey, aad)]);
}

export function unwrapVaultKey(key: Buffer, wrapped: Buffer, aad: string): Buffer {
  if (wrapped.length !== 61 || wrapped[0] !== 0x01) throw new Error('bad wrapped key');
  return gcmOpen(key, wrapped.subarray(1, 13), wrapped.subarray(13), aad);
}

// ----- recovery code ---------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function encodeRecoveryCode(bytes: Buffer): string {
  if (bytes.length !== 20) throw new Error('recovery code must be 20 bytes');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out.match(/.{4}/g)!.join('-');
}

export function parseRecoveryCode(text: string): Buffer {
  const cleaned = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== 32) throw new Error('recovery code must be 32 characters');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) throw new Error(`invalid character ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

export function recoveryKeys(code: Buffer): { authKey: Buffer; wrapKey: Buffer } {
  return { authKey: hkdf(code, INFO.recoveryAuth), wrapKey: hkdf(code, INFO.recoveryWrap) };
}

// ----- records and blobs -----------------------------------------------------

export function sealRecord(
  vaultKey: Buffer,
  type: string,
  id: string,
  json: string,
  nonce: Buffer = randomBytes(12),
): Buffer {
  const raw = Buffer.from(json, 'utf8');
  const compress = raw.length > COMPRESS_THRESHOLD;
  const body = compress ? deflateRawSync(raw) : raw;
  const flags = compress ? 0x01 : 0x00;
  return Buffer.concat([Buffer.from([0x01, flags]), nonce, gcmSeal(vaultKey, nonce, body, AAD.record(type, id))]);
}

export function openRecord(vaultKey: Buffer, type: string, id: string, envelope: Buffer): string {
  if (envelope.length < 30 || envelope[0] !== 0x01) throw new Error('bad envelope');
  const flags = envelope[1]!;
  const body = gcmOpen(vaultKey, envelope.subarray(2, 14), envelope.subarray(14), AAD.record(type, id));
  return ((flags & 0x01) !== 0 ? inflateRawSync(body) : body).toString('utf8');
}

export function sealBlob(vaultKey: Buffer, blobId: string, data: Buffer, nonce: Buffer = randomBytes(12)): Buffer {
  return Buffer.concat([Buffer.from([0x01]), nonce, gcmSeal(vaultKey, nonce, data, AAD.blob(blobId))]);
}

export function openBlob(vaultKey: Buffer, blobId: string, blob: Buffer): Buffer {
  if (blob.length < 29 || blob[0] !== 0x01) throw new Error('bad blob');
  return gcmOpen(vaultKey, blob.subarray(1, 13), blob.subarray(13), AAD.blob(blobId));
}

// ----- account bundles used by the API ----------------------------------------

export interface AccountSecrets {
  password: string;
  salt: Buffer;
  iterations: number;
  vaultKey: Buffer;
  recoveryCode: Buffer;
  keys: PasswordKeys;
}

export function newAccount(password: string, iterations = DEFAULT_ITERATIONS): AccountSecrets {
  const salt = randomBytes(16);
  return {
    password,
    salt,
    iterations,
    vaultKey: randomBytes(32),
    recoveryCode: randomBytes(20),
    keys: passwordKeys(password, salt, iterations),
  };
}

export function kdfJson(salt: Buffer, iterations: number) {
  return { algorithm: 'pbkdf2-sha256', iterations, salt: salt.toString('base64') };
}

export function recoveryJson(vaultKey: Buffer, code: Buffer) {
  const rk = recoveryKeys(code);
  return {
    authHash: rk.authKey.toString('base64'),
    wrappedVaultKey: wrapVaultKey(rk.wrapKey, vaultKey, AAD.vaultKeyRecovery).toString('base64'),
  };
}

/** Body for POST /v1/auth/register. */
export function registerBody(email: string, a: AccountSecrets, device = { name: 'Test device', platform: 'android' }) {
  return {
    email,
    displayName: 'Test User',
    kdf: kdfJson(a.salt, a.iterations),
    authHash: a.keys.authKey.toString('base64'),
    wrappedVaultKey: wrapVaultKey(a.keys.wrapKey, a.vaultKey, AAD.vaultKey).toString('base64'),
    recovery: recoveryJson(a.vaultKey, a.recoveryCode),
    device,
  };
}
