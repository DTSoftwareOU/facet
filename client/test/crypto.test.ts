import { describe, expect, it } from 'vitest';
import vectors from '../../docs/test-vectors.json';
import { b64, unb64, utf8 } from '../src/core/bytes';
import {
  decryptBlob,
  decryptRecord,
  deriveFromPassword,
  deriveFromRecovery,
  encryptBlob,
  encryptRecord,
  formatRecoveryCode,
  hkdf,
  normalizePassword,
  paddedSize,
  parseRecoveryCode,
  pbkdf2,
  unwrapVaultKey,
  wrapVaultKey,
} from '../src/core/crypto';

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const v = vectors as any;

describe('crypto matches docs/test-vectors.json', () => {
  it('normalizes passwords with NFKC', () => {
    expect(toHex(normalizePassword(v.nfkc.input))).toBe(v.nfkc.normalizedUtf8Hex);
  });

  it('derives password keys and wraps the vault key', async () => {
    const salt = hex(v.inputs.saltHex);
    const master = await pbkdf2(v.inputs.password, salt, v.inputs.iterations);
    expect(toHex(master)).toBe(v.password.masterKeyHex);
    expect(toHex(await hkdf(master, 'facet:auth:v1'))).toBe(v.password.authKeyHex);
    const keys = await deriveFromPassword(v.inputs.password, salt, v.inputs.iterations);
    expect(b64(keys.authHash)).toBe(v.password.authHashB64);
    expect(toHex(keys.wrapKey)).toBe(v.password.wrapKeyHex);
    const wrapped = await wrapVaultKey(keys.wrapKey, hex(v.inputs.vaultKeyHex), false, hex(v.inputs.nonces.passwordWrapHex));
    expect(toHex(wrapped)).toBe(v.password.wrappedVaultKeyHex);
    expect(toHex(await unwrapVaultKey(keys.wrapKey, wrapped))).toBe(v.inputs.vaultKeyHex);
  });

  it('formats, parses and derives recovery codes', async () => {
    const code = hex(v.inputs.recoveryCodeBytesHex);
    expect(formatRecoveryCode(code)).toBe(v.recovery.codeText);
    for (const text of v.recovery.codeTextVariantsThatMustParse) expect(toHex(parseRecoveryCode(text)!)).toBe(v.inputs.recoveryCodeBytesHex);
    expect(parseRecoveryCode('nope')).toBeNull();
    const keys = await deriveFromRecovery(code);
    expect(b64(keys.authHash)).toBe(v.recovery.recoveryAuthHashB64);
    const wrapped = await wrapVaultKey(keys.wrapKey, hex(v.inputs.vaultKeyHex), true, hex(v.inputs.nonces.recoveryWrapHex));
    expect(toHex(wrapped)).toBe(v.recovery.recoveryWrappedVaultKeyHex);
  });

  it('opens reference records and reproduces deterministic ones', async () => {
    const key = hex(v.inputs.vaultKeyHex);
    for (const r of v.records) {
      expect(await decryptRecord(key, r.type, r.id, unb64(r.envelopeB64))).toBe(r.plaintextJson);
      if (r.deterministic) {
        const env = await encryptRecord(key, r.type, r.id, r.plaintextJson, { nonce: hex(r.nonceHex), compressAbove: 1024 });
        expect(b64(env)).toBe(r.envelopeB64);
      }
    }
  });

  it('round-trips padded, compressed records', async () => {
    const key = hex(v.inputs.vaultKeyHex);
    const json = JSON.stringify({ text: 'hello '.repeat(400) });
    const env = await encryptRecord(key, 'e', 'abc', json, { pad: true });
    expect(env[1]).toBe(0x03);
    expect(await decryptRecord(key, 'e', 'abc', env)).toBe(json);
    await expect(decryptRecord(key, 'e', 'other', env)).rejects.toThrow();
  });

  it('matches the reference blob and round-trips compressed blobs', async () => {
    const key = hex(v.inputs.vaultKeyHex);
    const env = await encryptBlob(key, v.blob.id, hex(v.blob.plaintextHex), { nonce: hex(v.blob.nonceHex) });
    expect(b64(env)).toBe(v.blob.envelopeB64);
    expect(toHex(await decryptBlob(key, v.blob.id, env))).toBe(v.blob.plaintextHex);
    const text = utf8('line of text\n'.repeat(500));
    const v2 = await encryptBlob(key, 'b1', text, { compressible: true });
    expect(v2[0]).toBe(0x02);
    expect(await decryptBlob(key, 'b1', v2)).toEqual(text);
  });

  it('pads like the Kotlin client', () => {
    expect(paddedSize(0)).toBe(256);
    expect(paddedSize(252)).toBe(256);
    expect(paddedSize(253)).toBe(272);
    expect(paddedSize(1000)).toBe(1024);
    expect(paddedSize(100_000)).toBe(100352);
  });
});
