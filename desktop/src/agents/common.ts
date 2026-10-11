/**
 * Shared pieces for importing Claude Code and Codex sessions: public types, path comparison,
 * a streaming JSONL reader, and the message builder (merging, tool lines, truncation, titles).
 * Pure Node: no Electron imports.
 */
import { createReadStream, promises as fsp } from 'node:fs';

export type AgentKind = 'claude' | 'codex';
export interface AgentSessionSummary { id: string; title: string; updatedAt: number; messageCount: number }
export interface ImportedMessage { role: 'user' | 'assistant'; text: string; at?: number }
export interface ImportedSession { id: string; title: string; cwd: string; updatedAt: number; messages: ImportedMessage[]; truncated: boolean }
export interface AgentOptions { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }

/** Resolved [AgentOptions]. */
export interface Ctx { home: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform }

/** Parsed JSON from transcript files: untrusted and shape-checked at every use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const MAX_SESSIONS = 50;
export const MAX_CHARS = 300_000;
const TITLE_MAX = 80;
const COMMAND_MAX = 120;
const TOOL_LINE_MAX = 200;

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** Session ids are file names (Claude Code) or uuids (Codex): letters, digits, `-` and `_` only. */
export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

/** A non-empty string, or undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** ISO strings, or epoch seconds / milliseconds, to milliseconds. */
export function parseTime(v: unknown): number | undefined {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? Math.round(v * 1000) : v;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Paths

/**
 * A path with `/` separators, `.`/`..` resolved and no trailing slash (except at a root). On
 * win32, backslashes, `\\?\` prefixes and Git-Bash `/c/...` forms are accepted. `file://` URIs too.
 */
export function slashPath(p: string, platform: NodeJS.Platform): string {
  let s = p.trim();
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\/(localhost)?/i, '');
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep it encoded
    }
    if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
  }
  const win = platform === 'win32';
  if (win) {
    s = s.replace(/\\/g, '/');
    if (s.startsWith('//?/') || s.startsWith('//./')) s = s.slice(4);
    if (/^\/[a-zA-Z](\/|$)/.test(s)) s = `${s[1]}:${s.slice(2) || '/'}`;
  }
  const unc = win && s.startsWith('//');
  const abs = s.startsWith('/');
  const drive = win ? /^([a-zA-Z]:)(\/|$)/.exec(s) : null;
  const body = drive ? s.slice(2) : s;
  const out: string[] = [];
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs && !drive) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  if (drive) return `${drive[1].toUpperCase()}/${joined}`;
  if (unc) return `//${joined}`;
  if (abs) return `/${joined}`;
  return joined;
}

/** The form used to compare paths: [slashPath], lower-cased on win32. */
export function pathKey(p: string, platform: NodeJS.Platform): string {
  const s = slashPath(p, platform);
  return platform === 'win32' ? s.toLowerCase() : s;
}

export function samePath(a: string | null | undefined, b: string | null | undefined, platform: NodeJS.Platform): boolean {
  if (!a || !b) return false;
  return pathKey(a, platform) === pathKey(b, platform);
}

function isAbsoluteSlash(s: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? /^[A-Za-z]:\//.test(s) || s.startsWith('//') : s.startsWith('/');
}

