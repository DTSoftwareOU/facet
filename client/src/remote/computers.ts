/**
 * Which computer a chat's tools run on (docs/REMOTE.md): this PC in the Windows app, or a PC of
 * the account reached through the relay. A chat records its PC (host id) and folder; this module
 * turns that into something the tool registry and the UI can use. A chat that hasn't chosen uses
 * this PC in the Windows app and, elsewhere, your PC whenever one is online.
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
  /** No computer: no PC is online (automatic), or the chat doesn't use one. */
  | { kind: 'none'; automatic?: boolean }
  /** [automatic]: the chat hasn't chosen a PC, so it uses the one online now. */
  | { kind: 'ready'; computer: ChatComputer; automatic?: boolean }
  /** The chat's PC is online but its owner hasn't allowed other devices to use it. */
  | { kind: 'disabled'; host: HostInfo; folder: string | null; automatic?: boolean }
  /** The chat's PC isn't online. [name]: when this device has seen it. */
  | { kind: 'offline'; hostId: string; folder: string | null; name?: string | null };

/** The chat fields that pick its computer. */
export type ComputerFields = Pick<ConversationEntity, 'computerHost' | 'computerFolder' | 'workspace'>;

/** `computerHost` of a chat that doesn't use a PC ("Don't use a PC"). Host ids are 16+ characters, so it can't clash. */
export const NO_COMPUTER = 'none';
export const NO_COMPUTER_BINDING: ComputerBinding = { host: NO_COMPUTER, folder: '' };

/** What this device remembers about the account's PCs between launches (local preferences). */
export interface ComputerMemory {
  /** The PC this device used last, preferred for chats that haven't chosen one. */
  lastUsed(): string | null;
  /** Names of the PCs this device has seen, by host id. */
  names(): Record<string, string>;
  remember(change: { used?: string; names?: Record<string, string> }): void;
}

/** A PC name as plain text for the model's instructions. */
function plainName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f"]/g, ' ').trim().slice(0, 64) || 'the PC';
}

/**
 * What the model is told when the chat's PC can't be used right now, so it can tell the user what
 * to do instead of saying it has no access. [knownNames]: PCs this device has seen before.
 */
export function computerNote(state: ComputerState, knownNames: string[] = []): string | null {
  switch (state.kind) {
    case 'ready':
      return null;
    case 'disabled': {
      const pc = plainName(state.host.name);
      return (
        `## Computer\nThe user's PC ${pc} is online, but Facet AI on it doesn't let other devices use it, so you can't see its files or run commands on it from here. ` +
        `If the user asks for something on that PC, tell them to turn on "Let your other devices use this PC" in Facet AI on ${pc} ` +
        '(in the menu of the Facet AI icon in the Windows notification area, or Settings, Computer access), then ask again.'
      );
    }
    case 'offline': {
      const pc = state.name ? `PC ${plainName(state.name)}` : 'PC';
      return (
        `## Computer\nThis chat works on the user's ${pc}, which is offline right now, so you can't see its files or run commands on it. ` +
        'If the user asks for something on that PC, tell them to start Facet AI on it, signed in to the same account, and ask again.'
      );
    }
    case 'none': {
      if (!state.automatic || knownNames.length === 0) return null;
      const pcs = knownNames.slice(0, 3).map(plainName).join(', ');
      return (
        `## Computer\nThe user's PC (${pcs}) isn't online right now, so you can't see its files or run commands on it. ` +
        'If the user asks for something on their computer, tell them to start Facet AI on that PC, signed in to the same account, and ask again.'
      );
    }
  }
}

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
    private readonly memory: ComputerMemory | null = null,
  ) {}

  /** Loads this PC's host id (Windows app) and starts remembering the PCs that come online. */
  async start(): Promise<void> {
    this.hub.subscribe(() => this.rememberNames());
    const host = platform().host;
    if (!host) return;
    try {
      this.hostIdValue = (await host.settings()).hostId;
      this.localName = (await platform().computer?.info())?.hostname || null;
    } catch {
      // The main process isn't answering: this PC just won't bind chats.
    }
  }

  private rememberNames(): void {
    if (!this.memory) return;
    const known = this.memory.names();
    const fresh: Record<string, string> = {};
    for (const h of this.hub.hosts) if (h.hostId !== this.hostIdValue && known[h.hostId] !== h.name) fresh[h.hostId] = h.name;
    if (Object.keys(fresh).length > 0) this.memory.remember({ names: { ...known, ...fresh } });
  }

  /** Names of other PCs this device has seen, for telling the model about one that's offline. */
  knownNames(): string[] {
    const names = this.memory?.names() ?? {};
    return Object.entries(names).filter(([id]) => id !== this.hostIdValue).map(([, name]) => name);
  }

  /** Notes that this device used [hostId], so chats that haven't chosen a PC prefer it. */
  markUsed(hostId: string): void {
    if (hostId !== this.hostIdValue && this.memory && this.memory.lastUsed() !== hostId) this.memory.remember({ used: hostId });
  }

  /**
   * The PC a chat that hasn't chosen one uses on this device: an online PC that can run tools,
   * preferring ones that allow remote use, then the one used last, then by name.
   */
  automaticHost(): HostInfo | null {
    const pcs = this.hub.hosts.filter((h) => h.hostId !== this.hostIdValue && (h.features.length === 0 || h.features.includes('computer')));
    if (pcs.length === 0) return null;
    const usable = pcs.filter((h) => h.remote);
    const pool = usable.length > 0 ? usable : pcs;
    const last = this.memory?.lastUsed() ?? null;
    return pool.find((h) => h.hostId === last) ?? pool[0];
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
    if (hostId === NO_COMPUTER) return { kind: 'none' };
    const local = platform().computer;
    if (local && (!hostId || hostId === this.hostIdValue)) {
      const f = (hostId ? folder : null) || fields?.workspace || (await this.defaultFolder());
      return { kind: 'ready', computer: this.localComputer(f), automatic: !hostId };
    }
    if (!hostId) {
      const auto = this.automaticHost();
      if (!auto) return { kind: 'none', automatic: true };
      if (!auto.remote) return { kind: 'disabled', host: auto, folder: null, automatic: true };
      return { kind: 'ready', computer: this.remoteComputer(auto, auto.defaultFolder), automatic: true };
    }
    const host = this.hub.host(hostId);
    if (!host) return { kind: 'offline', hostId, folder, name: this.memory?.names()[hostId] ?? null };
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
