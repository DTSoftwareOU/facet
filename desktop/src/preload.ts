/**
 * Exposes `window.facetDesktop` (client/src/platform/desktop.ts → DesktopApi) to the web app.
 * Runs sandboxed: only contextBridge and ipcRenderer, no Node APIs. Every call is validated
 * again in the main process.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopApi } from '../../client/src/platform/desktop';
import type {
  AgentSessionSummary,
  ComputerCallResult,
  ComputerInfo,
  ComputerToolInfo,
  DesktopSettings,
  FolderListing,
  ImportedSession,
  UpdateState,
} from '../../client/src/platform/platform';
import { Ch } from './channels';

declare const __FACET_APP_VERSION__: string;

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>;

// --- notification clicks ------------------------------------------------------------------------

const clickListeners = new Set<() => void>();
ipcRenderer.on(Ch.notificationClick, () => {
  for (const l of clickListeners) l();
});

// --- stdio events (buffered until someone subscribes, so nothing is lost between spawn and subscribe)

type MessageListener = (message: string) => void;
type ExitListener = (code: number | null, stderr: string) => void;

const messageListeners = new Map<string, Set<MessageListener>>();
const exitListeners = new Map<string, Set<ExitListener>>();
const pendingMessages = new Map<string, string[]>();
const exits = new Map<string, { code: number | null; stderr: string }>();
const MAX_PENDING = 1000;

ipcRenderer.on(Ch.stdioMessage, (_e: IpcRendererEvent, handle: string, message: string) => {
  const ls = messageListeners.get(handle);
  if (ls && ls.size > 0) {
    for (const l of ls) l(message);
    return;
  }
  const q = pendingMessages.get(handle) ?? [];
  if (q.length < MAX_PENDING) q.push(message);
  pendingMessages.set(handle, q);
});

ipcRenderer.on(Ch.stdioExit, (_e: IpcRendererEvent, handle: string, code: number | null, stderr: string) => {
  exits.set(handle, { code, stderr });
  const ls = exitListeners.get(handle);
  if (ls) for (const l of ls) l(code, stderr);
  exitListeners.delete(handle);
  // Messages nobody will read anymore.
  if (!messageListeners.get(handle)?.size) setTimeout(() => pendingMessages.delete(handle), 30000);
});

// --- updates ------------------------------------------------------------------------------------

const updateListeners = new Set<(s: UpdateState) => void>();
ipcRenderer.on(Ch.updatesChanged, (_e: IpcRendererEvent, state: UpdateState) => {
  for (const l of updateListeners) l(state);
});

// --- this PC's own settings -------------------------------------------------------------------------

const settingsListeners = new Set<(s: DesktopSettings) => void>();
ipcRenderer.on(Ch.hostSettingsChanged, (_e: IpcRendererEvent, s: DesktopSettings) => {
  for (const l of settingsListeners) l(s);
});

const api: DesktopApi = {
  version: __FACET_APP_VERSION__,
  deviceName: () => invoke<string>(Ch.deviceName),
  secrets: {
    seal: (plainB64) => invoke<string>(Ch.secretsSeal, plainB64),
    open: (sealed) => invoke<string>(Ch.secretsOpen, sealed),
  },
  openExternal: (url) => {
    void invoke(Ch.openExternal, String(url)).catch(() => {});
  },
  saveFile: (name, bytes) => invoke<boolean>(Ch.saveFile, String(name), bytes),
  notify: (title, body) => {
    void invoke(Ch.notify, String(title ?? ''), String(body ?? '')).catch(() => {});
  },
  onNotificationClick: (listener) => {
    clickListeners.add(listener);
    return () => {
      clickListeners.delete(listener);
    };
  },
  oauth: {
    redirectUri: () => invoke<string>(Ch.oauthRedirectUri),
    // AbortSignals can't cross the context bridge; use oauth.cancel() to stop waiting.
    authorize: (authUrl, redirectUri) => invoke<string>(Ch.oauthAuthorize, String(authUrl), String(redirectUri)),
    cancel: () => invoke<void>(Ch.oauthCancel),
  },
  computer: {
    info: () => invoke<ComputerInfo>(Ch.computerInfo),
    tools: () => invoke<ComputerToolInfo[]>(Ch.computerTools),
    call: (name, argumentsJson, ctx) =>
      invoke<ComputerCallResult>(Ch.computerCall, String(name), String(argumentsJson ?? ''), {
        cwd: String(ctx?.cwd ?? ''),
        callId: String(ctx?.callId ?? ''),
      }),
    cancel: (callId) => invoke<void>(Ch.computerCancel, String(callId)),
    defaultWorkspace: () => invoke<string>(Ch.computerDefaultWorkspace),
    pickFolder: (current) => invoke<string | null>(Ch.computerPickFolder, current == null ? undefined : String(current)),
    open: (path, reveal) => invoke<void>(Ch.computerOpen, String(path), !!reveal),
  },
  stdio: {
    spawn: (spec) =>
      invoke<string>(Ch.stdioSpawn, {
        command: String(spec?.command ?? ''),
        args: Array.isArray(spec?.args) ? spec.args.map(String) : [],
        env: spec?.env ? { ...spec.env } : undefined,
        cwd: spec?.cwd ?? null,
      }),
    send: (handle, message) => invoke<void>(Ch.stdioSend, String(handle), String(message)),
    onMessage: (handle, listener) => {
      const set = messageListeners.get(handle) ?? new Set<MessageListener>();
      set.add(listener);
      messageListeners.set(handle, set);
      const queued = pendingMessages.get(handle);
      if (queued) {
        pendingMessages.delete(handle);
        queueMicrotask(() => {
          for (const m of queued) listener(m);
        });
      }
      return () => {
        set.delete(listener);
        if (set.size === 0) messageListeners.delete(handle);
      };
    },
    onExit: (handle, listener) => {
      const done = exits.get(handle);
      if (done) {
        queueMicrotask(() => listener(done.code, done.stderr));
        return () => {};
      }
      const set = exitListeners.get(handle) ?? new Set<ExitListener>();
      set.add(listener);
      exitListeners.set(handle, set);
      return () => {
        set.delete(listener);
      };
    },
    kill: (handle) => invoke<void>(Ch.stdioKill, String(handle)),
  },
  updates: {
    state: () => invoke<UpdateState>(Ch.updatesState),
    onState: (listener) => {
      updateListeners.add(listener);
      return () => {
        updateListeners.delete(listener);
      };
    },
    check: () => invoke<void>(Ch.updatesCheck),
    install: () => invoke<void>(Ch.updatesInstall),
  },
  host: {
    settings: () => invoke<DesktopSettings>(Ch.hostSettings),
    setSettings: (patch) =>
      invoke<DesktopSettings>(Ch.hostSetSettings, {
        remoteAccess: typeof patch?.remoteAccess === 'boolean' ? patch.remoteAccess : undefined,
        startWithWindows: typeof patch?.startWithWindows === 'boolean' ? patch.startWithWindows : undefined,
        keepRunning: typeof patch?.keepRunning === 'boolean' ? patch.keepRunning : undefined,
      }),
    onSettings: (listener) => {
      settingsListeners.add(listener);
      return () => {
        settingsListeners.delete(listener);
      };
    },
    listFolders: (target, recent) =>
      invoke<FolderListing>(Ch.hostListFolders, target == null ? null : String(target), Array.isArray(recent) ? recent.map(String) : []),
    agentSessions: (agent, cwd) => invoke<AgentSessionSummary[]>(Ch.hostAgentSessions, String(agent), String(cwd)),
    readAgentSession: (agent, cwd, id) => invoke<ImportedSession | null>(Ch.hostReadAgentSession, String(agent), String(cwd), String(id)),
    setBusy: (value) => {
      void invoke(Ch.hostSetBusy, !!value).catch(() => {});
    },
    activity: (text) => {
      void invoke(Ch.hostActivity, text == null ? null : String(text)).catch(() => {});
    },
    setShellStrings: (strings) => {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(strings ?? {})) if (typeof v === 'string') clean[String(k)] = v;
      void invoke(Ch.hostShellStrings, clean).catch(() => {});
    },
  },
};

contextBridge.exposeInMainWorld('facetDesktop', api);
