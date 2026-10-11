/**
 * Facet for Windows: the Electron shell around the shared web app (client/, built into renderer/).
 * It adds what a browser can't do: local computer access for models, local MCP servers, DPAPI
 * secrets, OAuth loopback redirects, notifications, file saving and auto-updates. It can keep
 * running in the notification area so the account's other devices can use this PC (docs/REMOTE.md).
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import { promises as fsp, existsSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentKind, DesktopSettings, UpdateState } from '../../client/src/platform/platform';
import { listAgentSessions, readAgentSession } from './agents';
import { Ch } from './channels';
import { ComputerService } from './computer';
import { listFolders } from './folders';
import { HostSettings } from './host-settings';
import { ShellTexts } from './shell-text';
import { OAuthLoopback } from './oauth';
import { APP_ORIGIN, APP_URL, createHandler, SCHEME } from './protocol';
import { Secrets } from './secrets';
import { StdioServers, type StdioSpec } from './stdio';
import { AppTray } from './tray';
import { UpdateSplash } from './update-splash';
import { Updates } from './updates';
import { loadWindowState, MIN_HEIGHT, MIN_WIDTH, trackWindowState } from './window-state';

const APP_ID = 'io.dtsoftware.facet';
const BACKGROUND = '#11151B';

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const isDev = !app.isPackaged;
/** Dev only: load the Vite dev server instead of renderer/ (e.g. FACET_DEV_URL=http://localhost:5173/app/). */
const DEV_URL = isDev && process.env.FACET_DEV_URL ? process.env.FACET_DEV_URL : null;
const DEV_ORIGIN = DEV_URL ? new URL(DEV_URL).origin : null;
/** Dev only: serve another folder as the renderer (e.g. a placeholder page for testing the shell). */
const RENDERER_DIR = (isDev && process.env.FACET_RENDERER_DIR) || path.join(app.getAppPath(), 'renderer');
const SELFTEST = (() => {
  const a = process.argv.find((x) => x.startsWith('--facet-selftest'));
  if (!a) return null;
  const v = a.split('=')[1];
  return { out: v ? path.resolve(v) : null };
})();

/**
 * Dev only: `electron . --facet-script=steps.json` runs scripted UI steps (JavaScript in the page,
 * waits, screenshots) for end-to-end checks of the real app, then quits. Never in packaged builds.
 */
const SCRIPT = (() => {
  const a = isDev ? process.argv.find((x) => x.startsWith('--facet-script=')) : undefined;
  return a ? path.resolve(a.slice('--facet-script='.length)) : null;
})();

// Keep development and self-test data (vault, chats, window state) apart from the installed app's.
if (SCRIPT) {
  app.setPath('userData', path.join(os.tmpdir(), `facet-script-${path.basename(SCRIPT, '.json')}`));
} else if (SELFTEST) {
  // Remove what earlier self-tests left behind (Chromium holds its files until the process ends).
  for (const d of readdirSync(os.tmpdir()).filter((n) => n.startsWith('facet-selftest-'))) {
    try {
      rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
    } catch {
      /* in use */
    }
  }
  app.setPath('userData', path.join(os.tmpdir(), `facet-selftest-${process.pid}`));
} else if (isDev) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Facet Dev'));
}

let mainWindow: BrowserWindow | null = null;
let quitting = false;
/** The window's first show applies the remembered maximized state. */
let pendingMaximize = false;
/** True while the app writes replies (the renderer tells us), so updates wait. */
let busy = false;
let hostSettings: HostSettings | null = null;
let shellText: ShellTexts | null = null;
let tray: AppTray | null = null;

/** Left by an update that installed while Facet was in the background: start hidden again. */
const RELAUNCH_HIDDEN = 'relaunch-hidden';
const startHidden = (() => {
  if (SELFTEST || SCRIPT) return false;
  let flagged = false;
  try {
    const flag = path.join(app.getPath('userData'), RELAUNCH_HIDDEN);
    if (existsSync(flag)) {
      unlinkSync(flag);
      flagged = true;
    }
  } catch {
    /* unreadable: start normally */
  }
  return flagged || process.argv.includes('--hidden');
})();

// --------------------------------------------------------------------------------------------
// Services

function sendTo(wcId: number, channel: string, ...args: unknown[]): void {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.id === wcId);
  if (w && !w.webContents.isDestroyed()) w.webContents.send(channel, ...args);
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}

