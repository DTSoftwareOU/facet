import { beforeEach, describe, expect, it } from 'vitest';
import { b64 } from '../../src/core/bytes';
import { McpClient } from '../../src/mcp/client';
import { McpAuthRequiredException, McpException, type McpAuthMode, type McpOAuthState, type McpServerConfig, type McpTokenStore } from '../../src/mcp/types';
import {
  bodyOf,
  empty,
  FakeMcpServer,
  FakeNet,
  initResult,
  installPlatform,
  json,
  rpcMethod,
  rpcResult,
  sleep,
  sse,
  SseFeed,
  TOOLS_PAGE,
} from './fakes';

const BASE = 'https://mcp.test';

class MemoryTokens implements McpTokenStore {
  map = new Map<string, McpOAuthState>();
  async load(id: string) {
    return this.map.get(id) ?? null;
  }
  async save(id: string, state: McpOAuthState | null) {
    if (state == null) this.map.delete(id);
    else this.map.set(id, state);
  }
}

const config = (authMode: McpAuthMode = 'NONE', headers: Record<string, string> = {}): McpServerConfig => ({
  id: 'srv',
  name: 'Test Server',
  url: `${BASE}/mcp`,
  authMode,
  headers,
});

async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

let net: FakeNet;

beforeEach(() => {
  net = new FakeNet();
  installPlatform(net);
});

