/**
 * The account's devices talking to each other (docs/REMOTE.md): keeps the list of online PCs,
 * sends encrypted calls to them and settles their results, and hands requests addressed to this
 * PC to the host service. One hub per window; the window that holds the change stream forwards
 * its events to the others.
 */
import { b64, b64url, randomBytes, unb64 } from '../core/bytes';
import { openRelay, ReplayGuard, sealRelay } from '../sync/relay';
import { CALL_TIMEOUT_MS, parseHost, RemoteError, type HostInfo, type RemoteMessage, type RemoteMethod } from './protocol';

export interface RelayPeer {
  sessionId: string;
  deviceName: string;
  platform: string;
}

/** The sync account as the hub needs it. */
export interface RelayTransport {
  /** This device's session id, or null when signed out. */
  me(): Promise<string | null>;
  /** The relay key (from the vault key), or null when signed out. */
  key(): Promise<CryptoKey | null>;
  /** Delivers a sealed envelope; rejects with RemoteError('offline') when the session isn't online. */
  send(to: string, msg: string): Promise<void>;
  peers(): Promise<RelayPeer[]>;
}

/** Answers `hello`, `call` and `cancel` (the Windows app). */
export interface HostHandler {
  handle(from: string, message: RemoteMessage): Promise<void>;
}

interface Pending {
  sessionId: string;
  finish(error: Error | null, value?: unknown): void;
}

const VERSION = 1;
const CHANNEL = 'facet-relay';

export function messageId(): string {
  return b64url(randomBytes(16));
}

