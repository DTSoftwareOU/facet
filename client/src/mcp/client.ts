/**
 * Client for one MCP server (port of McpClient.kt). Speaks Streamable HTTP (2025-03-26 and later)
 * and falls back to the legacy HTTP+SSE transport (2024-11-05) automatically; in the Windows app it
 * also runs local servers over stdio (newline-delimited JSON-RPC through platform().stdio).
 * Sessions are re-established when the server expires them (or a local server exits), and OAuth
 * tokens are refreshed when they lapse, so a long-lived instance keeps working as long as the
 * token store does.
 *
 * Safe for concurrent use: initialization and token refresh are serialized; requests run in parallel.
 */
import { isObject } from '../core/json';
import { readSse } from '../core/sse';
import { t } from '../i18n';
import { platform, type StdioBridge } from '../platform';
import {
  discard,
  isAbortError,
  jarr,
  jobj,
  jstr,
  Mcp,
  Mutex,
  parseBearerChallenge,
  parseTool,
  raceAbort,
  rpcErrorText,
  flattenCallResult,
  TIMED_OUT,
  withDeadline,
  type Json,
} from './internal';
import { McpOAuth, OAuthErrorException } from './oauth';
import {
  McpAuthRequiredException,
  McpException,
  type McpCallResult,
  type McpServerConfig,
  type McpServerInfo,
  type McpTokenStore,
  type McpTool,
} from './types';

type Mode = 'STREAMABLE' | 'LEGACY' | 'STDIO';

/** The server forgot our session (HTTP 404 with a session id), its stream closed, or the local process exited. */
class SessionExpired extends Error {
  constructor(readonly detail: string | null = null) {
    super('Session expired');
  }
}

class Unauthorized extends Error {
  constructor(readonly wwwAuthenticate: string | null, readonly tokenUsed: string | null) {
    super('Unauthorized');
  }
}

class NotStreamable extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

class RpcError extends Error {
  constructor(readonly error: Json) {
    super(rpcErrorText(error));
  }
}

interface Sent {
  response: Response;
  token: string | null;
}

const NO_TOKENS: McpTokenStore = { load: async () => null, save: async () => {} };

function rpc(id: number | null, method: string, params: Json | null): string {
  const msg: Json = { jsonrpc: '2.0' };
  if (id != null) msg.id = id;
  msg.method = method;
  if (params != null) msg.params = params;
  return JSON.stringify(msg);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Requests waiting for their response on a shared channel (legacy SSE stream, stdio), by JSON-RPC id. */
class PendingRequests {
  dead = false;
  /** Why the channel ended (a local server's exit code and the end of its stderr). */
  detail: string | null = null;
  private waiting = new Map<string, { resolve: (o: Json) => void; reject: (e: unknown) => void }>();

  register(id: number): Promise<Json> {
    if (this.dead) throw new SessionExpired(this.detail);
    const p = new Promise<Json>((resolve, reject) => this.waiting.set(String(id), { resolve, reject }));
    p.catch(() => {});
    return p;
  }

  forget(id: number): void {
    this.waiting.delete(String(id));
  }

  /** Routes one incoming message (or batch): responses to their waiter, server requests to [onRequest]. */
  dispatch(data: string, onRequest: (o: Json) => void): void {
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // Servers sometimes log to stdout; ignore lines that aren't JSON.
    }
    const list = Array.isArray(msg) ? msg.filter(isObject) : isObject(msg) ? [msg] : [];
    for (const o of list) {
      const msgId = jstr(o, 'id');
      if (jstr(o, 'method') != null) {
        if (msgId != null) onRequest(o);
        continue;
      }
      if (msgId == null) continue;
      const w = this.waiting.get(msgId);
      if (w) {
        this.waiting.delete(msgId);
        w.resolve(o);
      }
    }
  }

  end(detail: string | null): void {
    if (this.dead) return;
    this.dead = true;
    this.detail = detail;
    for (const w of this.waiting.values()) w.reject(new SessionExpired(detail));
    this.waiting.clear();
  }
}

/** The long-lived GET stream of a legacy server, demultiplexing responses by id. */
class LegacyChannel extends PendingRequests {
  endpointUrl: string | null = null;
  readonly endpoint: Promise<string>;
  private resolveEndpoint!: (url: string) => void;
  private rejectEndpoint!: (e: unknown) => void;

