/**
 * The shell's own texts (notification-area menu, update window, file dialogs) in the interface
 * language. The renderer sends them (client/src/platform/shellStrings.ts); they're saved so the
 * update window, which opens before the renderer, speaks the same language on the next launch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ENGLISH = {
  open: 'Open Facet AI',
  quit: 'Quit Facet AI',
  remote: 'Let your other devices use this PC',
  startWithWindows: 'Start with Windows',
  remoteOn: 'Your other devices can use this PC',
  checking: 'Checking for updates…',
  updating: 'Updating Facet AI',
  downloading: 'Downloading an update · {progress}',
  starting: 'Starting the download…',
  installing: 'Installing the update',
  reopening: 'Facet AI will open again in a moment.',
  openNow: 'Open Facet AI now',
  chooseFolder: 'Choose working folder',
  fileOfType: '{ext} file',
  allFiles: 'All files',
};

export type ShellText = typeof ENGLISH;
const FILE = 'shell-strings.json';

export class ShellTexts {
  private value: ShellText = { ...ENGLISH };

  constructor(private readonly dir: string) {
    try {
      this.merge(JSON.parse(readFileSync(path.join(dir, FILE), 'utf8')));
    } catch {
      // First run or unreadable: English until the interface sends its language.
    }
  }

  get(): ShellText {
    return this.value;
  }

  /** Accepts known keys with short strings only; returns true when something changed. */
  set(input: unknown): boolean {
    const before = JSON.stringify(this.value);
    this.merge(input);
    const changed = JSON.stringify(this.value) !== before;
    if (changed) {
      try {
        writeFileSync(path.join(this.dir, FILE), JSON.stringify(this.value));
      } catch {
        // Not critical: the texts come again on the next start.
      }
    }
    return changed;
  }

  private merge(input: unknown): void {
    if (!input || typeof input !== 'object') return;
    const next = { ...this.value };
    for (const key of Object.keys(ENGLISH) as (keyof ShellText)[]) {
      const v = (input as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.trim() && v.length <= 200) next[key] = v;
    }
    this.value = next;
  }
}