export class RemoteHub {
  private readonly hostMap = new Map<string, HostInfo>();
  private hostList: HostInfo[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly guard = new ReplayGuard();
  private readonly names = new Map<string, string>();
  private channel: BroadcastChannel | null = null;
  handler: HostHandler | null = null;

  constructor(private readonly transport: RelayTransport) {}

  /** Listens for events forwarded by the window that holds the change stream. */
  start(): void {
    if (this.channel || typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.onmessage = (e: MessageEvent<{ event: string; data: string }>) => {
      if (e.data && typeof e.data.event === 'string' && typeof e.data.data === 'string') this.streamEvent(e.data.event, e.data.data, true);
    };
  }

  /** Signed out or switched accounts: forget the PCs and fail what's waiting. */
  reset(): void {
    for (const p of [...this.pending.values()]) p.finish(new RemoteError('offline', 'Signed out.'));
    this.names.clear();
    if (this.hostMap.size) {
      this.hostMap.clear();
      this.emit();
    }
  }

  // ---- state for the UI ----

  get hosts(): HostInfo[] {
    return this.hostList;
  }

  host(hostId: string | null | undefined): HostInfo | null {
    return hostId ? this.hostMap.get(hostId) ?? null : null;
  }

  /** The device name a session signed in with, when the hub has seen it. */
  deviceName(sessionId: string): string | null {
    return this.names.get(sessionId) ?? null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.hostList = [...this.hostMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const l of this.listeners) l();
  }

  // ---- incoming ----

  /** An event from the change stream (or forwarded by the window that holds it). */
  streamEvent(event: string, data: string, forwarded = false): void {
    if (!forwarded && event !== 'ready') this.channel?.postMessage({ event, data });
    try {
      if (event === 'ready') {
        void this.discover();
      } else if (event === 'presence') {
        const p = JSON.parse(data) as { sessionId?: unknown; online?: unknown };
        if (typeof p.sessionId !== 'string') return;
        if (p.online === true) {
          if (!forwarded) void this.hello(p.sessionId);
        } else {
          this.dropSession(p.sessionId);
        }
      } else if (event === 'relay') {
        const r = JSON.parse(data) as { from?: unknown; msg?: unknown };
        if (typeof r.from === 'string' && typeof r.msg === 'string') void this.receive(r.from, r.msg);
      }
    } catch {
      // Malformed event: ignore.
    }
  }

  /** Decrypts and dispatches one envelope. Anything that doesn't verify is dropped silently. */
  async receive(from: string, msg: string): Promise<void> {
    const [key, me] = await Promise.all([this.transport.key(), this.transport.me()]);
    if (!key || !me) return;
    let m: RemoteMessage;
    try {
      m = JSON.parse(await openRelay(key, from, me, unb64(msg))) as RemoteMessage;
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || m.v !== VERSION || typeof m.type !== 'string') return;
    if (!this.guard.accept(m.id, m.ts)) return;
    switch (m.type) {
      case 'host': {
        const info = parseHost(from, m);
        if (!info) return;
        for (const [id, h] of this.hostMap) if (h.sessionId === from && id !== info.hostId) this.hostMap.delete(id);
        this.hostMap.set(info.hostId, info);
        this.emit();
        return;
      }
      case 'result': {
        const p = typeof m.re === 'string' ? this.pending.get(m.re) : undefined;
        if (!p || p.sessionId !== from) return;
        if (m.ok === true) p.finish(null, m.value);
        else {
          const e = (m.error ?? {}) as { code?: unknown; message?: unknown };
          p.finish(RemoteError.from(e.code, e.message));
        }
        return;
      }
      case 'hello':
      case 'call':
      case 'cancel':
        if (this.handler) await this.handler.handle(from, m).catch(() => {});
        return;
    }
  }

  private dropSession(sessionId: string): void {
    let changed = false;
    for (const [id, h] of this.hostMap) {
      if (h.sessionId === sessionId) {
        this.hostMap.delete(id);
        changed = true;
      }
    }
    for (const p of [...this.pending.values()]) {
      if (p.sessionId === sessionId) p.finish(new RemoteError('offline', 'The PC went offline.'));
    }
    if (changed) this.emit();
  }

  // ---- outgoing ----

  /** Seals and sends one message; returns its id. */
  async send(to: string, body: { type: string; [field: string]: unknown }, id = messageId()): Promise<string> {
    const [key, me] = await Promise.all([this.transport.key(), this.transport.me()]);
    if (!key || !me) throw new RemoteError('offline', 'Sign in to reach your other devices.');
    const message: RemoteMessage = { ...body, v: VERSION, id, ts: Date.now() };
    const sealed = await sealRelay(key, me, to, JSON.stringify(message));
    try {
      await this.transport.send(to, b64(sealed));
    } catch (e) {
      if (e instanceof RemoteError && e.code === 'offline') this.dropSession(to);
      throw e;
    }
    return id;
  }

  /** Asks every online session who it is; PCs answer with `host`. */
  async discover(): Promise<void> {
    let peers: RelayPeer[];
    try {
      peers = await this.transport.peers();
    } catch {
      return;
    }
    const online = new Set(peers.map((p) => p.sessionId));
    for (const p of peers) this.names.set(p.sessionId, p.deviceName);
    let changed = false;
    for (const [id, h] of this.hostMap) {
      if (!online.has(h.sessionId)) {
        this.hostMap.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
    await Promise.all(peers.map((p) => this.hello(p.sessionId)));
  }

  /** Sends [body] to every online session of the account (each gets its own envelope). */
  async broadcast(body: { type: string; [field: string]: unknown }): Promise<void> {
    let peers: RelayPeer[];
    try {
      peers = await this.transport.peers();
    } catch {
      return;
    }
    for (const p of peers) this.names.set(p.sessionId, p.deviceName);
    await Promise.all(peers.map((p) => this.send(p.sessionId, body).catch(() => {})));
  }

  private async hello(sessionId: string): Promise<void> {
    try {
      await this.send(sessionId, { type: 'hello' });
    } catch {
      // Gone again, or signed out: nothing to do.
    }
  }

  /** Calls [method] on a PC. Rejects with RemoteError (offline, timeout, or the PC's error). */
  call<T>(hostId: string, method: RemoteMethod, params: Record<string, unknown> = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const host = this.hostMap.get(hostId);
    if (!host) return Promise.reject(new RemoteError('offline', 'That PC is offline.'));
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    const id = messageId();
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(
        () => finish(new RemoteError('timeout', `${host.name} didn’t answer in time.`)),
        options.timeoutMs ?? CALL_TIMEOUT_MS[method],
      );
      const onAbort = () => {
        void this.send(host.sessionId, { type: 'cancel', re: id }).catch(() => {});
        finish(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      };
      const finish = (error: Error | null, value?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value as T);
      };
      this.pending.set(id, { sessionId: host.sessionId, finish });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.send(host.sessionId, { type: 'call', method, params }, id).catch((e: unknown) =>
        finish(e instanceof Error ? e : new RemoteError('failed', String(e))),
      );
    });
  }
}