  constructor(
    private readonly ctrl: AbortController,
    body: ReadableStream<Uint8Array>,
    private readonly baseUrl: string,
    private readonly serverName: string,
    private readonly onRequest: (o: Json) => void,
  ) {
    super();
    this.endpoint = new Promise<string>((resolve, reject) => {
      this.resolveEndpoint = resolve;
      this.rejectEndpoint = reject;
    });
    this.endpoint.catch(() => {});
    void this.read(body);
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const ev of readSse(body, this.ctrl.signal)) {
        if (ev.event === 'endpoint') {
          const url = this.resolve(ev.data);
          if (url) {
            this.endpointUrl = url;
            this.resolveEndpoint(url);
          }
        } else if (ev.event === 'message') {
          this.dispatch(ev.data, this.onRequest);
        }
      }
    } catch {
      // Stream dropped or was cancelled: fail pending requests below.
    } finally {
      this.rejectEndpoint(new McpException(t('{server} closed the connection.', { server: this.serverName })));
      this.end(null);
    }
  }

  private resolve(data: string): string | null {
    try {
      const u = new URL(data.trim(), this.baseUrl);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.ctrl.abort();
    this.end(null);
  }
}

/** A local server process (Windows app): one JSON-RPC message per line on stdin/stdout. */
class StdioChannel extends PendingRequests {
  private unsubscribers: (() => void)[] = [];

  constructor(private readonly bridge: StdioBridge, readonly handle: string, onRequest: (o: Json) => void) {
    super();
    // Subscribed right after spawn resolves, before any later bridge event can be delivered.
    this.unsubscribers.push(bridge.onMessage(handle, (m) => this.dispatch(m, onRequest)));
    this.unsubscribers.push(
      bridge.onExit(handle, (code, stderr) => {
        this.end(exitDetail(code, stderr));
        this.unsubscribe();
      }),
    );
  }

  /** Writes one message (the bridge adds the newline). A dead process expires the session. */
  async send(message: string): Promise<void> {
    if (this.dead) throw new SessionExpired(this.detail);
    try {
      await this.bridge.send(this.handle, message);
    } catch (e) {
      throw new SessionExpired(this.detail ?? errorText(e));
    }
  }

  private unsubscribe(): void {
    for (const u of this.unsubscribers.splice(0)) u();
  }

  close(): void {
    const running = !this.dead;
    this.end(null);
    this.unsubscribe();
    if (running) this.bridge.kill(this.handle).catch(() => {});
  }
}

function exitDetail(code: number | null, stderr: string): string {
  const head = code == null ? 'it stopped' : `exit code ${code}`;
  const tail = stderr.trim().split(/\r?\n/).slice(-3).join('\n').slice(-400).trim();
  return tail ? `${head}: ${tail}` : head;
}

export class McpClient {
  /** tools/call deadline. */
  static readonly CALL_TIMEOUT_MS = 120_000;
  /** initialize / tools/list deadline. */
  static readonly REQUEST_TIMEOUT_MS = 30_000;
  /** A local server may download its package first (npx, uvx), so it gets longer to start. */
  static readonly STDIO_START_TIMEOUT_MS = 90_000;
  private static readonly MAX_PAGES = 50;

  private readonly initLock = new Mutex();
  private readonly authLock = new Mutex();
  private ids = 1;
  private mode: Mode | null = null;
  private sessionId: string | null = null;
  private negotiated: string | null = null;
  private info: McpServerInfo | null = null;
  private generation = 0;
  private legacy: LegacyChannel | null = null;
  private stdio: StdioChannel | null = null;
  private closed = false;
  /** The last OAuth token sent, so close() can end the session with it. */
  private lastToken: string | null = null;

  constructor(readonly config: McpServerConfig, private readonly tokens: McpTokenStore = NO_TOKENS) {}

  /** Connects (initialize + initialized) if needed and returns the server's identity. */
  async connect(): Promise<McpServerInfo> {
    return (await this.ensureSession()).info;
  }