/** A path for a tool line: relative to [cwd] (with `/`) when inside it, else absolute. */
export function displayPath(p: unknown, cwd: string | null | undefined, platform: NodeJS.Platform): string {
  if (typeof p !== 'string' || !p.trim()) return '';
  const a = slashPath(p, platform);
  if (!a) return p.trim();
  if (!isAbsoluteSlash(a, platform)) return a;
  if (cwd) {
    const b = slashPath(cwd, platform);
    const ka = platform === 'win32' ? a.toLowerCase() : a;
    const kb = platform === 'win32' ? b.toLowerCase() : b;
    if (ka === kb) return '.';
    const prefix = kb.endsWith('/') ? kb : `${kb}/`;
    if (ka.startsWith(prefix)) return a.slice(prefix.length);
  }
  return platform === 'win32' && !a.startsWith('//') ? a.replace(/\//g, '\\') : a;
}

// ---------------------------------------------------------------------------------------------
// Files

export interface FileInfo { file: string; mtimeMs: number; size: number }

/** Regular files only (symlinks are skipped); null when missing. */
export async function statFile(file: string): Promise<FileInfo | null> {
  try {
    const st = await fsp.lstat(file);
    return st.isFile() ? { file, mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

export async function readDirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Stats many files with bounded concurrency, dropping the ones that vanished. */
export async function statAll(files: string[]): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  for (let i = 0; i < files.length; i += 64) {
    const batch = await Promise.all(files.slice(i, i + 64).map(statFile));
    for (const f of batch) if (f) out.push(f);
  }
  return out;
}

const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Streams a file's lines as Buffers (without the `\n`). [onLine] returns false to stop early.
 * Lines over 64 MiB are skipped; a missing or unreadable file reads as empty.
 */
export async function forEachLine(file: string, onLine: (line: Buffer) => boolean | void, highWaterMark = 1024 * 1024): Promise<void> {
  const stream = createReadStream(file, { highWaterMark });
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let skipping = false;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      while (start < chunk.length) {
        const nl = chunk.indexOf(10, start);
        if (nl === -1) {
          if (!skipping) {
            pending.push(chunk.subarray(start));
            pendingLen += chunk.length - start;
            if (pendingLen > MAX_LINE_BYTES) {
              skipping = true;
              pending = [];
              pendingLen = 0;
            }
          }
          break;
        }
        if (skipping) {
          skipping = false;
          start = nl + 1;
          continue;
        }
        let line: Buffer;
        if (pending.length) {
          pending.push(chunk.subarray(start, nl));
          line = Buffer.concat(pending);
          pending = [];
          pendingLen = 0;
        } else {
          line = chunk.subarray(start, nl);
        }
        start = nl + 1;
        if (onLine(line) === false) return;
      }
    }
    if (!skipping && pending.length) onLine(Buffer.concat(pending));
  } catch {
    // Missing or unreadable: whatever was read so far stands.
  } finally {
    stream.destroy();
  }
}

/** One JSON object per line; anything else (blank, truncated, not an object) is undefined. */
export function parseLine(line: Buffer | string): Json | undefined {
  const s = typeof line === 'string' ? line : line.toString('utf8');
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '﻿')) i++;
  if (s[i] !== '{') return undefined;
  try {
    const o = JSON.parse(i ? s.slice(i) : s);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Text helpers

/** Cuts [s] to at most [n] UTF-16 units without splitting a surrogate pair. */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  let end = n;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

/** Single line, collapsed whitespace, at most [max] characters with an ellipsis. */
export function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${cut(s, max - 1).trimEnd()}…`;
}

/** Inline code, safe for text containing backticks. */
export function code(s: string): string {
  return s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``;
}

/** A session title: the first non-empty line, at most 80 characters. */
export function makeTitle(text: string | undefined): string {
  if (!text) return '';
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  return oneLine(line, TITLE_MAX);
}

/** "› Ran `cmd`" with the command on one line, cut to ~120 characters. */
export function ranLine(command: string): string {
  const one = oneLine(command, COMMAND_MAX);
  return one ? `› Ran ${code(one)}` : '› Ran a command';
}

/** Caps a tool line's length. */
export function toolLine(text: string): string {
  return oneLine(text, TOOL_LINE_MAX);
}

/** "a, b, c and 2 more" */
export function listItems(items: string[], max = 4): string {
  const uniq = [...new Set(items.filter(Boolean))];
  if (uniq.length <= max) return uniq.join(', ');
  return `${uniq.slice(0, max).join(', ')} and ${uniq.length - max} more`;
}

/** The text a shell was asked to run, from a command string or an argv array. */
export function commandText(cmd: unknown): string {
  if (typeof cmd === 'string') return cmd;
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every((a) => typeof a === 'string')) return '';
  const argv = cmd as string[];
  const exe = (argv[0].split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'].includes(exe)) {
    const i = argv.findIndex((a, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(a));
    if (i > 0 && i + 1 < argv.length) return argv[i + 1];
  }
  if (exe === 'powershell' || exe === 'pwsh') {
    const i = argv.findIndex((a, k) => k > 0 && /^-(c|command)$/i.test(a));
    if (i > 0 && i + 1 < argv.length) return argv.slice(i + 1).join(' ');
  }
  if (exe === 'cmd') {
    const i = argv.findIndex((a, k) => k > 0 && /^\/[ck]$/i.test(a));
    if (i > 0 && i + 1 < argv.length) return argv.slice(i + 1).join(' ');
  }
  return argv.map((a) => (/[\s"]/.test(a) || a === '' ? JSON.stringify(a) : a)).join(' ');
}

/** "› Edited a.ts, b.ts; created c.ts; deleted d.ts" from an apply_patch body. */
export function patchLine(patch: string, cwd: string | null | undefined, platform: NodeJS.Platform): string {
  const groups: Record<'Edited' | 'Created' | 'Deleted', string[]> = { Edited: [], Created: [], Deleted: [] };
  for (const m of patch.matchAll(/^\*\*\* (Update|Add|Delete) File: *(.+?) *$/gm)) {
    const verb = m[1] === 'Update' ? 'Edited' : m[1] === 'Add' ? 'Created' : 'Deleted';
    groups[verb].push(displayPath(m[2], cwd, platform));
  }
  return changesLine(groups);
}

export function changesLine(groups: Record<'Edited' | 'Created' | 'Deleted', string[]>): string {
  const parts: string[] = [];
  for (const verb of ['Edited', 'Created', 'Deleted'] as const) {
    if (!groups[verb].length) continue;
    parts.push(`${parts.length ? verb.toLowerCase() : verb} ${listItems(groups[verb])}`);
  }
  return toolLine(parts.length ? `› ${parts.join('; ')}` : '› Edited files');
}

/** Tags the CLIs wrap around context they inject into user turns. User content like `<pasted_content>` is kept. */
const INJECTED_TAGS = new Set([
  // Claude Code
  'system-reminder',
  'task-notification',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'user-prompt-submit-hook',
  'ide_selection',
  'ide_opened_file',
  'ide_diagnostics',
  'new-diagnostics',
  'fork-boilerplate',
  // Codex
  'environment_context',
  'user_instructions',
  'user_shell_command',
  'turn_aborted',
  'permissions instructions',
  'collaboration_mode',
  'skills_instructions',
  'apps_instructions',
  'plugins_instructions',
  'personality_spec',
  'model_switch',
  'subagent_notification',
  'send_user_message_question_reply',
  'user_action',
]);
const INJECTED_SUFFIX_RE = /[-_ ](context|instructions|reminder|notification|caveat|hook|aborted|reply|stdout|stderr|boilerplate|diagnostics|guidance)$/;

function isInjectedTag(name: string): boolean {
  const n = name.toLowerCase();
  return INJECTED_TAGS.has(n) || INJECTED_SUFFIX_RE.test(n);
}

const LEADING_BLOCK = /^\s*<([a-zA-Z][\w-]*(?: [\w-]+)*)(\s[^>]*)?>[\s\S]*?<\/\1>\s*/;
const TRAILING_BLOCK = /\s*<([a-zA-Z][\w-]*(?: [\w-]+)*)(\s[^>]*)?>[\s\S]*?<\/\1>\s*$/;

/** Removes injected context blocks (`<system-reminder>`, `<environment_context>`, …) at the start and end of a text. */
export function stripInjected(text: string): string {
  let s = text;
  for (let i = 0; i < 20; i++) {
    const m = LEADING_BLOCK.exec(s);
    if (!m || !isInjectedTag(m[1])) break;
    s = s.slice(m[0].length);
  }
  for (let i = 0; i < 20; i++) {
    const m = TRAILING_BLOCK.exec(s);
    if (!m || !isInjectedTag(m[1])) break;
    s = s.slice(0, m.index);
  }
  return s.trim();
}

// ---------------------------------------------------------------------------------------------
// Messages

/** A piece of a message, in transcript order. Consecutive parts of one role become one message. */
export interface Part {
  role: 'user' | 'assistant';
  kind: 'text' | 'tool' | 'image';
  text: string;
  at?: number;
}

/**
 * Text parts are separated by blank lines, consecutive tool lines by single newlines, and a tool
 * line repeated back to back is written once with a count. Image placeholders only stand in for
 * messages that have nothing else.
 */
function joinParts(parts: Part[]): string {
  const hasContent = parts.some((p) => p.kind !== 'image' && p.text.trim());
  if (!hasContent) return parts.filter((p) => p.kind === 'image').map((p) => p.text).join(' ');
  const segs: { kind: Part['kind']; text: string; count: number }[] = [];
  for (const p of parts) {
    if (p.kind === 'image') continue;
    const text = p.text.trim();
    if (!text) continue;
    const last = segs[segs.length - 1];
    if (last && last.kind === 'tool' && p.kind === 'tool' && last.text === text) last.count++;
    else segs.push({ kind: p.kind, text, count: 1 });
  }
  let out = '';
  segs.forEach((s, i) => {
    if (i) out += segs[i - 1].kind === 'tool' && s.kind === 'tool' ? '\n' : '\n\n';
    out += s.count > 1 ? `${s.text} (×${s.count})` : s.text;
  });
  return out;
}

/** Merges consecutive parts of the same role into messages and drops empty ones. */
export function buildMessages(parts: Part[]): ImportedMessage[] {
  const out: ImportedMessage[] = [];
  let role: Part['role'] | null = null;
  let group: Part[] = [];
  const flush = () => {
    if (role && group.length) {
      const text = joinParts(group);
      if (text.trim()) {
        const at = group.find((p) => p.at !== undefined)?.at;
        out.push(at !== undefined ? { role, text, at } : { role, text });
      }
    }
    group = [];
  };
  for (const p of parts) {
    if (p.kind !== 'image' && !p.text.trim()) continue;
    if (p.role !== role) {
      flush();
      role = p.role;
    }
    group.push(p);
  }
  flush();
  // Two same-role messages can meet when the one between them came out empty.
  const merged: ImportedMessage[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.text = `${last.text}\n\n${m.text}`;
    else merged.push(m);
  }
  return merged;
}

/**
 * Keeps the newest messages whose text adds up to at most [max] characters. A newest message
 * that alone is too long keeps its end.
 */
export function keepNewest(messages: ImportedMessage[], max = MAX_CHARS): { messages: ImportedMessage[]; truncated: boolean } {
  let total = 0;
  let i = messages.length;
  while (i > 0) {
    const len = messages[i - 1].text.length;
    if (total + len > max) break;
    total += len;
    i--;
  }
  if (i === 0) return { messages, truncated: false };
  if (i === messages.length) {
    const m = messages[i - 1];
    let start = m.text.length - (max - 1);
    const c = m.text.charCodeAt(start);
    if (c >= 0xdc00 && c <= 0xdfff) start++;
    return { messages: [{ ...m, text: `…${m.text.slice(start)}` }], truncated: true };
  }
  return { messages: messages.slice(i), truncated: true };
}

/** A parsed transcript, independent of the folder it was asked for. */
export interface ParsedSession {
  id: string;
  cwd: string | null;
  title: string;
  parts: Part[];
}

export interface Converted { messages: ImportedMessage[]; truncated: boolean; updatedAt: number }

export function convert(parsed: ParsedSession, mtimeMs: number): Converted {
  const { messages, truncated } = keepNewest(buildMessages(parsed.parts));
  let last: number | undefined;
  for (const p of parsed.parts) if (p.at !== undefined && (last === undefined || p.at > last)) last = p.at;
  return { messages, truncated, updatedAt: last ?? Math.round(mtimeMs) };
}

// ---------------------------------------------------------------------------------------------
// Cache of listing summaries, keyed by file identity (path, size, mtime) and platform.

export interface CachedSummary { id: string; cwd: string | null; title: string; updatedAt: number; messageCount: number }

const CACHE_MAX = 1000;
const summaries = new Map<string, CachedSummary>();

export function cacheKey(kind: AgentKind, f: FileInfo, platform: NodeJS.Platform): string {
  return `${kind}\0${platform}\0${f.file}\0${f.size}\0${f.mtimeMs}`;
}

export function getCached(key: string): CachedSummary | undefined {
  return summaries.get(key);
}

export function putCached(key: string, value: CachedSummary): void {
  if (summaries.size >= CACHE_MAX) {
    const first = summaries.keys().next().value;
    if (first !== undefined) summaries.delete(first);
  }
  summaries.set(key, value);
}

export function summarize(parsed: ParsedSession, f: FileInfo): CachedSummary {
  const c = convert(parsed, f.mtimeMs);
  return { id: parsed.id, cwd: parsed.cwd, title: parsed.title, updatedAt: c.updatedAt, messageCount: c.messages.length };
}
