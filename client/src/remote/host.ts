/**
 * The Windows app as a host (docs/REMOTE.md): answers `hello` with what this PC offers, and runs
 * calls from the account's other devices once the owner has switched on remote use. Everything
 * runs through the same computer bridge as local chats.
 */
import type { AgentKind, DesktopSettings } from '../platform/platform';
import { platform } from '../platform';
import { messageId, type HostHandler, type RemoteHub } from './hub';
import { RemoteError, type HostAnnouncement, type RemoteMessage } from './protocol';

/** Results larger than this are refused rather than relayed (the server takes envelopes up to 4 MiB). */
const MAX_RESULT_CHARS = 3_000_000;

export interface HostServiceDeps {
  defaultFolder(): Promise<string>;
  recentFolders(): Promise<string[]>;
  /** Opens Settings → Computer access (from the "a device tried to use this PC" notification). */
  openSettings(): void;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const AGENTS: AgentKind[] = ['claude', 'codex'];

/** Windows paths only: drive-absolute (C:\…) or UNC (\\server\share). */
function absoluteFolder(path: string | null): path is string {
  return !!path && (/^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path));
}

export class HostService implements HostHandler {
  private settings: DesktopSettings | null = null;
  /** Calls in progress by message id, for `cancel`. */
  private readonly running = new Map<string, string>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly hub: RemoteHub,
    private readonly deps: HostServiceDeps,
  ) {}

  async start(): Promise<void> {
    const host = platform().host;
    if (!host || !platform().computer) return;
    this.settings = await host.settings();
    host.onSettings((s) => {
      const changed = s.remoteAccess !== this.settings?.remoteAccess;
      this.settings = s;
      if (changed) void this.announce();
    });
    this.hub.handler = this;
  }

  get remoteAccess(): boolean {
    return this.settings?.remoteAccess ?? false;
  }

  async announcement(): Promise<HostAnnouncement> {
    const computer = platform().computer!;
    const info = await computer.info().catch(() => null);
    return {
      hostId: this.settings?.hostId ?? '',
      name: info?.hostname || 'PC',
      os: info?.os ?? 'Windows',
      version: platform().version,
      remote: this.remoteAccess,
      home: info?.home ?? '',
      defaultFolder: await this.deps.defaultFolder(),
      recentFolders: await this.deps.recentFolders(),
      features: ['computer', 'files', 'claude', 'codex'],
    };
  }

  /** Tells every online device what this PC offers (after remote use is switched on or off). */
  async announce(): Promise<void> {
    if (!this.settings) return;
    await this.hub.broadcast({ type: 'host', ...(await this.announcement()) });
  }

  async handle(from: string, m: RemoteMessage): Promise<void> {
    if (!this.settings) return;
    if (m.type === 'hello') {
      await this.hub.send(from, { type: 'host', re: m.id, ...(await this.announcement()) }).catch(() => {});
      return;
    }
    if (m.type === 'cancel') {
      const callId = typeof m.re === 'string' ? this.running.get(m.re) : undefined;
      if (callId) await platform().computer?.cancel(callId).catch(() => {});
      return;
    }
    if (m.type !== 'call') return;
    const reply = (body: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }) =>
      this.deliver(from, { type: 'result', re: m.id, ...body });
    if (!this.remoteAccess) {
      this.warn(from);
      await reply({ ok: false, error: { code: 'remote_disabled', message: 'This PC doesn’t allow other devices to use it. Turn it on in Facet on the PC: Settings → Computer access.' } });
      return;
    }
    try {
      const value = await this.run(from, m);
      if (JSON.stringify(value ?? null).length > MAX_RESULT_CHARS) throw new RemoteError('too_large', 'The result is too large to send.');
      await reply({ ok: true, value: value ?? {} });
    } catch (e) {
      const err = e instanceof RemoteError ? e : new RemoteError('failed', (e as Error)?.message || 'The PC couldn’t do that.');
      await reply({ ok: false, error: { code: err.code, message: err.message } });
    }
  }

  private async run(from: string, m: RemoteMessage): Promise<unknown> {
    const computer = platform().computer!;
    const host = platform().host!;
    const p = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>;
    const agent = (): AgentKind => {
      const a = str(p.agent) as AgentKind | null;
      if (!a || !AGENTS.includes(a)) throw new RemoteError('bad_request', 'Unknown agent.');
      return a;
    };
    const folder = (key: string): string => {
      const f = str(p[key]);
      if (!absoluteFolder(f)) throw new RemoteError('bad_request', 'A full folder path is needed.');
      return f;
    };
    switch (m.method) {
      case 'computer.info':
        return computer.info();
      case 'computer.tools':
        return computer.tools();
      case 'computer.call': {
        const name = str(p.name);
        const args = str(p.argumentsJson) ?? '{}';
        const callId = str(p.callId) ?? m.id;
        if (!name) throw new RemoteError('bad_request', 'Which tool?');
        const cwd = folder('cwd');
        const localId = `remote-${from}-${callId}`;
        this.running.set(m.id, localId);
        this.noteActivity(from);
        try {
          return await computer.call(name, args, { cwd, callId: localId });
        } finally {
          this.running.delete(m.id);
        }
      }
      case 'computer.cancel': {
        const callId = str(p.callId);
        if (callId) await computer.cancel(`remote-${from}-${callId}`);
        return {};
      }
      case 'files.list': {
        const path = p.path == null ? null : str(p.path);
        if (path !== null && !absoluteFolder(path)) throw new RemoteError('bad_request', 'A full folder path is needed.');
        try {
          return await host.listFolders(path, await this.deps.recentFolders());
        } catch (e) {
          throw new RemoteError('not_found', (e as Error)?.message || 'That folder doesn’t exist.');
        }
      }
      case 'agents.list':
        this.noteActivity(from);
        return { sessions: await host.agentSessions(agent(), folder('cwd')) };
      case 'agents.read': {
        const id = str(p.id);
        if (!id) throw new RemoteError('bad_request', 'Which session?');
        const session = await host.readAgentSession(agent(), folder('cwd'), id);
        if (!session) throw new RemoteError('not_found', 'That session isn’t in this folder anymore.');
        this.noteActivity(from);
        return session;
      }
      default:
        throw new RemoteError('unknown_method', 'This version of Facet on the PC can’t do that. Update it.');
    }
  }

  /**
   * Sends a result, retrying for a few seconds when the device is briefly unreachable (its stream
   * reconnecting, say); otherwise the result would be lost and the device would wait for its timeout.
   */
  private async deliver(to: string, body: { type: string; [field: string]: unknown }): Promise<void> {
    const id = messageId();
    for (const wait of [0, 500, 1000, 2000, 4000, 8000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        await this.hub.send(to, body, id);
        return;
      } catch (e) {
        if (!(e instanceof RemoteError) || e.code !== 'offline') return;
      }
    }
  }

  private noteActivity(from: string): void {
    const who = this.hub.deviceName(from);
    const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    platform().host?.activity(who ? `Used from ${who} at ${at}` : `Used from another device at ${at}`);
    if (!who) void this.hub.discover();
  }

  /** The first refused request from each device this session gets a notification. */
  private warn(from: string): void {
    if (this.warned.has(from)) return;
    this.warned.add(from);
    const who = this.hub.deviceName(from) ?? 'One of your devices';
    platform().notify(
      'Facet',
      `${who} tried to use this PC. To allow it, turn on “Let your other devices use this PC” in Settings → Computer access.`,
      () => this.deps.openSettings(),
    );
  }
}
