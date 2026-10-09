/** Test doubles shared by the MCP and tools tests: a fake network, platform, stdio bridge and MCP server. */
import { b64, unb64 } from '../../src/core/bytes';
import { setPlatform, type Platform, type SecretBox, type StdioBridge } from '../../src/platform';

export const plainBox: SecretBox = {
  seal: async (plain) => 'v1:' + b64(plain),
  open: async (sealed) => unb64(sealed.slice(3)),
};

export interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  init: RequestInit;
}

export type Handler = (req: Recorded) => Response | Promise<Response>;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Records requests and answers them with [handler]; honors abort signals like real fetch. */
export class FakeNet {
  requests: Recorded[] = [];
  handler: Handler = () => new Response(null, { status: 404 });

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init.body == null ? '' : typeof init.body === 'string' ? init.body : String(init.body);
    const req: Recorded = { url, method: (init.method ?? 'GET').toUpperCase(), headers: new Headers(init.headers), body, init };
    const signal = init.signal;
    if (signal?.aborted) throw signal.reason;
    this.requests.push(req);
    const answer = Promise.resolve(this.handler(req));
    if (!signal) return answer;
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      answer.then(resolve, reject);
    });
  };

  /** Waits until a request matching [test] was made. */
  async waitFor(test: (r: Recorded) => boolean, timeoutMs = 3000): Promise<Recorded> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const hit = this.requests.find(test);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error('Timed out waiting for a request');
  }
}

export function fakePlatform(over: Partial<Platform> = {}): Platform {
  return {
    kind: 'desktop',
    apiPlatform: 'other',
    defaultServerUrl: 'https://sync.test',
    deviceName: async () => 'Test',
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    corsLimited: false,
    secrets: plainBox,
    openExternal: () => {},
    saveFile: async () => {},
    notify: () => {},
    oauth: {
      redirectUri: async () => 'http://127.0.0.1:4567/oauth/mcp',
      authorize: () => Promise.reject(new Error('No browser in tests')),
    },
    version: 'test',
    ...over,
  };
}

/** Installs a fake platform whose fetch goes to [net]. */
export function installPlatform(net: FakeNet, over: Partial<Platform> = {}): Platform {
  const p = fakePlatform({ fetch: net.fetch as typeof fetch, ...over });
  setPlatform(p);
  return p;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export const sse = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

export const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

export const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });

export const initResult = (id: unknown, version = '2025-11-25', name = 'fake-server') =>
  rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name, version: '1.2.3' }, instructions: 'Use me wisely.' });

