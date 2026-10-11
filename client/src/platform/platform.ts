/**
 * What differs between the website and the Windows app. Everything else (sync, encryption,
 * chat, tools) is shared code. The Windows app's Electron preload exposes `window.facetDesktop`,
 * which platform/desktop.ts adapts to this interface.
 */

/** Encrypts small local secrets (API keys, vault key, tokens) at rest. */
export interface SecretBox {
  seal(plain: Uint8Array): Promise<string>;
  open(sealed: string): Promise<Uint8Array>;
}

/** A tool the computer offers to models (Windows app): run commands, read and edit files. */
export interface ComputerToolInfo {
  name: string;
  description: string;
  /** JSON Schema of the arguments, as a JSON string. */
  inputSchemaJson: string;
  /** Reads only (never changes files or runs programs): runs without asking unless the user chose "Always ask". */
  readOnly: boolean;
}

export interface ComputerCallResult {
  content: string;
  isError: boolean;
  /** Short past-tense line for the UI, e.g. "Ran npm test" or "Edited src/app.ts". */
  label?: string;
}

export interface ComputerInfo {
  os: string;
  /** The shell commands run in, e.g. "PowerShell 7.4". */
  shell: string;
  home: string;
  user: string;
  hostname: string;
}

/** Local computer access for models (Windows app only). Runs in Electron's main process. */
export interface ComputerBridge {
  info(): Promise<ComputerInfo>;
  tools(): Promise<ComputerToolInfo[]>;
  /** Runs a tool in [cwd] (the chat's working folder). [callId] identifies it for [cancel]. */
  call(name: string, argumentsJson: string, ctx: { cwd: string; callId: string }): Promise<ComputerCallResult>;
  cancel(callId: string): Promise<void>;
  /** The folder new chats work in until the user picks another. */
  defaultWorkspace(): Promise<string>;
  /** Shows a folder picker; null when cancelled. */
  pickFolder(current?: string): Promise<string | null>;
  /** Opens a file or folder with its default app (or reveals it in Explorer). */
  open(path: string, reveal?: boolean): Promise<void>;
}

/** Local MCP servers over stdin/stdout (Windows app only). Messages are JSON-RPC strings, one per line. */
export interface StdioBridge {
  spawn(spec: { command: string; args: string[]; env?: Record<string, string>; cwd?: string | null }): Promise<string>;
  send(handle: string, message: string): Promise<void>;
  /** Subscribes to messages (one JSON-RPC message per call). Returns an unsubscribe function. */
  onMessage(handle: string, listener: (message: string) => void): () => void;
  /** Fires once when the process exits, with its exit code and the end of its stderr. */
  onExit(handle: string, listener: (code: number | null, stderr: string) => void): () => void;
  kill(handle: string): Promise<void>;
}

/** OAuth 2.1 sign-in for MCP servers: opens the authorization page and waits for the redirect. */
export interface OAuthBridge {
  /** The redirect URI to register with the authorization server. */
  redirectUri(): Promise<string>;
  /** Opens [authUrl] and resolves with the full URL the server redirected to (with code and state). */
  authorize(authUrl: string, redirectUri: string, signal?: AbortSignal): Promise<string>;
}

/** The Windows app's own settings, kept by its main process (they apply before any window opens). */
export interface DesktopSettings {
  /** Identifies this Windows install to the account's other devices (docs/REMOTE.md). */
  hostId: string;
  /** Let the account's other devices use this PC. Off until the owner switches it on. */
  remoteAccess: boolean;
  /** Start hidden in the notification area when the user signs in to Windows. */
  startWithWindows: boolean;
  /** Closing the window keeps Facet running in the notification area. */
  keepRunning: boolean;
}

export interface FolderEntry {
  name: string;
  path: string;
}

/** One level of a folder browser: the folders in [path], or the starting places when [path] is null. */
export interface FolderListing {
  path: string | null;
  parent: string | null;
  folders: FolderEntry[];
  places: FolderEntry[];
}

export type AgentKind = 'claude' | 'codex';

export interface AgentSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface ImportedMessage {
  role: 'user' | 'assistant';
  text: string;
  at?: number;
}

/** A Claude Code or Codex session converted for Facet (docs/REMOTE.md). */
export interface ImportedSession {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  messages: ImportedMessage[];
  truncated: boolean;
}

/** What the Windows app adds as a host for the account's other devices (docs/REMOTE.md). */
export interface HostBridge {
  settings(): Promise<DesktopSettings>;
  setSettings(patch: Partial<Omit<DesktopSettings, 'hostId'>>): Promise<DesktopSettings>;
  onSettings(listener: (settings: DesktopSettings) => void): () => void;
  /** Folders in [path] (or the starting places, with [recent] chat folders among them). */
  listFolders(path: string | null, recent: string[]): Promise<FolderListing>;
  agentSessions(agent: AgentKind, cwd: string): Promise<AgentSessionSummary[]>;
  readAgentSession(agent: AgentKind, cwd: string, id: string): Promise<ImportedSession | null>;
  /** True while replies are being written, so updates don't restart the app mid-reply. */
  setBusy(busy: boolean): void;
  /** A short line for the notification-area tooltip, e.g. "Used from Pixel 9 at 14:02". */
  activity(text: string | null): void;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  version?: string;
  progress?: number;
  message?: string;
}

/** App updates (Windows app only). */
export interface UpdateBridge {
  state(): Promise<UpdateState>;
  onState(listener: (state: UpdateState) => void): () => void;
  check(): Promise<void>;
  /** Restarts into the downloaded update. */
  install(): Promise<void>;
}

export interface Platform {
  kind: 'web' | 'desktop';
  /** Sent to the sync server as the session's platform (older servers store windows as other). */
  apiPlatform: 'web' | 'windows' | 'other';
  /** Sync server used until the user picks another. */
  defaultServerUrl: string;
  /** Short name for this device in the signed-in devices list. */
  deviceName(): Promise<string>;
  /** fetch for provider, MCP and search requests. On the website it is subject to CORS. */
  fetch: typeof fetch;
  /** True when provider requests are subject to CORS (the website). */
  corsLimited: boolean;
  secrets: SecretBox;
  openExternal(url: string): void;
  /** Saves a file the user exported or downloaded. */
  saveFile(name: string, data: Blob): Promise<void>;
  /** A system notification (reply finished while the window was in the background). */
  notify(title: string, body: string, onClick?: () => void): void;
  oauth: OAuthBridge;
  computer?: ComputerBridge;
  stdio?: StdioBridge;
  updates?: UpdateBridge;
  host?: HostBridge;
  version: string;
}
