/** read_file, write_file, edit_file and list_directory. All file access is async. */
import { createReadStream, promises as fsp, type Dirent, type Stats } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { formatBytes, formatTime, isBinaryPath, looksBinary, ToolError } from './util';

export const READ_DEFAULT_LIMIT = 2000;
export const MAX_LINE_CHARS = 2000;
/** Total characters read_file returns in one call. */
export const READ_MAX_CHARS = 100_000;
/** Files up to this size are read in one go; bigger ones are streamed line by line. */
const WHOLE_FILE_LIMIT = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Text encodings (UTF-8, UTF-8 with BOM, and the UTF-16 files Windows PowerShell 5.1 writes by default)

export type TextEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be';

export function decodeText(buf: Buffer): { text: string; encoding: TextEncoding } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2));
    body.swap16();
    return { text: body.toString('utf16le'), encoding: 'utf16be' };
  }
  return { text: buf.toString('utf8'), encoding: 'utf8' };
}

export function encodeText(text: string, encoding: TextEncoding): Buffer {
  switch (encoding) {
    case 'utf8bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'utf16be': {
      const body = Buffer.from(text, 'utf16le');
      body.swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    }
    default:
      return Buffer.from(text, 'utf8');
  }
}

// ---------------------------------------------------------------------------------------------
// read_file

/** `cat -n` style: right-aligned line number, a tab, then the line (long lines cut). */
export function numberLine(n: number, line: string): string {
  const shown =
    line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated: ${line.length.toLocaleString('en-US')} characters]` : line;
  return `${String(n).padStart(6)}\t${shown}`;
}

/** Splits text into lines; a trailing newline doesn't start another line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface ReadWindow {
  /** The requested lines (offset-based). */
  lines: string[];
  totalLines: number;
}

/**
 * Formats the lines of a read: numbered lines starting at [offset], then a note when the file
 * has more than what's shown.
 */
export function formatRead(win: ReadWindow, offset: number, size: number, maxChars = READ_MAX_CHARS): string {
  const { lines, totalLines } = win;
  if (totalLines === 0) return '(empty file)';
  if (offset > totalLines) {
    throw new ToolError(`The file has only ${totalLines.toLocaleString('en-US')} lines; offset ${offset} is past the end.`);
  }
  const out: string[] = [];
  let chars = 0;
  let shown = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = numberLine(offset + i, lines[i]);
    if (chars + s.length + 1 > maxChars && shown > 0) break;
    out.push(s);
    chars += s.length + 1;
    shown++;
  }
  const last = offset + shown - 1;
  if (offset > 1 || last < totalLines) {
    const more = last < totalLines ? ` Use offset ${last + 1} to read on.` : '';
    out.push('');
    out.push(
      `[Showing lines ${offset}-${last} of ${totalLines.toLocaleString('en-US')} (file size ${formatBytes(size)}).${more}]`,
    );
  }
  return out.join('\n');
}

async function readHead(file: string, n: number): Promise<Buffer> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Streams a big file, keeping only the requested window of lines and counting the rest. */
async function streamWindow(file: string, offset: number, limit: number, signal?: AbortSignal): Promise<ReadWindow> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let n = 0;
  try {
    for await (const line of rl) {
      if (signal?.aborted) throw new ToolError('Cancelled.');
      n++;
      if (n >= offset && lines.length < limit) lines.push(n === 1 ? line.replace(/^﻿/, '') : line);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { lines, totalLines: n };
}

export interface ReadResult {
  content: string;
  /** Binary or otherwise unreadable as text (not an error, but nothing to show). */
  refused?: boolean;
}

export async function readTextFile(
  file: string,
  shown: string,
  offsetArg?: number,
  limitArg?: number,
  signal?: AbortSignal,
): Promise<ReadResult> {
  const st = await fsp.stat(file);
  if (st.isDirectory()) throw new ToolError(`${shown} is a folder. Use list_directory to see what's in it.`);
  const offset = Math.max(1, Math.floor(offsetArg ?? 1));
  const limit = Math.max(1, Math.floor(limitArg ?? READ_DEFAULT_LIMIT));
  if (isBinaryPath(file)) {
    return { content: `${shown} is a binary file (${formatBytes(st.size)}), so it can't be shown as text.`, refused: true };
  }
  const head = await readHead(file, 8192);
  if (looksBinary(head)) {
    return { content: `${shown} looks like a binary file (${formatBytes(st.size)}), so it can't be shown as text.`, refused: true };
  }
  const utf16 = head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff));
  let win: ReadWindow;
  if (st.size <= WHOLE_FILE_LIMIT || utf16) {
    if (st.size > 200 * 1024 * 1024) throw new ToolError(`${shown} is too big to read (${formatBytes(st.size)}).`);
    const { text } = decodeText(await fsp.readFile(file));
    const all = splitLines(text);
    win = { lines: all.slice(offset - 1, offset - 1 + limit), totalLines: all.length };
  } else {
    win = await streamWindow(file, offset, limit, signal);
  }
  return { content: formatRead(win, offset, st.size) };
}

