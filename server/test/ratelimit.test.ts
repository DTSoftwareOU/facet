import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { defaultConfig } from '../src/config.js';
import { api, makeApp, registerUser, uniqueEmail } from './helpers.js';

describe('rate limiting (production defaults)', () => {
  test('login: 5 failures per email, then 429 with Retry-After', async () => {
    const t = await makeApp({ rateLimits: defaultConfig().rateLimits });
    try {
      const u = await registerUser(t.app);
      const attempt = (ip: string) =>
        api(t.app, 'POST', '/v1/auth/login', {
          body: { email: u.email, authHash: randomBytes(32).toString('base64') },
          ip,
        });
      // Spread over different IPs so only the per-email bucket is exercised.
      for (let i = 0; i < 5; i++) {
        const res = await attempt(`10.0.0.${i + 1}`);
        assert.equal(res.status, 401, `attempt ${i + 1}`);
      }
      const blocked = await attempt('10.0.0.99');
      assert.equal(blocked.status, 429);
      assert.equal(blocked.json.error.code, 'rate_limited');
      assert.ok(Number(blocked.headers['retry-after']) > 0);
    } finally {
      await t.close();
    }
  });

  test('auth endpoints: 10 requests per IP per window', async () => {
    const t = await makeApp({ rateLimits: defaultConfig().rateLimits });
    try {
      for (let i = 0; i < 10; i++) {
        const res = await api(t.app, 'POST', '/v1/auth/login', {
          body: { email: uniqueEmail('ip'), authHash: randomBytes(32).toString('base64') },
          ip: '192.0.2.7',
        });
        assert.equal(res.status, 401);
      }
      const blocked = await api(t.app, 'POST', '/v1/auth/login', {
        body: { email: uniqueEmail('ip'), authHash: randomBytes(32).toString('base64') },
        ip: '192.0.2.7',
      });
      assert.equal(blocked.status, 429);
      const otherIp = await api(t.app, 'POST', '/v1/auth/login', {
        body: { email: uniqueEmail('ip'), authHash: randomBytes(32).toString('base64') },
        ip: '192.0.2.8',
      });
      assert.equal(otherIp.status, 401, 'a different IP is unaffected');
    } finally {
      await t.close();
    }
  });

  test('prelogin: 30 per minute per IP', async () => {
    const t = await makeApp({ rateLimits: defaultConfig().rateLimits });
    try {
      for (let i = 0; i < 30; i++) {
        const res = await api(t.app, 'POST', '/v1/auth/prelogin', { body: { email: `p${i}@example.com` }, ip: '198.51.100.1' });
        assert.equal(res.status, 200);
      }
      const blocked = await api(t.app, 'POST', '/v1/auth/prelogin', { body: { email: 'p@example.com' }, ip: '198.51.100.1' });
      assert.equal(blocked.status, 429);
    } finally {
      await t.close();
    }
  });

  test('X-Forwarded-For is honoured when TRUST_PROXY is on', async () => {
    const t = await makeApp({ rateLimits: defaultConfig().rateLimits });
    try {
      for (let i = 0; i < 30; i++) {
        await t.app.inject({
          method: 'POST',
          url: '/v1/auth/prelogin',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.50' },
          payload: JSON.stringify({ email: `q${i}@example.com` }),
        });
      }
      const blocked = await t.app.inject({
        method: 'POST',
        url: '/v1/auth/prelogin',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.50' },
        payload: JSON.stringify({ email: 'q@example.com' }),
      });
      assert.equal(blocked.statusCode, 429);
      // Prepending a fake address doesn't help: only the hop added by the proxy is trusted.
      const spoofed = await t.app.inject({
        method: 'POST',
        url: '/v1/auth/prelogin',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9, 203.0.113.50' },
        payload: JSON.stringify({ email: 'q@example.com' }),
      });
      assert.equal(spoofed.statusCode, 429);
      const other = await t.app.inject({
        method: 'POST',
        url: '/v1/auth/prelogin',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.51' },
        payload: JSON.stringify({ email: 'q@example.com' }),
      });
      assert.equal(other.statusCode, 200);
    } finally {
      await t.close();
    }
  });
});