function showMainWindow(): void {
  const w = mainWindow;
  if (!w || w.isDestroyed()) return;
  if (pendingMaximize) {
    pendingMaximize = false;
    w.maximize();
  }
  if (w.isMinimized()) w.restore();
  if (!w.isVisible()) w.show();
  w.focus();
}

function windowHidden(): boolean {
  const w = mainWindow;
  return !w || w.isDestroyed() || !w.isVisible() || w.isMinimized();
}

const computer = new ComputerService({
  openPath: (p) => shell.openPath(p),
  showItemInFolder: (p) => shell.showItemInFolder(p),
  grepWorkerFile: path.join(__dirname, 'grep-worker.js'),
});

const stdio = new StdioServers((ownerId) => ({
  message: (handle, message) => sendTo(ownerId, Ch.stdioMessage, handle, message),
  exit: (handle, code, stderr) => sendTo(ownerId, Ch.stdioExit, handle, code, stderr),
}));

const oauth = new OAuthLoopback(
  (url) => shell.openExternal(url),
  () => showMainWindow(),
);

const updates = new Updates((state: UpdateState) => broadcast(Ch.updatesChanged, state), {
  beforeInstall: () => {
    quitting = true;
    shutdownChildren();
  },
  idle: () => windowHidden() && !busy,
  relaunchHidden: (hidden) => {
    try {
      const flag = path.join(app.getPath('userData'), RELAUNCH_HIDDEN);
      if (hidden) writeFileSync(flag, '1');
      else if (existsSync(flag)) unlinkSync(flag);
    } catch {
      /* best effort */
    }
  },
});

let secrets: Secrets | null = null;

function shutdownChildren(): void {
  oauth.cancel('Facet is closing.');
  computer.shutdown();
  stdio.killAllSync();
}

// --------------------------------------------------------------------------------------------
// IPC (every handler checks that the message comes from the app's own page)

function trustedUrl(url: string): boolean {
  if (url.startsWith(`${APP_ORIGIN}/`)) return true;
  return !!DEV_ORIGIN && url.startsWith(`${DEV_ORIGIN}/`);
}

function handle<A extends unknown[], R>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (e, ...args) => {
    const url = e.senderFrame?.url ?? '';
    if (!trustedUrl(url)) throw new Error('Blocked: this request did not come from Facet.');
    return fn(e, ...(args as A));
  });
}

const SAFE_EXTERNAL = new Set(['http:', 'https:', 'mailto:']);

function openExternalSafe(url: string): void {
  try {
    const u = new URL(url);
    if (SAFE_EXTERNAL.has(u.protocol)) void shell.openExternal(u.toString());
  } catch {
    /* not a URL */
  }
}

function deviceName(): string {
  const kind = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'Mac' : 'Linux';
  return `Facet AI for ${kind} · ${os.hostname()}`.slice(0, 80);
}

function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const n = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  return n.slice(0, 200) || 'download';
}

const notifications = new Set<Notification>();

