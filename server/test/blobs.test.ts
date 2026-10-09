import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { openBlob, sealBlob } from './client-crypto.js';
import { api, makeApp, registerUser, type Registered, type TestApp } from './helpers.js';

describe('blobs', () => {
  let t: TestApp;
  let u: Registered;
  // Small quota so quota tests are cheap.
  before(async () => {
    t = await makeApp({ quotaBytes: 64 * 1024 });
    u = await registerUser(t.app);
  });
  after(async () => t.close());

  test('put → get round-trips the encrypted bytes', async () => {
    const plain = randomBytes(5000);
    const sealed = sealBlob(u.account.vaultKey, 'att_1', plain);
    const put = await api(t.app, 'PUT', '/v1/blobs/att_1', { token: u.tokens.accessToken, payload: sealed });
    assert.equal(put.status, 201);
    assert.deepEqual(put.json, { id: 'att_1', size: sealed.length });

    const get = await api(t.app, 'GET', '/v1/blobs/att_1', { token: u.tokens.accessToken });
    assert.equal(get.status, 200);
    assert.equal(get.headers['content-type'], 'application/octet-stream');
    assert.ok(get.raw.equals(sealed));
    assert.ok(openBlob(u.account.vaultKey, 'att_1', get.raw).equals(plain));

    const acct = await api(t.app, 'GET', '/v1/account', { token: u.tokens.accessToken });
    assert.equal(acct.json.user.storage.usedBytes, sealed.length);
    assert.equal(acct.json.user.storage.quotaBytes, 64 * 1024);
  });

  test('re-upload replaces and re-counts usage', async () => {
    const sealed = sealBlob(u.account.vaultKey, 'att_1', randomBytes(100));
    await api(t.app, 'PUT', '/v1/blobs/att_1', { token: u.tokens.accessToken, payload: sealed });
    const acct = await api(t.app, 'GET', '/v1/account', { token: u.tokens.accessToken });
    assert.equal(acct.json.user.storage.usedBytes, sealed.length);
  });

  test('quota is enforced', async () => {
    const big = sealBlob(u.account.vaultKey, 'big', randomBytes(70 * 1024));
    const res = await api(t.app, 'PUT', '/v1/blobs/big', { token: u.tokens.accessToken, payload: big });
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, 'quota_exceeded');
    assert.equal((await api(t.app, 'GET', '/v1/blobs/big', { token: u.tokens.accessToken })).status, 404);
  });

  test('delete frees quota; missing blobs 404; delete is idempotent', async () => {
    const del = await api(t.app, 'DELETE', '/v1/blobs/att_1', { token: u.tokens.accessToken });
    assert.equal(del.status, 204);
    assert.equal((await api(t.app, 'DELETE', '/v1/blobs/att_1', { token: u.tokens.accessToken })).status, 204);
    const get = await api(t.app, 'GET', '/v1/blobs/att_1', { token: u.tokens.accessToken });
    assert.equal(get.status, 404);
    assert.equal(get.json.error.code, 'not_found');
    const acct = await api(t.app, 'GET', '/v1/account', { token: u.tokens.accessToken });
    assert.equal(acct.json.user.storage.usedBytes, 0);
  });

  test('rejects non-envelopes, bad ids, wrong content type, and other users', async () => {
    const plain = await api(t.app, 'PUT', '/v1/blobs/x', { token: u.tokens.accessToken, payload: Buffer.from('plaintext!!!!!!!!!!!!!!!!!!!!!!!!') });
    assert.equal(plain.status, 400);

    const badId = await api(t.app, 'PUT', '/v1/blobs/bad.id', {
      token: u.tokens.accessToken,
      payload: sealBlob(u.account.vaultKey, 'bad.id', Buffer.from('a')),
    });
    assert.equal(badId.status, 400);

    const wrongType = await api(t.app, 'PUT', '/v1/blobs/x', {
      token: u.tokens.accessToken,
      payload: sealBlob(u.account.vaultKey, 'x', Buffer.from('a')),
      contentType: 'image/png',
    });
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.json.error.code, 'invalid_request');

    const mine = sealBlob(u.account.vaultKey, 'mine', Buffer.from('secret'));
    await api(t.app, 'PUT', '/v1/blobs/mine', { token: u.tokens.accessToken, payload: mine });
    const other = await registerUser(t.app);
    assert.equal((await api(t.app, 'GET', '/v1/blobs/mine', { token: other.tokens.accessToken })).status, 404);

    const anon = await api(t.app, 'PUT', '/v1/blobs/anon', { payload: mine });
    assert.equal(anon.status, 401);
  });
});

describe('blob size limit', () => {
  test('blobs over maxBlobBytes → too_large', async () => {
    const base = await makeApp();
    const limits = { ...base.config.limits, maxBlobBytes: 1024 };
    await base.close();
    const t = await makeApp({ limits });
    try {
      const u = await registerUser(t.app);
      const res = await api(t.app, 'PUT', '/v1/blobs/big', {
        token: u.tokens.accessToken,
        payload: sealBlob(u.account.vaultKey, 'big', randomBytes(2048)),
      });
      assert.equal(res.status, 413);
      assert.equal(res.json.error.code, 'too_large');
    } finally {
      await t.close();
    }
  });
});
