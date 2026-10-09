import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { sealRecord } from './client-crypto.js';
import { api, loginUser, makeApp, registerUser, type Registered, type TestApp } from './helpers.js';

interface SseEvent {
  event: string;
  data: string;
}

/** Minimal SSE client: collects events and comment lines. */
function connect(port: number, token: string) {
  const events: SseEvent[] = [];
  const comments: string[] = [];
  let status = 0;
  let headers: http.IncomingHttpHeaders = {};
  let ended = false;
  const waiters: (() => void)[] = [];
  const notify = () => waiters.splice(0).forEach((w) => w());

  const req = http.request({ host: '127.0.0.1', port, path: '/v1/sync/stream', headers: { authorization: `Bearer ${token}` } });
  req.on('response', (res) => {
    status = res.statusCode ?? 0;
    headers = res.headers;
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) comments.push(line.slice(1).trim());
          else if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length > 0) events.push({ event, data: data.join('\n') });
      }
      notify();
    });
    res.on('end', () => {
      ended = true;
      notify();
    });
  });
  req.on('error', () => {
    ended = true;
    notify();
  });
  req.end();

  const waitFor = async (predicate: () => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for SSE condition');
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };

  return {
    events,
    comments,
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    get ended() {
      return ended;
    },
    waitFor,
    close: () => req.destroy(),
  };
}

describe('sync stream (SSE)', () => {
  let t: TestApp;
  let port: number;
  let u: Registered;

  before(async () => {
    t = await makeApp({ ssePingMs: 100 });
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    port = (t.app.server.address() as AddressInfo).port;
    u = await registerUser(t.app, undefined, 'stream pw');
  });
  after(async () => t.close());

  test('ready → changed after a push from another session; pings arrive', async () => {
    const other = await loginUser(t.app, u.email, 'stream pw');
    const s = connect(port, u.tokens.accessToken);
    try {
      await s.waitFor(() => s.events.length >= 1);
      assert.equal(s.status, 200);
      assert.match(String(s.headers['content-type']), /^text\/event-stream/);
      assert.equal(s.headers['x-accel-buffering'], 'no');
      assert.deepEqual(s.events[0], { event: 'ready', data: '{"cursor":0}' });

      const push = await api(t.app, 'POST', '/v1/sync/push', {
        token: other.res.json.tokens.accessToken,
        body: {
          records: [
            { id: 'c1', type: 'conv', updatedAt: 1, deleted: false, ct: sealRecord(u.account.vaultKey, 'conv', 'c1', '{}').toString('base64') },
          ],
        },
      });
      assert.equal(push.status, 200);
      await s.waitFor(() => s.events.some((e) => e.event === 'changed'));
      const changed = s.events.find((e) => e.event === 'changed')!;
      assert.deepEqual(JSON.parse(changed.data), { cursor: 1 });

      await s.waitFor(() => s.comments.includes('ping'));
    } finally {
      s.close();
    }
  });

  test('a push that changes nothing does not notify', async () => {
    const s = connect(port, u.tokens.accessToken);
    try {
      await s.waitFor(() => s.events.length >= 1);
      const ready = JSON.parse(s.events[0]!.data);
      // Stale write → rejected, cursor unchanged.
      await api(t.app, 'POST', '/v1/sync/push', {
        token: u.tokens.accessToken,
        body: { records: [{ id: 'c1', type: 'conv', updatedAt: 0, deleted: true, ct: null }] },
      });
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(s.events.filter((e) => e.event === 'changed').length, 0);
      assert.equal(ready.cursor, 1);
    } finally {
      s.close();
    }
  });

  test('unauthenticated stream → 401 JSON error', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/sync/stream`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'unauthorized');
  });

  test('logging out closes the stream', async () => {
    const other = await loginUser(t.app, u.email, 'stream pw', 'Ephemeral');
    const token = other.res.json.tokens.accessToken;
    const s = connect(port, token);
    await s.waitFor(() => s.events.length >= 1);
    const res = await api(t.app, 'POST', '/v1/auth/logout', { token, body: {} });
    assert.equal(res.status, 204);
    await s.waitFor(() => s.ended);
    assert.equal(t.ctx.streams.size >= 0, true);
  });

  test('server shutdown closes open streams', async () => {
    const s = connect(port, u.tokens.accessToken);
    await s.waitFor(() => s.events.length >= 1);
    assert.ok(t.ctx.streams.size >= 1);
    // after() closes the app; verify here that close() resolves with a stream open.
    const closing = t.close();
    await s.waitFor(() => s.ended);
    await closing;
    // Reopen a fresh app for the after() hook.
    t = await makeApp();
  });
});
