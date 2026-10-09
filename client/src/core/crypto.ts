/**
 * Facet's client-side cryptography (docs/SECURITY.md), on Web Crypto. Byte-for-byte compatible
 * with the Android app (FacetCrypto.kt) and the reference client (server/test/client-crypto.ts).
 * The server never sees passwords, master keys or the vault key.
 */
import { ascii, b64url, buf, concat, fromUtf8, randomBytes, utf8 } from './bytes';

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export const DEFAULT_ITERATIONS = 600_000;
const VERSION = 0x01;
const BLOB_V2 = 0x02;
const NONCE = 12;
const COMPRESS_THRESHOLD = 200;
const MIN_PADDED = 256;
const AAD_VAULT = 'facet:vault-key:v1';
const AAD_VAULT_RECOVERY = 'facet:vault-key-recovery:v1';

const subtle = globalThis.crypto.subtle;

export function normalizePassword(password: string): Uint8Array {
  return utf8(password.normalize('NFKC'));
}

/** PBKDF2-HMAC-SHA256 over the NFKC-normalized UTF-8 password, 32-byte output. */
export async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', buf(normalizePassword(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations }, key, 256);
  return new Uint8Array(bits);
}

/** HKDF-SHA256 (RFC 5869) with a 32-zero-byte salt. */
export async function hkdf(ikm: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(32), info: buf(utf8(info)) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey('raw', buf(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, buf(data)));
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', buf(data)));
}

export interface DerivedKeys {
  authHash: Uint8Array;
  wrapKey: Uint8Array;
}

export async function deriveFromPassword(password: string, salt: Uint8Array, iterations: number): Promise<DerivedKeys> {
  const master = await pbkdf2(password, salt, iterations);
  try {
    return { authHash: await hkdf(master, 'facet:auth:v1'), wrapKey: await hkdf(master, 'facet:wrap:v1') };
  } finally {
    master.fill(0);
  }
}

export async function deriveFromRecovery(code: Uint8Array): Promise<DerivedKeys> {
  return { authHash: await hkdf(code, 'facet:recovery-auth:v1'), wrapKey: await hkdf(code, 'facet:recovery-wrap:v1') };
}

async function aesKey(key: Uint8Array | CryptoKey): Promise<CryptoKey> {
  if (key instanceof Uint8Array) return subtle.importKey('raw', buf(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return key;
}

export async function gcmEncrypt(key: Uint8Array | CryptoKey, plaintext: Uint8Array, aad: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad), tagLength: 128 },
    await aesKey(key),
    buf(plaintext),
  );
  return new Uint8Array(ct);
}

export async function gcmDecrypt(key: Uint8Array | CryptoKey, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad), tagLength: 128 },
      await aesKey(key),
      buf(ciphertext),
    );
    return new Uint8Array(pt);
  } catch {
    throw new DecryptionError('Authentication failed');
  }
}

// ---- Vault key wrapping ----

export async function wrapVaultKey(wrapKey: Uint8Array, vaultKey: Uint8Array, recovery = false, nonce = randomBytes(NONCE)): Promise<Uint8Array> {
  const aad = ascii(recovery ? AAD_VAULT_RECOVERY : AAD_VAULT);
  return concat(new Uint8Array([VERSION]), nonce, await gcmEncrypt(wrapKey, vaultKey, aad, nonce));
}

export async function unwrapVaultKey(wrapKey: Uint8Array, wrapped: Uint8Array, recovery = false): Promise<Uint8Array> {
  if (wrapped.length !== 61 || wrapped[0] !== VERSION) throw new DecryptionError('Bad wrapped key');
  const aad = ascii(recovery ? AAD_VAULT_RECOVERY : AAD_VAULT);
  return gcmDecrypt(wrapKey, wrapped.subarray(1, 13), wrapped.subarray(13), aad);
}

// ---- Compression (raw DEFLATE, RFC 1951) ----

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([buf(bytes)]).stream().pipeThrough(stream as unknown as TransformStream<Uint8Array, Uint8Array>));
  return new Uint8Array(await out.arrayBuffer());
}

export function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('deflate-raw'));
}

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return await pipe(bytes, new DecompressionStream('deflate-raw'));
  } catch {
    throw new DecryptionError('Bad compressed body');
  }
}

// ---- Records ----

function recordAad(type: string, id: string): Uint8Array {
  return ascii(`facet:rec:v1:${type}:${id}`);
}

/**
 * Padmé padding (Nikitin et al., PETS 2019): at most ~12% overhead while leaking only
 * O(log log n) bits of length; never below 256 bytes.
 */
export function paddedSize(n: number): number {
  const total = Math.max(n + 4, MIN_PADDED);
  const e = 31 - Math.clz32(total);
  const s = 32 - Math.clz32(e);
  const mask = (1 << (e - s)) - 1;
  return (total + mask) & ~mask;
}

function frame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(paddedSize(body.length));
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return out;
}

function unframe(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) throw new DecryptionError('Bad padding');
  const n = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, false);
  if (n > padded.length - 4) throw new DecryptionError('Bad padding');
  return padded.subarray(4, 4 + n);
}

/**
 * Encrypts a record body. With [pad], the (possibly compressed) body is framed with a 4-byte length
 * and zero-padded to a size bucket (flags bit1) so ciphertext length doesn't reveal content length.
 */