function registerIpc(): void {
  handle(Ch.deviceName, () => deviceName());
  handle(Ch.secretsSeal, (_e, plainB64: string) => secrets!.seal(plainB64));
  handle(Ch.secretsOpen, (_e, sealed: string) => secrets!.open(sealed));
  handle(Ch.openExternal, (_e, url: string) => openExternalSafe(String(url)));

  handle(Ch.saveFile, async (e, name: string, bytes: Uint8Array) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const fileName = sanitizeFileName(String(name ?? ''));
    const ext = path.extname(fileName).slice(1);
    const opts = {
      defaultPath: path.join(app.getPath('downloads'), fileName),
      filters: ext
        ? [
            { name: text().fileOfType.replace('{ext}', ext.toUpperCase()), extensions: [ext] },
            { name: text().allFiles, extensions: ['*'] },
          ]
        : [],
    };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return false;
    await fsp.writeFile(r.filePath, Buffer.from(bytes ?? new Uint8Array()));
    return true;
  });

  handle(Ch.notify, (e, title: string, body: string) => {
    if (!Notification.isSupported()) return;
    const ownerId = e.sender.id;
    const n = new Notification({ title: String(title).slice(0, 200), body: String(body).slice(0, 1000), silent: false });
    notifications.add(n);
    n.on('click', () => {
      notifications.delete(n);
      showMainWindow();
      sendTo(ownerId, Ch.notificationClick);
    });
    n.on('close', () => notifications.delete(n));
    n.show();
    // Don't keep references forever (the Action Center may hold it for long).
    setTimeout(() => notifications.delete(n), 60 * 60 * 1000);
  });

  handle(Ch.oauthRedirectUri, () => oauth.redirectUri());
  handle(Ch.oauthAuthorize, (_e, authUrl: string, redirectUri: string) => oauth.authorize(String(authUrl), String(redirectUri)));
  handle(Ch.oauthCancel, () => oauth.cancel());

  handle(Ch.computerInfo, () => computer.info());
  handle(Ch.computerTools, () => computer.tools());
  handle(Ch.computerCall, (_e, name: string, argumentsJson: string, ctx: { cwd: string; callId: string }) =>
    computer.call(String(name), String(argumentsJson ?? ''), { cwd: String(ctx?.cwd ?? ''), callId: String(ctx?.callId ?? '') }),
  );
  handle(Ch.computerCancel, (_e, callId: string) => computer.cancel(String(callId)));
  handle(Ch.computerDefaultWorkspace, () => computer.defaultWorkspace());
  handle(Ch.computerPickFolder, async (e, current?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts = {
      title: text().chooseFolder,
      defaultPath: current && existsSync(current) ? current : computer.defaultWorkspace(),
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
  });
  handle(Ch.computerOpen, async (_e, p: string, reveal?: boolean) => {
    const target = path.resolve(String(p));
    if (reveal) {
      shell.showItemInFolder(target);
      return;
    }
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  });

  handle(Ch.stdioSpawn, (e, spec: StdioSpec) => stdio.spawn(spec, e.sender.id));
  handle(Ch.stdioSend, (_e, h: string, message: string) => stdio.send(String(h), String(message)));
  handle(Ch.stdioKill, (_e, h: string) => stdio.kill(String(h)));

  handle(Ch.updatesState, () => updates.state());
  handle(Ch.updatesCheck, () => updates.check());
  handle(Ch.updatesInstall, () => updates.install());

  handle(Ch.hostSettings, () => hostSettings!.get());
  handle(Ch.hostSetSettings, (_e, patch: Partial<Omit<DesktopSettings, 'hostId'>>) => hostSettings!.set(patch ?? {}));
  handle(Ch.hostListFolders, (_e, target: string | null, recent: string[]) =>
    listFolders(target == null ? null : String(target), Array.isArray(recent) ? recent.map(String).slice(0, 20) : [], {
      home: os.homedir(),
      desktop: app.getPath('desktop'),
      documents: app.getPath('documents'),
      downloads: app.getPath('downloads'),
    }),
  );
  handle(Ch.hostAgentSessions, (_e, agent: AgentKind, cwd: string) => listAgentSessions(agentKind(agent), String(cwd)));
  handle(Ch.hostReadAgentSession, (_e, agent: AgentKind, cwd: string, id: string) => readAgentSession(agentKind(agent), String(cwd), String(id)));
  handle(Ch.hostSetBusy, (_e, value: boolean) => {
    busy = !!value;
    if (!busy) updates.installIfIdle();
  });
  handle(Ch.hostActivity, (_e, text: string | null) => tray?.setActivity(text == null ? null : String(text)));
  handle(Ch.hostShellStrings, (_e, strings: unknown) => {
    if (shellText?.set(strings)) tray?.refresh();
  });
}

/** The shell's texts in the interface language (English until the interface sends them). */
function text() {
  return shellText ? shellText.get() : new ShellTexts(app.getPath('userData')).get();
}

function agentKind(v: unknown): AgentKind {
  if (v === 'claude' || v === 'codex') return v;
  throw new Error('Unknown agent.');
}

/** Applies settings that live outside the app: starting with Windows, the tray menu. */
function applyHostSettings(s: DesktopSettings): void {
  if (app.isPackaged && process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: s.startWithWindows, path: process.execPath, args: ['--hidden'] });
  }
  tray?.refresh();
}

// --------------------------------------------------------------------------------------------
// Window

const ALLOWED_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'notifications',
  'media',
  // Chromium's Local Network Access: needed to reach local model servers (Ollama, LM Studio)
  // and MCP servers on this computer or the LAN.
  'local-network-access',
  'local-network',
  'loopback-network',
]);

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const fromApp = trustedUrl(details.requestingUrl ?? wc.getURL());
    callback(fromApp && ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    const origin = requestingOrigin.replace(/\/$/, '');
    const fromApp = origin === APP_ORIGIN || (!!DEV_ORIGIN && origin === DEV_ORIGIN);
    return fromApp && ALLOWED_PERMISSIONS.has(permission);
  });
}

