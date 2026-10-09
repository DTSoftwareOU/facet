import { beforeEach, describe, expect, it } from 'vitest';
import { fromUtf8, utf8 } from '../../src/core/bytes';
import { db, FacetDb, setDb } from '../../src/data/db';
import { McpAuthRequiredException } from '../../src/mcp/types';
import { MCP_DIRECTORY, MCP_CATEGORIES, filterDirectory } from '../../src/tools/mcpDirectory';
import { MCP_BROWSER_BLOCKED, McpManager, joinCommandLine, splitCommandLine, stdioName } from '../../src/tools/mcpManager';
import { empty, FakeMcpServer, FakeNet, FakeStdio, installPlatform, json, plainBox, type Recorded } from '../mcp/fakes';

const BASE = 'https://mcp.test';
const path = (r: Recorded) => new URL(r.url).pathname;

let net: FakeNet;
let changes: number;
let mcp: McpManager;

beforeEach(() => {
  setDb(new FacetDb('test-' + Math.random()));
  net = new FakeNet();
  installPlatform(net);
  changes = 0;
  mcp = new McpManager(() => changes++);
});

async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

const openSealed = async (sealed: string) => JSON.parse(fromUtf8(await plainBox.open(sealed)));

describe('configuration', () => {
  it('adds a server with sealed headers and defaults, and marks it for sync', async () => {
    const e = await mcp.add('', `${BASE}/mcp`, 'HEADERS', { Authorization: 'Bearer k', ' ': 'dropped' });
    expect(e.name).toBe('mcp.test');
    expect(e.dirty).toBe(1);
    expect(e.approval).toBe('WRITES');
    expect(e.enabled).toBe(true);
    expect(e.headersSealed.startsWith('v1:')).toBe(true);
    expect(await mcp.headers(e)).toEqual({ Authorization: 'Bearer k' });
    expect(changes).toBe(1);
    expect(mcp.approval(e)).toBe('WRITES');
    expect((await mcp.add('Second', `${BASE}/two`, 'NONE', {})).sort).toBe(1);
  });

  it('changes tools, approvals and auto-approvals as user edits', async () => {
    const e = await mcp.add('Srv', `${BASE}/mcp`, 'NONE', {});
    await db().mcpServers.update(e.id, { dirty: 0 });
    await mcp.setToolEnabled(e.id, 'delete_all', false);
    await mcp.setAutoApprove(e.id, 'search', true);
    await mcp.autoApprove(e.id, 'list');
    await mcp.setApproval(e.id, 'ALWAYS');
    let s = (await mcp.get(e.id))!;
    expect([...mcp.disabledTools(s)]).toEqual(['delete_all']);
    expect([...mcp.autoApproved(s)].sort()).toEqual(['list', 'search']);
    expect(mcp.approval(s)).toBe('ALWAYS');
    expect(s.dirty).toBe(1);
    expect(s.updatedAt).toBeGreaterThanOrEqual(e.updatedAt);
    await mcp.setToolEnabled(e.id, 'delete_all', true);
    await mcp.setAutoApprove(e.id, 'search', false);
    s = (await mcp.get(e.id))!;
    expect(mcp.disabledTools(s).size).toBe(0);
    expect([...mcp.autoApproved(s)]).toEqual(['list']);
    expect(changes).toBe(7);
  });

  it('clears the sign-in when the address or auth mode changes', async () => {
    const e = await mcp.add('Srv', `${BASE}/mcp`, 'OAUTH', {});
    await db().mcpServers.update(e.id, { oauthSealed: 'v1:e30=' });
    await mcp.update(e.id, 'Srv', `${BASE}/mcp`, 'OAUTH', null);
    expect((await mcp.get(e.id))!.oauthSealed).toBe('v1:e30=');
    await mcp.update(e.id, 'Srv', `${BASE}/other`, 'OAUTH', null);
    expect((await mcp.get(e.id))!.oauthSealed).toBe('');
  });

  it('soft-deletes and clears secrets', async () => {
    const e = await mcp.add('Srv', `${BASE}/mcp`, 'HEADERS', { A: 'b' });
    await mcp.delete(e.id);
    const s = (await mcp.get(e.id))!;
    expect(s.deleted).toBe(1);
    expect(s.dirty).toBe(1);
    expect(s.headersSealed).toBe('');
    expect(await mcp.all()).toEqual([]);
    await expect(mcp.call(e.id, 'x', '{}')).rejects.toThrow('That MCP server was removed.');
  });
});