export async function encryptRecord(
  key: Uint8Array | CryptoKey,
  type: string,
  id: string,
  json: string,
  options: { pad?: boolean; nonce?: Uint8Array; compressAbove?: number } = {},
): Promise<Uint8Array> {
  const pad = options.pad ?? false;
  const nonce = options.nonce ?? randomBytes(NONCE);
  const raw = utf8(json);
  let deflated: Uint8Array | null = null;
  if (raw.length > (options.compressAbove ?? COMPRESS_THRESHOLD)) {
    const d = await deflate(raw);
    if (d.length < raw.length) deflated = d;
  }
  let body = deflated ?? raw;
  if (pad) body = frame(body);
  const flags = (deflated ? 0x01 : 0) | (pad ? 0x02 : 0);
  return concat(new Uint8Array([VERSION, flags]), nonce, await gcmEncrypt(key, body, recordAad(type, id), nonce));
}

export async function decryptRecord(key: Uint8Array | CryptoKey, type: string, id: string, envelope: Uint8Array): Promise<string> {
  if (envelope.length < 30 || envelope[0] !== VERSION) throw new DecryptionError('Bad record envelope');
  const flags = envelope[1];
  let body = await gcmDecrypt(key, envelope.subarray(2, 14), envelope.subarray(14), recordAad(type, id));
  if (flags & 0x02) body = unframe(body);
  const raw = flags & 0x01 ? await inflate(body) : body;
  return fromUtf8(raw);
}

// ---- Blobs ----

function blobAad(id: string): Uint8Array {
  return ascii(`facet:blob:v1:${id}`);
}

function blobAadV2(id: string, flags: number): Uint8Array {
  return ascii(`facet:blob:v2:${flags}:${id}`);
}

/**
 * Encrypts an attachment. With [compressible], the bytes are DEFLATEd when that saves space and the
 * v2 envelope records it (`0x02 || flags || nonce || ct`, flags bound into the AAD); otherwise v1.
 */
export async function encryptBlob(
  key: Uint8Array | CryptoKey,
  blobId: string,
  bytes: Uint8Array,
  options: { compressible?: boolean; nonce?: Uint8Array } = {},
): Promise<Uint8Array> {
  const nonce = options.nonce ?? randomBytes(NONCE);
  let deflated: Uint8Array | null = null;
  if (options.compressible) {
    const d = await deflate(bytes);
    if (d.length < bytes.length * 0.95) deflated = d;
  }
  if (!deflated) return concat(new Uint8Array([VERSION]), nonce, await gcmEncrypt(key, bytes, blobAad(blobId), nonce));
  const flags = 0x01;
  return concat(new Uint8Array([BLOB_V2, flags]), nonce, await gcmEncrypt(key, deflated, blobAadV2(blobId, flags), nonce));
}

export async function decryptBlob(key: Uint8Array | CryptoKey, blobId: string, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length >= 29 && blob[0] === VERSION) {
    return gcmDecrypt(key, blob.subarray(1, 13), blob.subarray(13), blobAad(blobId));
  }
  if (blob.length >= 30 && blob[0] === BLOB_V2) {
    const flags = blob[1];
    const body = await gcmDecrypt(key, blob.subarray(2, 14), blob.subarray(14), blobAadV2(blobId, flags));
    return flags & 0x01 ? inflate(body) : body;
  }
  throw new DecryptionError('Bad blob');
}

/** Already-compressed formats (JPEG, PNG, MP3, MP4, …) gain nothing from DEFLATE; text-like ones shrink a lot. */
export function compressible(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return (
    m.startsWith('text/') || m === 'application/json' || m === 'application/pdf' || m === 'application/xml' ||
    m === 'image/svg+xml' || m === 'audio/wav' || m === 'audio/x-wav'
  );
}

// ---- Vault: the account key, imported once ----

/** The vault key with its Web Crypto handles, so records don't re-import the key each time. */
export class Vault {
  private constructor(
    readonly raw: Uint8Array,
    readonly aes: CryptoKey,
    private readonly idKey: CryptoKey,
  ) {}

  static async open(vaultKey: Uint8Array): Promise<Vault> {
    const aes = await subtle.importKey('raw', buf(vaultKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const idRaw = await hkdf(vaultKey, 'facet:record-id:v1');
    const idKey = await subtle.importKey('raw', buf(idRaw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Vault(vaultKey, aes, idKey);
  }

  /** First 24 bytes of HMAC-SHA256(recordIdKey, input), base64url without padding. */
  async opaqueId(input: string): Promise<string> {
    const mac = new Uint8Array(await subtle.sign('HMAC', this.idKey, buf(utf8(input))));
    return b64url(mac.subarray(0, 24));
  }
}

// ---- Recovery codes: 20 random bytes as Crockford base32, "XXXX-XXXX-…" ----

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_BYTES = 20;

export function generateRecoveryCode(): Uint8Array {
  return randomBytes(RECOVERY_BYTES);
}

export function formatRecoveryCode(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_BYTES) throw new Error('Recovery code must be 20 bytes');
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = ((buffer << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}

/** Parses user input; returns null if it isn't a valid code. */
export function parseRecoveryCode(input: string): Uint8Array | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== 32) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const c of cleaned) {
    const v = CROCKFORD.indexOf(c);
    if (v < 0) return null;
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out.length === RECOVERY_BYTES ? new Uint8Array(out) : null;
}
