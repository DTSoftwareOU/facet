/**
 * App updates through electron-updater's generic provider (latest.yml + installer on
 * facet.dtsoftware.io). The app isn't code-signed, so no publisherName is configured and
 * electron-updater skips the signature check (the installer's sha512 from latest.yml is still verified).
 */
import { app } from 'electron';
import type { UpdateState } from '../../client/src/platform/platform';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15 * 1000;

type Updater = typeof import('electron-updater').autoUpdater;

export class Updates {
  private current: UpdateState = { status: 'idle' };
  private updater: Updater | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly broadcast: (state: UpdateState) => void,
    private readonly beforeInstall: () => void,
  ) {}

  state(): UpdateState {
    return this.current;
  }

  private set(state: UpdateState): void {
    this.current = state;
    this.broadcast(state);
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

  /** Checks shortly after start and every 6 hours (installed app only). */
  start(): void {
    if (!app.isPackaged) return;
    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  install(): void {
    const u = this.get();
    if (!u || this.current.status !== 'ready') return;
    this.beforeInstall();
    // Silent install, then start the new version.
    setImmediate(() => u.quitAndInstall(true, true));
  }
}

function friendly(e: Error): string {
  const m = e?.message ?? String(e);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(m)) return "Couldn't reach the update server.";
  return m.split('\n')[0].slice(0, 300);
}