describe('connections', () => {
  it('caches tools and instructions, then reuses the session for calls', async () => {
    const fake = new FakeMcpServer();
    net.handler = fake.handle;
    const e = await mcp.add('Srv', `${BASE}/mcp`, 'NONE', {});
    await db().mcpServers.update(e.id, { status: 'old problem' });
    const tools = await mcp.refreshTools(e.id);
    expect(tools.map((t) => t.name)).toEqual(['search']);
    const s = (await mcp.get(e.id))!;
    expect(s.status).toBeNull();
    expect(s.instructions).toBe('Use me wisely.');
    expect(s.toolsFetchedAt).toBeGreaterThan(0);
    expect(mcp.tools(s)[0]).toMatchObject({ name: 'search', title: 'Search', readOnlyHint: true });
    expect(JSON.parse(s.toolsJson)[0]).not.toHaveProperty('destructiveHint'); // nulls omitted, as on Android
    expect((await mcp.call(e.id, 'search', '{"q":"a"}')).text).toBe('called search');
    expect((await mcp.call(e.id, 'search', '{"q":"b"}')).text).toBe('called search');
    expect(fake.initializes).toBe(1);
    mcp.closeAll();
  });

  it('records connection problems as the status', async () => {
    net.handler = () => empty(500);
    const e = await mcp.add('Srv', `${BASE}/mcp`, 'NONE', {});
    const err = await rejects(mcp.refreshTools(e.id));
    expect(err.message).toBe('Srv had a server error (HTTP 500).');
    expect((await mcp.get(e.id))!.status).toBe('Srv had a server error (HTTP 500).');
  });

  it('marks servers that need a sign-in', async () => {
    net.handler = () => empty(401, { 'WWW-Authenticate': 'Bearer realm="x"' });
    const e = await mcp.add('Srv', `${BASE}/mcp`, 'NONE', {});
    expect(await rejects(mcp.refreshTools(e.id))).toBeInstanceOf(McpAuthRequiredException);
    expect((await mcp.get(e.id))!.status).toBe(McpManager.STATUS_SIGN_IN);
    const call = await rejects(mcp.call(e.id, 'x', '{}'));
    expect(call.message).toBe('Srv needs you to sign in again. Open Settings → MCP servers.');
  });

  it('on the website, tells a server that blocks browsers apart from one that is down', async () => {
    installPlatform(net, { corsLimited: true, kind: 'web' });
    let reachable = true;
    net.handler = (req) => {
      if (req.init.mode === 'no-cors' && req.method === 'HEAD' && reachable) return empty(200);
      throw new TypeError('Failed to fetch');
    };
    const e = await mcp.add('Srv', `${BASE}/mcp`, 'NONE', {});
    expect((await rejects(mcp.refreshTools(e.id))).message).toBe(MCP_BROWSER_BLOCKED);
    expect((await mcp.get(e.id))!.status).toBe(MCP_BROWSER_BLOCKED);
    reachable = false;
    expect((await rejects(mcp.refreshTools(e.id))).message).toBe("Couldn't reach Srv. Check the address and your connection.");
  });

  it('warms up servers that have no tools cached yet', async () => {
    const fake = new FakeMcpServer();
    net.handler = fake.handle;
    const a = await mcp.add('A', `${BASE}/mcp`, 'NONE', {});
    const b = await mcp.add('B', `${BASE}/mcp`, 'NONE', {});
    await mcp.setEnabled(b.id, false);
    mcp.warmUp();
    for (let i = 0; i < 100 && !(await mcp.get(a.id))!.toolsFetchedAt; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await mcp.get(a.id))!.toolsFetchedAt).toBeGreaterThan(0);
    expect((await mcp.get(b.id))!.toolsFetchedAt).toBe(0);
    mcp.closeAll();
  });

  it('tests an unsaved server without storing anything', async () => {
    net.handler = new FakeMcpServer().handle;
    const r = await mcp.test({ name: 'Try', url: `${BASE}/mcp`, authMode: 'NONE', headers: {} });
    expect(r.info.name).toBe('fake-server');
    expect(r.tools).toHaveLength(1);
    expect(await db().mcpServers.count()).toBe(0);
  });
});

