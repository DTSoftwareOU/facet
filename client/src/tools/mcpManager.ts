/**
 * MCP servers (port of McpManager.kt): configuration (secrets sealed locally, synced end-to-end
 * encrypted), cached tool lists (so tools are ready in every new chat and after restarts),
 * connections, OAuth sign-in and token refresh. Tokens refreshed on one device sync to the others.
 *
 * The Windows app adds local stdio servers (a command, its arguments, folder and environment).
 * Their rows set `stdio`, keep their environment in `headersSealed`, are never marked dirty and are
 * deleted outright: they stay on this computer and the sync engine skips them.
 */
import { fromUtf8, utf8 } from '../core/bytes';
import { newId } from '../core/ids';
import { isObject, parseJson, toJson } from '../core/json';
import { db } from '../data/db';
import type { McpAuthMode, McpServerEntity, StdioSpec } from '../data/entities';
import { McpClient } from '../mcp/client';
import { Mutex } from '../mcp/internal';
import { McpOAuth } from '../mcp/oauth';
import {
  DEFAULT_INPUT_SCHEMA,
  McpAuthRequiredException,
  McpException,
  parseOAuthState,
  type McpCallResult,
  type McpOAuthState,
  type McpPendingAuth,
  type McpServerConfig,
  type McpServerInfo,
  type McpTokenStore,
  type McpTool,
} from '../mcp/types';
import { platform } from '../platform';
import { TOOL_APPROVAL_INFO, type ToolApproval } from './types';

export const MCP_STATUS_SIGN_IN = 'Sign in required';
/** Status on the website when a remote server answers but doesn't allow requests from web pages (no CORS). */
export const MCP_BROWSER_BLOCKED =
  "This server doesn't accept connections from web browsers. Use it in the Facet app for Windows or Android.";
const STDIO_ONLY_DESKTOP = 'Local servers run only in the Facet app for Windows.';

/** A local server as entered in Settings (Windows app). */
export interface StdioServerInput {
  name: string;
  command: string;
  args: string[];
  cwd?: string | null;
  /** Environment variables. On update, null or missing keeps the saved ones. */
  env?: Record<string, string> | null;
}

/** Splits a command line typed by the user into words. Only double quotes group, so Windows paths and apostrophes survive. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let inWord = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      inWord = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/** The command line shown for a local server: the reverse of [splitCommandLine]. */
export function joinCommandLine(words: string[]): string {
  return words.map((w) => (w === '' || /\s/.test(w) ? `"${w}"` : w)).join(' ');
}

const LAUNCHERS = new Set(['npx', 'bunx', 'pnpx', 'uvx', 'pnpm', 'yarn', 'npm', 'node', 'bun', 'deno', 'python', 'python3', 'py', 'uv', 'pipx', 'docker']);
const LAUNCHER_VERBS = new Set(['run', 'exec', 'dlx', 'x', 'tool']);

/** A default name for a local server: the package a launcher runs (npx, uvx, docker…), or the program's name. */
export function stdioName(spec: { command: string; args: string[] }): string {
  const base = (p: string) => (p.split(/[\\/]/).pop() ?? p).replace(/\.(exe|cmd|bat|ps1|js|mjs|py)$/i, '');
  const program = base(spec.command.trim());
  if (LAUNCHERS.has(program.toLowerCase())) {
    const target = spec.args.find((a) => a && !a.startsWith('-') && !LAUNCHER_VERBS.has(a));
    const name = target ? base(target.replace(/(.)@[^@/]+$/, '$1')) : '';
    if (name) return name;
  }
  return program || 'Local server';
}

function stdioSpec(input: StdioServerInput): StdioSpec {
  const command = input.command.trim();
  if (!command) throw new McpException('Enter the command that starts the server.');
  return { command, args: input.args.map((a) => a), cwd: input.cwd?.trim() || null };
}

function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObject(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  return out;
}

function normalizeTool(raw: unknown): McpTool | null {
  if (!isObject(raw) || typeof raw.name !== 'string') return null;
  const s = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : null);
  const b = (k: string) => (typeof raw[k] === 'boolean' ? (raw[k] as boolean) : null);
  return {
    name: raw.name,
    title: s('title'),
    description: s('description'),
    inputSchemaJson: s('inputSchemaJson') ?? DEFAULT_INPUT_SCHEMA,
    readOnlyHint: b('readOnlyHint'),
    destructiveHint: b('destructiveHint'),
    openWorldHint: b('openWorldHint'),
  };
}

