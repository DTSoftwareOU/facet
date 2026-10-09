/** A small glob matcher (`**`, `*`, `?`, `{a,b}`, `[abc]`) and an async directory walker. */
import { promises as fsp, type Dirent } from 'node:fs';
import path from 'node:path';
import { CASE_INSENSITIVE_FS, IS_WINDOWS, ToolError } from './util';

const GLOB_CHARS = /[*?[{]/;

function escapeRegex(c: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(c) ? `\\${c}` : c;
}

/** Converts a glob (with `/` separators) to a regular expression source matching whole relative paths. */
export function globToRegexSource(glob: string): string {
  let re = '';
  let depth = 0;
  const n = glob.length;
  for (let i = 0; i < n; ) {
    const c = glob[i];
    if (c === '*') {
      let j = i;
      while (glob[j] === '*') j++;
      const starts = i === 0 || glob[i - 1] === '/';
      const ends = j === n || glob[j] === '/';
      if (j - i >= 2 && starts && ends) {
        if (j === n) {
          re += '.*'; // trailing `**`: everything below
          i = j;
        } else {
          re += '(?:[^/]*/)*'; // `**/`: zero or more folders
          i = j + 1;
        }
      } else {
        re += '[^/]*';
        i = j;
      }
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close !== -1) {
        let body = glob.slice(i + 1, close);
        let neg = false;
        if (body[0] === '!' || body[0] === '^') {
          neg = true;
          body = body.slice(1);
        }
        body = body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
        re += neg ? `[^/${body}]` : `[${body}]`;
        i = close + 1;
        continue;
      }
      re += '\\[';
      i++;
      continue;
    }
    if (c === '{') {
      depth++;
      re += '(?:';
      i++;
      continue;
    }
    if (c === '}' && depth > 0) {
      depth--;
      re += ')';
      i++;
      continue;
    }
    if (c === ',' && depth > 0) {
      re += '|';
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < n) {
      re += escapeRegex(glob[i + 1]);
      i += 2;
      continue;
    }
    re += escapeRegex(c);
    i++;
  }
  if (depth > 0) throw new ToolError(`The glob pattern ${glob} has an unclosed "{".`);
  return `^${re}$`;
}

/** Normalizes separators: on Windows `\` is a path separator, not an escape. */
export function normalizeGlob(pattern: string): string {
  let p = pattern.trim();
  if (IS_WINDOWS) p = p.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

export function globToRegex(glob: string, caseInsensitive = CASE_INSENSITIVE_FS): RegExp {
  return new RegExp(globToRegexSource(normalizeGlob(glob)), caseInsensitive ? 'i' : '');
}

/** Splits a pattern into its literal leading folders and the glob part: `src/**\/*.ts` → `src`, `**\/*.ts`. */
export function splitGlobBase(pattern: string): { base: string; rest: string } {
  const p = normalizeGlob(pattern);
  const segs = p.split('/');
  let i = 0;
  while (i < segs.length - 1 && !GLOB_CHARS.test(segs[i])) i++;
  if (!GLOB_CHARS.test(segs[segs.length - 1]) && i === segs.length - 1) {
    // No glob characters at all: a literal path.
    return { base: segs.slice(0, -1).join('/'), rest: segs[segs.length - 1] };
  }
  let base = segs.slice(0, i).join('/');
  if (base === '' && p.startsWith('/')) base = '/';
  return { base, rest: segs.slice(i).join('/') };
}

/** Folders the walkers skip unless the pattern names them. */
export const SKIP_DIRS = ['.git', 'node_modules', '.hg', '.svn'];

export function skippedDirs(...patterns: (string | undefined)[]): Set<string> {
  const text = patterns.filter(Boolean).join(' ');
  return new Set(SKIP_DIRS.filter((d) => !text.includes(d)));
}

export interface WalkEntry {
  abs: string;
  /** Relative to the walk's root, with `/`. */
  rel: string;
}

export interface WalkOptions {
  skip: Set<string>;
  /** Files deeper than this aren't visited (1 = the root's own files). */
  maxDepth?: number;
  maxEntries?: number;
  signal?: AbortSignal;
}

export interface WalkStats {
  visited: number;
  /** Stopped early because of [WalkOptions.maxEntries]. */
  capped: boolean;
}

/** Yields the files under [root], depth-first in name order. Doesn't follow symlinked folders. */
export async function* walkFiles(root: string, opts: WalkOptions, stats: WalkStats = { visited: 0, capped: false }): AsyncGenerator<WalkEntry> {
  const maxEntries = opts.maxEntries ?? 200_000;
  const maxDepth = opts.maxDepth ?? Infinity;
  const stack: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: '', depth: 1 }];
  while (stack.length > 0) {
    if (opts.signal?.aborted) throw new ToolError('Cancelled.');
    const { dir, rel, depth } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: { dir: string; rel: string; depth: number }[] = [];
    for (const e of entries) {
      if (++stats.visited > maxEntries) {
        stats.capped = true;
        return;
      }
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!opts.skip.has(e.name) && depth < maxDepth) subdirs.push({ dir: abs, rel: r, depth: depth + 1 });
      } else if (e.isFile()) {
        yield { abs, rel: r };
      } else if (e.isSymbolicLink()) {
        try {
          if ((await fsp.stat(abs)).isFile()) yield { abs, rel: r };
        } catch {
          /* broken link */
        }
      }
    }
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
}

