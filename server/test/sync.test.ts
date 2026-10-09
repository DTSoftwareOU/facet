import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openRecord, sealRecord } from './client-crypto.js';
import { api, loginUser, makeApp, registerUser, type Registered, type TestApp } from './helpers.js';

function rec(r: Registered, type: string, id: string, payload: object, updatedAt: number, deleted = false) {
  return {
    id,
    type,
    updatedAt,
    deleted,
    ct: deleted ? null : sealRecord(r.account.vaultKey, type, id, JSON.stringify(payload)).toString('base64'),
  };
}

describe('sync push/pull', () => {
  let t: TestApp;
  let u: Registered;
  before(async () => {
    t = await makeApp();
    u = await registerUser(t.app, undefined, 'sync password');
  });
  after(async () => t.close());

  const push = (records: unknown[], token = u.tokens.accessToken) =>
    api(t.app, 'POST', '/v1/sync/push', { token, body: { records } });
  const pull = (since: number, limit?: number, token = u.tokens.accessToken) =>
    api(t.app, 'GET', `/v1/sync/pull?since=${since}${limit ? `&limit=${limit}` : ''}`, { token });

  test('empty pull', async () => {
    const res = await pull(0);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { records: [], cursor: 0, hasMore: false });
  });

  test('push inserts with increasing seq; another device pulls and decrypts', async () => {
    const res = await push([
      rec(u, 'conv', 'c1', { title: 'Hello' }, 1000),
      rec(u, 'msg', 'm1', { text: 'Hi there' }, 1001),
    ]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.accepted, [
      { id: 'c1', type: 'conv', seq: 1 },
      { id: 'm1', type: 'msg', seq: 2 },
    ]);
    assert.deepEqual(res.json.rejected, []);
    assert.equal(res.json.cursor, 2);

    const other = await loginUser(t.app, u.email, 'sync password');
    assert.equal(other.res.status, 200);
    const p = await pull(0, undefined, other.res.json.tokens.accessToken);
    assert.equal(p.json.records.length, 2);
    assert.equal(p.json.cursor, 2);
    const conv = p.json.records[0];
    assert.equal(conv.seq, 1);
    assert.equal(conv.updatedAt, 1000);
    assert.equal(conv.deleted, false);
    const plain = openRecord(other.vaultKey!, 'conv', 'c1', Buffer.from(conv.ct, 'base64'));
    assert.deepEqual(JSON.parse(plain), { title: 'Hello' });
  });

  test('last writer wins; stale writes are rejected with the current copy', async () => {
    const newer = await push([rec(u, 'conv', 'c1', { title: 'Renamed' }, 2000)]);
    assert.deepEqual(newer.json.accepted, [{ id: 'c1', type: 'conv', seq: 3 }]);

    const stale = await push([rec(u, 'conv', 'c1', { title: 'Old edit' }, 1500)]);
    assert.equal(stale.json.accepted.length, 0);
    assert.equal(stale.json.rejected.length, 1);
    const rej = stale.json.rejected[0];
    assert.equal(rej.reason, 'stale');
    assert.equal(rej.current.updatedAt, 2000);
    assert.equal(rej.current.seq, 3);
    assert.deepEqual(JSON.parse(openRecord(u.account.vaultKey, 'conv', 'c1', Buffer.from(rej.current.ct, 'base64'))), {
      title: 'Renamed',
    });
    assert.equal(stale.json.cursor, 3);

    const tie = await push([rec(u, 'conv', 'c1', { title: 'Tie' }, 2000)]);
    assert.deepEqual(tie.json.accepted, [{ id: 'c1', type: 'conv', seq: 4 }], 'equal updatedAt overwrites');
  });

  test('identical retries are idempotent and do not bump the cursor', async () => {
    const r = rec(u, 'folder', 'f1', { name: 'Work' }, 3000);
    const a = await push([r]);
    const b = await push([r]);
    assert.deepEqual(a.json.accepted, b.json.accepted);
    assert.equal(a.json.cursor, b.json.cursor);
  });

  test('tombstones win ties and only yield to strictly newer live writes', async () => {
    const del = await push([rec(u, 'msg', 'm1', {}, 5000, true)]);
    assert.equal(del.json.accepted.length, 1);

    const tieLive = await push([rec(u, 'msg', 'm1', { text: 'resurrect?' }, 5000)]);
    assert.equal(tieLive.json.rejected.length, 1, 'live write at the same time does not resurrect');
    assert.equal(tieLive.json.rejected[0].current.deleted, true);
    assert.equal(tieLive.json.rejected[0].current.ct, null);

    const newerLive = await push([rec(u, 'msg', 'm1', { text: 'back' }, 5001)]);
    assert.equal(newerLive.json.accepted.length, 1, 'strictly newer live write resurrects');

    const p = await pull(0);
    const m1 = p.json.records.find((x: any) => x.id === 'm1');
    assert.equal(m1.deleted, false);
  });

  test('records of different types may share an id', async () => {
    const res = await push([rec(u, 'asst', 'same', { a: 1 }, 1), rec(u, 'prompt', 'same', { b: 2 }, 1)]);
    assert.equal(res.json.accepted.length, 2);
  });

  test('pull pages with hasMore and cursor', async () => {
    const all = await pull(0);
    const total = all.json.records.length;
    assert.ok(total >= 4);
    const page1 = await pull(0, 2);
    assert.equal(page1.json.records.length, 2);
    assert.equal(page1.json.hasMore, true);
    const page2 = await pull(page1.json.cursor, 1000);
    assert.equal(page2.json.records.length, total - 2);
    assert.equal(page2.json.hasMore, false);
    // Records come back ordered by seq, each id once (latest version only).
    const seqs = all.json.records.map((x: any) => x.seq);
    assert.deepEqual(seqs, [...seqs].sort((a: number, b: number) => a - b));
    const caught = await pull(all.json.cursor);
    assert.deepEqual(caught.json.records, []);
    assert.equal(caught.json.cursor, all.json.cursor);
  });

  test('pull with a cursor from the future asks the client to reset', async () => {
    const res = await pull(999_999);
    assert.equal(res.status, 200);
    assert.equal(res.json.reset, true);
    assert.equal(res.json.cursor, 0);
  });

  test('validation: bad ids, missing ct, bad envelopes', async () => {
    const badId = await push([{ id: 'has space', type: 'conv', updatedAt: 1, deleted: false, ct: 'AQ==' }]);
    assert.equal(badId.status, 400);
    assert.match(badId.json.error.message, /^records\.0\.id:/);

    const missingCt = await push([{ id: 'x', type: 'conv', updatedAt: 1, deleted: false }]);
    assert.equal(missingCt.status, 400);
    assert.match(missingCt.json.error.message, /records\.0\.ct/);

    const wrongVersion = await push([
      { id: 'x', type: 'conv', updatedAt: 1, deleted: false, ct: Buffer.alloc(40, 2).toString('base64') },
    ]);
    assert.equal(wrongVersion.status, 400);

    const badType = await push([{ id: 'x', type: 'Conv', updatedAt: 1, deleted: false, ct: null }]);
    assert.equal(badType.status, 400);
  });

  test('limits: record size and batch length', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
    const tooBig = await push([{ id: 'big', type: 'msg', updatedAt: 1, deleted: false, ct: big.toString('base64') }]);
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.json.error.code, 'too_large');

    const many = Array.from({ length: 501 }, (_, i) => ({ id: `t${i}`, type: 'msg', updatedAt: 1, deleted: true, ct: null }));
    const tooMany = await push(many);
    assert.equal(tooMany.status, 413);
    assert.equal(tooMany.json.error.code, 'too_large');

    const body = 'x'.repeat(9 * 1024 * 1024);
    const hugeBody = await t.app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: { authorization: `Bearer ${u.tokens.accessToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ records: [], pad: body }),
    });
    assert.equal(hugeBody.statusCode, 413);
    assert.equal(hugeBody.json().error.code, 'too_large');
  });

  test('sync requires auth', async () => {
    const res = await api(t.app, 'GET', '/v1/sync/pull?since=0');
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'unauthorized');
  });

  test('users are isolated', async () => {
    const other = await registerUser(t.app);
    const p = await api(t.app, 'GET', '/v1/sync/pull?since=0', { token: other.tokens.accessToken });
    assert.deepEqual(p.json.records, []);
  });
});

describe('tombstone purge horizon', () => {
  let t: TestApp;
  before(async () => (t = await makeApp({ tombstoneRetentionMs: 0 })));
  after(async () => t.close());

  test('pulling from before a purged tombstone requests a reset; since=0 still works', async () => {
    const u = await registerUser(t.app);
    const push = (records: unknown[]) => api(t.app, 'POST', '/v1/sync/push', { token: u.tokens.accessToken, body: { records } });
    await push([rec(u, 'conv', 'a', { x: 1 }, 1)]); // seq 1
    await push([rec(u, 'conv', 'b', { x: 2 }, 1)]); // seq 2
    await push([rec(u, 'conv', 'a', {}, 2, true)]); // seq 3 tombstone
    await new Promise((r) => setTimeout(r, 5));
    const purged = t.ctx.store.housekeeping();
    assert.equal(purged.tombstones, 1);

    const stale = await api(t.app, 'GET', '/v1/sync/pull?since=1', { token: u.tokens.accessToken });
    assert.equal(stale.json.reset, true);
    const full = await api(t.app, 'GET', '/v1/sync/pull?since=0', { token: u.tokens.accessToken });
    assert.equal(full.json.reset, undefined);
    assert.deepEqual(
      full.json.records.map((x: any) => x.id),
      ['b'],
    );
    const fresh = await api(t.app, 'GET', '/v1/sync/pull?since=3', { token: u.tokens.accessToken });
    assert.equal(fresh.json.reset, undefined);
  });
});
