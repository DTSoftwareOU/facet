import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { sealBlob } from './client-crypto.js';
import { api, makeApp, registerUser, type Registered, type TestApp } from './helpers.js';

const OVERHEAD = 64; // RECORD_OVERHEAD_BYTES

describe('storage quota (records + blobs)', () => {
  let t: TestApp;
  let u: Registered;
  before(async () => {
    t = await makeApp({ quotaBytes: 8 * 1024 });
    u = await registerUser(t.app);
  });
  after(async () => t.close());

  // Opaque ciphertext is all the server sees; random bytes stand in for it.
  const rec = (id: string, bytes: number, updatedAt: number, deleted = false) => ({
    type: 'e', id, updatedAt, deleted, ct: Buffer.concat([Buffer.from([0x01]), randomBytes(bytes - 1)]).toString('base64'),
  });
  const push = (records: unknown[]) => api(t.app, 'POST', '/v1/sync/push', { token: u.tokens.accessToken, body: { records } });
  const storage = async () => (await api(t.app, 'GET', '/v1/account', { token: u.tokens.accessToken })).json.user.storage;

  test('records count toward the quota', async () => {
    const res = await push([rec('a', 2000, 1), rec('b', 2000, 1), rec('c', 2000, 1)]);
    assert.equal(res.json.accepted.length, 3);
    const s = await storage();
    assert.equal(s.recordBytes, 3 * (2000 + OVERHEAD));
    assert.equal(s.usedBytes, s.recordBytes + s.blobBytes);
    assert.equal(s.quotaBytes, 8 * 1024);
  });

  test('growth past the quota is refused per record; the rest of the batch still applies', async () => {
    const res = await push([rec('d', 3000, 1), rec('a', 40, 2)]);
    assert.deepEqual(res.json.rejected.map((r: { id: string; reason: string }) => [r.id, r.reason]), [['d', 'quota']]);
    assert.deepEqual(res.json.accepted.map((r: { id: string }) => r.id), ['a']);
  });

  test('blobs share the same quota', async () => {
    const sealed = sealBlob(u.account.vaultKey, 'att_q', randomBytes(6000));
    const put = await api(t.app, 'PUT', '/v1/blobs/att_q', { token: u.tokens.accessToken, payload: sealed });
    assert.equal(put.status, 413);
    assert.equal(put.json.error.code, 'quota_exceeded');
  });

  test('deleting frees space, so refused writes fit again', async () => {
    const before = (await storage()).recordBytes;
    const del = await push([rec('b', 40, 3, true)]); // encrypted tombstone, much smaller
    assert.equal(del.json.accepted.length, 1);
    assert.equal((await storage()).recordBytes, before - 2000 + 40);
    const retry = await push([rec('d', 3000, 1)]);
    assert.equal(retry.json.accepted.length, 1);
    assert.equal(retry.json.rejected.length, 0);
  });
});
