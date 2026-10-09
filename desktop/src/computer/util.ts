/** Small helpers shared by the computer tools. No Electron imports: these are unit-tested in plain Node. */
import os from 'node:os';
import path from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';
/** File systems on Windows and macOS are case-insensitive by default. */
export const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/** An expected failure with a message meant for the model (file not found, bad arguments, ...). */
export class ToolError extends Error {}

/**
 * Resolves a path the model gave: absolute, `~`-relative, or relative to the chat's working folder.
 * On Windows, Git-Bash style paths like `/c/Users/me` are accepted too.
 */
export function resolvePath(p: string | undefined | null, cwd: string): string {
  let s = (p ?? '').trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1);
  }
  if (!s) return path.resolve(cwd);
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  if (IS_WINDOWS) {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
    if (m) s = `${m[1].toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}`;
  }
  return path.resolve(cwd, s);
}

/** True when [child] is [parent] or inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A path for output and labels: relative to the working folder (with `/`) when inside it, else absolute. */
export function displayPath(abs: string, cwd: string): string {
  if (cwd && isInside(abs, cwd)) {
    const rel = path.relative(cwd, abs);
    return rel === '' ? '.' : rel.split(path.sep).join('/');
  }
  return abs;
}

/** Shortens text to [max] characters (single line) with an ellipsis. */
export function shorten(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** Keeps the head and tail of long text, with a note about what was left out. */
export function truncateMiddle(text: string, max = 30000): string {
  if (text.length <= max) return text;
  const keep = max - 100;
  const head = Math.ceil(keep * 0.5);
  const tail = keep - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n… [${omitted.toLocaleString('en-US')} characters omitted] …\n\n${text.slice(text.length - tail)}`;
}

// CSI sequences (colors, cursor moves), OSC sequences (titles, hyperlinks) and other 2-char escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Terminal output → plain text: strips colors, applies carriage returns (progress bars), LF line endings. */
export function cleanOutput(text: string): string {
  let s = text.replace(ANSI, '').replace(/\r\n/g, '\n');
  if (s.includes('\r')) {
    s = s
      .split('\n')
      .map((line) => {
        const t = line.replace(/\r+$/, '');
        const i = t.lastIndexOf('\r');
        return i >= 0 ? t.slice(i + 1) : t;
      })
      .join('\n');
  }
  // Backspaces (some tools draw spinners with them).
  if (s.includes('\b')) {
    // eslint-disable-next-line no-control-regex
    const pair = /[^\n\x08]\x08/g;
    for (let i = 0; i < 64 && pair.test(s); i++) s = s.replace(pair, '');
    // eslint-disable-next-line no-control-regex
    s = s.replace(/\x08/g, '');
  }
  return s;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** Local time as `YYYY-MM-DD HH:MM`. */
export function formatTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const BINARY_EXTENSIONS = new Set(
  (
    'png jpg jpeg gif bmp ico icns webp avif tif tiff psd heic heif raw cr2 nef ' +
    'mp3 wav flac ogg oga opus m4a aac wma mid midi mp4 m4v mov avi mkv webm wmv flv mpg mpeg 3gp ' +
    'zip gz tgz bz2 xz 7z rar zst lz4 tar cab iso dmg img vhd vhdx jar war apk aab ipa msi msix appx deb rpm ' +
    'exe dll sys so dylib lib a o obj pdb class pyc pyo pyd wasm node bin dat db sqlite sqlite3 mdb accdb ' +
    'pdf doc docx xls xlsx ppt pptx odt ods odp rtf epub mobi ' +
    'ttf otf woff woff2 eot ' +
    'blend fbx glb gltf3 stl 3ds max dae unitypackage pak'
  ).split(/\s+/),
);

/** Known binary file types, by extension. */
export function isBinaryPath(p: string): boolean {
  const ext = path.extname(p).slice(1).toLowerCase();
  return ext !== '' && BINARY_EXTENSIONS.has(ext);
}

/** Content sniffing: NUL bytes in the first 8 KB mean binary (UTF-16 text with a BOM is not binary). */
export function looksBinary(buf: Uint8Array): boolean {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false;
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** A readable message for a file system error. */
export function fsErrorMessage(err: unknown, shown: string): string {
  const e = err as NodeJS.ErrnoException;
  switch (e?.code) {
    case 'ENOENT':
      return `${shown} doesn't exist.`;
    case 'EACCES':
    case 'EPERM':
      return `Permission denied: ${shown}.`;
    case 'EISDIR':
      return `${shown} is a folder, not a file.`;
    case 'ENOTDIR':
      return `A part of the path ${shown} is not a folder.`;
    case 'EBUSY':
      return `${shown} is in use by another program.`;
    case 'EEXIST':
      return `${shown} already exists.`;
    case 'ENAMETOOLONG':
      return `The path ${shown} is too long.`;
    case 'EROFS':
      return `${shown} is on a read-only drive.`;
    case 'ENOSPC':
      return 'The drive is full.';
    default:
      return `${shown}: ${e?.message ?? String(err)}`;
  }
}

/** Environment for commands the model runs: the app's environment minus Electron's own variables. */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase().startsWith('ELECTRON_')) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}
