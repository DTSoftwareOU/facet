/**
 * grep: regular-expression search through files. Pure Node (async fs); the app runs it in a
 * worker thread (grep-worker.ts) so a slow pattern can't freeze the main process.
 */
import { promises as fsp } from 'node:fs';
import { globToRegex, normalizeGlob, skippedDirs, walkFiles, type WalkStats } from './glob';
import { decodeText } from './files';
import { displayPath, isBinaryPath, looksBinary, ToolError } from './util';

export type GrepMode = 'files_with_matches' | 'content' | 'count';

export interface GrepOptions {
  pattern: string;
  /** Folder or file to search (absolute). */
  root: string;
  /** The chat's working folder, for display paths. */
  cwd: string;
  glob?: string;
  ignoreCase?: boolean;
  mode?: GrepMode;
  context?: number;
  headLimit?: number;
}

export interface GrepOutput {
  content: string;
  isError: boolean;
  /** Files with at least one match. */
  matchedFiles: number;
}

export const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 30000;
const MAX_LINE_CHARS = 400;
const DEFAULT_LIMITS: Record<GrepMode, number> = { files_with_matches: 300, count: 300, content: 300 };

export function compilePattern(pattern: string, ignoreCase?: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (e) {
    throw new ToolError(`Invalid regular expression ${JSON.stringify(pattern)}: ${(e as Error).message.replace(/^Invalid regular expression: /, '')}`);
  }
}

/** A file filter from a glob: without `/` it matches file names (like ripgrep's --glob), else relative paths. */
export function fileFilter(glob: string | undefined): ((rel: string) => boolean) | null {
  if (!glob || !glob.trim()) return null;
  const g = normalizeGlob(glob);
  const re = globToRegex(g);
  if (!g.includes('/')) return (rel) => re.test(rel.slice(rel.lastIndexOf('/') + 1));
  return (rel) => re.test(rel);
}

function cutLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/** Matching line numbers (0-based) of [text]. */
export function matchLines(text: string, re: RegExp): { lines: string[]; hits: number[] } {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i);
  return { lines, hits };
}

/** ripgrep-style output for one file: `path:N:text` for matches, `path-N-text` for context, `--` between groups. */
export function formatContent(shown: string, lines: string[], hits: number[], context: number): string[] {
  const out: string[] = [];
  let prevEnd = -1;
  const hitSet = new Set(hits);
  for (const h of hits) {
    const start = Math.max(0, h - context, prevEnd + 1);
    const end = Math.min(lines.length - 1, h + context);
    if (prevEnd >= 0 && start > prevEnd + 1 && context > 0) out.push('--');
    for (let i = start; i <= end; i++) {
      out.push(hitSet.has(i) ? `${shown}:${i + 1}:${cutLine(lines[i])}` : `${shown}-${i + 1}-${cutLine(lines[i])}`);
    }
    prevEnd = Math.max(prevEnd, end);
  }
  return out;
}

interface FileHit {
  shown: string;
  mtimeMs: number;
  count: number;
  lines?: string[];
  hits?: number[];
}

