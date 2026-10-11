/**
 * Creates and wires the app's services (the counterpart of AppContainer.kt). One instance per
 * window; every window shares the same IndexedDB data and sync account.
 */
import { liveQuery } from 'dexie';
import { AttachmentStore } from './data/attachments';
import { ConversationRepository } from './data/conversations';
import { db } from './data/db';
import { AssistantRepository, FolderRepository, PromptRepository } from './data/library';
import { SettingsStore } from './data/prefs';
import { ProviderRepository } from './data/providers';
import { ChatEngine } from './domain/chat';
import { MediaService } from './domain/media/service';
import { PricingCatalog } from './llm/pricing';
import { LocalQuirkStore } from './llm/quirks';
import { platform } from './platform';
import { Computers, type ChatComputer, type ComputerFields, type ComputerState } from './remote/computers';
import { HostService } from './remote/host';
import { RemoteHub, type RelayTransport } from './remote/hub';
import { msg } from './i18n';
import { remoteError } from './remote/protocol';
import { ApiError, SyncApi } from './sync/api';
import { AuthManager } from './sync/auth';
import { SyncEngine } from './sync/engine';
import { relayKey } from './sync/relay';
import { McpManager } from './tools/mcpManager';
import { ToolRegistry } from './tools/registry';
import { SkillRepository } from './tools/skills';
import { WebSearch, type SearchConfig } from './tools/webSearch';
import { isSearchKind, searchKind } from './tools/types';

export class App {
  readonly settings = new SettingsStore();
  readonly auth = new AuthManager();
  readonly attachments: AttachmentStore;
  readonly sync: SyncEngine;
  readonly conversations: ConversationRepository;
  readonly assistants: AssistantRepository;
  readonly folders: FolderRepository;
  readonly prompts: PromptRepository;
  readonly quirks = new LocalQuirkStore();
  readonly pricing = new PricingCatalog();
  readonly providers: ProviderRepository;
  readonly mcp: McpManager;
  readonly skills: SkillRepository;
  readonly search = new WebSearch();
  readonly media: MediaService;
  readonly tools: ToolRegistry;
  readonly chat: ChatEngine;
  /** The account's other devices: online PCs and encrypted calls to them (docs/REMOTE.md). */
  readonly remote: RemoteHub;
  readonly computers: Computers;
  /** The Windows app's side of remote use. */
  readonly host: HostService | null;

  constructor() {
    const changed = () => this.sync.requestSync();
    this.attachments = new AttachmentStore(changed);
    this.sync = new SyncEngine(this.auth, this.settings, this.attachments);
    this.conversations = new ConversationRepository(changed);
    this.assistants = new AssistantRepository(changed);
    this.folders = new FolderRepository(changed);
    this.prompts = new PromptRepository(changed);
    this.providers = new ProviderRepository(this.quirks, this.pricing, changed);
    this.mcp = new McpManager(changed);
    this.skills = new SkillRepository(changed);
    this.media = new MediaService({ providers: this.providers, settings: this.settings, attachments: this.attachments });
    this.tools = new ToolRegistry({
      search: this.search,
      searchConfig: () => this.searchConfig(),
      mcp: this.mcp,
      skills: this.skills,
      settings: this.settings,
      media: this.media,
      computerFor: (id) => this.computerFor(id),
    });
    this.chat = new ChatEngine(
      this.conversations, this.providers, this.assistants, this.attachments, this.settings, this.pricing, this.sync, this.tools,
      (serverId, tool) => this.mcp.autoApprove(serverId, tool),
    );
    this.remote = new RemoteHub(this.relayTransport());
    this.computers = new Computers(this.remote, () => this.defaultFolder(), () => this.recentFolders());
    this.host = platform().host
      ? new HostService(this.remote, {
          defaultFolder: () => this.defaultFolder(),
          recentFolders: () => this.recentFolders(),
          openSettings: () => void import('./ui/nav').then(({ ui }) => ui.openSettings('computer')),
        })
      : null;
    this.sync.onStreamEvent = (event, data) => this.remote.streamEvent(event, data);
    this.chat.subscribe(() => platform().host?.setBusy(this.chat.active.size > 0));
    this.settings.onSyncedChanged = changed;
    this.auth.onProfileName = (name) => void this.settings.updateSynced((s) => ({ ...s, profileName: name }));
    this.auth.onSignedIn = (fresh) => {
      void (async () => {
        if (fresh) await this.sync.markEverythingDirty();
        else await this.sync.resetCursor();
        this.sync.requestSync(0);
      })();
    };
  }

