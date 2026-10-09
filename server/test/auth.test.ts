import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AAD, newAccount, passwordKeys, registerBody, unwrapVaultKey } from './client-crypto.js';
import { api, loginUser, makeApp, registerUser, TEST_ITERATIONS, uniqueEmail, type TestApp } from './helpers.js';

describe('meta', () => {
  let t: TestApp;
  before(async () => (t = await makeApp()));
  after(async () => t.close());

  test('health and meta', async () => {
    const health = await api(t.app, 'GET', '/v1/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true });

    const meta = await api(t.app, 'GET', '/v1/meta');
    assert.equal(meta.status, 200);
    assert.equal(meta.json.name, 'Facet Sync');
    assert.equal(meta.json.registrationOpen, true);
    assert.equal(meta.json.emailEnabled, false);
    assert.deepEqual(meta.json.limits, { maxRecordBytes: 2097152, maxBatchRecords: 500, maxBlobBytes: 33554432 });
    assert.equal(meta.headers['cache-control'], 'no-store');
  });

  test('unknown route uses the error envelope', async () => {
    const res = await api(t.app, 'GET', '/v1/nope');
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'not_found');
  });
});

describe('auth', () => {
  let t: TestApp;
  before(async () => (t = await makeApp()));
  after(async () => t.close());

  test('prelogin returns deterministic fake KDF for unknown emails', async () => {
    const a1 = await api(t.app, 'POST', '/v1/auth/prelogin', { body: { email: 'ghost@example.com' } });
    const a2 = await api(t.app, 'POST', '/v1/auth/prelogin', { body: { email: '  GHOST@example.com ' } });
    const b = await api(t.app, 'POST', '/v1/auth/prelogin', { body: { email: 'other-ghost@example.com' } });
    assert.equal(a1.status, 200);
    assert.equal(a1.json.kdf.algorithm, 'pbkdf2-sha256');
    assert.equal(a1.json.kdf.iterations, 600000);
    assert.equal(Buffer.from(a1.json.kdf.salt, 'base64').length, 16);
    assert.deepEqual(a1.json, a2.json, 'same email (normalized) → same fake salt');
    assert.notEqual(a1.json.kdf.salt, b.json.kdf.salt, 'different email → different salt');
  });

  test('prelogin returns the real KDF for existing accounts', async () => {
    const r = await registerUser(t.app);
    const pre = await api(t.app, 'POST', '/v1/auth/prelogin', { body: { email: r.email.toUpperCase() } });
    assert.equal(pre.json.kdf.iterations, TEST_ITERATIONS);
    assert.equal(pre.json.kdf.salt, r.account.salt.toString('base64'));
  });

  test('register returns user and tokens; duplicate email → 409', async () => {
    const email = uniqueEmail();
    const r = await registerUser(t.app, email);
    assert.equal(r.user.email, email);
    assert.equal(r.user.displayName, 'Test User');
    assert.deepEqual(r.user.storage, { usedBytes: 0, quotaBytes: 2147483648 });
    assert.ok(r.tokens.accessToken.split('.').length === 3);
    assert.ok(r.tokens.refreshToken.length >= 40);
    assert.ok(r.tokens.accessExpiresAt > Date.now());

    const dup = await api(t.app, 'POST', '/v1/auth/register', { body: registerBody(email, newAccount('x', TEST_ITERATIONS)) });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 'email_taken');
  });

  test('register validation errors name the field', async () => {
    const body: any = registerBody(uniqueEmail(), newAccount('pw', TEST_ITERATIONS));
    body.authHash = Buffer.alloc(31).toString('base64');
    const res = await api(t.app, 'POST', '/v1/auth/register', { body });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'invalid_request');
    assert.match(res.json.error.message, /^authHash:/);

    const low: any = registerBody(uniqueEmail(), newAccount('pw', TEST_ITERATIONS));
    low.kdf.iterations = 1000;
    const res2 = await api(t.app, 'POST', '/v1/auth/register', { body: low });
    assert.equal(res2.status, 400);
    assert.match(res2.json.error.message, /^kdf\.iterations:/);

    const malformed = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error.code, 'invalid_request');
  });

  test('login: wrong password → invalid_credentials; right password → wrapped vault key unwraps', async () => {
    const r = await registerUser(t.app, uniqueEmail(), 'correct password');
    const bad = await loginUser(t.app, r.email, 'wrong password');
    assert.equal(bad.res.status, 401);
    assert.equal(bad.res.json.error.code, 'invalid_credentials');

    const unknown = await loginUser(t.app, uniqueEmail('nobody'), 'whatever');
    assert.equal(unknown.res.status, 401);
    assert.equal(unknown.res.json.error.code, 'invalid_credentials');

    const ok = await loginUser(t.app, r.email, 'correct password');
    assert.equal(ok.res.status, 200);
    assert.ok(ok.vaultKey?.equals(r.account.vaultKey));
    assert.equal(ok.res.json.kdf.salt, r.account.salt.toString('base64'));
    assert.equal(ok.res.json.user.id, r.user.id);
  });

  test('access token authorizes; garbage and missing tokens → unauthorized', async () => {
    const r = await registerUser(t.app);
    const ok = await api(t.app, 'GET', '/v1/account', { token: r.tokens.accessToken });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.email, r.email);

    const missing = await api(t.app, 'GET', '/v1/account');
    assert.equal(missing.status, 401);
    assert.equal(missing.json.error.code, 'unauthorized');

    const tampered = r.tokens.accessToken.slice(0, -2) + (r.tokens.accessToken.endsWith('AA') ? 'BB' : 'AA');
    const bad = await api(t.app, 'GET', '/v1/account', { token: tampered });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error.code, 'unauthorized');
  });

  test('refresh rotates; reusing a rotated token revokes the session', async () => {
    const r = await registerUser(t.app);
    const first = await api(t.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: r.tokens.refreshToken } });
    assert.equal(first.status, 200);
    const t1 = first.json.tokens;
    assert.notEqual(t1.refreshToken, r.tokens.refreshToken);
    assert.equal(t1.sessionId, r.tokens.sessionId);

    const second = await api(t.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: t1.refreshToken } });
    assert.equal(second.status, 200);
    const t2 = second.json.tokens;

    // Replay the very first (rotated) token → theft detection.
    const replay = await api(t.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: t1.refreshToken } });
    assert.equal(replay.status, 401);
    assert.equal(replay.json.error.code, 'invalid_refresh_token');

    // The whole session is gone now: current refresh token and access token both fail.
    const after = await api(t.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: t2.refreshToken } });
    assert.equal(after.status, 401);
    assert.equal(after.json.error.code, 'invalid_refresh_token');
    const acct = await api(t.app, 'GET', '/v1/account', { token: t2.accessToken });
    assert.equal(acct.status, 401);

    const unknown = await api(t.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: 'x'.repeat(43) } });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.json.error.code, 'invalid_refresh_token');
  });

  test('logout ends the session immediately (empty JSON body tolerated)', async () => {
    const r = await registerUser(t.app);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${r.tokens.accessToken}`, 'content-type': 'application/json' },
      payload: '',
    });
    assert.equal(res.statusCode, 204);
    const acct = await api(t.app, 'GET', '/v1/account', { token: r.tokens.accessToken });
    assert.equal(acct.status, 401);
    const refresh = await api(t.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: r.tokens.refreshToken } });
    assert.equal(refresh.status, 401);
  });
});

describe('refresh grace window', () => {
  let t: TestApp;
  before(async () => (t = await makeApp({ refreshReuseGraceMs: 60_000 })));
  after(async () => t.close());

  test('a rotated token re-presented within the grace window gets a fresh token instead of revocation', async () => {
    const r = await registerUser(t.app);
    const first = await api(t.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: r.tokens.refreshToken } });
    assert.equal(first.status, 200);
    // Response "lost": client retries with the original token.
    const retry = await api(t.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: r.tokens.refreshToken } });
    assert.equal(retry.status, 200);
    const next = await api(t.app, 'POST', '/v1/auth/refresh', { body: { refreshToken: retry.json.tokens.refreshToken } });
    assert.equal(next.status, 200);
  });
});

describe('registration closed', () => {
  let t: TestApp;
  before(async () => (t = await makeApp({ registrationOpen: false })));
  after(async () => t.close());

  test('register → 403 registration_closed', async () => {
    const res = await api(t.app, 'POST', '/v1/auth/register', {
      body: registerBody(uniqueEmail(), newAccount('pw', TEST_ITERATIONS)),
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'registration_closed');
    const meta = await api(t.app, 'GET', '/v1/meta');
    assert.equal(meta.json.registrationOpen, false);
  });
});

describe('password derivation sanity', () => {
  test('NFKC normalization makes equivalent passwords derive the same key', () => {
    const salt = Buffer.alloc(16, 7);
    const composed = passwordKeys('café', salt, TEST_ITERATIONS);
    const decomposed = passwordKeys('café', salt, TEST_ITERATIONS);
    assert.ok(composed.authKey.equals(decomposed.authKey));
    const a = newAccount('pw', TEST_ITERATIONS);
    const body = registerBody('x@y.z', a);
    const unwrapped = unwrapVaultKey(a.keys.wrapKey, Buffer.from(body.wrappedVaultKey, 'base64'), AAD.vaultKey);
    assert.ok(unwrapped.equals(a.vaultKey));
  });
});