export async function grepSearch(opts: GrepOptions, signal?: AbortSignal): Promise<GrepOutput> {
  const mode: GrepMode = opts.mode ?? 'files_with_matches';
  const re = compilePattern(opts.pattern, opts.ignoreCase);
  const limit = Math.max(1, Math.floor(opts.headLimit ?? DEFAULT_LIMITS[mode]));
  const context = Math.max(0, Math.min(20, Math.floor(opts.context ?? 0)));
  const filter = fileFilter(opts.glob);

  let rootStat;
  try {
    rootStat = await fsp.stat(opts.root);
  } catch {
    throw new ToolError(`${displayPath(opts.root, opts.cwd)} doesn't exist.`);
  }

  const results: FileHit[] = [];
  let matchedLines = 0;
  let skippedLarge = 0;
  let scanned = 0;
  let stoppedEarly = false;
  const stats: WalkStats = { visited: 0, capped: false };

  const scan = async (abs: string, explicit: boolean): Promise<void> => {
    if (!explicit && isBinaryPath(abs)) return;
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      return;
    }
    if (st.size > GREP_MAX_FILE_BYTES) {
      skippedLarge++;
      return;
    }
    let buf: Buffer;
    try {
      buf = await fsp.readFile(abs);
    } catch {
      return;
    }
    if (looksBinary(buf)) return;
    scanned++;
    const { text } = decodeText(buf);
    if (mode === 'files_with_matches') {
      // Fast path: one test over the lines until the first match.
      const { hits } = matchLinesFirst(text, re);
      if (hits) results.push({ shown: displayPath(abs, opts.cwd), mtimeMs: st.mtimeMs, count: 1 });
      return;
    }
    const { lines, hits } = matchLines(text, re);
    if (hits.length === 0) return;
    matchedLines += hits.length;
    results.push({
      shown: displayPath(abs, opts.cwd),
      mtimeMs: st.mtimeMs,
      count: hits.length,
      ...(mode === 'content' ? { lines, hits } : {}),
    });
  };

  if (rootStat.isFile()) {
    await scan(opts.root, true);
  } else {
    const skip = skippedDirs(opts.glob, opts.root);
    for await (const f of walkFiles(opts.root, { skip, signal }, stats)) {
      if (signal?.aborted) throw new ToolError('Cancelled.');
      if (filter && !filter(f.rel)) continue;
      await scan(f.abs, false);
      // Content mode: enough lines collected.
      if (mode === 'content' && matchedLines >= limit * 4 && results.length >= limit) {
        stoppedEarly = true;
        break;
      }
      if (mode !== 'content' && results.length >= 20_000) {
        stoppedEarly = true;
        break;
      }
    }
  }

  const notes: string[] = [];
  if (stats.capped) notes.push(`Stopped after looking at ${stats.visited.toLocaleString('en-US')} entries; search a narrower path for complete results.`);
  if (skippedLarge > 0) notes.push(`Skipped ${skippedLarge} file${skippedLarge === 1 ? '' : 's'} over 2 MB.`);

  const where = displayPath(opts.root, opts.cwd);
  if (results.length === 0) {
    const base = `No matches for ${JSON.stringify(opts.pattern)} in ${where}${opts.glob ? ` (files matching ${opts.glob})` : ''}. Searched ${scanned.toLocaleString('en-US')} file${scanned === 1 ? '' : 's'}.`;
    return { content: [base, ...notes].join('\n'), isError: false, matchedFiles: 0 };
  }

  let body: string[];
  let header: string;
  if (mode === 'files_with_matches') {
    results.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.shown < b.shown ? -1 : 1));
    body = results.slice(0, limit).map((r) => r.shown);
    header = `Found ${results.length.toLocaleString('en-US')}${stoppedEarly ? '+' : ''} file${results.length === 1 ? '' : 's'}`;
    if (results.length > limit) notes.push(`Showing the ${limit} most recently modified; use head_limit, path or glob to see others.`);
  } else if (mode === 'count') {
    results.sort((a, b) => (a.shown < b.shown ? -1 : 1));
    body = results.slice(0, limit).map((r) => `${r.shown}:${r.count}`);
    const total = results.reduce((n, r) => n + r.count, 0);
    header = `${total.toLocaleString('en-US')} matching line${total === 1 ? '' : 's'} in ${results.length.toLocaleString('en-US')} file${results.length === 1 ? '' : 's'}`;
    if (results.length > limit) notes.push(`Showing ${limit} of ${results.length} files.`);
  } else {
    results.sort((a, b) => (a.shown < b.shown ? -1 : 1));
    body = [];
    let shownMatches = 0;
    const total = results.reduce((n, r) => n + r.count, 0);
    for (const r of results) {
      if (shownMatches >= limit) break;
      const hits = r.hits!.slice(0, limit - shownMatches);
      if (body.length > 0 && context > 0) body.push('--');
      body.push(...formatContent(r.shown, r.lines!, hits, context));
      shownMatches += hits.length;
    }
    header = `${total.toLocaleString('en-US')}${stoppedEarly ? '+' : ''} matching line${total === 1 ? '' : 's'} in ${results.length.toLocaleString('en-US')} file${results.length === 1 ? '' : 's'}`;
    if (total > shownMatches) notes.push(`Showing the first ${shownMatches} matches; use head_limit, path or glob to see more.`);
  }

  let text = `${header}:\n${body.join('\n')}`;
  if (text.length > MAX_OUTPUT_CHARS) {
    const cut = text.lastIndexOf('\n', MAX_OUTPUT_CHARS);
    text = `${text.slice(0, cut > 0 ? cut : MAX_OUTPUT_CHARS)}\n… [output cut at ${MAX_OUTPUT_CHARS.toLocaleString('en-US')} characters]`;
  }
  if (notes.length) text += `\n\n${notes.join('\n')}`;
  return { content: text, isError: false, matchedFiles: results.length };
}

function matchLinesFirst(text: string, re: RegExp): { hits: boolean } {
  let start = 0;
  const n = text.length;
  while (start <= n) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = n;
    let line = text.slice(start, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (re.test(line)) return { hits: true };
    if (end === n) break;
    start = end + 1;
  }
  return { hits: false };
}