  /** Loads stored state and starts background work. */
  async start(): Promise<void> {
    await Promise.all([this.settings.load(), this.auth.load()]);
    await this.recoverInterrupted();
    await this.computers.start();
    await this.host?.start().catch(() => {});
    this.remote.start();
    let signedIn = false;
    this.auth.subscribe(() => {
      if (this.auth.isSignedIn === signedIn) return;
      signedIn = this.auth.isSignedIn;
      this.relayKeyCache = null;
      if (signedIn) void this.remote.discover();
      else this.remote.reset();
    });
    signedIn = this.auth.isSignedIn;
    if (signedIn) void this.remote.discover();
    await this.sync.start();
    void this.pricing.refreshIfStale({ enabled: this.settings.local.pricingFeed });
    this.keepListsFresh();
  }

  /**
   * Providers and MCP servers that arrive by sync (or were just added) fetch their model and tool
   * lists; model lists older than a day refresh once per launch, so new models show up.
   */
  private keepListsFresh(): void {
    const triedModels = new Set<string>();
    liveQuery(() => db().providers.filter((p) => p.deleted === 0).toArray()).subscribe((list) => {
      const stale = Date.now() - 24 * 60 * 60 * 1000;
      for (const p of list) {
        if (!p.enabled || p.modelsFetchedAt >= stale || isSearchKind(p.kind) || triedModels.has(p.id)) continue;
        triedModels.add(p.id);
        void this.providers.refreshModels(p.id).catch(() => {});
      }
    });
    const triedTools = new Set<string>();
    liveQuery(() => db().mcpServers.filter((s) => s.deleted === 0).toArray()).subscribe((list) => {
      for (const s of list) {
        if (!s.enabled || s.toolsFetchedAt !== 0 || s.status || triedTools.has(s.id) || (s.stdio && !platform().stdio)) continue;
        triedTools.add(s.id);
        void this.mcp.refreshTools(s.id).catch(() => {});
      }
    });
  }

  /** The configured BYOK search backend, if any. */
  async searchConfig(): Promise<SearchConfig | null> {
    for (const p of await this.providers.all()) {
      if (!p.enabled || !isSearchKind(p.kind)) continue;
      const kind = searchKind(p.kind);
      if (kind) return { kind, apiKey: await this.providers.apiKey(p), baseUrl: p.baseUrl };
    }
    return null;
  }

  /** The Windows app's default working folder (Settings, else the bridge's default). */
  async defaultFolder(): Promise<string> {
    const configured = this.settings.local.defaultWorkspace;
    if (configured) return configured;
    return (await platform().computer?.defaultWorkspace()) ?? '';
  }

  /** Folders of this PC's most recent chats, newest first. */
  async recentFolders(): Promise<string[]> {
    const me = this.computers.hostId;
    const chats = await db().conversations.filter((c) => c.deleted === 0 && (!!c.workspace || (!!me && c.computerHost === me && !!c.computerFolder))).toArray();
    chats.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const out: string[] = [];
    for (const c of chats) {
      const f = (me && c.computerHost === me ? c.computerFolder : null) || c.workspace;
      if (f && !out.includes(f)) out.push(f);
      if (out.length >= 8) break;
    }
    return out;
  }

  /** The computer for a chat's fields (or a new chat's choice). */
  computerState(fields: ComputerFields | null | undefined): Promise<ComputerState> {
    return this.computers.resolve(fields);
  }

  /** The computer a chat's tools run on right now, if any. */
  async computerFor(conversationId: string | null | undefined): Promise<ChatComputer | null> {
    const conv = conversationId ? await db().conversations.get(conversationId) : undefined;
    const state = await this.computers.resolve(conv ?? null);
    return state.kind === 'ready' ? state.computer : null;
  }

  private relayKeyCache: Promise<CryptoKey | null> | null = null;

  private relayTransport(): RelayTransport {
    const api = new SyncApi((i, init) => platform().fetch(i, init));
    return {
      me: () => this.auth.sessionId(),
      key: () => {
        if (!this.relayKeyCache) {
          this.relayKeyCache = this.auth.vault().then((v) => (v ? relayKey(v.raw) : null)).catch(() => null);
        }
        return this.relayKeyCache;
      },
      send: async (to, body) => {
        try {
          await this.auth.authed((base, token) => api.relay(base, token, to, body));
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) throw remoteError('offline', msg('That device is offline.'));
          throw e;
        }
      },
      peers: () => this.auth.authed((base, token) => api.relayPeers(base, token)),
    };
  }

  /** Replies left "streaming" by a closed window become "stopped", unless another window is still writing them. */
  private async recoverInterrupted(): Promise<void> {
    const active = new Set<string>();
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (locks?.query) {
      const state = await locks.query();
      for (const l of state.held ?? []) if (l.name?.startsWith('facet-gen:')) active.add(l.name.slice('facet-gen:'.length));
    }
    await this.conversations.recoverInterrupted(active);
  }
}

let app: App | null = null;

export function getApp(): App {
  if (!app) app = new App();
  return app;
}
