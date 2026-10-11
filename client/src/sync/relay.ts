/**
 * End-to-end encrypted messages between the account's devices (docs/REMOTE.md). The sync server
 * forwards them between sessions without being able to read them: the key is derived from the
 * vault key, and the sender and recipient session ids are bound into the AAD.
 */
import { ascii, buf, concat, fromUtf8, randomBytes, utf8 } from '../core/bytes';
import { DecryptionError, deflate, gcmDecrypt, gcmEncrypt, hkdf, inflate } from '../core/crypto';

const VERSION = 0x01;
const NONCE = 12;
const FLAG_DEFLATE = 0x01;
/** Bodies longer than this are compressed when that makes them smaller. */
const COMPRESS_ABOVE = 1024;

const subtle = globalThis.crypto.subtle;

/** HKDF(vault key, "facet:relay:v1") as an AES-GCM key. */
export async function relayKey(vaultKey: Uint8Array): Promise<CryptoKey> {
  const raw = await hkdf(vaultKey, 'facet:relay:v1');
  return subtle.importKey('raw', buf(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function relayAad(flags: number, from: string, to: string): Uint8Array {
  return ascii(`facet:relay:v1:${flags}:${from}:${to}`);
}

/** `0x01 || flags || nonce(12) || AES-GCM(body)`, body = UTF-8 JSON, raw-DEFLATEd when large. */
export async function sealRelay(key: CryptoKey | Uint8Array, from: string, to: string, json: string, nonce: Uint8Array = randomBytes(NONCE)): Promise<Uint8Array> {
  const raw = utf8(json);
  let body = raw;
  let flags = 0;
  if (raw.length > COMPRESS_ABOVE) {
    const d = await deflate(raw);
    if (d.length < raw.length) {
      body = d;
      flags |= FLAG_DEFLATE;
    }
  }
  return concat(new Uint8Array([VERSION, flags]), nonce, await gcmEncrypt(key, body, relayAad(flags, from, to), nonce));
}

export async function openRelay(key: CryptoKey | Uint8Array, from: string, to: string, envelope: Uint8Array): Promise<string> {
  if (envelope.length < 2 + NONCE + 16 || envelope[0] !== VERSION) throw new DecryptionError('Bad relay envelope');
  const flags = envelope[1];
  const body = await gcmDecrypt(key, envelope.subarray(2, 2 + NONCE), envelope.subarray(2 + NONCE), relayAad(flags, from, to));
  return fromUtf8(flags & FLAG_DEFLATE ? await inflate(body) : body);
}

/** Drops replays: messages outside ±10 minutes of the local clock, or ids seen in the last 20 minutes. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly skewMs = 10 * 60_000,
    private readonly rememberMs = 20 * 60_000,
  ) {}

  accept(id: unknown, ts: unknown, now = Date.now()): boolean {
    if (typeof id !== 'string' || id.length < 8 || typeof ts !== 'number' || Math.abs(now - ts) > this.skewMs) return false;
    for (const [k, at] of this.seen) {
      if (now - at <= this.rememberMs) break;
      this.seen.delete(k);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    return true;
  }
}
