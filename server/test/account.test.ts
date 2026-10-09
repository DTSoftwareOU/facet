import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { MailMessage } from '../src/mail.js';
import {
  AAD,
  encodeRecoveryCode,
  kdfJson,
  openRecord,
  parseRecoveryCode,
  passwordKeys,
  recoveryJson,
  recoveryKeys,
  sealBlob,
  sealRecord,
  unwrapVaultKey,
  wrapVaultKey,
} from './client-crypto.js';
import { api, loginUser, makeApp, registerUser, TEST_ITERATIONS, type TestApp } from './helpers.js';

describe('account', () => {
  let t: TestApp;
  before(async () => (t = await makeApp()));
  after(async () => t.close());

  test('get and patch display name', async () => {
    const u = await registerUser(t.app);
    const patched = await api(t.app, 'PATCH', '/v1/account', { token: u.tokens.accessToken, body: { displayName: '  Ada  ' } });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.user.displayName, 'Ada');
    const cleared = await api(t.app, 'PATCH', '/v1/account', { token: u.tokens.accessToken, body: { displayName: null } });
    assert.equal(cleared.json.user.displayName, null);
    const tooLong = await api(t.app, 'PATCH', '/v1/account', { token: u.tokens.accessToken, body: { displayName: 'x'.repeat(81) } });
    assert.equal(tooLong.status, 400);
  });

  test('change password keeps data, revokes other sessions, vault still unwraps', async () => {
    const u = await registerUser(t.app, undefined, 'old password');
    const second = await loginUser(t.app, u.email, 'old password');
    const secondToken = second.res.json.tokens.accessToken;

    await api(t.app, 'POST', '/v1/sync/push', {
      token: u.tokens.accessToken,
      body: {
        records: [
          {
            id: 'c1',
            type: 'conv',
            updatedAt: 1,
            deleted: false,
            ct: sealRecord(u.account.vaultKey, 'conv', 'c1', '{"t":"keep me"}').toString('base64'),
          },
        ],
      },
    });

    const newSalt = randomBytes(16);
    const newKeys = passwordKeys('new password', newSalt, TEST_ITERATIONS);
    const wrong = await api(t.app, 'POST', '/v1/account/password', {
      token: u.tokens.accessToken,
      body: {
        currentAuthHash: passwordKeys('nope', u.account.salt, TEST_ITERATIONS).authKey.toString('base64'),
        kdf: kdfJson(newSalt, TEST_ITERATIONS),
        authHash: newKeys.authKey.toString('base64'),
        wrappedVaultKey: wrapVaultKey(newKeys.wrapKey, u.account.vaultKey, AAD.vaultKey).toString('base64'),
      },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, 'invalid_credentials');

    const res = await api(t.app, 'POST', '/v1/account/password', {
      token: u.tokens.accessToken,
      body: {
        currentAuthHash: u.account.keys.authKey.toString('base64'),
        kdf: kdfJson(newSalt, TEST_ITERATIONS),
        authHash: newKeys.authKey.toString('base64'),
        wrappedVaultKey: wrapVaultKey(newKeys.wrapKey, u.account.vaultKey, AAD.vaultKey).toString('base64'),
      },
    });
    assert.equal(res.status, 200);
    const fresh = res.json.tokens;
    assert.ok(fresh.accessToken);

    // Old sessions (including the caller's old one) are revoked; the new session works.
    assert.equal((await api(t.app, 'GET', '/v1/account', { token: u.tokens.accessToken })).status, 401);
    assert.equal((await api(t.app, 'GET', '/v1/account', { token: secondToken })).status, 401);
    assert.equal((await api(t.app, 'GET', '/v1/account', { token: fresh.accessToken })).status, 200);

    assert.equal((await loginUser(t.app, u.email, 'old password')).res.status, 401);
    const relog = await loginUser(t.app, u.email, 'new password');
    assert.equal(relog.res.status, 200);
    assert.ok(relog.vaultKey!.equals(u.account.vaultKey));

    const pulled = await api(t.app, 'GET', '/v1/sync/pull?since=0', { token: relog.res.json.tokens.accessToken });
    assert.equal(openRecord(relog.vaultKey!, 'conv', 'c1', Buffer.from(pulled.json.records[0].ct, 'base64')), '{"t":"keep me"}');
  });

  test('recovery code: start → finish resets password and keeps data; tokens are single use', async () => {
    const u = await registerUser(t.app, undefined, 'forgotten password');
    const codeText = encodeRecoveryCode(u.account.recoveryCode);
    const parsed = parseRecoveryCode(codeText.toLowerCase().replace(/-/g, ' '));
    assert.ok(parsed.equals(u.account.recoveryCode));

    const wrongCode = recoveryKeys(randomBytes(20));
    const bad = await api(t.app, 'POST', '/v1/auth/recover/start', {
      body: { email: u.email, recoveryAuthHash: wrongCode.authKey.toString('base64') },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error.code, 'invalid_credentials');

    const rk = recoveryKeys(parsed);
    const start = await api(t.app, 'POST', '/v1/auth/recover/start', {
      body: { email: u.email, recoveryAuthHash: rk.authKey.toString('base64') },
    });
    assert.equal(start.status, 200);
    assert.equal(start.json.kdf.iterations, TEST_ITERATIONS);
    const vaultKey = unwrapVaultKey(rk.wrapKey, Buffer.from(start.json.recoveryWrappedVaultKey, 'base64'), AAD.vaultKeyRecovery);
    assert.ok(vaultKey.equals(u.account.vaultKey));

    const newSalt = randomBytes(16);
    const newKeys = passwordKeys('remembered now', newSalt, TEST_ITERATIONS);
    const newCode = randomBytes(20);
    const finishBody = {
      resetToken: start.json.resetToken,
      kdf: kdfJson(newSalt, TEST_ITERATIONS),
      authHash: newKeys.authKey.toString('base64'),
      wrappedVaultKey: wrapVaultKey(newKeys.wrapKey, vaultKey, AAD.vaultKey).toString('base64'),
      recovery: recoveryJson(vaultKey, newCode),
      device: { name: 'Recovered phone', platform: 'android' },
    };
    const finish = await api(t.app, 'POST', '/v1/auth/recover/finish', { body: finishBody });
    assert.equal(finish.status, 200);
    assert.equal(finish.json.user.email, u.email);

    const reuse = await api(t.app, 'POST', '/v1/auth/recover/finish', { body: finishBody });
    assert.equal(reuse.status, 401, 'reset token is single use');

    assert.equal((await api(t.app, 'GET', '/v1/account', { token: u.tokens.accessToken })).status, 401, 'old sessions revoked');
    const relog = await loginUser(t.app, u.email, 'remembered now');
    assert.ok(relog.vaultKey!.equals(u.account.vaultKey));

    // The old recovery code no longer works; the new one does.
    const old = await api(t.app, 'POST', '/v1/auth/recover/start', {
      body: { email: u.email, recoveryAuthHash: rk.authKey.toString('base64') },
    });
    assert.equal(old.status, 401);
    const fresh = await api(t.app, 'POST', '/v1/auth/recover/start', {
      body: { email: u.email, recoveryAuthHash: recoveryKeys(newCode).authKey.toString('base64') },
    });
    assert.equal(fresh.status, 200);
  });

  test('regenerate recovery code requires the current password', async () => {
    const u = await registerUser(t.app);
    const code = randomBytes(20);
    const wrong = await api(t.app, 'POST', '/v1/account/recovery', {
      token: u.tokens.accessToken,
      body: { currentAuthHash: randomBytes(32).toString('base64'), recovery: recoveryJson(u.account.vaultKey, code) },
    });
    assert.equal(wrong.status, 401);
    const ok = await api(t.app, 'POST', '/v1/account/recovery', {
      token: u.tokens.accessToken,
      body: { currentAuthHash: u.account.keys.authKey.toString('base64'), recovery: recoveryJson(u.account.vaultKey, code) },
    });
    assert.equal(ok.status, 204);
    const start = await api(t.app, 'POST', '/v1/auth/recover/start', {
      body: { email: u.email, recoveryAuthHash: recoveryKeys(code).authKey.toString('base64') },
    });
    assert.equal(start.status, 200);
  });

  test('sessions: list, revoke one, revoke others', async () => {
    const u = await registerUser(t.app, undefined, 'session pw');
    const b = await loginUser(t.app, u.email, 'session pw', 'Tablet');
    const c = await loginUser(t.app, u.email, 'session pw', 'Laptop');

    const list = await api(t.app, 'GET', '/v1/sessions', { token: u.tokens.accessToken });
    assert.equal(list.status, 200);
    assert.equal(list.json.sessions.length, 3);
    const current = list.json.sessions.filter((s: any) => s.current);
    assert.equal(current.length, 1);
    assert.equal(current[0].id, u.tokens.sessionId);
    assert.equal(current[0].deviceName, 'Test device');
    assert.equal(current[0].platform, 'android');
    assert.ok(list.json.sessions.some((s: any) => s.deviceName === 'Tablet'));

    const self = await api(t.app, 'DELETE', `/v1/sessions/${u.tokens.sessionId}`, { token: u.tokens.accessToken });
    assert.equal(self.status, 400);

    const del = await api(t.app, 'DELETE', `/v1/sessions/${b.res.json.tokens.sessionId}`, { token: u.tokens.accessToken });
    assert.equal(del.status, 204);
    assert.equal((await api(t.app, 'GET', '/v1/account', { token: b.res.json.tokens.accessToken })).status, 401);

    const missing = await api(t.app, 'DELETE', `/v1/sessions/${b.res.json.tokens.sessionId}`, { token: u.tokens.accessToken });
    assert.equal(missing.status, 404);

    const others = await api(t.app, 'DELETE', '/v1/sessions', { token: u.tokens.accessToken });
    assert.equal(others.status, 204);
    assert.equal((await api(t.app, 'GET', '/v1/account', { token: c.res.json.tokens.accessToken })).status, 401);
    assert.equal((await api(t.app, 'GET', '/v1/account', { token: u.tokens.accessToken })).status, 200);
    const after = await api(t.app, 'GET', '/v1/sessions', { token: u.tokens.accessToken });
    assert.equal(after.json.sessions.length, 1);
  });

  test('another user cannot revoke my session', async () => {
    const a = await registerUser(t.app);
    const b = await registerUser(t.app);
    const res = await api(t.app, 'DELETE', `/v1/sessions/${a.tokens.sessionId}`, { token: b.tokens.accessToken });
    assert.equal(res.status, 404);
    assert.equal((await api(t.app, 'GET', '/v1/account', { token: a.tokens.accessToken })).status, 200);
  });

  test('delete account removes everything', async () => {
    const u = await registerUser(t.app, undefined, 'delete me');
    const token = u.tokens.accessToken;
    await api(t.app, 'PUT', '/v1/blobs/b1', { token, payload: sealBlob(u.account.vaultKey, 'b1', Buffer.from('file')) });
    const wrong = await api(t.app, 'DELETE', '/v1/account', { token, body: { currentAuthHash: randomBytes(32).toString('base64') } });
    assert.equal(wrong.status, 401);
    const res = await api(t.app, 'DELETE', '/v1/account', { token, body: { currentAuthHash: u.account.keys.authKey.toString('base64') } });
    assert.equal(res.status, 204);
    assert.equal((await api(t.app, 'GET', '/v1/account', { token })).status, 401);
    assert.equal((await loginUser(t.app, u.email, 'delete me')).res.status, 401);
    const count = t.ctx.db.prepare('SELECT COUNT(*) AS n FROM blobs WHERE user_id = ?').get(u.user.id) as { n: number };
    assert.equal(count.n, 0);
    // Email can be reused afterwards.
    const again = await registerUser(t.app, u.email);
    assert.equal(again.user.email, u.email);
  });
});

describe('email reset', () => {
  test('without SMTP the endpoints answer email_disabled', async () => {
    const t = await makeApp();
    try {
      const res = await api(t.app, 'POST', '/v1/auth/reset/request', { body: { email: 'a@b.co' } });
      assert.equal(res.status, 501);
      assert.equal(res.json.error.code, 'email_disabled');
    } finally {
      await t.close();
    }
  });

  test('code reset wipes encrypted data and sets new credentials', async () => {
    const sent: MailMessage[] = [];
    const t = await makeApp({}, { mailer: { send: async (m) => void sent.push(m) } });
    try {
      assert.equal((await api(t.app, 'GET', '/v1/meta')).json.emailEnabled, true);
      const u = await registerUser(t.app, undefined, 'lost everything');
      const token = u.tokens.accessToken;
      await api(t.app, 'POST', '/v1/sync/push', {
        token,
        body: { records: [{ id: 'c', type: 'conv', updatedAt: 1, deleted: false, ct: sealRecord(u.account.vaultKey, 'conv', 'c', '{}').toString('base64') }] },
      });
      await api(t.app, 'PUT', '/v1/blobs/b', { token, payload: sealBlob(u.account.vaultKey, 'b', Buffer.from('x')) });

      const unknown = await api(t.app, 'POST', '/v1/auth/reset/request', { body: { email: 'nobody@example.com' } });
      assert.equal(unknown.status, 202);
      assert.equal(sent.length, 0, 'no email for unknown accounts');

      const req = await api(t.app, 'POST', '/v1/auth/reset/request', { body: { email: u.email } });
      assert.equal(req.status, 202);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.to, u.email);
      const code = /(\d{4}) (\d{4})/.exec(sent[0]!.text)!.slice(1).join('');

      const vaultKey = randomBytes(32);
      const salt = randomBytes(16);
      const keys = passwordKeys('brand new', salt, TEST_ITERATIONS);
      const body = (c: string) => ({
        email: u.email,
        code: c,
        kdf: kdfJson(salt, TEST_ITERATIONS),
        authHash: keys.authKey.toString('base64'),
        wrappedVaultKey: wrapVaultKey(keys.wrapKey, vaultKey, AAD.vaultKey).toString('base64'),
        recovery: recoveryJson(vaultKey, randomBytes(20)),
        device: { name: 'Phone', platform: 'android' },
      });
      const wrongCode = code === '00000000' ? '11111111' : '00000000';
      const bad = await api(t.app, 'POST', '/v1/auth/reset/confirm', { body: body(wrongCode) });
      assert.equal(bad.status, 401);

      const ok = await api(t.app, 'POST', '/v1/auth/reset/confirm', { body: body(`${code.slice(0, 4)}-${code.slice(4)}`) });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.json.user.storage.usedBytes, 0);
      const newToken = ok.json.tokens.accessToken;
      const pulled = await api(t.app, 'GET', '/v1/sync/pull?since=0', { token: newToken });
      assert.deepEqual(pulled.json.records, []);
      assert.equal((await api(t.app, 'GET', '/v1/blobs/b', { token: newToken })).status, 404);
      assert.equal((await api(t.app, 'GET', '/v1/account', { token })).status, 401, 'old sessions revoked');
      const relog = await loginUser(t.app, u.email, 'brand new');
      assert.ok(relog.vaultKey!.equals(vaultKey));

      const replay = await api(t.app, 'POST', '/v1/auth/reset/confirm', { body: body(code) });
      assert.equal(replay.status, 401, 'code is single use');
    } finally {
      await t.close();
    }
  });

  test('five wrong codes burn the code', async () => {
    const sent: MailMessage[] = [];
    const t = await makeApp({}, { mailer: { send: async (m) => void sent.push(m) } });
    try {
      const u = await registerUser(t.app);
      await api(t.app, 'POST', '/v1/auth/reset/request', { body: { email: u.email } });
      const code = /(\d{4}) (\d{4})/.exec(sent[0]!.text)!.slice(1).join('');
      const vaultKey = randomBytes(32);
      const salt = randomBytes(16);
      const keys = passwordKeys('pw', salt, TEST_ITERATIONS);
      const body = (c: string) => ({
        email: u.email,
        code: c,
        kdf: kdfJson(salt, TEST_ITERATIONS),
        authHash: keys.authKey.toString('base64'),
        wrappedVaultKey: wrapVaultKey(keys.wrapKey, vaultKey, AAD.vaultKey).toString('base64'),
        recovery: recoveryJson(vaultKey, randomBytes(20)),
      });
      const wrong = code === '12345678' ? '87654321' : '12345678';
      for (let i = 0; i < 5; i++) {
        assert.equal((await api(t.app, 'POST', '/v1/auth/reset/confirm', { body: body(wrong) })).status, 401);
      }
      assert.equal((await api(t.app, 'POST', '/v1/auth/reset/confirm', { body: body(code) })).status, 401);
    } finally {
      await t.close();
    }
  });
});
