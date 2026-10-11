import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { defaultConfig } from '../src/config.js';
import { deviceSchema } from '../src/validation.js';
import { api, loginUser, makeApp, registerUser, type Registered, type TestApp } from './helpers.js';
import { connect } from './sse-client.js';

/** A syntactically valid envelope (the server can't and doesn't check what's inside). */
function envelope(size = 64, version = 0x01): string {
  const bytes = Buffer.alloc(size, 7);
  bytes[0] = version;
  return bytes.toString('base64');
}

describe('device relay', () => {
  let t: TestApp;
  let port: number;
  let a: Registered;
  let bToken: string;
  let bSession: string;
  let stranger: Registered;

  before(async () => {
    const base = defaultConfig();
    t = await makeApp({
      ssePingMs: 100,
      limits: { ...base.limits, maxRelayBytes: 1024 },
      rateLimits: { ...base.rateLimits, relay: { max: 20, windowMs: 60_000 } },
    });
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    port = (t.app.server.address() as AddressInfo).port;
    a = await registerUser(t.app, undefined, 'relay pw');
    const b = await loginUser(t.app, a.email, 'relay pw', 'Pixel 9');
    bToken = b.res.json.tokens.accessToken;
    bSession = b.res.json.tokens.sessionId;
    stranger = await registerUser(t.app);
  });
  after(async () => t.close());

  test('peers lists the other sessions that are streaming', async () => {
    const none = await api(t.app, 'GET', '/v1/relay/peers', { token: a.tokens.accessToken });
    assert.equal(none.status, 200);
    assert.deepEqual(none.json, { peers: [] });

    const sb = connect(port, bToken);
    try {
      await sb.waitFor(() => sb.events.some((e) => e.event === 'ready'));
      const res = await api(t.app, 'GET', '/v1/relay/peers', { token: a.tokens.accessToken });
      assert.deepEqual(res.json, { peers: [{ sessionId: bSession, deviceName: 'Pixel 9', platform: 'android' }] });
      // A session never lists itself, and other accounts see nothing.
      assert.deepEqual((await api(t.app, 'GET', '/v1/relay/peers', { token: bToken })).json, { peers: [] });
      assert.deepEqual((await api(t.app, 'GET', '/v1/relay/peers', { token: stranger.tokens.accessToken })).json, { peers: [] });
    } finally {
      sb.close();
    }
  });

  test('presence events announce sessions coming and going', async () => {
    const sa = connect(port, a.tokens.accessToken);
    try {
      await sa.waitFor(() => sa.events.some((e) => e.event === 'ready'));
      const sb = connect(port, bToken);
      await sa.waitFor(() => sa.events.some((e) => e.event === 'presence'));
      assert.deepEqual(JSON.parse(sa.events.find((e) => e.event === 'presence')!.data), { sessionId: bSession, online: true });

      // A second stream of the same session doesn't announce again; closing one of two doesn't either.
      const sb2 = connect(port, bToken);
      await sb2.waitFor(() => sb2.events.some((e) => e.event === 'ready'));
      sb2.close();
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(sa.events.filter((e) => e.event === 'presence').length, 1);

      sb.close();
      await sa.waitFor(() => sa.events.filter((e) => e.event === 'presence').length === 2);
      assert.deepEqual(JSON.parse(sa.events.filter((e) => e.event === 'presence')[1]!.data), { sessionId: bSession, online: false });
    } finally {
      sa.close();
    }
  });

  test('a message reaches the target session with the sender id', async () => {
    const sb = connect(port, bToken);
    try {
      await sb.waitFor(() => sb.events.some((e) => e.event === 'ready'));
      const msg = envelope();
      const res = await api(t.app, 'POST', '/v1/relay', { token: a.tokens.accessToken, body: { to: bSession, msg } });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { delivered: 1 });
      await sb.waitFor(() => sb.events.some((e) => e.event === 'relay'));
      assert.deepEqual(JSON.parse(sb.events.find((e) => e.event === 'relay')!.data), { from: a.tokens.sessionId, msg });
    } finally {
      sb.close();
    }
  });

  test('offline sessions and other accounts can’t be reached', async () => {
    // The previous test's stream closes asynchronously on the server.
    const deadline = Date.now() + 3000;
    while ((await api(t.app, 'GET', '/v1/relay/peers', { token: a.tokens.accessToken })).json.peers.length > 0) {
      if (Date.now() > deadline) throw new Error('stream never closed');
      await new Promise((r) => setTimeout(r, 25));
    }
    const offline = await api(t.app, 'POST', '/v1/relay', { token: a.tokens.accessToken, body: { to: bSession, msg: envelope() } });
    assert.equal(offline.status, 404);
    assert.equal(offline.json.error.code, 'peer_offline');

    const sb = connect(port, bToken);
    try {
      await sb.waitFor(() => sb.events.some((e) => e.event === 'ready'));
      const cross = await api(t.app, 'POST', '/v1/relay', { token: stranger.tokens.accessToken, body: { to: bSession, msg: envelope() } });
      assert.equal(cross.status, 404);
      assert.equal(cross.json.error.code, 'peer_offline');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(sb.events.filter((e) => e.event === 'relay').length, 0);
    } finally {
      sb.close();
    }
  });

  test('rejects bad envelopes, oversize messages and messages to itself', async () => {
    const token = a.tokens.accessToken;
    const post = (body: unknown) => api(t.app, 'POST', '/v1/relay', { token, body });
    assert.equal((await post({ to: bSession, msg: '%%%' })).status, 400);
    assert.equal((await post({ to: bSession, msg: envelope(64, 0x02) })).status, 400);
    assert.equal((await post({ to: bSession, msg: envelope(20) })).status, 400);
    assert.equal((await post({ to: bSession, msg: envelope(2048) })).status, 413);
    assert.equal((await post({ to: a.tokens.sessionId, msg: envelope() })).status, 400);
    assert.equal((await api(t.app, 'POST', '/v1/relay', { body: { to: bSession, msg: envelope() } })).status, 401);
  });

  test('rate-limits each session', async () => {
    const s = await registerUser(t.app);
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      statuses.push((await api(t.app, 'POST', '/v1/relay', { token: s.tokens.accessToken, body: { to: bSession, msg: envelope() } })).status);
    }
    assert.ok(statuses.slice(0, 20).every((st) => st === 404));
    assert.equal(statuses[21], 429);
  });

  test('windows is a known platform', () => {
    assert.equal(deviceSchema.parse({ name: 'OFFICE-PC', platform: 'windows' }).platform, 'windows');
    assert.equal(deviceSchema.parse({ name: 'Toaster', platform: 'toaster' }).platform, 'other');
  });
});