export const GLOB_MAX_RESULTS = 1000;
const GLOB_MAX_CANDIDATES = 50_000;

export interface GlobMatch {
  abs: string;
  mtimeMs: number;
}

export interface GlobOutcome {
  matches: GlobMatch[];
  /** More matches than returned. */
  total: number;
  capped: boolean;
}

/** Files under [root] matching [pattern], newest first. */
export async function globFiles(pattern: string, root: string, signal?: AbortSignal): Promise<GlobOutcome> {
  let base = root;
  let rest = normalizeGlob(pattern);
  if (!rest) throw new ToolError('The glob pattern is empty.');
  const split = splitGlobBase(rest);
  if (split.base) {
    base = path.resolve(root, split.base);
    rest = split.rest;
  }
  if (!GLOB_CHARS.test(rest)) {
    // A literal path.
    const abs = path.resolve(base, rest);
    try {
      const st = await fsp.stat(abs);
      return st.isFile() ? { matches: [{ abs, mtimeMs: st.mtimeMs }], total: 1, capped: false } : { matches: [], total: 0, capped: false };
    } catch {
      return { matches: [], total: 0, capped: false };
    }
  }
  try {
    if (!(await fsp.stat(base)).isDirectory()) throw new ToolError(`${base} is not a folder.`);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`The folder ${base} doesn't exist.`);
  }
  const re = globToRegex(rest);
  const maxDepth = rest.includes('**') || /\{[^}]*\/[^}]*\}/.test(rest) ? undefined : rest.split('/').length;
  const stats: WalkStats = { visited: 0, capped: false };
  const found: string[] = [];
  let total = 0;
  for await (const f of walkFiles(base, { skip: skippedDirs(pattern), maxDepth, signal }, stats)) {
    if (re.test(f.rel)) {
      total++;
      if (found.length < GLOB_MAX_CANDIDATES) found.push(f.abs);
    }
  }
  const matches: GlobMatch[] = new Array(found.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, found.length) }, async () => {
      while (next < found.length) {
        const i = next++;
        let mtimeMs = 0;
        try {
          mtimeMs = (await fsp.stat(found[i])).mtimeMs;
        } catch {
          /* vanished */
        }
        matches[i] = { abs: found[i], mtimeMs };
      }
    }),
  );
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.abs < b.abs ? -1 : 1));
  return { matches: matches.slice(0, GLOB_MAX_RESULTS), total, capped: stats.capped };
}