describe('Streamable HTTP', () => {
  it('initializes, lists tools and sends session and version headers', async () => {
    const fake = new FakeMcpServer();
    net.handler = fake.handle;
    const client = new McpClient(config(), new MemoryTokens());
    const info = await client.connect();
    expect(info).toEqual({ name: 'fake-server', version: '1.2.3', protocolVersion: '2025-11-25', instructions: 'Use me wisely.' });

    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    const t = tools[0];
    expect(t.name).toBe('search');
    expect(t.title).toBe('Search');
    expect(t.readOnlyHint).toBe(true);
    expect(t.openWorldHint).toBe(true);
    expect(t.destructiveHint).toBeNull();
    expect(t.inputSchemaJson).toContain('"required":["q"]');

    const init = net.requests.find((r) => rpcMethod(r) === 'initialize')!;
    expect(init.headers.get('Accept')).toContain('application/json');
    expect(init.headers.get('Accept')).toContain('text/event-stream');
    expect(init.headers.get('Mcp-Session-Id')).toBeNull();
    expect(init.headers.get('User-Agent')).toBe('Facet/1.0.0');
    expect(bodyOf(init).params.protocolVersion).toBe('2025-11-25');
    expect(bodyOf(init).params.clientInfo.name).toBe('Facet AI');

    const list = net.requests.find((r) => rpcMethod(r) === 'tools/list')!;
    expect(list.headers.get('Mcp-Session-Id')).toBe('s1');
    expect(list.headers.get('MCP-Protocol-Version')).toBe('2025-11-25');
    expect(net.requests.some((r) => rpcMethod(r) === 'notifications/initialized' && r.headers.get('Mcp-Session-Id') === 's1')).toBe(true);
    client.close();
  });

  it('reads SSE responses, skips notifications and answers server pings', async () => {
    const fake = new FakeMcpServer();
    fake.onCall = (id) =>
      sse(
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n' +
          'data: {"jsonrpc":"2.0","id":"srv-1","method":"ping"}\n\n' +
          `data: {"jsonrpc":"2.0","id":${id},"result":{"content":[{"type":"text","text":"streamed answer"}]}}\n\n`,
      );
    net.handler = fake.handle;
    const client = new McpClient(config());
    const res = await client.callTool('search', '{"q":"x"}');
    expect(res.text).toBe('streamed answer');
    expect(res.isError).toBe(false);
    const pong = await net.waitFor((r) => bodyOf(r)?.id === 'srv-1');
    expect(bodyOf(pong).result).toEqual({});
    expect(pong.headers.get('Mcp-Session-Id')).toBe('s1');
    client.close();
  });

  it('re-initializes once when the session expires', async () => {
    const fake = new FakeMcpServer();
    net.handler = fake.handle;
    const client = new McpClient(config());
    await client.connect();
    fake.activeSession = 'server-restarted';
    expect(await client.listTools()).toHaveLength(1);
    expect(fake.initializes).toBe(2);
    expect(net.requests.filter((r) => rpcMethod(r) === 'tools/list').map((r) => r.headers.get('Mcp-Session-Id'))).toEqual(['s1', 's2']);
    client.close();
  });

  it('accepts an older supported version and sends its header', async () => {
    net.handler = new FakeMcpServer('2025-06-18').handle;
    const client = new McpClient(config());
    expect((await client.connect()).protocolVersion).toBe('2025-06-18');
    await client.listTools();
    expect(net.requests.find((r) => rpcMethod(r) === 'tools/list')!.headers.get('MCP-Protocol-Version')).toBe('2025-06-18');
    client.close();
  });

  it('omits the version header for versions that predate it', async () => {
    net.handler = new FakeMcpServer('2025-03-26').handle;
    const client = new McpClient(config());
    await client.listTools();
    expect(net.requests.find((r) => rpcMethod(r) === 'tools/list')!.headers.get('MCP-Protocol-Version')).toBeNull();
    client.close();
  });

  it('rejects an unsupported version', async () => {
    net.handler = new FakeMcpServer('2030-01-01').handle;
    const client = new McpClient(config());
    const e = await rejects(client.connect());
    expect(e).toBeInstanceOf(McpException);
    expect((e as Error).message).toContain('2030-01-01');
    client.close();
  });

  it('follows tool pagination and gives schemaless tools an object schema', async () => {
    const fake = new FakeMcpServer();
    fake.onList = (id, params) =>
      params?.cursor == null
        ? json(rpcResult(id, { tools: [{ name: 'a', inputSchema: { type: 'object' } }], nextCursor: 'page2' }))
        : params.cursor === 'page2'
          ? json(rpcResult(id, { tools: [{ name: 'b' }], nextCursor: '' }))
          : json(rpcResult(id, { tools: [] }));
    net.handler = fake.handle;
    const client = new McpClient(config());
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(tools[1].inputSchemaJson).toContain('"type":"object"');
    client.close();
  });

  it('flattens call results', async () => {
    const png = new Uint8Array([0x89, 80, 78, 71]);
    const fake = new FakeMcpServer();
    fake.onCall = (id, params) => {
      if (params.name === 'rich') {
        return json(rpcResult(id, {
          content: [
            { type: 'text', text: 'Found 2 items' },
            { type: 'image', data: b64(png), mimeType: 'image/png' },
            { type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello' } },
            { type: 'resource_link', uri: 'https://x.io/doc', name: 'Doc' },
            { type: 'audio', data: 'AAA', mimeType: 'audio/wav' },
          ],
          structuredContent: { count: 2 },
        }));
      }
      if (params.name === 'dup') return json(rpcResult(id, { content: [{ type: 'text', text: '{"count":2}' }], structuredContent: { count: 2 } }));
      return json(rpcResult(id, { content: [{ type: 'text', text: 'Permission denied' }], isError: true }));
    };
    net.handler = fake.handle;
    const client = new McpClient(config());

    const rich = await client.callTool('rich', '{}');
    expect(rich.isError).toBe(false);
    expect(rich.text.startsWith('Found 2 items')).toBe(true);
    expect(rich.text).toContain('[resource: file:///a.txt]\nhello');
    expect(rich.text).toContain('[resource link: Doc (https://x.io/doc)]');
    expect(rich.text).toContain('[audio omitted]');
    expect(rich.text).toContain('"count": 2');
    expect(rich.images).toHaveLength(1);
    expect(rich.images[0].mimeType).toBe('image/png');
    expect(Array.from(rich.images[0].bytes)).toEqual(Array.from(png));

    expect((await client.callTool('dup', '')).text).toBe('{"count":2}');

    const err = await client.callTool('broken', '{}');
    expect(err.isError).toBe(true);
    expect(err.text).toBe('Permission denied');

    const bad = await rejects(client.callTool('rich', 'not json'));
    expect((bad as Error).message).toContain('valid JSON');
    const call = bodyOf(net.requests.find((r) => rpcMethod(r) === 'tools/call')!).params;
    expect(call.name).toBe('rich');
    expect(call.arguments).toEqual({});
    client.close();
  });

  it('turns JSON-RPC errors into McpExceptions', async () => {
    const fake = new FakeMcpServer();
    fake.onCall = (id) => json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: nope' } });
    net.handler = fake.handle;
    const client = new McpClient(config());
    const e = await rejects(client.callTool('nope', '{}'));
    expect(e).toBeInstanceOf(McpException);
    expect((e as Error).message).toContain('Unknown tool: nope');
    expect((e as Error).message).toContain('-32602');
    client.close();
  });

  it('sends static headers in HEADERS mode', async () => {
    net.handler = new FakeMcpServer().handle;
    const client = new McpClient(config('HEADERS', { Authorization: 'Bearer static-key', 'X-Team': 'core' }));
    await client.listTools();
    for (const r of net.requests.filter((x) => x.method === 'POST')) {
      expect(r.headers.get('Authorization')).toBe('Bearer static-key');
      expect(r.headers.get('X-Team')).toBe('core');
    }
    client.close();
  });

  it('shares one initialize between concurrent calls', async () => {
    const fake = new FakeMcpServer();
    fake.initDelayMs = 150;
    net.handler = fake.handle;
    const client = new McpClient(config());
    const results = await Promise.all([1, 2, 3, 4].map((n) => client.callTool(`t${n}`, '{}')));
    expect(results.map((r) => r.text)).toEqual(['called t1', 'called t2', 'called t3', 'called t4']);
    expect(fake.initializes).toBe(1);
    const ids = net.requests.filter((r) => rpcMethod(r) === 'tools/call').map((r) => bodyOf(r).id);
    expect(new Set(ids).size).toBe(ids.length);
    client.close();
  });

  it('maps an unreachable server to a friendly error that keeps the network cause', async () => {
    net.handler = () => {
      throw new TypeError('fetch failed');
    };
    const client = new McpClient({ ...config(), name: 'Gone' });
    const e = await rejects(client.connect());
    expect(e).toBeInstanceOf(McpException);
    expect((e as Error).message.startsWith("Couldn't reach Gone")).toBe(true);
    expect((e as McpException).cause).toBeInstanceOf(TypeError);
  });

  it('says when an address is not an MCP server', async () => {
    net.handler = () => new Response('<html>hello</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    const e = await rejects(new McpClient(config()).connect());
    expect((e as Error).message).toContain('not as an MCP server');
  });

  it('deletes the session on close and refuses later calls', async () => {
    net.handler = new FakeMcpServer().handle;
    const client = new McpClient(config());
    await client.connect();
    client.close();
    const del = await net.waitFor((r) => r.method === 'DELETE');
    expect(del.headers.get('Mcp-Session-Id')).toBe('s1');
    const e = await rejects(client.listTools());
    expect((e as Error).message).toContain('closed');
  });

  it('cancels a call when the signal aborts and tells the server', async () => {
    const fake = new FakeMcpServer();
    fake.onCall = () => new Promise<Response>(() => {}); // never answers
    net.handler = fake.handle;
    const client = new McpClient(config());
    await client.connect();
    const ctrl = new AbortController();
    const pending = client.callTool('slow', '{}', ctrl.signal);
    await net.waitFor((r) => rpcMethod(r) === 'tools/call');
    ctrl.abort();
    const e = await rejects(pending);
    expect((e as Error).name).toBe('AbortError');
    const id = bodyOf(net.requests.find((r) => rpcMethod(r) === 'tools/call')!).id;
    const note = await net.waitFor((r) => rpcMethod(r) === 'notifications/cancelled');
    expect(bodyOf(note).params.requestId).toBe(id);
    client.close();
  });

  it('leaves out User-Agent on the website, where browsers would preflight it', async () => {
    installPlatform(net, { corsLimited: true, kind: 'web' });
    net.handler = new FakeMcpServer().handle;
    const client = new McpClient(config());
    await client.connect();
    expect(net.requests.every((r) => !r.headers.has('User-Agent'))).toBe(true);
    client.close();
  });
});

describe('legacy HTTP+SSE', () => {
  it('falls back when POST is not allowed', async () => {
    const feed = new SseFeed();
    feed.push('event: endpoint\ndata: /messages?sessionId=abc\n\n');
    const posted: any[] = [];
    net.handler = (req) => {
      const u = new URL(req.url);
      if (u.pathname === '/mcp' && req.method === 'POST') return empty(405);
      if (u.pathname === '/mcp' && req.method === 'GET') return feed.response();
      if (u.pathname === '/messages') {
        expect(u.searchParams.get('sessionId')).toBe('abc');
        const body = bodyOf(req);
        posted.push(body);
        const id = body.id;
        if (body.method === 'initialize') feed.push(`event: message\ndata: ${JSON.stringify(initResult(id, '2024-11-05', 'legacy'))}\n\n`);
        if (body.method === 'tools/list') feed.push(`event: message\ndata: ${JSON.stringify(rpcResult(id, TOOLS_PAGE))}\n\n`);
        if (body.method === 'tools/call') feed.push(`event: message\ndata: ${JSON.stringify(rpcResult(id, { content: [{ type: 'text', text: 'legacy ok' }] }))}\n\n`);
        return empty(202);
      }
      return empty(404);
    };
    const client = new McpClient(config());
    const info = await client.connect();
    expect(info.name).toBe('legacy');
    expect(info.protocolVersion).toBe('2024-11-05');
    expect((await client.listTools())[0].name).toBe('search');
    expect((await client.callTool('search', '{"q":"a"}')).text).toBe('legacy ok');
    expect(posted.some((b) => b.method === 'notifications/initialized')).toBe(true);
    expect(net.requests.find((r) => r.method === 'GET')!.headers.get('Accept')).toBe('text/event-stream');
    client.close();
    await sleep(10);
    expect(feed.closed).toBe(true);
  });

  it('reports a server that answers neither transport', async () => {
    net.handler = (req) => (req.method === 'POST' ? empty(404) : empty(404));
    const e = await rejects(new McpClient(config()).connect());
    expect((e as Error).message).toBe('No MCP server answered at this address (HTTP 404).');
  });
});

describe('auth', () => {
  const state = (over: Partial<McpOAuthState> = {}): McpOAuthState => ({
    authorizationEndpoint: `${BASE}/authorize`,
    tokenEndpoint: `${BASE}/token`,
    resource: `${BASE}/mcp`,
    clientId: 'cid',
    redirectUri: 'io.dtsoftware.facet:/oauth/mcp',
    accessToken: 'old',
    refreshToken: 'r1',
    ...over,
  });

  it('refreshes an expired token and retries', async () => {
    const tokens = new MemoryTokens();
    await tokens.save('srv', state());
    const fake = new FakeMcpServer();
    net.handler = (req) => {
      if (new URL(req.url).pathname === '/token') {
        expect(req.body).toContain('grant_type=refresh_token');
        expect(req.body).toContain('refresh_token=r1');
        expect(req.body).toContain('client_id=cid');
        expect(req.body).toContain('resource=');
        return json({ access_token: 'new', refresh_token: 'r2', expires_in: 3600, token_type: 'Bearer' });
      }
      if (req.headers.get('Authorization') !== 'Bearer new') return empty(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      return fake.handle(req);
    };
    const client = new McpClient(config('OAUTH'), tokens);
    expect(await client.listTools()).toHaveLength(1);
    const saved = (await tokens.load('srv'))!;
    expect(saved.accessToken).toBe('new');
    expect(saved.refreshToken).toBe('r2');
    expect(saved.expiresAt).toBeGreaterThan(Date.now());
    expect(net.requests.filter((r) => new URL(r.url).pathname === '/token')).toHaveLength(1);
    client.close();
  });

  it('refreshes proactively before expiry and keeps an unrotated refresh token', async () => {
    const tokens = new MemoryTokens();
    await tokens.save('srv', state({ accessToken: 'about-to-expire', resource: null, expiresAt: Date.now() + 5_000 }));
    const fake = new FakeMcpServer();
    net.handler = (req) => {
      if (new URL(req.url).pathname === '/token') return json({ access_token: 'fresh', expires_in: 3600 });
      expect(req.headers.get('Authorization')).toBe('Bearer fresh');
      return fake.handle(req);
    };
    const client = new McpClient(config('OAUTH'), tokens);
    await client.connect();
    expect((await tokens.load('srv'))!.accessToken).toBe('fresh');
    expect((await tokens.load('srv'))!.refreshToken).toBe('r1');
    client.close();
  });

  it('clears tokens and asks for sign-in when the refresh is rejected', async () => {
    const tokens = new MemoryTokens();
    await tokens.save('srv', state({ refreshToken: 'revoked' }));
    net.handler = (req) =>
      new URL(req.url).pathname === '/token'
        ? json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400)
        : empty(401, { 'WWW-Authenticate': 'Bearer resource_metadata="https://x/prm"' });
    const client = new McpClient(config('OAUTH'), tokens);
    const e = await rejects(client.connect());
    expect(e).toBeInstanceOf(McpAuthRequiredException);
    expect((e as McpAuthRequiredException).serverId).toBe('srv');
    expect((e as McpAuthRequiredException).wwwAuthenticate).toBe('Bearer resource_metadata="https://x/prm"');
    const s = (await tokens.load('srv'))!;
    expect(s.accessToken).toBeNull();
    expect(s.refreshToken).toBeNull();
    expect(s.clientId).toBe('cid'); // registration is kept for the next sign-in
    client.close();
  });

  it('asks for sign-in when there are no tokens', async () => {
    const challenge = `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="tools:read"`;
    net.handler = () => empty(401, { 'WWW-Authenticate': challenge });
    const e = await rejects(new McpClient(config(), new MemoryTokens()).listTools());
    expect(e).toBeInstanceOf(McpAuthRequiredException);
    expect((e as McpAuthRequiredException).wwwAuthenticate).toBe(challenge);
  });

  it('asks for sign-in on insufficient scope', async () => {
    const fake = new FakeMcpServer();
    fake.onCall = () => empty(403, { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="admin"' });
    net.handler = fake.handle;
    const e = await rejects(new McpClient(config()).callTool('x', '{}'));
    expect(e).toBeInstanceOf(McpAuthRequiredException);
    expect((e as McpAuthRequiredException).wwwAuthenticate).toContain('insufficient_scope');
  });
});
