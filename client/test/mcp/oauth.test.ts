import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalResource, parseBearerChallenge, s256 } from '../../src/mcp/internal';
import { McpOAuth, OAuthErrorException } from '../../src/mcp/oauth';
import { McpException } from '../../src/mcp/types';
import { empty, FakeNet, installPlatform, json, type Recorded } from './fakes';

const BASE = 'https://srv.test';
const REDIRECT = 'io.dtsoftware.facet:/oauth/mcp';
const path = (r: Recorded) => new URL(r.url).pathname;

let net: FakeNet;

beforeEach(() => {
  net = new FakeNet();
  installPlatform(net);
});

async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

/** Protected resource at /mcp, authorization server at /auth (issuer with a path). */
function standardServer(opts: { prmPath?: string; withRegistration?: boolean; methods?: string[] } = {}) {
  const prmPath = opts.prmPath ?? '/.well-known/oauth-protected-resource/mcp';
  const auth = `${BASE}/auth`;
  return (req: Recorded): Response => {
    switch (path(req)) {
      case prmPath:
        return json({ resource: `${BASE}/mcp`, authorization_servers: [auth], scopes_supported: ['tools:read', 'tools:write'] });
      case '/.well-known/oauth-authorization-server/auth':
        return json({
          issuer: auth,
          authorization_endpoint: `${auth}/authorize`,
          token_endpoint: `${auth}/token`,
          ...(opts.withRegistration === false ? {} : { registration_endpoint: `${auth}/register` }),
          code_challenge_methods_supported: opts.methods ?? ['S256'],
          response_types_supported: ['code'],
        });
      case '/auth/register':
        return json({ client_id: 'cid-123', client_id_issued_at: 1 }, 201);
      case '/auth/token':
        return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 120, token_type: 'Bearer', scope: 'tools:read' });
      default:
        return empty(404);
    }
  };
}