function hardenWebContents(wc: WebContents): void {
  wc.on('will-navigate', (e) => {
    if (trustedUrl(e.url)) return;
    e.preventDefault();
    openExternalSafe(e.url);
  });
  wc.on('will-redirect', (e) => {
    if (e.isMainFrame && !trustedUrl(e.url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // A reload starts a fresh page: the local MCP servers it started can't be reached anymore.
  wc.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) stdio.killOwnedBy(wc.id);
  });
  wc.on('context-menu', (_e, params) => {
    const items: MenuItemConstructorOptions[] = [];
    for (const s of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    }
    if (params.misspelledWord) {
      if (items.length === 0) items.push({ label: 'No suggestions', enabled: false });
      items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
      items.push({ type: 'separator' });
    }
    if (params.linkURL && /^(https?|mailto):/i.test(params.linkURL)) {
      items.push({ label: 'Open link in browser', click: () => openExternalSafe(params.linkURL) });
      items.push({ label: 'Copy link', click: () => clipboard.writeText(params.linkURL) });
      items.push({ type: 'separator' });
    }
    const f = params.editFlags;
    if (params.isEditable) {
      items.push({ role: 'undo', enabled: f.canUndo }, { role: 'redo', enabled: f.canRedo }, { type: 'separator' });
      items.push({ role: 'cut', enabled: f.canCut }, { role: 'copy', enabled: f.canCopy }, { role: 'paste', enabled: f.canPaste });
      items.push({ type: 'separator' }, { role: 'selectAll', enabled: f.canSelectAll });
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy' });
    }
    while (items.length && items[items.length - 1].type === 'separator') items.pop();
    if (isDev) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ label: 'Inspect element', click: () => wc.inspectElement(params.x, params.y) });
    }
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
  wc.on('render-process-gone', (_e, details) => {
    console.error('[facet] renderer gone:', details.reason);
    if (details.reason !== 'clean-exit' && !quitting) setTimeout(() => !wc.isDestroyed() && wc.reload(), 500);
  });
}

function windowIcon(): string | undefined {
  const p = path.join(app.getAppPath(), 'build', 'icon.png');
  return existsSync(p) ? p : undefined;
}

function trayIcon(): string {
  const ico = path.join(app.getAppPath(), 'build', 'icon.ico');
  return existsSync(ico) ? ico : windowIcon() ?? ico;
}