export class McpManager implements McpTokenStore {
  static readonly STATUS_SIGN_IN = MCP_STATUS_SIGN_IN;

  static hostOf(url: string): string {
    try {
      const host = new URL(url.trim()).hostname.replace(/^www\./, '');
      return host || 'MCP server';
    } catch {
      return 'MCP server';
    }
  }

  private readonly clients = new Map<string, { stamp: string; client: McpClient }>();
  /** Opened OAuth state, keyed by the sealed text it came from (a synced update replaces the text). */
  private readonly tokenCache = new Map<string, { sealed: string; state: McpOAuthState | null }>();
  private readonly saveLocks = new Map<string, Mutex>();

  /** [onLocalChange] runs after the user changes a synced server, so the sync engine can push it. */
  constructor(private readonly onLocalChange: () => void = () => {}) {}

  // ---- reading (Dexie queries only, so they work inside liveQuery/useLiveQuery) ----

  async all(): Promise<McpServerEntity[]> {
    const rows = await db().mcpServers.toArray();
    return rows.filter((e) => !e.deleted).sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
  }

  async get(id: string): Promise<McpServerEntity | undefined> {
    return db().mcpServers.get(id);
  }

  /** True in the Windows app, which can run local (stdio) servers. */
  get stdioAvailable(): boolean {
    return platform().stdio != null;
  }

  isStdio(e: McpServerEntity): boolean {
    return e.stdio != null;
  }

  tools(e: McpServerEntity): McpTool[] {
    const raw = parseJson<unknown>(e.toolsJson, []);
    return Array.isArray(raw) ? raw.map(normalizeTool).filter((t): t is McpTool => t != null) : [];
  }

  disabledTools(e: McpServerEntity): Set<string> {
    return new Set(parseJson<unknown[]>(e.disabledToolsJson, []).filter((x): x is string => typeof x === 'string'));
  }

  autoApproved(e: McpServerEntity): Set<string> {
    return new Set(parseJson<unknown[]>(e.autoApprovedJson, []).filter((x): x is string => typeof x === 'string'));
  }

  approval(e: McpServerEntity): ToolApproval {
    return e.approval in TOOL_APPROVAL_INFO ? (e.approval as ToolApproval) : 'WRITES';
  }

  /** The static headers of a remote server, or the environment variables of a local one. */
  async headers(e: McpServerEntity): Promise<Record<string, string>> {
    if (!e.headersSealed.trim()) return {};
    try {
      return stringRecord(JSON.parse(fromUtf8(await platform().secrets.open(e.headersSealed))));
    } catch {
      return {};
    }
  }

  isSignedIn(e: McpServerEntity): boolean {
    const cached = this.tokenCache.get(e.id);
    if (cached && cached.sealed === e.oauthSealed) return !!(cached.state?.accessToken || cached.state?.refreshToken);
    return e.oauthSealed.trim() !== '';
  }

  // ---- configuration ----

  async add(name: string, url: string, authMode: McpAuthMode, headers: Record<string, string>): Promise<McpServerEntity> {
    const now = Date.now();
    const e: McpServerEntity = {
      ...this.blank(now),
      name: name.trim() || McpManager.hostOf(url),
      url: url.trim(),
      authMode,
      headersSealed: await this.sealMap(headers),
      sort: (await this.all()).length,
      dirty: 1,
    };
    await db().mcpServers.put(e);
    this.onLocalChange();
    return e;
  }

  /** Adds a local server (Windows app). */
  async addStdio(input: StdioServerInput): Promise<McpServerEntity> {
    if (!platform().stdio) throw new McpException(STDIO_ONLY_DESKTOP);
    const spec = stdioSpec(input);
    const now = Date.now();
    const e: McpServerEntity = {
      ...this.blank(now),
      name: input.name.trim() || stdioName(spec),
      headersSealed: await this.sealMap(input.env ?? {}),
      sort: (await this.all()).length,
      stdio: spec,
    };
    await db().mcpServers.put(e);
    return e;
  }