describe('OAuth', () => {
  function oauthServer() {
    const fake = new FakeMcpServer();
    return (req: Recorded): Response | Promise<Response> => {
      switch (path(req)) {
        case '/.well-known/oauth-protected-resource/mcp':
          return json({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
        case '/.well-known/oauth-authorization-server':
          return json({ issuer: BASE, authorization_endpoint: `${BASE}/authorize`, token_endpoint: `${BASE}/token`, registration_endpoint: `${BASE}/register`, code_challenge_methods_supported: ['S256'] });
        case '/register':
          return json({ client_id: 'cid-9' });
        case '/token':
          if (req.body.includes('grant_type=refresh_token')) return json({ access_token: 'at-2', expires_in: 3600 });
          return req.body.includes('code=the-code') ? json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
        case '/mcp': {
          const auth = req.headers.get('Authorization');
          if (auth !== 'Bearer at-1' && auth !== 'Bearer at-2') {
            return empty(401, { 'WWW-Authenticate': `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"` });
          }
          return fake.handle(req);
        }
        default:
          return empty(404);
      }
    };
  }

  it('signs in through the OAuth bridge, stores Android-compatible state and connects', async () => {
    net.handler = oauthServer();
    let opened = '';
    installPlatform(net, {
      oauth: {
        redirectUri: async () => 'http://127.0.0.1:4567/oauth/mcp',
        authorize: async (authUrl, redirectUri) => {
          opened = authUrl;
          return `${redirectUri}?code=the-code&state=${new URL(authUrl).searchParams.get('state')}`;
        },
      },
    });
    const e = await mcp.add('Srv', `${BASE}/mcp`, 'NONE', {});
    const tools = await mcp.signIn(e.id);
    expect(tools.map((t) => t.name)).toEqual(['search']);
    expect(new URL(opened).searchParams.get('client_id')).toBe('cid-9');
    const s = (await mcp.get(e.id))!;
    expect(s.authMode).toBe('OAUTH');
    expect(s.dirty).toBe(1);
    expect(mcp.isSignedIn(s)).toBe(true);
    const state = await openSealed(s.oauthSealed);
    expect(Object.keys(state).sort()).toEqual(
      ['accessToken', 'authorizationEndpoint', 'clientId', 'expiresAt', 'issuer', 'redirectUri', 'refreshToken', 'registrationEndpoint', 'resource', 'tokenEndpoint'].sort(),
    );
    expect(state).toMatchObject({ clientId: 'cid-9', accessToken: 'at-1', refreshToken: 'rt-1', redirectUri: 'http://127.0.0.1:4567/oauth/mcp', resource: `${BASE}/mcp` });
    expect(net.requests.filter((r) => path(r) === '/mcp' && r.headers.get('Authorization') === 'Bearer at-1').length).toBeGreaterThan(0);
    mcp.closeAll();
  });

  it('opens the sign-in page within the click when prepared ahead', async () => {
    net.handler = oauthServer();
    let opened = false;
    installPlatform(net, {
      oauth: {
        redirectUri: async () => 'https://facet.test/app/oauth-callback.html',
        authorize: async (authUrl, redirectUri) => {
          opened = true;
          return `${redirectUri}?code=the-code&state=${new URL(authUrl).searchParams.get('state')}`;
        },
      },
    });
    const e = await mcp.add('Srv', `${BASE}/mcp`, 'NONE', {});
    const pending = await mcp.prepareSignIn(e.id);
    expect(opened).toBe(false);
    const done = mcp.finishSignIn(pending);
    expect(opened).toBe(true); // synchronously, as browsers require for popups
    expect((await done).map((t) => t.name)).toEqual(['search']);
    mcp.closeAll();
  });

  it('refuses a redirect with the wrong state, and reports a cancelled sign-in', async () => {
    net.handler = oauthServer();
    const e = await mcp.add('Srv', `${BASE}/mcp`, 'NONE', {});
    let reply = (redirect: string, _state: string) => `${redirect}?code=the-code&state=forged`;
    installPlatform(net, {
      oauth: {
        redirectUri: async () => 'http://127.0.0.1:4567/oauth/mcp',
        authorize: async (authUrl, redirectUri) => reply(redirectUri, new URL(authUrl).searchParams.get('state')!),
      },
    });
    expect((await rejects(mcp.signIn(e.id))).message).toBe('This sign-in link expired. Start again from Settings.');
    reply = (redirect, state) => `${redirect}?error=access_denied&state=${state}`;
    expect((await rejects(mcp.signIn(e.id))).message).toBe('Sign-in was cancelled.');
    expect((await mcp.get(e.id))!.oauthSealed).toBe('');
  });

  it('persists refreshed tokens and picks up tokens synced from another device', async () => {
    net.handler = oauthServer();
    const e = await mcp.add('Srv', `${BASE}/mcp`, 'OAUTH', {});
    const expiring = {
      authorizationEndpoint: `${BASE}/authorize`, tokenEndpoint: `${BASE}/token`, clientId: 'cid-9', redirectUri: 'x:/cb',
      accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 1_000,
    };
    await db().mcpServers.update(e.id, { oauthSealed: await plainBox.seal(utf8(JSON.stringify(expiring))), dirty: 0 });
    await mcp.refreshTools(e.id);
    const s = (await mcp.get(e.id))!;
    expect(s.dirty).toBe(1);
    const saved = await openSealed(s.oauthSealed);
    expect(saved.accessToken).toBe('at-2');
    expect(saved.refreshToken).toBe('rt-1');
    // The sync engine writes a newer state from another device: the next load sees it.
    await db().mcpServers.update(e.id, { oauthSealed: await plainBox.seal(utf8(JSON.stringify({ ...saved, accessToken: 'from-phone' }))) });
    expect((await mcp.load(e.id))!.accessToken).toBe('from-phone');
    await mcp.signOut(e.id);
    expect(await mcp.load(e.id)).toBeNull();
    mcp.closeAll();
  });
});

describe('local (stdio) servers', () => {
  it('needs the Windows app', async () => {
    await expect(mcp.addStdio({ name: '', command: 'npx', args: [] })).rejects.toThrow('Local servers run only in the Facet app for Windows.');
  });

  it('adds, connects, edits and deletes a local server that never syncs', async () => {
    const stdio = new FakeStdio();
    installPlatform(net, { stdio });
    const e = await mcp.addStdio({ name: '', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.2', 'C:\\Users\\me'], cwd: ' C:\\work ', env: { TOKEN: 't1' } });
    expect(e.name).toBe('server-filesystem');
    expect(e.stdio).toEqual({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.2', 'C:\\Users\\me'], cwd: 'C:\\work' });
    expect(e.dirty).toBe(0);
    expect(mcp.isStdio(e)).toBe(true);
    expect(await mcp.headers(e)).toEqual({ TOKEN: 't1' });
    const tools = await mcp.refreshTools(e.id);
    expect(tools.map((t) => t.name)).toEqual(['read_file', 'write_file']);
    expect((await mcp.call(e.id, 'read_file', '{}')).text).toBe('read_file in C:\\work with TOKEN=t1');

    await mcp.setApproval(e.id, 'NEVER');
    await mcp.updateStdio(e.id, { name: 'Files', command: 'npx', args: ['-y', 'pkg'], cwd: null });
    const s = (await mcp.get(e.id))!;
    expect(s.dirty).toBe(0);
    expect(s.name).toBe('Files');
    expect(await mcp.headers(s)).toEqual({ TOKEN: 't1' }); // env kept when not given
    expect(stdio.killed).toEqual(['h1']); // editing restarts the process
    expect(changes).toBe(0);

    await mcp.call(e.id, 'read_file', '{}');
    await mcp.delete(e.id);
    expect(await mcp.get(e.id)).toBeUndefined();
    expect(stdio.killed).toEqual(['h1', 'h2']);
    expect(changes).toBe(0);
  });

  it('names and splits command lines', () => {
    expect(splitCommandLine('npx -y "@scope/server x" "C:\\Program Files\\App" O\'Brien')).toEqual(['npx', '-y', '@scope/server x', 'C:\\Program Files\\App', "O'Brien"]);
    expect(joinCommandLine(['node', 'C:\\My Tools\\server.js', ''])).toBe('node "C:\\My Tools\\server.js" ""');
    expect(stdioName({ command: 'uvx', args: ['mcp-server-git'] })).toBe('mcp-server-git');
    expect(stdioName({ command: 'docker', args: ['run', '-i', '--rm', 'mcp/fetch'] })).toBe('fetch');
    expect(stdioName({ command: 'C:\\tools\\my-server.exe', args: [] })).toBe('my-server');
    expect(stdioName({ command: 'npx', args: [] })).toBe('npx');
  });
});

describe('directory', () => {
  it('lists all servers with known categories', () => {
    expect(MCP_DIRECTORY).toHaveLength(84);
    const ids = new Set(MCP_CATEGORIES.map((c) => c.id));
    expect(MCP_DIRECTORY.every((e) => ids.has(e.category) && e.url.startsWith('https://'))).toBe(true);
    expect(new Set(MCP_DIRECTORY.map((e) => e.url)).size).toBe(84);
  });

  it('filters like the settings screen', () => {
    const popular = filterDirectory('', null, []);
    expect(popular.every((e) => e.popular)).toBe(true);
    expect(filterDirectory('', null, ['https://mcp.deepwiki.com/mcp/']).some((e) => e.name === 'DeepWiki')).toBe(false);
    expect(filterDirectory('', 'FINANCE', []).map((e) => e.name)).toEqual(['CoinGecko', 'Alpha Vantage']);
    expect(filterDirectory('payments', null, []).map((e) => e.name)).toContain('PayPal');
  });
});