function createWindow(autoShow: boolean): BrowserWindow {
  const userData = app.getPath('userData');
  const state = loadWindowState(userData);
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'Facet AI',
    backgroundColor: BACKGROUND,
    titleBarStyle: 'default',
    autoHideMenuBar: true,
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Provider APIs are called directly with the user's own keys and many don't send CORS
      // headers. Everything else is locked down (navigation, windows, permissions, IPC, CSP).
      webSecurity: false,
      webviewTag: false,
      spellcheck: true,
      navigateOnDragDrop: false,
      // Keep timers running while minimized: replies stream in the background.
      backgroundThrottling: false,
    },
  });
  hardenWebContents(win.webContents);
  trackWindowState(win, userData);
  win.on('page-title-updated', (e) => e.preventDefault());
  pendingMaximize = state.maximized;
  win.once('ready-to-show', () => {
    if (autoShow) showMainWindow();
  });
  win.on('close', (e) => {
    // Closing keeps Facet in the notification area, so other devices can still reach this PC.
    if (quitting || !tray || !hostSettings?.get().keepRunning) return;
    e.preventDefault();
    win.hide();
  });
  win.on('hide', () => updates.installIfIdle());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  void win.loadURL(DEV_URL ?? APP_URL);
  return win;
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(isDev
          ? ([{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[])
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  if (process.platform === 'darwin') template.unshift({ role: 'appMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --------------------------------------------------------------------------------------------
// Self-test (`electron . --facet-selftest[=out.json]`): checks the window, protocol and preload API, then quits.

async function runSelfTest(win: BrowserWindow): Promise<void> {
  const report: Record<string, unknown> = {};
  try {
    await new Promise<void>((resolve) => {
      if (!win.webContents.isLoading()) resolve();
      else win.webContents.once('did-finish-load', () => resolve());
    });
    report.url = win.webContents.getURL();
    // A local server to check that the page can reach loopback addresses (local model servers).
    const http = await import('node:http');
    const srv = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/plain' }).end('pong'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    report.page = await win.webContents.executeJavaScript(`(async () => {
      const d = window.facetDesktop;
      const out = { typeofFacetDesktop: typeof d, keys: d ? Object.keys(d) : [], origin: location.origin,
        title: document.title, secureContext: isSecureContext, subtle: typeof crypto.subtle?.digest };
      try { out.computerKeys = Object.keys(d.computer); out.stdioKeys = Object.keys(d.stdio); out.updatesKeys = Object.keys(d.updates); out.oauthKeys = Object.keys(d.oauth); } catch (e) { out.keysError = String(e); }
      try { out.version = d.version; out.deviceName = await d.deviceName(); } catch (e) { out.deviceError = String(e); }
      try { const s = await d.secrets.seal(btoa('hello')); out.sealedPrefix = s.slice(0, 3); out.roundTrip = atob(await d.secrets.open(s)); } catch (e) { out.secretsError = String(e); }
      try { const t = await d.computer.tools(); out.tools = t.map((x) => x.name + (x.readOnly ? ' (ro)' : '')); } catch (e) { out.toolsError = String(e); }
      try { out.info = await d.computer.info(); out.workspace = await d.computer.defaultWorkspace(); } catch (e) { out.infoError = String(e); }
      try { const r = await d.computer.call('run_command', JSON.stringify({ command: 'Write-Output "hi from $($PSVersionTable.PSVersion)"' }), { cwd: out.workspace, callId: 'selftest-1' }); out.run = r; } catch (e) { out.runError = String(e); }
      try { const r = await d.computer.call('grep', JSON.stringify({ pattern: '(facet|generic)', path: ${JSON.stringify(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'src'))}, output_mode: 'count', head_limit: 3 }), { cwd: out.workspace, callId: 'selftest-2' }); out.grep = r; } catch (e) { out.grepError = String(e); }
      try { out.update = await d.updates.state(); } catch (e) { out.updateError = String(e); }
      try { out.redirectUri = await d.oauth.redirectUri(); } catch (e) { out.redirectError = String(e); }
      try { await d.oauth.authorize('https://example.com/auth', 'http://evil.example/cb', new AbortController().signal); out.oauthSignal = 'resolved?'; } catch (e) { out.oauthSignal = 'rejected: ' + String(e && e.message || e); }
      try {
        const h = await d.stdio.spawn({ command: 'node', args: ['-e', "process.stdin.on('data', (b) => process.stdout.write(b)); console.error('ready with spaces')"] });
        const got = await new Promise((resolve) => {
          d.stdio.onMessage(h, (m) => resolve(m));
          d.stdio.send(h, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { text: 'a "quoted" & <odd> %PATH%' } }));
          setTimeout(() => resolve('timeout'), 8000);
        });
        out.stdioEcho = got;
        const exit = new Promise((resolve) => d.stdio.onExit(h, (code, stderr) => resolve({ code, stderr })));
        await d.stdio.kill(h);
        out.stdioExit = await Promise.race([exit, new Promise((r) => setTimeout(() => r('no exit event'), 8000))]);
      } catch (e) { out.stdioError = String(e); }
      try { const r = await fetch('http://127.0.0.1:${port}/'); out.loopbackFetch = r.status + ' ' + await r.text(); } catch (e) { out.loopbackFetch = 'failed: ' + String(e); }
      try { const r = await fetch('facet://app/does-not-exist.js'); out.missingAsset = r.status; const r2 = await fetch('facet://app/some/route'); out.spaRoute = r2.status + ' ' + r2.headers.get('content-type'); out.csp = r2.headers.get('content-security-policy'); } catch (e) { out.protocolError = String(e); }
      try { const r = await fetch('facet://app/..%2f..%2fpackage.json'); out.traversal = r.status; } catch (e) { out.traversal = 'failed: ' + String(e); }
      try { await new Promise((res, rej) => { const q = indexedDB.open('selftest', 1); q.onsuccess = () => { q.result.close(); res(); }; q.onerror = () => rej(q.error); }); out.indexedDB = 'ok'; } catch (e) { out.indexedDB = String(e); }
      try { localStorage.setItem('selftest', '1'); out.localStorage = localStorage.getItem('selftest'); } catch (e) { out.localStorage = String(e); }
      return out;
    })()`);
    srv.close();
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = String(e);
  }
  const text = JSON.stringify(report, null, 2);
  if (SELFTEST?.out) await fsp.writeFile(SELFTEST.out, text);
  else console.log(text);
  quitting = true;
  app.quit();
}

interface ScriptStep {
  js?: string;
  wait?: number;
  shot?: string;
}

async function runScript(win: BrowserWindow, file: string): Promise<void> {
  const steps = JSON.parse(await fsp.readFile(file, 'utf8')) as ScriptStep[];
  const log: string[] = [];
  const dir = path.dirname(file);
  const base = path.basename(file, '.json');
  win.webContents.on('console-message', (e) => {
    const ev = e as unknown as { level?: string | number; message?: string };
    if (ev.level === 'error' || ev.level === 'warning' || (typeof ev.level === 'number' && ev.level >= 2)) log.push('console: ' + (ev.message ?? ''));
  });
  await new Promise<void>((resolve) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', () => resolve()) : resolve()));
  for (const st of steps) {
    if (st.js) {
      try {
        const r = await win.webContents.executeJavaScript(st.js, true);
        if (r !== undefined) log.push('js: ' + JSON.stringify(r).slice(0, 1500));
      } catch (e) {
        log.push('js error: ' + String(e));
      }
    }
    await new Promise((r) => setTimeout(r, st.wait ?? 400));
    if (st.shot) {
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 150));
      const img = await win.webContents.capturePage();
      await fsp.writeFile(path.join(dir, `${base}-${st.shot}.png`), img.toPNG());
      log.push('shot ' + st.shot);
    }
  }
  await fsp.writeFile(path.join(dir, `${base}.log`), log.join('\n') + '\n');
  quitting = true;
  app.quit();
}

// --------------------------------------------------------------------------------------------
// Lifecycle

if (!SELFTEST && !SCRIPT && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  app.whenReady().then(async () => {
    secrets = new Secrets(safeStorage, app.getPath('userData'));
    shellText = new ShellTexts(app.getPath('userData'));
    hostSettings = new HostSettings(app.getPath('userData'), (s) => {
      broadcast(Ch.hostSettingsChanged, s);
      applyHostSettings(s);
    });
    protocol.handle(SCHEME, createHandler(RENDERER_DIR));
    hardenSession();
    registerIpc();
    buildMenu();
    if (SELFTEST || SCRIPT) {
      mainWindow = createWindow(!SELFTEST);
      if (SELFTEST) void runSelfTest(mainWindow);
      else void runScript(mainWindow, SCRIPT!);
      return;
    }
    tray = new AppTray(trayIcon(), {
      open: () => showMainWindow(),
      quit: () => {
        quitting = true;
        app.quit();
      },
      settings: () => hostSettings!.get(),
      setSettings: (patch) => hostSettings!.set(patch),
      text: () => text(),
    });
    tray.create();
    applyHostSettings(hostSettings.get());
    if (startHidden || !app.isPackaged) {
      mainWindow = createWindow(!startHidden);
      updates.start();
    } else {
      mainWindow = createWindow(false);
      await openAfterUpdateCheck();
    }
  });

  app.on('web-contents-created', (_e, wc) => {
    // Any other web contents (there shouldn't be any): no new windows, no webviews.
    wc.setWindowOpenHandler(({ url }) => {
      openExternalSafe(url);
      return { action: 'deny' };
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(true);
  });

  app.on('before-quit', () => {
    quitting = true;
    updates.stop();
    shutdownChildren();
    tray?.destroy();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/**
 * Opening Facet checks for an update first (docs/UPDATES.md). Usually there's none and the window
 * opens as soon as it's ready; a slow check shows a small "Checking for updates…" window, and a
 * new version downloads and installs before Facet opens, unless you choose to open it now.
 */
async function openAfterUpdateCheck(): Promise<void> {
  let splash = null as UpdateSplash | null;
  let skipped = false;
  const open = () => {
    splash?.close();
    splash = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.webContents.isLoading()) mainWindow.once('ready-to-show', () => showMainWindow());
      else showMainWindow();
    }
  };
  const makeSplash = () =>
    (splash ??= new UpdateSplash(windowIcon(), text(), () => {
      skipped = true;
      open();
    }));
  const slow = setTimeout(makeSplash, 700);
  const found = await updates.launchCheck(4000);
  clearTimeout(slow);
  if (found === 'none') {
    open();
    updates.start(true);
    return;
  }
  const s = makeSplash();
  s.update(updates.state());
  // The splash follows the download (it has no IPC of its own).
  const poll = setInterval(() => splash?.update(updates.state()), 300);
  const ok = await updates.whenReady();
  clearInterval(poll);
  if (skipped) {
    updates.start(true);
    return;
  }
  if (ok) {
    splash?.update(updates.state());
    updates.install(false);
    return;
  }
  open();
  updates.start(true);
}