describe('McpOAuth', () => {
  it('discovers, registers and builds the authorization URL, then exchanges the code', async () => {
    net.handler = standardServer();
    const serverUrl = `${BASE}/mcp`;
    const pending = await McpOAuth.begin('srv', serverUrl, null, REDIRECT, 'Facet');

    const url = new URL(pending.authorizationUrl);
    expect(url.pathname).toBe('/auth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid-123');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(await s256(pending.codeVerifier));
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(url.searchParams.get('resource')).toBe(serverUrl);
    expect(url.searchParams.get('scope')).toBe('tools:read tools:write');
    expect(pending.authorizationUrl).toContain('scope=tools%3Aread%20tools%3Awrite');
    expect(pending.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pending.codeVerifier.length).toBeLessThanOrEqual(128);

    const reg = JSON.parse(net.requests.find((r) => path(r) === '/auth/register')!.body);
    expect(reg.client_name).toBe('Facet');
    expect(reg.redirect_uris[0]).toBe(REDIRECT);
    expect(reg.token_endpoint_auth_method).toBe('none');
    expect(reg.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(reg.scope).toBe('tools:read tools:write');

    expect(pending.oauth.clientId).toBe('cid-123');
    expect(pending.oauth.accessToken).toBeUndefined();

    const state = await McpOAuth.complete(pending, 'code-xyz');
    expect(state.accessToken).toBe('at-1');
    expect(state.refreshToken).toBe('rt-1');
    expect(state.scope).toBe('tools:read');
    expect(state.expiresAt).toBeGreaterThan(Date.now() + 100_000);
    const tokenReq = net.requests.find((r) => path(r) === '/auth/token')!;
    expect(tokenReq.body).toContain('grant_type=authorization_code');
    expect(tokenReq.body).toContain('code=code-xyz');
    expect(tokenReq.body).toContain(`code_verifier=${pending.codeVerifier}`);
    expect(tokenReq.body).toContain('client_id=cid-123');
    expect(tokenReq.body).toContain('resource=');
    expect(tokenReq.headers.get('Authorization')).toBeNull(); // public client
  });

  it('uses resource metadata from the challenge and its scope', async () => {
    net.handler = standardServer({ prmPath: '/custom/prm' });
    const challenge = `Bearer resource_metadata="${BASE}/custom/prm", scope="tools:read"`;
    const pending = await McpOAuth.begin('srv', `${BASE}/mcp`, challenge, REDIRECT, 'Facet');
    expect(new URL(pending.authorizationUrl).searchParams.get('scope')).toBe('tools:read');
    expect(net.requests.some((r) => path(r) === '/.well-known/oauth-protected-resource/mcp')).toBe(false);
  });

  it('reuses a previous registration', async () => {
    net.handler = standardServer();
    const first = await McpOAuth.begin('srv', `${BASE}/mcp`, null, REDIRECT, 'Facet');
    const before = net.requests.filter((r) => path(r) === '/auth/register').length;
    const second = await McpOAuth.begin('srv', `${BASE}/mcp`, null, REDIRECT, 'Facet', first.oauth);
    expect(net.requests.filter((r) => path(r) === '/auth/register').length).toBe(before);
    expect(second.oauth.clientId).toBe('cid-123');
    // A different redirect (another device or platform) registers again.
    await McpOAuth.begin('srv', `${BASE}/mcp`, null, 'https://facet.test/app/oauth-callback.html', 'Facet', first.oauth);
    expect(net.requests.filter((r) => path(r) === '/auth/register').length).toBe(before + 1);
  });

  it('falls back to the origin when there is no protected resource metadata', async () => {
    net.handler = (req) => {
      switch (path(req)) {
        case '/.well-known/oauth-authorization-server':
          return json({ issuer: BASE, authorization_endpoint: `${BASE}/oauth/authorize`, token_endpoint: `${BASE}/oauth/token`, registration_endpoint: `${BASE}/oauth/register` });
        case '/oauth/register':
          return json({ client_id: 'legacy-client' });
        default:
          return empty(404);
      }
    };
    const pending = await McpOAuth.begin('srv', `${BASE}/sse`, null, REDIRECT, 'Facet');
    expect(new URL(pending.authorizationUrl).pathname).toBe('/oauth/authorize');
    expect(pending.oauth.clientId).toBe('legacy-client');
    expect(new URL(pending.authorizationUrl).searchParams.get('scope')).toBeNull();
  });

  it('uses default endpoints when there is no metadata at all', async () => {
    net.handler = (req) => (path(req) === '/register' ? json({ client_id: 'd' }) : empty(404));
    const pending = await McpOAuth.begin('srv', `${BASE}/mcp`, null, REDIRECT, 'Facet');
    expect(new URL(pending.authorizationUrl).pathname).toBe('/authorize');
    expect(pending.oauth.tokenEndpoint.endsWith('/token')).toBe(true);
    expect(pending.oauth.resource).toBe(`${BASE}/mcp`);
  });

  it('refuses without a registration endpoint', async () => {
    net.handler = standardServer({ withRegistration: false });
    const e = await rejects(McpOAuth.begin('srv', `${BASE}/mcp`, null, REDIRECT, 'Facet'));
    expect(e).toBeInstanceOf(McpException);
    expect(e.message).toContain('registered in advance');
  });

  it('refuses without S256', async () => {
    net.handler = standardServer({ methods: ['plain'] });
    const e = await rejects(McpOAuth.begin('srv', `${BASE}/mcp`, null, REDIRECT, 'Facet'));
    expect(e.message).toContain('PKCE');
  });

  it('makes token errors readable', async () => {
    const base = standardServer();
    net.handler = (req) => (path(req) === '/auth/token' ? json({ error: 'invalid_grant', error_description: 'Code expired' }, 400) : base(req));
    const pending = await McpOAuth.begin('srv', `${BASE}/mcp`, null, REDIRECT, 'Facet');
    const e = await rejects(McpOAuth.complete(pending, 'old-code'));
    expect(e).toBeInstanceOf(McpException);
    expect(e.message).toContain('Code expired');
  });

  it('uses Basic auth for confidential clients', async () => {
    net.handler = standardServer();
    const pending = await McpOAuth.begin('srv', `${BASE}/mcp`, null, REDIRECT, 'Facet');
    await McpOAuth.complete({ ...pending, oauth: { ...pending.oauth, clientSecret: 's3cret' } }, 'c');
    const tokenReq = net.requests.filter((r) => path(r) === '/auth/token').pop()!;
    expect(tokenReq.headers.get('Authorization')).toBe('Basic ' + btoa('cid-123:s3cret'));
  });

  it('refreshes, keeping the refresh token when not rotated, and reports a dead grant', async () => {
    net.handler = (req) => (req.body.includes('refresh_token=good') ? json({ access_token: 'a2', expires_in: '60' }) : json({ error: 'invalid_grant' }, 400));
    const base = { authorizationEndpoint: `${BASE}/a`, tokenEndpoint: `${BASE}/t`, clientId: 'c', redirectUri: REDIRECT };
    const next = await McpOAuth.refresh({ ...base, refreshToken: 'good' });
    expect(next.accessToken).toBe('a2');
    expect(next.refreshToken).toBe('good');
    expect(next.expiresAt).toBeGreaterThan(Date.now());
    const e = await rejects(McpOAuth.refresh({ ...base, refreshToken: 'bad' }));
    expect(e).toBeInstanceOf(OAuthErrorException);
    expect((e as OAuthErrorException).error).toBe('invalid_grant');
  });

  it('says so when the sign-in service is unreachable', async () => {
    net.handler = (req) => {
      if (path(req) === '/register') throw new TypeError('fetch failed');
      return empty(404);
    };
    const e = await rejects(McpOAuth.begin('srv', `${BASE}/mcp`, null, REDIRECT, 'Facet'));
    expect(e.message).toBe("Couldn't reach the server's sign-in service.");
    expect((e as McpException).cause).toBeInstanceOf(TypeError);
  });
});

describe('helpers', () => {
  it('parses challenges', () => {
    const p = parseBearerChallenge('Bearer realm="x", resource_metadata="https://a.b/.well-known/oauth-protected-resource", scope="a b", error=insufficient_scope');
    expect(p.resource_metadata).toBe('https://a.b/.well-known/oauth-protected-resource');
    expect(p.scope).toBe('a b');
    expect(p.error).toBe('insufficient_scope');
    expect(parseBearerChallenge(null)).toEqual({});
  });

  it('canonicalizes resources', () => {
    expect(canonicalResource('HTTPS://MCP.Example.com:443/mcp/')).toBe('https://mcp.example.com/mcp');
    expect(canonicalResource('http://localhost:8080/')).toBe('http://localhost:8080');
    expect(canonicalResource('https://x.io/a?b=1#frag')).toBe('https://x.io/a');
  });

  it('computes the RFC 7636 S256 challenge', async () => {
    expect(await s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});
