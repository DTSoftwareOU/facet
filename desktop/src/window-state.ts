/** Remembers the window's size, position and maximized state between launches. */
import { screen, type BrowserWindow, type Rectangle } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULT: WindowState = { width: 1200, height: 820, maximized: false };
export const MIN_WIDTH = 720;
export const MIN_HEIGHT = 520;

function visible(b: Rectangle): boolean {
  // At least a 100×60 corner of the title bar area is on some display.
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const ix = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const iy = Math.min(b.y + 60, a.y + a.height) - Math.max(b.y, a.y);
    return ix >= 100 && iy >= 30;
  });
}

export function loadWindowState(dir: string): WindowState {
  try {
    const s = JSON.parse(readFileSync(path.join(dir, 'window-state.json'), 'utf8')) as Partial<WindowState>;
    const width = Math.max(MIN_WIDTH, Number(s.width) || DEFAULT.width);
    const height = Math.max(MIN_HEIGHT, Number(s.height) || DEFAULT.height);
    const state: WindowState = { width, height, maximized: !!s.maximized };
    if (Number.isFinite(s.x) && Number.isFinite(s.y) && visible({ x: s.x!, y: s.y!, width, height })) {
      state.x = s.x;
      state.y = s.y;
    }
    return state;
  } catch {
    return { ...DEFAULT };
  }
}

/** Saves the state whenever the window moves or resizes (debounced) and when it closes. */
export function trackWindowState(win: BrowserWindow, dir: string): void {
  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    const state: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'window-state.json'), JSON.stringify(state));
    } catch {
      /* not important */
    }
  };
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  win.on('resize', later);
  win.on('move', later);
  win.on('maximize', later);
  win.on('unmaximize', later);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}