// ---------------------------------------------------------------------------------------------
// write_file

export async function writeTextFile(file: string, content: string): Promise<{ bytes: number; created: boolean }> {
  let created = true;
  try {
    const st = await fsp.stat(file);
    if (st.isDirectory()) throw new ToolError('That path is a folder.');
    created = false;
  } catch (e) {
    if (e instanceof ToolError) throw e;
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const buf = Buffer.from(content, 'utf8');
  await fsp.writeFile(file, buf);
  return { bytes: buf.length, created };
}

// ---------------------------------------------------------------------------------------------
// edit_file

export interface EditOutcome {
  text: string;
  replacements: number;
  /** Unified-diff-like snippet of the change. */
  diff: string;
}

/** The file's line ending: CRLF when most of its line breaks are CRLF. */
export function detectEol(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return '\n';
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf >= lf ? '\r\n' : '\n';
}

function withEol(s: string, eol: '\r\n' | '\n'): string {
  const lf = s.replace(/\r\n/g, '\n');
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

function countOccurrences(hay: string, needle: string): number[] {
  const at: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    at.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return at;
}

/**
 * Replaces [oldString] with [newString] in [text]. The strings are converted to the file's line
 * endings first, so an edit written with `\n` applies to a CRLF file (and keeps it CRLF).
 */
export function applyEdit(text: string, oldString: string, newString: string, replaceAll = false, shown = 'the file'): EditOutcome {
  if (oldString === '') throw new ToolError('old_string is empty. To create a file or replace all of it, use write_file.');
  if (oldString === newString) throw new ToolError('old_string and new_string are the same, so there is nothing to change.');
  let oldS = oldString;
  let newS = newString;
  let at = countOccurrences(text, oldS);
  if (at.length === 0) {
    // Try the file's line endings.
    const eol = detectEol(text);
    const o2 = withEol(oldString, eol);
    const a2 = o2 !== oldString ? countOccurrences(text, o2) : [];
    if (a2.length > 0) {
      oldS = o2;
      newS = withEol(newString, eol);
      at = a2;
    }
  } else if (detectEol(text) === '\r\n' && !newS.includes('\r\n') && newS.includes('\n')) {
    // old_string matched as is (e.g. a single line) but new_string brings bare LFs into a CRLF file.
    newS = withEol(newS, '\r\n');
  }
  if (at.length === 0) {
    let hint = ' Make sure it matches the file exactly, including whitespace and indentation (and without read_file line numbers), and read the file again if it may have changed.';
    const trimmed = oldString.trim();
    if (trimmed && trimmed !== oldString && text.includes(withEol(trimmed, detectEol(text)))) {
      hint = ' It matches when leading/trailing whitespace is removed: check the whitespace at its start and end.';
    } else if (text.toLowerCase().includes(withEol(oldString, detectEol(text)).toLowerCase())) {
      hint = ' A match differing only in upper/lower case exists: check the capitalization.';
    }
    throw new ToolError(`old_string was not found in ${shown}.${hint}`);
  }
  if (at.length > 1 && !replaceAll) {
    throw new ToolError(
      `old_string appears ${at.length} times in ${shown}. Include more surrounding lines to make it unique, or set replace_all to true to change every occurrence.`,
    );
  }
  const used = replaceAll ? at : [at[0]];
  let out = '';
  let last = 0;
  for (const i of used) {
    out += text.slice(last, i) + newS;
    last = i + oldS.length;
  }
  out += text.slice(last);
  return { text: out, replacements: used.length, diff: diffSnippet(text, out, used, oldS.length, newS.length) };
}

function lineIndexAt(text: string, pos: number): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

const CONTEXT_LINES = 3;
const MAX_HUNKS = 3;
const MAX_HUNK_LINES = 40;

/** A few unified-diff hunks around the replaced ranges. */
export function diffSnippet(before: string, after: string, positions: number[], oldLen: number, newLen: number): string {
  const bLines = before.split('\n').map((l) => l.replace(/\r$/, ''));
  const aLines = after.split('\n').map((l) => l.replace(/\r$/, ''));
  // A trailing newline leaves an empty pseudo-line at the end: never show it as context.
  const aReal = aLines.length - (aLines[aLines.length - 1] === '' ? 1 : 0);
  const hunks: string[] = [];
  let shift = 0;
  for (let k = 0; k < positions.length && k < MAX_HUNKS; k++) {
    const pos = positions[k];
    const newPos = pos + shift;
    shift += newLen - oldLen;
    // Whole lines touched by the replacement, in the file before and after.
    let bs = lineIndexAt(before, pos);
    let be = lineIndexAt(before, pos + oldLen);
    let as = lineIndexAt(after, newPos);
    let ae = lineIndexAt(after, newPos + newLen);
    // Drop lines that ended up unchanged at either end of the block.
    while (be >= bs && ae >= as && bLines[be] === aLines[ae]) {
      be--;
      ae--;
    }
    while (bs <= be && as <= ae && bLines[bs] === aLines[as]) {
      bs++;
      as++;
    }
    const before0 = Math.max(0, as - CONTEXT_LINES);
    const ctxBefore = as - before0;
    const ctxAfter = Math.max(0, Math.min(aReal - 1, ae + CONTEXT_LINES) - ae);
    const removed = bLines.slice(bs, be + 1);
    const added = aLines.slice(as, ae + 1);
    const lines: string[] = [];
    for (let i = before0; i < as; i++) lines.push(` ${aLines[i]}`);
    for (const l of removed.slice(0, MAX_HUNK_LINES)) lines.push(`-${l}`);
    if (removed.length > MAX_HUNK_LINES) lines.push(`-… (${removed.length - MAX_HUNK_LINES} more lines)`);
    for (const l of added.slice(0, MAX_HUNK_LINES)) lines.push(`+${l}`);
    if (added.length > MAX_HUNK_LINES) lines.push(`+… (${added.length - MAX_HUNK_LINES} more lines)`);
    for (let i = 1; i <= ctxAfter; i++) lines.push(` ${aLines[ae + i]}`);
    const bCount = ctxBefore + removed.length + ctxAfter;
    const aCount = ctxBefore + added.length + ctxAfter;
    hunks.push(`@@ -${bs - ctxBefore + 1},${bCount} +${as - ctxBefore + 1},${aCount} @@\n${lines.join('\n')}`);
  }
  if (positions.length > MAX_HUNKS) hunks.push(`… and ${positions.length - MAX_HUNKS} more replacements`);
  return hunks.join('\n');
}

export async function editTextFile(
  file: string,
  shown: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<EditOutcome> {
  const st = await fsp.stat(file);
  if (st.isDirectory()) throw new ToolError(`${shown} is a folder, not a file.`);
  if (st.size > 50 * 1024 * 1024) throw new ToolError(`${shown} is too big to edit (${formatBytes(st.size)}).`);
  const buf = await fsp.readFile(file);
  if (looksBinary(buf)) throw new ToolError(`${shown} looks like a binary file; edit_file only changes text files.`);
  const { text, encoding } = decodeText(buf);
  const outcome = applyEdit(text, oldString, newString, replaceAll, shown);
  await fsp.writeFile(file, encodeText(outcome.text, encoding));
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// list_directory

export const LIST_MAX_ENTRIES = 500;

export async function listDirectory(dir: string, shown: string): Promise<string> {
  const st = await fsp.stat(dir);
  if (!st.isDirectory()) throw new ToolError(`${shown} is a file, not a folder. Use read_file to read it.`);
  const entries: Dirent[] = await fsp.readdir(dir, { withFileTypes: true });
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  const isDir = (e: Dirent) => e.isDirectory();
  entries.sort((a, b) => (isDir(a) === isDir(b) ? collator.compare(a.name, b.name) : isDir(a) ? -1 : 1));
  const shownEntries = entries.slice(0, LIST_MAX_ENTRIES);
  const stats: (Stats | null)[] = new Array(shownEntries.length).fill(null);
  // Bounded parallel stat.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, shownEntries.length) }, async () => {
      while (next < shownEntries.length) {
        const i = next++;
        try {
          stats[i] = await fsp.stat(path.join(dir, shownEntries[i].name));
        } catch {
          stats[i] = null;
        }
      }
    }),
  );
  const dirs = entries.filter(isDir).length;
  const files = entries.length - dirs;
  const lines = [`${dir} (${dirs} folder${dirs === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'})`];
  if (entries.length === 0) lines.push('(empty folder)');
  for (let i = 0; i < shownEntries.length; i++) {
    const e = shownEntries[i];
    const s = stats[i];
    const dirLike = e.isDirectory() || (e.isSymbolicLink() && s?.isDirectory());
    const type = e.isSymbolicLink() ? 'link' : dirLike ? 'dir ' : 'file';
    const time = s ? formatTime(s.mtime) : '?'.padEnd(16);
    const size = dirLike ? '' : s ? formatBytes(s.size) : '?';
    lines.push(`${type}  ${time}  ${size.padStart(8)}  ${e.name}${dirLike ? '/' : ''}`);
  }
  if (entries.length > shownEntries.length) {
    lines.push(`… and ${(entries.length - shownEntries.length).toLocaleString('en-US')} more entries (not shown). Use glob to find specific files.`);
  }
  return lines.join('\n');
}
