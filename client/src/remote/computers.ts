/**
 * Which computer a chat's tools run on (docs/REMOTE.md): this PC in the Windows app, or a PC of
 * the account reached through the relay. A chat records its PC (host id) and folder; this module
 * turns that into something the tool registry and the UI can use.
 */
import type { ComputerBinding, ConversationEntity } from '../data/entities';
import type {
  AgentKind,
  AgentSessionSummary,
  ComputerBridge,
  ComputerCallResult,
  ComputerInfo,
  ComputerToolInfo,
  FolderListing,
  ImportedSession,
} from '../platform/platform';
import { platform } from '../platform';
import type { RemoteHub } from './hub';
import { msg, t } from '../i18n';
import { RemoteError, remoteError, type HostInfo } from './protocol';

/** A computer a chat can use right now, in a folder. */
export interface ChatComputer {
  /** This PC (Windows app) or another PC through the relay. */
  local: boolean;
  hostId: string;
  /** The PC's name, e.g. "OFFICE-PC". */
  name: string;
  folder: string;
  bridge: ComputerBridge;
  listFolders(path: string | null): Promise<FolderListing>;
  agentSessions(agent: AgentKind): Promise<AgentSessionSummary[]>;
  readAgentSession(agent: AgentKind, id: string): Promise<ImportedSession | null>;
}

export type ComputerState =
  /** No computer: the website or Android without a PC, or a chat that doesn't use one. */
  | { kind: 'none' }
  | { kind: 'ready'; computer: ChatComputer }
  /** The chat's PC is online but its owner hasn't allowed other devices to use it. */
  | { kind: 'disabled'; host: HostInfo; folder: string | null }
  /** The chat's PC isn't online. */
  | { kind: 'offline'; hostId: string; folder: string | null };

/** The chat fields that pick its computer. */
export type ComputerFields = Pick<ConversationEntity, 'computerHost' | 'computerFolder' | 'workspace'>;

/** A PC reached through the relay, with the same interface as this PC's bridge. */
export class RemoteComputerBridge implements ComputerBridge {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly hub: RemoteHub,
    private readonly hostId: string,
  ) {}

  info(): Promise<ComputerInfo> {
    return this.hub.call<ComputerInfo>(this.hostId, 'computer.info');
  }

  async tools(): Promise<ComputerToolInfo[]> {
    const list = await this.hub.call<ComputerToolInfo[]>(this.hostId, 'computer.tools');
    if (!Array.isArray(list)) return [];
    return list.filter((t) => t && typeof t.name === 'string' && typeof t.description === 'string').map((t) => ({
      name: t.name,
      description: t.description,
      inputSchemaJson: typeof t.inputSchemaJson === 'string' ? t.inputSchemaJson : '',
      readOnly: t.readOnly === true,
    }));
  }

  async call(name: string, argumentsJson: string, ctx: { cwd: string; callId: string }): Promise<ComputerCallResult> {
    const abort = new AbortController();
    this.running.set(ctx.callId, abort);
    try {
      const r = await this.hub.call<ComputerCallResult>(
        this.hostId,
        'computer.call',
        { name, argumentsJson, cwd: ctx.cwd, callId: ctx.callId },
        { signal: abort.signal },
      );
      return { content: typeof r?.content === 'string' ? r.content : '', isError: r?.isError === true, label: typeof r?.label === 'string' ? r.label : undefined };
    } catch (e) {
      if (e instanceof RemoteError) return { content: e.english, isError: true };
      throw e;
    } finally {
      this.running.delete(ctx.callId);
    }
  }

  async cancel(callId: string): Promise<void> {
    this.running.get(callId)?.abort();
  }

  async defaultWorkspace(): Promise<string> {
    return this.hub.host(this.hostId)?.defaultFolder ?? '';
  }

  /** There's no native picker for another PC: the UI browses with listFolders instead. */
  async pickFolder(): Promise<string | null> {
    return null;
  }

  async open(): Promise<void> {}
}