export const TOOLS_PAGE = {
  tools: [
    {
      name: 'search',
      title: 'Search',
      description: 'Searches things',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
  ],
};

export const bodyOf = (r: Recorded): any => {
  try {
    return JSON.parse(r.body);
  } catch {
    return null;
  }
};
export const rpcMethod = (r: Recorded): string | undefined => bodyOf(r)?.method;

/** A minimal Streamable HTTP server at /mcp. Override [onCall] / [onList]. */
export class FakeMcpServer {
  initializes = 0;
  activeSession: string | null = null;
  initDelayMs = 0;

  constructor(readonly version = '2025-11-25', readonly sessionPrefix = 's') {}

  onCall(id: unknown, params: any): Response | Promise<Response> {
    return json(rpcResult(id, { content: [{ type: 'text', text: `called ${params.name}` }] }));
  }

  onList(id: unknown, _params: any): Response | Promise<Response> {
    return json(rpcResult(id, TOOLS_PAGE));
  }

  handle = async (req: Recorded): Promise<Response> => {
    if (new URL(req.url).pathname !== '/mcp') return empty(404);
    if (req.method === 'DELETE') return empty(204);
    const body = bodyOf(req);
    const id = body?.id;
    switch (body?.method) {
      case 'initialize': {
        if (this.initDelayMs) await sleep(this.initDelayMs);
        const sid = this.sessionPrefix + ++this.initializes;
        this.activeSession = sid;
        return json(initResult(id, this.version), 200, { 'Mcp-Session-Id': sid });
      }
      case 'notifications/initialized':
        return empty(202);
      default:
        if (req.headers.get('Mcp-Session-Id') !== this.activeSession) return empty(404);
        if (body?.method === 'tools/list') return this.onList(id, body.params);
        if (body?.method === 'tools/call') return this.onCall(id, body.params);
        if (body?.method == null) return empty(202); // a response to a server request
        return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }
  };
}

/** A streaming text/event-stream body the test pushes events into. */
export class SseFeed {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();
  closed = false;
  readonly stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      this.controller = c;
    },
    cancel: () => {
      this.closed = true;
    },
  });

  push(text: string): void {
    if (!this.closed) this.controller.enqueue(this.encoder.encode(text));
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.close();
  }

  response(): Response {
    return new Response(this.stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
}

/** One fake local server process. [behave] answers each message the client sends. */
export class FakeProcess {
  alive = true;
  received: any[] = [];
  readonly messageListeners = new Set<(m: string) => void>();
  readonly exitListeners = new Set<(code: number | null, stderr: string) => void>();

  constructor(readonly handle: string, readonly spec: Parameters<StdioBridge['spawn']>[0]) {}

  emit(message: unknown): void {
    const line = typeof message === 'string' ? message : JSON.stringify(message);
    for (const l of [...this.messageListeners]) l(line);
  }

  exit(code: number | null, stderr = ''): void {
    if (!this.alive) return;
    this.alive = false;
    for (const l of [...this.exitListeners]) l(code, stderr);
  }
}

/** A StdioBridge whose processes run [behavior] (a fake MCP server) in memory. */
export class FakeStdio implements StdioBridge {
  readonly processes: FakeProcess[] = [];
  killed: string[] = [];

  constructor(public behavior: (proc: FakeProcess, msg: any) => void = mcpBehavior()) {}

  async spawn(spec: Parameters<StdioBridge['spawn']>[0]): Promise<string> {
    const proc = new FakeProcess('h' + (this.processes.length + 1), spec);
    this.processes.push(proc);
    return proc.handle;
  }

  private proc(handle: string): FakeProcess {
    const p = this.processes.find((x) => x.handle === handle);
    if (!p) throw new Error('No such process');
    return p;
  }

  async send(handle: string, message: string): Promise<void> {
    const p = this.proc(handle);
    if (!p.alive) throw new Error('The process isn\'t running.');
    if (message.includes('\n')) throw new Error('A message must be one line.');
    const msg = JSON.parse(message);
    p.received.push(msg);
    queueMicrotask(() => {
      if (p.alive) this.behavior(p, msg);
    });
  }

  onMessage(handle: string, listener: (message: string) => void): () => void {
    const p = this.proc(handle);
    p.messageListeners.add(listener);
    return () => p.messageListeners.delete(listener);
  }

  onExit(handle: string, listener: (code: number | null, stderr: string) => void): () => void {
    const p = this.proc(handle);
    p.exitListeners.add(listener);
    return () => p.exitListeners.delete(listener);
  }

  async kill(handle: string): Promise<void> {
    this.killed.push(handle);
    this.proc(handle).exit(null, '');
  }
}

/** A small MCP server over stdio: logs a line, pings the client before answering tools/call, echoes env. */
export function mcpBehavior(version = '2025-06-18') {
  return (proc: FakeProcess, msg: any) => {
    if (msg.method === 'initialize') {
      proc.emit('Starting server (this line is a log, not JSON)');
      proc.emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: version, serverInfo: { name: 'local-fs', version: '0.1.0' }, instructions: 'Local tools.' } });
    } else if (msg.method === 'tools/list') {
      proc.emit(rpcResult(msg.id, { tools: [{ name: 'read_file', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }, { name: 'write_file' }] }));
    } else if (msg.method === 'tools/call') {
      proc.emit({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' });
      proc.emit({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } });
      proc.emit(rpcResult(msg.id, { content: [{ type: 'text', text: `${msg.params.name} in ${proc.spec.cwd} with TOKEN=${proc.spec.env?.TOKEN}` }] }));
    }
  };
}
