/**
 * App updates through electron-updater's generic provider (latest.yml + installer on
 * facet.dtsoftware.io), as described in docs/UPDATES.md. The app isn't code-signed, so no
 * publisherName is configured and electron-updater skips the signature check (the installer's
 * sha512 from latest.yml is still verified).
 *
 * When you open Facet it checks first and, if there's a new version, installs it before you start.
 * While it runs (often hidden in the notification area) it checks every 6 hours and installs a
 * downloaded update as soon as the window is hidden and no reply is being written.
 */
import { app } from 'electron';
import type { UpdateState } from '../../client/src/platform/platform';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15 * 1000;

type Updater = typeof import('electron-updater').autoUpdater;

export interface UpdateHooks {
  /** Everything to stop before the installer runs (local servers, commands…). */
  beforeInstall(): void;
  /** True when an update may install without asking: the window is hidden and nothing is running. */
  idle(): boolean;
  /** Remembers to start hidden again after the installer restarts the app. */
  relaunchHidden(hidden: boolean): void;
}

export class Updates {
  private current: UpdateState = { status: 'idle' };
  private updater: Updater | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly waiters = new Set<(state: UpdateState) => void>();

  constructor(
    private readonly broadcast: (state: UpdateState) => void,
    private readonly hooks: UpdateHooks,
  ) {}

  state(): UpdateState {
    return this.current;
  }

  private set(state: UpdateState): void {
    this.current = state;
    this.broadcast(state);
    for (const w of [...this.waiters]) w(state);
    if (state.status === 'ready') this.installIfIdle();
  }

  private get(): Updater | null {
    if (!app.isPackaged) return null;
    if (this.updater) return this.updater;
    // Loaded lazily: it reads app-update.yml, which only exists in the installed app.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = {
      info: (m?: unknown) => console.log('[updates]', m),
      warn: (m?: unknown) => console.warn('[updates]', m),
      error: (m?: unknown) => console.error('[updates]', m),
      debug: () => {},
    };
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'idle' }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'available', version: info.version }));
    autoUpdater.on('download-progress', (p) =>
      this.set({ status: 'downloading', version: this.current.version, progress: Math.round(p.percent) }),
    );
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }));
    autoUpdater.on('error', (e: Error) => this.set({ status: 'error', message: friendly(e), version: this.current.version }));
    this.updater = autoUpdater;
    return autoUpdater;
  }

  /** Checks every 6 hours (installed app only); [checkedAtLaunch] skips the first, early check. */
  start(checkedAtLaunch = false): void {
    if (!app.isPackaged) return;
    if (!checkedAtLaunch) setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The check when Facet opens: resolves "available" as soon as a newer version is found (it then
   * downloads), or "none" when there's none, it failed, or it took longer than [timeoutMs].
   */
  async launchCheck(timeoutMs: number): Promise<'available' | 'none'> {
    if (!this.get()) return 'none';
    const found = new Promise<'available' | 'none'>((resolve) => {
      const timer = setTimeout(() => done('none'), timeoutMs);
      const done = (r: 'available' | 'none') => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(r);
      };
      const waiter = (s: UpdateState) => {
        if (s.status === 'available' || s.status === 'downloading' || s.status === 'ready') done('available');
        else if (s.status === 'idle' || s.status === 'error') done('none');
      };
      this.waiters.add(waiter);
    });
    void this.check();
    return found;
  }

  /** Resolves when the download finishes (true) or fails (false). */
  whenReady(): Promise<boolean> {
    if (this.current.status === 'ready') return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = (s: UpdateState) => {
        if (s.status === 'ready' || s.status === 'error' || s.status === 'idle') {
          this.waiters.delete(waiter);
          resolve(s.status === 'ready');
        }
      };
      this.waiters.add(waiter);
    });
  }

  async check(): Promise<void> {
    const u = this.get();
    if (!u) {
      this.set({ status: 'idle', message: 'Updates are only available in the installed app.' });
      return;
    }
    // Don't restart a download in progress or forget an update that's ready.
    if (this.current.status === 'downloading' || this.current.status === 'ready' || this.current.status === 'checking') return;
    try {
      await u.checkForUpdates();
    } catch (e) {
      this.set({ status: 'error', message: friendly(e as Error) });
    }
  }

  /** Restarts into the downloaded update. [hidden]: start in the notification area afterwards. */
  install(hidden = false): void {
    const u = this.get();
    if (!u || this.current.status !== 'ready') return;
    this.hooks.relaunchHidden(hidden);
    this.hooks.beforeInstall();
    // Silent install, then start the new version.
    setImmediate(() => u.quitAndInstall(true, true));
  }

  /** Installs a ready update when nobody would notice (window hidden, no reply running). */
  installIfIdle(): void {
    if (this.current.status === 'ready' && this.hooks.idle()) this.install(true);
  }
}

function friendly(e: Error): string {
  const m = e?.message ?? String(e);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(m)) return "Couldn't reach the update server.";
  return m.split('\n')[0].slice(0, 300);
}
