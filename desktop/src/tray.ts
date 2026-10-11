/** The notification-area icon: Facet keeps running there so the account's other devices can reach this PC. */
import { Menu, nativeImage, Tray } from 'electron';
import type { DesktopSettings } from '../../client/src/platform/platform';
import type { ShellText } from './shell-text';

export interface TrayActions {
  open(): void;
  quit(): void;
  settings(): DesktopSettings;
  setSettings(patch: Partial<Omit<DesktopSettings, 'hostId'>>): void;
  /** The menu's texts in the interface language. */
  text(): ShellText;
}

export class AppTray {
  private tray: Tray | null = null;
  private activity: string | null = null;

  constructor(
    private readonly iconPath: string,
    private readonly actions: TrayActions,
  ) {}

  create(): void {
    if (this.tray) return;
    this.tray = new Tray(nativeImage.createFromPath(this.iconPath));
    this.tray.on('click', () => this.actions.open());
    this.tray.on('double-click', () => this.actions.open());
    this.refresh();
  }

  /** Rebuilds the menu and tooltip (after a settings change or new activity). */
  refresh(): void {
    if (!this.tray) return;
    const s = this.actions.settings();
    const text = this.actions.text();
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: text.open, click: () => this.actions.open() },
        { type: 'separator' },
        {
          label: text.remote,
          type: 'checkbox',
          checked: s.remoteAccess,
          click: (item) => this.actions.setSettings({ remoteAccess: item.checked }),
        },
        {
          label: text.startWithWindows,
          type: 'checkbox',
          checked: s.startWithWindows,
          click: (item) => this.actions.setSettings({ startWithWindows: item.checked }),
        },
        { type: 'separator' },
        { label: text.quit, click: () => this.actions.quit() },
      ]),
    );
    const lines = ['Facet AI', s.remoteAccess ? text.remoteOn : null, this.activity].filter(Boolean);
    // Windows cuts tooltips at 127 characters.
    this.tray.setToolTip(lines.join('\n').slice(0, 127));
  }

  setActivity(text: string | null): void {
    this.activity = text ? text.slice(0, 80) : null;
    this.refresh();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
