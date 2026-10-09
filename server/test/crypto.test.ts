import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  AAD,
  encodeRecoveryCode,
  openBlob,
  openRecord,
  parseRecoveryCode,
  sealRecord,
  unwrapVaultKey,
  wrapVaultKey,
} from './client-crypto.js';
import { buildVectors } from './vectors.js';
import { decodeB64 } from '../src/validation.js';

describe('reference client crypto', () => {
  test('recovery code base32 round-trips and tolerates formatting', () => {
    for (let i = 0; i < 50; i++) {
      const bytes = randomBytes(20);
      const text = encodeRecoveryCode(bytes);
      assert.match(text, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.ok(parseRecoveryCode(text).equals(bytes));
      assert.ok(parseRecoveryCode(text.toLowerCase().replace(/-/g, ' ')).equals(bytes));
    }
    assert.ok(parseRecoveryCode('OOOO-OOOO-OOOO-OOOO-OOOO-OOOO-OOOO-OOOO').equals(Buffer.alloc(20)));
    assert.throws(() => parseRecoveryCode('UUUU-0000-0000-0000-0000-0000-0000-0000'));
    assert.throws(() => parseRecoveryCode('0000'));
  });

  test('vault key wrap is 61 bytes and binds the AAD', () => {
    const key = randomBytes(32);
    const vault = randomBytes(32);
    const wrapped = wrapVaultKey(key, vault, AAD.vaultKey);
    assert.equal(wrapped.length, 61);
    assert.equal(wrapped.toString('base64').length, 84);
    assert.ok(unwrapVaultKey(key, wrapped, AAD.vaultKey).equals(vault));
    assert.throws(() => unwrapVaultKey(key, wrapped, AAD.vaultKeyRecovery));
  });

  test('record envelopes compress above 1 KiB and bind type and id', () => {
    const key = randomBytes(32);
    const small = sealRecord(key, 'conv', 'a', '{"x":1}');
    assert.equal(small[1], 0);
    const big = sealRecord(key, 'msg', 'b', JSON.stringify({ t: 'y'.repeat(5000) }));
    assert.equal(big[1], 1);
    assert.ok(big.length < 1000, 'compressible content shrinks');
    assert.equal(openRecord(key, 'msg', 'b', big), JSON.stringify({ t: 'y'.repeat(5000) }));
    assert.throws(() => openRecord(key, 'msg', 'other', big));
    assert.throws(() => openRecord(key, 'conv', 'b', big));
  });

  test('server base64 decoder is lenient about padding and whitespace', () => {
    assert.deepEqual(decodeB64('AQID'), Buffer.from([1, 2, 3]));
    assert.deepEqual(decodeB64('AQI='), Buffer.from([1, 2]));
    assert.deepEqual(decodeB64('AQI'), Buffer.from([1, 2]));
    assert.deepEqual(decodeB64('AQ\nID'), Buffer.from([1, 2, 3]));
    assert.equal(decodeB64('A*=='), null);
    assert.equal(decodeB64('AQIDB'), null);
  });
});

describe('docs/test-vectors.json', () => {
  const file = JSON.parse(readFileSync(new URL('../../docs/test-vectors.json', import.meta.url), 'utf8'));
  const fresh = buildVectors();

  test('deterministic values match the committed file', () => {
    assert.deepEqual(file.inputs, fresh.inputs);
    assert.deepEqual(file.password, fresh.password);
    assert.deepEqual(file.recovery, fresh.recovery);
    assert.deepEqual(file.nfkc, fresh.nfkc);
    assert.equal(file.records[0].envelopeB64, fresh.records[0]!.envelopeB64);
    assert.equal(file.blob.envelopeB64, fresh.blob.envelopeB64);
  });

  test('every envelope in the file decrypts to its plaintext', () => {
    const vaultKey = Buffer.from(file.inputs.vaultKeyHex, 'hex');
    for (const r of file.records) {
      const env = Buffer.from(r.envelopeB64, 'base64');
      assert.equal(env[1], r.compressed ? 1 : 0);
      assert.equal(openRecord(vaultKey, r.type, r.id, env), r.plaintextJson);
    }
    const blob = openBlob(vaultKey, file.blob.id, Buffer.from(file.blob.envelopeB64, 'base64'));
    assert.equal(blob.toString('hex'), file.blob.plaintextHex);
    for (const variant of file.recovery.codeTextVariantsThatMustParse) {
      assert.equal(parseRecoveryCode(variant).toString('hex'), file.inputs.recoveryCodeBytesHex);
    }
    const wrapKey = Buffer.from(file.password.wrapKeyHex, 'hex');
    assert.equal(unwrapVaultKey(wrapKey, Buffer.from(file.password.wrappedVaultKeyB64, 'base64'), AAD.vaultKey).toString('hex'), file.inputs.vaultKeyHex);
  });
});