  /** Lists every tool, following pagination. */
  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const params: Json | null = cursor != null ? { cursor } : null;
      const result = await this.request('tools/list', params, McpClient.REQUEST_TIMEOUT_MS, signal);
      for (const el of jarr(result, 'tools') ?? []) {
        const tool = isObject(el) ? parseTool(el) : null;
        if (tool) out.push(tool);
      }
      const next = jstr(result, 'nextCursor');
      cursor = next ? next : null;
    } while (cursor != null && ++pages < McpClient.MAX_PAGES);
    return out;
  }

  /** Calls a tool. [argumentsJson] must be a JSON object (or blank for no arguments). Aborting [signal] cancels the call. */
  async callTool(name: string, argumentsJson: string, signal?: AbortSignal): Promise<McpCallResult> {
    let args: Json = {};
    if (argumentsJson.trim()) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(argumentsJson);
      } catch {
        parsed = null;
      }
      if (!isObject(parsed)) throw new McpException(`The arguments for "${name}" aren't a valid JSON object.`);
      args = parsed;
    }
    return flattenCallResult(await this.request('tools/call', { name, arguments: args }, McpClient.CALL_TIMEOUT_MS, signal));
  }

  /** Ends the session (best effort) and stops background readers and local processes. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.legacy?.close();
    this.legacy = null;
    this.stdio?.close();
    this.stdio = null;
    const sid = this.sessionId;
    if (this.mode === 'STREAMABLE' && sid != null) {
      const headers = new Headers({ [Mcp.HEADER_SESSION]: sid });
      if (this.negotiated && Mcp.VERSIONS_WITH_HEADER.has(this.negotiated)) headers.set(Mcp.HEADER_VERSION, this.negotiated);
      this.staticAuth(headers);
      if (this.config.authMode === 'OAUTH' && this.lastToken) headers.set('Authorization', `Bearer ${this.lastToken}`);
      platform().fetch(this.config.url, { method: 'DELETE', headers }).then(discard, () => {});
    }
  }

  // ---------------------------------------------------------------- request pipeline

  private async request(method: string, params: Json | null, timeoutMs: number, signal?: AbortSignal): Promise<Json> {
    let reinitialized = false;
    let refreshed = false;
    while (true) {
      const { gen } = await raceAbort(this.ensureSession(), signal);
      const id = this.ids++;
      try {
        const result = await withDeadline(timeoutMs, signal, (s) => this.send(id, method, params, s));
        if (result === TIMED_OUT) {
          this.notifyCancelled(id, 'Timed out');
          throw new McpException(t('{server} didn\'t answer within {seconds} seconds.', { server: this.config.name, seconds: timeoutMs / 1000 }));
        }
        return result;
      } catch (e) {
        if (e instanceof SessionExpired) {
          if (reinitialized) throw new McpException(t('{server} keeps ending the session. Try again in a moment.', { server: this.config.name }));
          reinitialized = true;
          await this.invalidate(gen);
          continue;
        }
        if (e instanceof Unauthorized) {
          if (refreshed || !(await this.refreshTokens(e.tokenUsed))) throw new McpAuthRequiredException(this.config.id, e.wwwAuthenticate);
          refreshed = true;
          continue;
        }
        if (e instanceof RpcError) throw new McpException(`${this.config.name}: ${e.message}`);
        if (e instanceof McpException || e instanceof McpAuthRequiredException) throw e;
        if (signal?.aborted || isAbortError(e)) {
          this.notifyCancelled(id, 'Cancelled by the user');
          throw e;
        }
        if (this.closed) throw new McpException(t('This connection to {server} was closed.', { server: this.config.name }));
        throw new McpException(t('Couldn\'t reach {server}. Check the address and your connection.', { server: this.config.name }), null, e);
      }
    }
  }

  private send(id: number, method: string, params: Json | null, signal: AbortSignal): Promise<Json> {
    switch (this.mode) {
      case 'LEGACY':
        return this.legacyRequest(id, method, params, signal);
      case 'STDIO':
        return this.stdioRequest(id, method, params, signal);
      default:
        return this.streamableRequest(id, method, params, signal);
    }
  }

  private async ensureSession(): Promise<{ info: McpServerInfo; gen: number }> {
    if (this.closed) throw new McpException(t('This connection to {server} was closed.', { server: this.config.name }));
    if (this.info) return { info: this.info, gen: this.generation };
    return this.initLock.run(async () => {
      if (this.closed) throw new McpException(t('This connection to {server} was closed.', { server: this.config.name }));
      if (this.info) return { info: this.info, gen: this.generation };
      let refreshed = false;
      while (true) {
        try {
          const info = await this.initializeLocked();
          return { info, gen: this.generation };
        } catch (e) {
          if (e instanceof Unauthorized) {
            if (refreshed || !(await this.refreshTokens(e.tokenUsed))) throw new McpAuthRequiredException(this.config.id, e.wwwAuthenticate);
            refreshed = true;
            continue;
          }
          if (e instanceof RpcError) throw new McpException(t('{server} refused to start a session: {reason}', { server: this.config.name, reason: e.message }));
          if (e instanceof SessionExpired) throw new McpException(t('Couldn\'t start a session with {server}.', { server: this.config.name }));
          if (e instanceof McpException || e instanceof McpAuthRequiredException) throw e;
          throw new McpException(t('Couldn\'t reach {server}. Check the address and your connection.', { server: this.config.name }), null, e);
        }
      }
    });
  }

  private invalidate(gen: number): Promise<void> {
    return this.initLock.run(async () => {
      if (this.generation !== gen) return;
      this.info = null;
      this.sessionId = null;
      this.legacy?.close();
      this.legacy = null;
      this.stdio?.close();
      this.stdio = null;
    });
  }

  private async initializeLocked(): Promise<McpServerInfo> {
    let result: McpServerInfo;
    if (this.config.stdio) {
      result = await this.initStdio();
    } else if (this.mode === 'STREAMABLE') {
      result = await this.initStreamable(false);
    } else if (this.mode === 'LEGACY') {
      result = await this.initLegacy();
    } else {
      try {
        result = await this.initStreamable(true);
      } catch (e) {
        if (!(e instanceof NotStreamable)) throw e;
        try {
          result = await this.initLegacy();
        } catch (legacyError) {
          if (legacyError instanceof McpException) throw new McpException(t('No MCP server answered at this address (HTTP {status}).', { status: String(e.status) }), e.status);
          throw legacyError;
        }
      }
    }
    this.generation++;
    return result;
  }

  private initParams(): Json {
    return {
      protocolVersion: Mcp.LATEST_VERSION,
      capabilities: {},
      clientInfo: { name: Mcp.CLIENT_NAME, title: Mcp.CLIENT_NAME, version: Mcp.CLIENT_VERSION },
    };
  }

  private serverInfo(result: Json): McpServerInfo {
    const version = jstr(result, 'protocolVersion');
    if (version == null) throw new McpException(t('{server} didn\'t say which MCP version it speaks.', { server: this.config.name }));
    if (!Mcp.SUPPORTED_VERSIONS.includes(version)) {
      throw new McpException(t('{server} uses MCP version {version}, which Facet doesn\'t support yet.', { server: this.config.name, version }));
    }
    const si = jobj(result, 'serverInfo');
    this.negotiated = version;
    const instructions = jstr(result, 'instructions');
    const built: McpServerInfo = {
      name: jstr(si, 'title') ?? jstr(si, 'name') ?? this.config.name,
      version: jstr(si, 'version'),
      protocolVersion: version,
      instructions: instructions != null && instructions.trim() ? instructions : null,
    };
    this.info = built;
    return built;
  }

  // ---------------------------------------------------------------- Streamable HTTP

  private async initStreamable(allowFallback: boolean): Promise<McpServerInfo> {
    const id = this.ids++;
    this.sessionId = null;
    this.negotiated = null;
    const answer = await withDeadline(McpClient.REQUEST_TIMEOUT_MS, undefined, async (signal) => {
      const sent = await this.post(this.config.url, rpc(id, 'initialize', this.initParams()), false, signal);
      if (allowFallback && [400, 404, 405].includes(sent.response.status)) {
        discard(sent.response);
        throw new NotStreamable(sent.response.status);
      }
      this.checkStatus(sent.response, true, sent.token);
      const session = sent.response.headers.get(Mcp.HEADER_SESSION);
      return { result: await this.readResponse(sent.response, id, signal), session };
    });
    if (answer === TIMED_OUT) throw new McpException(t('{server} didn\'t answer the initialize request.', { server: this.config.name }));
    this.sessionId = answer.session;
    this.mode = 'STREAMABLE';
    const built = this.serverInfo(answer.result);
    // notifications/initialized: no id; servers answer 202.
    const ack = await withDeadline(McpClient.REQUEST_TIMEOUT_MS, undefined, (signal) =>
      this.post(this.config.url, rpc(null, 'notifications/initialized', null), true, signal),
    );
    if (ack !== TIMED_OUT) {
      discard(ack.response);
      if (ack.response.status === 401) throw new Unauthorized(ack.response.headers.get('WWW-Authenticate'), ack.token);
    }
    return built;
  }

  private async streamableRequest(id: number, method: string, params: Json | null, signal: AbortSignal): Promise<Json> {
    const sent = await this.post(this.config.url, rpc(id, method, params), true, signal);
    this.checkStatus(sent.response, false, sent.token);
    return this.readResponse(sent.response, id, signal);
  }

  /** Builds and sends a POST, returning the live response (caller reads or discards) and the token it carried. */
  private async post(url: string, body: string, includeSession: boolean, signal?: AbortSignal): Promise<Sent> {
    const token = await this.currentAccessToken();
    const headers = new Headers({ Accept: Mcp.ACCEPT_STREAMABLE, 'Content-Type': 'application/json' });
    this.applyAuth(headers, token);
    if (includeSession) {
      if (this.sessionId != null) headers.set(Mcp.HEADER_SESSION, this.sessionId);
      if (this.negotiated && Mcp.VERSIONS_WITH_HEADER.has(this.negotiated)) headers.set(Mcp.HEADER_VERSION, this.negotiated);
    }
    const response = await platform().fetch(url, { method: 'POST', headers, body, signal });
    return { response, token };
  }

  /** Maps auth, session and generic HTTP failures. Leaves a successful response unread. */
  private checkStatus(response: Response, initializing: boolean, tokenUsed: string | null): void {
    if (response.ok) return;
    const code = response.status;
    const challenge = response.headers.get('WWW-Authenticate');
    discard(response);
    const name = this.config.name;
    if (code === 401) throw new Unauthorized(challenge, tokenUsed);
    if (code === 403 && parseBearerChallenge(challenge).error === 'insufficient_scope') throw new McpAuthRequiredException(this.config.id, challenge);
    if (code === 403) throw new McpException(t('{server} refused access (HTTP 403).', { server: name }), 403);
    if (code === 404 && !initializing && this.sessionId != null) throw new SessionExpired();
    if (code === 404) throw new McpException(t('No MCP server was found at this address (HTTP 404).'), 404);
    if (code === 429) throw new McpException(t('{server} is rate limiting requests. Try again shortly.', { server: name }), 429);
    if (code >= 500) throw new McpException(t('{server} had a server error (HTTP {status}).', { server: name, status: String(code) }), code);
    throw new McpException(t('{server} rejected the request (HTTP {status}).', { server: name, status: String(code) }), code);
  }

  /** Reads a JSON or SSE response until the JSON-RPC response for [id] arrives. */
  private async readResponse(response: Response, id: number, signal: AbortSignal): Promise<Json> {
    const name = this.config.name;
    const type = (response.headers.get('Content-Type') ?? '').toLowerCase();
    if (type.includes('text/event-stream')) {
      if (response.body) {
        for await (const ev of readSse(response.body, signal)) {
          if (ev.event !== 'message') continue;
          let msg: unknown;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            continue;
          }
          const found = this.handleIncoming(msg, id);
          if (found) return found;
        }
      }
      throw new McpException(t('{server} closed the stream before answering.', { server: name }));
    }
    const text = await response.text();
    if (response.status === 202 || !text.trim()) throw new McpException(t('{server} accepted the request but sent no answer.', { server: name }));
    const notMcp = t('The address answered, but not as an MCP server.');
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      throw new McpException(notMcp);
    }
    if (!isObject(msg) && !Array.isArray(msg)) throw new McpException(notMcp);
    const found = this.handleIncoming(msg, id);
    if (!found) throw new McpException(t('{server} answered a different request.', { server: name }));
    return found;
  }

  /**
   * Dispatches one incoming JSON-RPC message (or batch). Returns the result object when [msg] is
   * the response to [id]; answers server requests; ignores notifications.
   */
  private handleIncoming(msg: unknown, id: number): Json | null {
    if (Array.isArray(msg)) {
      let found: Json | null = null;
      for (const el of msg) found = this.handleIncoming(el, id) ?? found;
      return found;
    }
    if (!isObject(msg)) return null;
    const msgId = jstr(msg, 'id');
    if (jstr(msg, 'method') != null) {
      if (msgId != null) this.answerServerRequest(msg);
      return null;
    }
    if (msgId !== String(id)) return null;
    const error = jobj(msg, 'error');
    if (error) throw new RpcError(error);
    return jobj(msg, 'result') ?? {};
  }

  /** We declare no client capabilities: answer ping, refuse everything else. */
  private answerServerRequest(request: Json): void {
    const reply: Json = { jsonrpc: '2.0', id: request.id };
    if (jstr(request, 'method') === 'ping') reply.result = {};
    else reply.error = { code: -32601, message: 'Method not found' };
    this.sendAsync(JSON.stringify(reply));
  }

  private notifyCancelled(id: number, reason: string): void {
    this.sendAsync(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } }));
  }

  /** Fire-and-forget message (responses to server requests, notifications) on the active transport. */
  private sendAsync(body: string): void {
    if (this.closed) return;
    if (this.mode === 'STDIO') {
      this.stdio?.send(body).catch(() => {});
      return;
    }
    const target = this.mode === 'LEGACY' ? this.legacy?.endpointUrl : this.config.url;
    if (!target) return;
    this.post(target, body, this.mode === 'STREAMABLE').then((sent) => discard(sent.response), () => {});
  }

  // ---------------------------------------------------------------- legacy HTTP+SSE

  private async initLegacy(): Promise<McpServerInfo> {
    const name = this.config.name;
    const token = await this.currentAccessToken();
    const headers = new Headers({ Accept: 'text/event-stream' });
    this.applyAuth(headers, token);
    // Lives as long as the stream; the timer only bounds the wait for response headers.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), McpClient.REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await platform().fetch(this.config.url, { method: 'GET', headers, signal: ctrl.signal });
    } catch (e) {
      if (isAbortError(e)) throw new McpException(t('No MCP server answered at this address.'));
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) {
      const challenge = response.headers.get('WWW-Authenticate');
      ctrl.abort();
      throw new Unauthorized(challenge, token);
    }
    const type = (response.headers.get('Content-Type') ?? '').toLowerCase();
    if (!response.ok || !type.includes('text/event-stream') || !response.body) {
      ctrl.abort();
      throw new McpException(t('No MCP server answered at this address.'));
    }
    const channel = new LegacyChannel(ctrl, response.body, this.config.url, name, (o) => this.answerServerRequest(o));
    const endpoint = await withDeadline(McpClient.REQUEST_TIMEOUT_MS, undefined, () => channel.endpoint).catch(() => null);
    if (endpoint == null || endpoint === TIMED_OUT) {
      channel.close();
      throw new McpException(t('{server} didn\'t send its message endpoint.', { server: name }));
    }
    this.legacy?.close();
    this.legacy = channel;
    this.mode = 'LEGACY';
    this.sessionId = null;
    this.negotiated = null;
    const id = this.ids++;
    const result = await withDeadline(McpClient.REQUEST_TIMEOUT_MS, undefined, (s) => this.legacyRequest(id, 'initialize', this.initParams(), s));
    if (result === TIMED_OUT) throw new McpException(t('{server} didn\'t answer the initialize request.', { server: name }));
    const built = this.serverInfo(result);
    discard((await this.legacyPost(channel, rpc(null, 'notifications/initialized', null))).response);
    return built;
  }

  private async legacyRequest(id: number, method: string, params: Json | null, signal: AbortSignal): Promise<Json> {
    const channel = this.legacy;
    if (!channel) throw new SessionExpired();
    const waiting = channel.register(id);
    try {
      const sent = await this.legacyPost(channel, rpc(id, method, params), signal);
      const code = sent.response.status;
      const challenge = sent.response.headers.get('WWW-Authenticate');
      discard(sent.response);
      if (code === 401) throw new Unauthorized(challenge, sent.token);
      if (code === 404) throw new SessionExpired();
      if (!sent.response.ok) throw new McpException(t('{server} rejected the request (HTTP {status}).', { server: this.config.name, status: String(code) }), code);
      const msg = await raceAbort(waiting, signal);
      const error = jobj(msg, 'error');
      if (error) throw new RpcError(error);
      return jobj(msg, 'result') ?? {};
    } finally {
      channel.forget(id);
    }
  }

  private async legacyPost(channel: LegacyChannel, body: string, signal?: AbortSignal): Promise<Sent> {
    const url = channel.endpointUrl;
    if (!url) throw new SessionExpired();
    const token = await this.currentAccessToken();
    const headers = new Headers({ 'Content-Type': 'application/json' });
    this.applyAuth(headers, token);
    const response = await platform().fetch(url, { method: 'POST', headers, body, signal });
    return { response, token };
  }

  // ---------------------------------------------------------------- stdio (Windows app)

  private async initStdio(): Promise<McpServerInfo> {
    const name = this.config.name;
    const spec = this.config.stdio!;
    const bridge = platform().stdio;
    if (!bridge) throw new McpException(t('Local servers run only in the Facet app for Windows.'));
    let handle: string;
    try {
      handle = await bridge.spawn({ command: spec.command, args: spec.args ?? [], env: this.config.headers, cwd: spec.cwd ?? null });
    } catch (e) {
      throw new McpException(t('Couldn\'t start {server}: {reason}', { server: name, reason: errorText(e) }));
    }
    const channel = new StdioChannel(bridge, handle, (o) => this.answerServerRequest(o));
    this.stdio?.close();
    this.stdio = channel;
    this.mode = 'STDIO';
    this.sessionId = null;
    this.negotiated = null;
    try {
      const id = this.ids++;
      const result = await withDeadline(McpClient.STDIO_START_TIMEOUT_MS, undefined, (s) => this.stdioRequest(id, 'initialize', this.initParams(), s));
      if (result === TIMED_OUT) throw new McpException(t('{server} didn\'t answer the initialize request.', { server: name }));
      const built = this.serverInfo(result);
      await channel.send(rpc(null, 'notifications/initialized', null));
      return built;
    } catch (e) {
      channel.close();
      if (this.stdio === channel) this.stdio = null;
      this.info = null;
      if (e instanceof SessionExpired) {
        throw new McpException(e.detail
          ? t('{server} stopped before it was ready ({reason}). Check the command and its settings.', { server: name, reason: e.detail })
          : t('{server} stopped before it was ready. Check the command and its settings.', { server: name }));
      }
      throw e;
    }
  }

  private async stdioRequest(id: number, method: string, params: Json | null, signal: AbortSignal): Promise<Json> {
    const channel = this.stdio;
    if (!channel) throw new SessionExpired();
    const waiting = channel.register(id);
    try {
      await channel.send(rpc(id, method, params));
      const msg = await raceAbort(waiting, signal);
      const error = jobj(msg, 'error');
      if (error) throw new RpcError(error);
      return jobj(msg, 'result') ?? {};
    } finally {
      channel.forget(id);
    }
  }

  // ---------------------------------------------------------------- auth

  private staticAuth(headers: Headers): void {
    if (this.config.authMode !== 'HEADERS') return;
    for (const [k, v] of Object.entries(this.config.headers)) {
      try {
        headers.set(k, v);
      } catch {
        // Not a valid header name or value: skip it (the server's 401 tells the user to check the token).
      }
    }
  }

  private applyAuth(headers: Headers, token: string | null): void {
    // Browsers refuse or preflight a custom User-Agent, which can break CORS on the website.
    if (!platform().corsLimited) headers.set('User-Agent', `Facet/${Mcp.CLIENT_VERSION}`);
    this.staticAuth(headers);
    if (this.config.authMode === 'OAUTH' && token != null) {
      headers.set('Authorization', `Bearer ${token}`);
      this.lastToken = token;
    }
  }

  /** The OAuth access token to send, refreshed proactively when it expires within a minute. */
  private async currentAccessToken(): Promise<string | null> {
    if (this.config.authMode !== 'OAUTH') return null;
    const state = await this.tokens.load(this.config.id);
    if (!state) return null;
    const expiresAt = state.expiresAt;
    if (expiresAt != null && expiresAt - Date.now() < 60_000 && state.refreshToken != null) {
      await this.refreshTokens(state.accessToken ?? null);
      return (await this.tokens.load(this.config.id))?.accessToken ?? null;
    }
    return state.accessToken ?? null;
  }

  /**
   * Refreshes the access token once per expiry. Returns true when a usable token now exists
   * (refreshed here or by a concurrent caller). Clears dead tokens when the grant is rejected.
   */
  private refreshTokens(tokenUsed: string | null): Promise<boolean> {
    return this.authLock.run(async () => {
      if (this.config.authMode !== 'OAUTH') return false;
      const state = await this.tokens.load(this.config.id);
      if (!state) return false;
      if (state.accessToken != null && state.accessToken !== tokenUsed) return true;
      if (state.refreshToken == null) return false;
      try {
        await this.tokens.save(this.config.id, await McpOAuth.refresh(state));
        return true;
      } catch (e) {
        if (!(e instanceof OAuthErrorException)) throw e;
        // Keep the client registration for the next sign-in.
        await this.tokens.save(this.config.id, { ...state, accessToken: null, refreshToken: null, expiresAt: null });
        return false;
      }
    });
  }
}