  async update(id: string, name: string, url: string, authMode: McpAuthMode, headers: Record<string, string> | null): Promise<void> {
    const e = await this.get(id);
    if (!e) return;
    const urlChanged = e.url !== url.trim();
    const sealed = headers != null ? await this.sealMap(headers) : null;
    await this.mutate(id, (it) => ({
      name: name.trim() || McpManager.hostOf(url),
      url: url.trim(),
      authMode,
      headersSealed: sealed ?? it.headersSealed,
      oauthSealed: urlChanged || authMode !== 'OAUTH' ? '' : it.oauthSealed,
    }));
    if (urlChanged) this.tokenCache.delete(id);
    this.dropClient(id);
  }

  async updateStdio(id: string, input: StdioServerInput): Promise<void> {
    const spec = stdioSpec(input);
    const sealed = input.env != null ? await this.sealMap(input.env) : null;
    await this.mutate(id, (it) => ({ name: input.name.trim() || stdioName(spec), stdio: spec, headersSealed: sealed ?? it.headersSealed }));
    this.dropClient(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.mutate(id, () => ({ enabled }));
    // Turning a server off also ends its session (and stops a local server's process).
    if (!enabled) this.dropClient(id);
  }

  async setApproval(id: string, approval: ToolApproval): Promise<void> {
    await this.mutate(id, () => ({ approval }));
  }

  async setToolEnabled(id: string, tool: string, enabled: boolean): Promise<void> {
    await this.mutate(id, (e) => {
      const set = this.disabledTools(e);
      if (enabled) set.delete(tool);
      else set.add(tool);
      return { disabledToolsJson: JSON.stringify([...set]) };
    });
  }

  async setAutoApprove(id: string, tool: string, auto: boolean): Promise<void> {
    await this.mutate(id, (e) => {
      const set = this.autoApproved(e);
      if (auto) set.add(tool);
      else set.delete(tool);
      return { autoApprovedJson: JSON.stringify([...set]) };
    });
  }

  /** "Always allow" from a chat approval: this tool stops asking. */
  async autoApprove(id: string, tool: string): Promise<void> {
    await this.setAutoApprove(id, tool, true);
  }

  async delete(id: string): Promise<void> {
    const e = await this.get(id);
    if (e?.stdio) await db().mcpServers.delete(id);
    else await this.mutate(id, () => ({ deleted: 1, headersSealed: '', oauthSealed: '' }));
    this.tokenCache.delete(id);
    this.dropClient(id);
  }

  async signOut(id: string): Promise<void> {
    await this.mutate(id, () => ({ oauthSealed: '' }));
    this.tokenCache.delete(id);
    this.dropClient(id);
  }

  private blank(now: number): McpServerEntity {
    return {
      id: newId(now),
      name: '',
      url: '',
      authMode: 'NONE',
      headersSealed: '',
      oauthSealed: '',
      enabled: true,
      approval: 'WRITES',
      toolsJson: '[]',
      toolsFetchedAt: 0,
      instructions: null,
      status: null,
      disabledToolsJson: '[]',
      autoApprovedJson: '[]',
      sort: 0,
      createdAt: now,
      updatedAt: now,
      deleted: 0,
      dirty: 0,
    };
  }

  /** Applies a user change: bumps updatedAt and marks the row for sync (local servers never sync). */
  private async mutate(id: string, transform: (e: McpServerEntity) => Partial<McpServerEntity>): Promise<void> {
    let synced = false;
    await db().transaction('rw', db().mcpServers, async () => {
      const e = await db().mcpServers.get(id);
      if (!e) return;
      const next: McpServerEntity = { ...e, ...transform(e), updatedAt: Date.now() };
      next.dirty = next.stdio ? 0 : 1;
      synced = !next.stdio;
      await db().mcpServers.put(next);
    });
    if (synced) this.onLocalChange();
  }

  /** Local-only fields (status, cached tools) change without a sync. */
  private async setStatus(id: string, status: string | null): Promise<void> {
    await db().mcpServers.update(id, { status });
  }

  private async sealText(text: string): Promise<string> {
    return platform().secrets.seal(utf8(text));
  }

  private async sealMap(h: Record<string, string>): Promise<string> {
    const clean = Object.fromEntries(Object.entries(h).filter(([k]) => k.trim() !== ''));
    return Object.keys(clean).length === 0 ? '' : this.sealText(JSON.stringify(clean));
  }

  private async config(e: McpServerEntity): Promise<McpServerConfig> {
    const authMode: McpAuthMode = e.authMode === 'HEADERS' || e.authMode === 'OAUTH' ? e.authMode : 'NONE';
    return { id: e.id, name: e.name, url: e.url, authMode, headers: await this.headers(e), stdio: e.stdio ?? null };
  }

  /** One live client per server, reused until its connection settings change (token refreshes don't reset it). */
  private async client(e: McpServerEntity): Promise<McpClient> {
    const stamp = [e.url, e.authMode, e.headersSealed, JSON.stringify(e.stdio ?? null)].join('|');
    const cached = this.clients.get(e.id);
    if (cached?.stamp === stamp) return cached.client;
    const config = await this.config(e);
    const again = this.clients.get(e.id);
    if (again?.stamp === stamp) return again.client;
    again?.client.close();
    const client = new McpClient(config, this);
    this.clients.set(e.id, { stamp, client });
    return client;
  }

  private dropClient(id: string): void {
    this.clients.get(id)?.client.close();
    this.clients.delete(id);
  }

  /** Ends every session and stops local servers (app shutdown, sign-out of the account). */
  closeAll(): void {
    for (const id of [...this.clients.keys()]) this.dropClient(id);
  }

  // ---- connection ----

  /** Connects, lists tools and caches them. Marks the server "Sign in required" when OAuth is needed. Throws with the status shown. */
  async refreshTools(id: string): Promise<McpTool[]> {
    const e = await this.get(id);
    if (!e) throw new McpException('Server not found.');
    try {
      const c = await this.client(e);
      const info = await c.connect();
      const tools = await c.listTools();
      await db().mcpServers.update(id, {
        toolsJson: toJson(tools),
        toolsFetchedAt: Date.now(),
        instructions: info.instructions ? info.instructions.slice(0, 4000) : null,
        status: null,
      });
      return tools;
    } catch (ex) {
      if (ex instanceof McpAuthRequiredException) {
        await this.setStatus(id, MCP_STATUS_SIGN_IN);
        throw ex;
      }
      const problem = await this.explain(ex, e);
      await this.setStatus(id, problem.message || "Couldn't connect.");
      throw problem;
    }
  }

  /** Connects to a server that isn't saved yet and lists its tools (e.g. to test a local command before saving). */
  async test(config: Omit<McpServerConfig, 'id'>): Promise<{ info: McpServerInfo; tools: McpTool[] }> {
    const client = new McpClient({ ...config, id: 'test' });
    try {
      const info = await client.connect();
      return { info, tools: await client.listTools() };
    } catch (ex) {
      if (!config.stdio && (await this.browserBlocked(ex, config.url))) throw new McpException(MCP_BROWSER_BLOCKED, null, ex);
      throw ex;
    } finally {
      client.close();
    }
  }

  /** Calls a tool on a server, reusing its session. Aborting [signal] cancels the call. */
  async call(serverId: string, tool: string, argumentsJson: string, signal?: AbortSignal): Promise<McpCallResult> {
    const e = await this.get(serverId);
    if (!e || e.deleted) throw new McpException('That MCP server was removed.');
    try {
      return await (await this.client(e)).callTool(tool, argumentsJson, signal);
    } catch (ex) {
      if (ex instanceof McpAuthRequiredException) {
        await this.setStatus(serverId, MCP_STATUS_SIGN_IN);
        throw new McpException(`${e.name} needs you to sign in again. Open Settings → MCP servers.`);
      }
      if (!e.stdio && (await this.browserBlocked(ex, e.url))) throw new McpException(MCP_BROWSER_BLOCKED, null, ex);
      throw ex;
    }
  }

  /** Refreshes tool lists for servers that have none cached yet (new or synced from another device). */
  warmUp(): void {
    void (async () => {
      const pending = (await this.all()).filter((e) => e.enabled && e.toolsFetchedAt === 0 && (!e.stdio || platform().stdio));
      await Promise.allSettled(pending.map((e) => this.refreshTools(e.id)));
    })().catch(() => {});
  }

  private async explain(ex: unknown, e: McpServerEntity): Promise<Error> {
    if (!e.stdio && (await this.browserBlocked(ex, e.url))) return new McpException(MCP_BROWSER_BLOCKED, null, ex);
    return ex instanceof Error ? ex : new McpException("Couldn't connect.", null, ex);
  }

  /**
   * On the website, a request the browser refused shows up as a bare network error. When the same
   * address answers an opaque no-cors probe, the server is up but doesn't allow web pages (CORS).
   */
  private async browserBlocked(ex: unknown, url: string): Promise<boolean> {
    if (!platform().corsLimited || !(ex instanceof McpException) || !(ex.cause instanceof TypeError)) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      await platform().fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- OAuth ----

  /**
   * Signs in through the platform's OAuth bridge (a popup on the website, the system browser with a
   * loopback redirect in the Windows app), saves the tokens and reconnects. Returns the server's tools.
   */
  async signIn(id: string, signal?: AbortSignal): Promise<McpTool[]> {
    return this.finishSignIn(await this.prepareSignIn(id), signal);
  }

  /**
   * First half of [signIn]: discovery and client registration. Browsers only allow a popup during
   * a click, so on the website run this before the user clicks "Sign in" and call [finishSignIn]
   * from the click handler.
   */
  async prepareSignIn(id: string): Promise<McpPendingAuth> {
    const e = await this.get(id);
    if (!e || e.deleted) throw new McpException('Server not found.');
    const redirectUri = await platform().oauth.redirectUri();
    const previous = await this.load(id);
    const wwwAuth = await this.probeWwwAuthenticate(e);
    try {
      return await McpOAuth.begin(id, e.url, wwwAuth, redirectUri, 'Facet', previous);
    } catch (ex) {
      throw this.signInProblem(ex);
    }
  }

  /** Second half of [signIn]: opens the sign-in page right away, then exchanges the code and reconnects. */
  async finishSignIn(pending: McpPendingAuth, signal?: AbortSignal): Promise<McpTool[]> {
    const id = pending.serverId;
    // Called before any await, so the website's popup opens within the user's click.
    const redirected = platform().oauth.authorize(pending.authorizationUrl, pending.oauth.redirectUri, signal);
    const params = new URL(await redirected).searchParams;
    if (params.get('state') !== pending.state) throw new McpException('This sign-in link expired. Start again from Settings.');
    const error = params.get('error');
    if (error) {
      throw new McpException(error === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in didn't complete: ${params.get('error_description') || error}`);
    }
    const code = params.get('code');
    if (!code) throw new McpException("Sign-in didn't complete: the server sent no code.");
    let oauth: McpOAuthState;
    try {
      oauth = await McpOAuth.complete(pending, code);
    } catch (ex) {
      throw this.signInProblem(ex);
    }
    const sealed = await this.sealText(toJson(oauth));
    await this.mutate(id, () => ({ authMode: 'OAUTH', oauthSealed: sealed }));
    this.tokenCache.set(id, { sealed, state: oauth });
    this.dropClient(id);
    return this.refreshTools(id);
  }

  private async probeWwwAuthenticate(e: McpServerEntity): Promise<string | null> {
    try {
      await (await this.client(e)).connect();
      return null;
    } catch (ex) {
      return ex instanceof McpAuthRequiredException ? ex.wwwAuthenticate : null;
    }
  }

  private signInProblem(ex: unknown): unknown {
    if (platform().corsLimited && ex instanceof McpException && ex.cause instanceof TypeError) {
      return new McpException(
        "Couldn't reach the server's sign-in service. It may not accept connections from web browsers; sign in from the Facet app for Windows or Android instead, and the sign-in syncs here.",
        null,
        ex,
      );
    }
    return ex;
  }

  // ---- McpTokenStore (called by McpClient) ----

  async load(serverId: string): Promise<McpOAuthState | null> {
    const e = await db().mcpServers.get(serverId);
    if (!e || !e.oauthSealed.trim()) return null;
    const cached = this.tokenCache.get(serverId);
    if (cached && cached.sealed === e.oauthSealed) return cached.state;
    let state: McpOAuthState | null = null;
    try {
      state = parseOAuthState(JSON.parse(fromUtf8(await platform().secrets.open(e.oauthSealed))));
    } catch {
      state = null;
    }
    this.tokenCache.set(serverId, { sealed: e.oauthSealed, state });
    return state;
  }

  async save(serverId: string, state: McpOAuthState | null): Promise<void> {
    let lock = this.saveLocks.get(serverId);
    if (!lock) this.saveLocks.set(serverId, (lock = new Mutex()));
    await lock.run(async () => {
      const sealed = state ? await this.sealText(toJson(state)) : '';
      await this.mutate(serverId, () => ({ oauthSealed: sealed }));
      this.tokenCache.set(serverId, { sealed, state });
    });
  }
}
