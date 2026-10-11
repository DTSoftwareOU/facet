/**
 * The Windows app's own settings (client DesktopSettings): kept by the main process because some
 * apply before any window exists (starting hidden with Windows, the tray, remote use).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DesktopSettings } from '../../client/src/platform/platform';

const FILE = 'desktop-settings.json';

const DEFAULTS: Omit<DesktopSettings, 'hostId'> = {
  remoteAccess: false,
  startWithWindows: true,
  keepRunning: true,
};

export class HostSettings {
  private value: DesktopSettings;

  constructor(
    private readonly dir: string,
    private readonly onChange: (settings: DesktopSettings) => void,
  ) {
    let stored: Partial<DesktopSettings> = {};
    try {
      stored = JSON.parse(readFileSync(path.join(dir, FILE), 'utf8')) as Partial<DesktopSettings>;
    } catch {
      // First run, or an unreadable file: start from the defaults.
    }
    const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
    this.value = {
      hostId: typeof stored.hostId === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(stored.hostId) ? stored.hostId : randomBytes(16).toString('base64url'),
      remoteAccess: bool(stored.remoteAccess, DEFAULTS.remoteAccess),
      startWithWindows: bool(stored.startWithWindows, DEFAULTS.startWithWindows),
      keepRunning: bool(stored.keepRunning, DEFAULTS.keepRunning),
    };
    if (stored.hostId !== this.value.hostId) this.save();
  }

  get(): DesktopSettings {
    return { ...this.value };
  }

  set(patch: Partial<Omit<DesktopSettings, 'hostId'>>): DesktopSettings {
    const next = { ...this.value };
    for (const key of ['remoteAccess', 'startWithWindows', 'keepRunning'] as const) {
      if (typeof patch?.[key] === 'boolean') next[key] = patch[key]!;
    }
    const changed = (Object.keys(next) as (keyof DesktopSettings)[]).some((k) => next[k] !== this.value[k]);
    this.value = next;
    if (changed) {
      this.save();
      this.onChange(this.get());
    }
    return this.get();
  }

  private save(): void {
    try {
      writeFileSync(path.join(this.dir, FILE), JSON.stringify(this.value, null, 2));
    } catch (e) {
      console.error('[facet] could not save desktop settings:', e);
    }
  }
}