export class Computers {
  private hostIdValue: string | null = null;
  private localName: string | null = null;
  private readonly bridges = new Map<string, RemoteComputerBridge>();

  constructor(
    private readonly hub: RemoteHub,
    /** The Windows app's default working folder. */
    private readonly defaultFolder: () => Promise<string>,
    /** Folders of recent chats on this PC, newest first. */
    private readonly recentFolders: () => Promise<string[]>,
  ) {}

  /** Loads this PC's host id (Windows app). */
  async start(): Promise<void> {
    const host = platform().host;
    if (!host) return;
    try {
      this.hostIdValue = (await host.settings()).hostId;
      this.localName = (await platform().computer?.info())?.hostname || null;
    } catch {
      // The main process isn't answering: this PC just won't bind chats.
    }
  }

  /** This PC's host id (Windows app), else null. */
  get hostId(): string | null {
    return this.hostIdValue;
  }

  /** Where a new chat works by default: this PC's default folder in the Windows app, else nowhere. */
  async defaultBinding(): Promise<ComputerBinding | null> {
    if (!this.hostIdValue || !platform().computer) return null;
    const folder = await this.defaultFolder();
    return folder ? { host: this.hostIdValue, folder } : null;
  }

  /** The computer for a chat (or a new chat's choice), as of now. */
  async resolve(fields: ComputerFields | null | undefined): Promise<ComputerState> {
    const hostId = fields?.computerHost ?? null;
    const folder = fields?.computerFolder ?? null;
    const local = platform().computer;
    if (local && (!hostId || hostId === this.hostIdValue)) {
      const f = (hostId ? folder : null) || fields?.workspace || (await this.defaultFolder());
      return { kind: 'ready', computer: this.localComputer(f) };
    }
    if (!hostId) return { kind: 'none' };
    const host = this.hub.host(hostId);
    if (!host) return { kind: 'offline', hostId, folder };
    if (!host.remote) return { kind: 'disabled', host, folder };
    return { kind: 'ready', computer: this.remoteComputer(host, folder || host.defaultFolder) };
  }

  /** A PC that is online with remote use on, by host id. */
  remote(hostId: string, folder?: string | null): ChatComputer | null {
    const host = this.hub.host(hostId);
    if (!host || !host.remote) return null;
    return this.remoteComputer(host, folder || host.defaultFolder);
  }

  private localComputer(folder: string): ChatComputer {
    const bridge = platform().computer!;
    const host = platform().host;
    return {
      local: true,
      hostId: this.hostIdValue ?? 'local',
      name: this.localName ?? t('This PC'),
      folder,
      bridge,
      listFolders: async (path) => {
        if (!host) throw remoteError('failed', msg('Folders can’t be listed here.'));
        return host.listFolders(path, await this.recentFolders());
      },
      agentSessions: async (agent) => (host ? host.agentSessions(agent, folder) : []),
      readAgentSession: async (agent, id) => (host ? host.readAgentSession(agent, folder, id) : null),
    };
  }

  private remoteComputer(host: HostInfo, folder: string): ChatComputer {
    let bridge = this.bridges.get(host.hostId);
    if (!bridge) {
      bridge = new RemoteComputerBridge(this.hub, host.hostId);
      this.bridges.set(host.hostId, bridge);
    }
    const hub = this.hub;
    return {
      local: false,
      hostId: host.hostId,
      name: host.name,
      folder,
      bridge,
      listFolders: (path) => hub.call<FolderListing>(host.hostId, 'files.list', { path }),
      agentSessions: async (agent) => {
        const r = await hub.call<{ sessions?: AgentSessionSummary[] }>(host.hostId, 'agents.list', { agent, cwd: folder });
        return Array.isArray(r?.sessions) ? r.sessions : [];
      },
      readAgentSession: (agent, id) => hub.call<ImportedSession | null>(host.hostId, 'agents.read', { agent, cwd: folder, id }),
    };
  }
}
