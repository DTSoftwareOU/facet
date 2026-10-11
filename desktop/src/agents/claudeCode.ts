/**
 * Claude Code sessions: `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded cwd>/<session id>.jsonl`.
 *
 * Each line is a JSON entry. Messages (`user`, `assistant`, `attachment`, `system`) carry `uuid` and
 * `parentUuid`; the conversation is the chain from the newest message back to its root, so edited
 * (rewound) prompts and their replies on abandoned branches are left out. A compaction starts a
 * new root (`system/compact_boundary`) followed by the summary (`isCompactSummary`). One API
 * response with several content blocks is written as one line per block sharing `message.id`, and
 * parallel tool calls can hang off the chain as siblings, so those lines are kept too.
 * Sub-agent transcripts live in `<session id>/subagents/` (older versions: `isSidechain` lines).
 */
import path from 'node:path';
import {
  type AgentSessionSummary,
  type CachedSummary,
  type Ctx,
  type FileInfo,
  type ImportedSession,
  type Json,
  type ParsedSession,
  type Part,
  MAX_SESSIONS,
  cacheKey,
  code,
  convert,
  displayPath,
  forEachLine,
  getCached,
  isValidId,
  makeTitle,
  oneLine,
  parseLine,
  parseTime,
  putCached,
  ranLine,
  readDirSafe,
  samePath,
  slashPath,
  statFile,
  str,
  stripInjected,
  summarize,
  toolLine,
} from './common';

export function claudeConfigDir(ctx: Ctx): string {
  const env = ctx.env.CLAUDE_CONFIG_DIR?.trim();
  return env ? path.resolve(env) : path.join(ctx.home, '.claude');
}

/** Claude Code's project folder name: every character other than A–Z, a–z and 0–9 becomes `-`. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The project folders that can hold sessions for [cwd]. Names are matched case-insensitively
 * (Windows sessions started from `c:\…` live in `c--…`); long names that Claude Code shortened
 * with a hash suffix match on their first 200 characters. The `cwd` inside the files decides.
 */
async function projectDirs(cwd: string, ctx: Ctx): Promise<string[]> {
  const clean = slashPath(cwd, ctx.platform);
  if (!clean) return [];
  const want = encodeProjectDir(clean).toLowerCase();
  const root = path.join(claudeConfigDir(ctx), 'projects');
  const out: string[] = [];
  for (const d of await readDirSafe(root)) {
    if (!d.isDirectory()) continue;
    const name = d.name.toLowerCase();
    if (name === want || (want.length > 200 && name.length > 200 && name.startsWith(want.slice(0, 200)))) {
      out.push(path.join(root, d.name));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tool lines

function mcpName(name: string): string {
  const rest = name.slice('mcp__'.length);
  const i = rest.indexOf('__');
  if (i <= 0) return `› Used ${rest || name}`;
  return `› Used ${rest.slice(0, i)}: ${rest.slice(i + 2)}`;
}

/** One line for a Claude Code tool call. */
export function claudeToolLine(name: unknown, input: Json, cwd: string | null, platform: NodeJS.Platform): string {
  const n = typeof name === 'string' ? name : '';
  const i: Json = input && typeof input === 'object' ? input : {};
  const p = (v: unknown) => displayPath(v, cwd, platform);
  const inPath = (v: unknown) => {
    const d = p(v);
    return d && d !== '.' ? ` in ${d}` : '';
  };
  switch (n) {
    case 'Bash':
    case 'PowerShell':
      return ranLine(typeof i.command === 'string' ? i.command : '');
    case 'Monitor':
      return typeof i.command === 'string' && i.command.trim() ? `› Monitored ${code(oneLine(i.command, 120))}` : '› Monitored a command';
    case 'BashOutput':
    case 'TaskOutput':
      return '› Checked a background command';
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return '› Stopped a background command';
    case 'Read':
    case 'NotebookRead': {
      const f = p(i.file_path ?? i.notebook_path ?? i.path);
      return f ? toolLine(`› Read ${f}`) : '› Read a file';
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const f = p(i.file_path ?? i.notebook_path);
      return f ? toolLine(`› Edited ${f}`) : '› Edited a file';
    }
    case 'Write': {
      const f = p(i.file_path);
      return f ? toolLine(`› Wrote ${f}`) : '› Wrote a file';
    }
    case 'Glob':
      return typeof i.pattern === 'string' ? toolLine(`› Listed files matching ${code(oneLine(i.pattern, 120))}${inPath(i.path)}`) : '› Listed files';
    case 'Grep':
      return typeof i.pattern === 'string' ? toolLine(`› Searched for ${code(oneLine(i.pattern, 120))}${inPath(i.path)}`) : '› Searched files';
    case 'LS': {
      const d = p(i.path);
      return d ? toolLine(`› Listed ${d}`) : '› Listed a folder';
    }
    case 'WebFetch':
      return typeof i.url === 'string' ? toolLine(`› Fetched ${i.url}`) : '› Fetched a web page';
    case 'WebSearch':
      return typeof i.query === 'string' ? toolLine(`› Searched the web for ${code(oneLine(i.query, 120))}`) : '› Searched the web';
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return '› Updated the plan';
    case 'TodoRead':
    case 'TaskList':
    case 'TaskGet':
      return '› Checked the plan';
    case 'Task':
    case 'Agent': {
      const what = str(i.description) ?? str(i.subagent_type);
      return what ? toolLine(`› Ran a sub-agent: ${what}`) : '› Ran a sub-agent';
    }
    case 'SendMessage': {
      const to = str(i.to) ?? str(i.recipient);
      return to ? toolLine(`› Sent a message to ${to}`) : '› Sent a message';
    }
    case 'AskUserQuestion': {
      const q = Array.isArray(i.questions) ? str(i.questions[0]?.question) ?? str(i.questions[0]?.header) : str(i.question);
      return q ? toolLine(`› Asked the user: ${q}`) : '› Asked the user a question';
    }
    case 'Skill': {
      const s = str(i.skill) ?? str(i.command) ?? str(i.name);
      return s ? toolLine(`› Used the ${s} skill`) : '› Used a skill';
    }
    case 'ExitPlanMode':
      return '› Proposed a plan';
    case 'EnterPlanMode':
      return '› Entered plan mode';
    case 'ToolSearch':
      return '› Looked up tools';
    case 'ReadMcpResourceTool': {
      const s = str(i.server);
      const u = str(i.uri);
      return toolLine(`› Read ${s ? `${s} resource` : 'a resource'}${u ? ` ${u}` : ''}`);
    }
    case 'ListMcpResourcesTool':
      return '› Listed MCP resources';
  }
  if (n.startsWith('mcp__')) return toolLine(mcpName(n));
  return toolLine(`› Used ${n || 'a tool'}`);
}

/** Server-side tools (web search and fetch run by the API, code execution). */
function serverToolLine(name: unknown, input: Json): string {
  const i: Json = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'web_search':
      return typeof i.query === 'string' ? toolLine(`› Searched the web for ${code(oneLine(i.query, 120))}`) : '› Searched the web';
    case 'web_fetch':
      return typeof i.url === 'string' ? toolLine(`› Fetched ${i.url}`) : '› Fetched a web page';
    case 'code_execution':
    case 'bash_code_execution':
      return typeof i.command === 'string' ? ranLine(i.command) : '› Ran code';
  }
  return toolLine(`› Used ${typeof name === 'string' && name ? name : 'a tool'}`);
}

// ---------------------------------------------------------------------------------------------
// Parsing

interface CompactMeta {
  preservedMessages?: { anchorUuid?: unknown; uuids?: unknown; allUuids?: unknown };
  preservedSegment?: { headUuid?: unknown; anchorUuid?: unknown; tailUuid?: unknown };
}

interface Entry {
  idx: number;
  uuid: string;
  parent: string | null;
  type: string;
  msgId?: string;
  parts: Part[];
  /** The compact summary that starts the conversation after a compaction. */
  summary?: boolean;
  boundary?: CompactMeta;
  /** A `<command-name>` slash command, dropped when its local output follows. */
  command?: boolean;
  /** `<local-command-stdout>`: the command before it ran locally (/model, /mcp, …). */
  localOutput?: boolean;
}

interface State {
  cwd: string | null;
  entries: Map<string, Entry>;
  order: Entry[];
  leaf: Entry | null;
  aiTitle?: string;
  customTitle?: string;
  agentName?: string;
  summaries: { text: string; leaf?: string }[];
  firstPrompt?: string;
}

const COMPACT_PREFIX = 'Summary of the earlier conversation:\n\n';
const CONTINUED_RE = /^This session is being continued from a previous conversation/;

function summaryText(text: string): string {
  let s = text.replace(/^This session is being continued from a previous conversation[^\n]*\n+/, '');
  s = s.replace(/^Summary:[ \t]*\n/, '');
  return COMPACT_PREFIX + s.trim();
}

/** A user text: a prompt, a slash command, or something to drop. */
function userText(raw: string, at: number | undefined, e: Entry, st: State): void {
  const t = raw.trim();
  if (!t) return;
  if (/^\[Request interrupted by user/.test(t)) return;
  if (t.startsWith('<command-')) {
    const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(t)?.[1];
    if (name) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? '';
      e.command = true;
      e.parts.push({ role: 'user', kind: 'text', text: `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`, at });
      return;
    }
  }
  if (/^<local-command-(stdout|stderr)>/.test(t)) {
    e.localOutput = true;
    return;
  }
  const text = stripInjected(t);
  if (!text) return;
  if (st.firstPrompt === undefined) st.firstPrompt = text;
  e.parts.push({ role: 'user', kind: 'text', text, at });
}

function userBlocks(content: unknown, at: number | undefined, e: Entry, st: State): void {
  if (typeof content === 'string') {
    userText(content, at, e, st);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') userText(b.text, at, e, st);
    else if (b.type === 'image') e.parts.push({ role: 'user', kind: 'image', text: '[image]', at });
    else if (b.type === 'document') e.parts.push({ role: 'user', kind: 'image', text: '[document]', at });
  }
}

function onUser(o: Json, e: Entry, at: number | undefined, st: State): void {
  if (o.isMeta === true) return;
  const kind = o.origin && typeof o.origin === 'object' ? o.origin.kind : undefined;
  if (typeof kind === 'string' && kind !== 'human') return; // task notifications, peer agents
  const content = o.message?.content;
  const first = typeof content === 'string' ? content : Array.isArray(content) ? content.find((b: Json) => b?.type === 'text')?.text : undefined;
  if (o.isCompactSummary === true || (typeof first === 'string' && CONTINUED_RE.test(first.trimStart()))) {
    if (typeof first === 'string') {
      e.summary = true;
      e.parts.push({ role: 'user', kind: 'text', text: summaryText(first.trim()), at });
    }
    return;
  }
  userBlocks(content, at, e, st);
}

function onAssistant(o: Json, e: Entry, at: number | undefined, st: State, ctx: Ctx): void {
  const m = o.message;
  if (!m || typeof m !== 'object') return;
  if (typeof m.id === 'string') e.msgId = m.id;
  if (o.isApiErrorMessage === true || m.model === '<synthetic>') return;
  const c = m.content;
  if (typeof c === 'string') {
    if (c.trim()) e.parts.push({ role: 'assistant', kind: 'text', text: c, at });
    return;
  }
  if (!Array.isArray(c)) return;
  for (const b of c) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      if (b.text.trim() && b.text.trim() !== '(no content)') e.parts.push({ role: 'assistant', kind: 'text', text: b.text, at });
    } else if (b.type === 'tool_use') {
      e.parts.push({ role: 'assistant', kind: 'tool', text: claudeToolLine(b.name, b.input, st.cwd, ctx.platform), at });
    } else if (b.type === 'server_tool_use') {
      e.parts.push({ role: 'assistant', kind: 'tool', text: serverToolLine(b.name, b.input), at });
    } else if (b.type === 'mcp_tool_use') {
      const server = str(b.server_name);
      e.parts.push({ role: 'assistant', kind: 'tool', text: toolLine(`› Used ${server ? `${server}: ` : ''}${str(b.name) ?? 'a tool'}`), at });
    }
  }
}

/** Prompts typed while Claude was working arrive as `queued_command` attachments. */
function onAttachment(o: Json, e: Entry, at: number | undefined, st: State): void {
  const a = o.attachment;
  if (!a || typeof a !== 'object' || a.type !== 'queued_command' || a.isMeta === true || o.isMeta === true) return;
  const kind = a.origin && typeof a.origin === 'object' ? a.origin.kind : undefined;
  if (typeof kind === 'string' ? kind !== 'human' : a.commandMode !== undefined && a.commandMode !== 'prompt') return;
  userBlocks(a.prompt, at, e, st);
}

const HEAD_RE = /^\{"parentUuid":(null|"([^"\\]*)"),"isSidechain":(true|false),/;
const TOOL_RESULT_MARK = '"type":"user","message":{"role":"user","content":[{"tool_use_id":"';
const UUID_AFTER_MESSAGE = Buffer.from(']},"uuid":"');
const UUID_RE = /^\]\},"uuid":"([^"\\]{1,100})","timestamp":"/;
const FAST_MIN = 64 * 1024;

/**
 * Tool results (often with base64 images) make up most of a transcript's bytes, but only their
 * place in the chain matters. For big lines that are plainly a tool-result message, read the ids
 * without decoding or parsing the line; anything unexpected falls back to a full parse.
 */
export function fastToolResult(line: Buffer): Json | undefined {
  if (line.length < FAST_MIN) return undefined;
  const head = line.toString('utf8', 0, 1024);
  const h = HEAD_RE.exec(head);
  if (!h || !head.includes(TOOL_RESULT_MARK)) return undefined;
  const i = line.indexOf(UUID_AFTER_MESSAGE);
  if (i < 0) return undefined;
  const m = UUID_RE.exec(line.toString('utf8', i, i + 160));
  if (!m) return undefined;
  return { type: 'user', uuid: m[1], parentUuid: h[2] ?? null, isSidechain: h[3] === 'true', message: { role: 'user', content: [] } };
}

function onLine(o: Json, st: State, ctx: Ctx): void {
  const type = o.type;
  if (typeof type !== 'string') return;
  switch (type) {
    case 'ai-title':
      if (typeof o.aiTitle === 'string' && o.aiTitle.trim()) st.aiTitle = o.aiTitle;
      return;
    case 'custom-title':
      if (typeof o.customTitle === 'string' && o.customTitle.trim()) st.customTitle = o.customTitle;
      return;
    case 'agent-name':
      if (typeof o.agentName === 'string' && o.agentName.trim()) st.agentName = o.agentName;
      return;
    case 'summary':
      if (typeof o.summary === 'string' && o.summary.trim()) st.summaries.push({ text: o.summary, leaf: str(o.leafUuid) });
      return;
  }
  if (typeof o.uuid !== 'string' || o.isSidechain === true || st.entries.has(o.uuid)) return;
  if (st.cwd === null && typeof o.cwd === 'string' && o.cwd.trim()) st.cwd = o.cwd;
  const e: Entry = { idx: st.order.length, uuid: o.uuid, parent: typeof o.parentUuid === 'string' ? o.parentUuid : null, type, parts: [] };
  const at = parseTime(o.timestamp);
  if (type === 'user') onUser(o, e, at, st);
  else if (type === 'assistant') onAssistant(o, e, at, st, ctx);
  else if (type === 'attachment') onAttachment(o, e, at, st);
  else if (type === 'system' && o.subtype === 'compact_boundary') e.boundary = o.compactMetadata && typeof o.compactMetadata === 'object' ? o.compactMetadata : {};
  st.entries.set(e.uuid, e);
  st.order.push(e);
  if (type === 'user' || type === 'assistant') st.leaf = e;
}

/** Messages kept after a compaction, which belong right after the summary. */
function preservedAfterCompact(meta: CompactMeta | undefined, st: State): { anchor?: string; entries: Entry[] } {
  if (!meta) return { entries: [] };
  const pm = meta.preservedMessages;
  const seg = meta.preservedSegment;
  let ids: string[] = [];
  if (pm && Array.isArray(pm.allUuids)) ids = pm.allUuids.filter((x): x is string => typeof x === 'string');
  else if (pm && Array.isArray(pm.uuids)) ids = pm.uuids.filter((x): x is string => typeof x === 'string');
  else if (seg && typeof seg.tailUuid === 'string') {
    const chain: string[] = [];
    let e = st.entries.get(seg.tailUuid);
    while (e && chain.length < st.order.length) {
      chain.push(e.uuid);
      if (e.uuid === seg.headUuid || !e.parent) break;
      e = st.entries.get(e.parent);
    }
    ids = chain.reverse();
  }
  const anchor = str(pm?.anchorUuid) ?? str(seg?.anchorUuid);
  return { anchor, entries: ids.map((id) => st.entries.get(id)).filter((x): x is Entry => !!x) };
}

/** The entries of the conversation as it stands, in file order. */
function activeEntries(st: State): Entry[] {
  const leaf = st.leaf;
  if (!leaf) return [];
  const chain = new Set<Entry>();
  let e: Entry | undefined = leaf;
  while (e && !chain.has(e)) {
    chain.add(e);
    e = e.parent ? st.entries.get(e.parent) : undefined;
  }
  let start = leaf.idx;
  const ids = new Set<string>();
  for (const c of chain) {
    if (c.idx < start) start = c.idx;
    if (c.msgId) ids.add(c.msgId);
  }
  let selected = st.order.filter((x) => x.idx >= start && (chain.has(x) || (x.type === 'assistant' && x.msgId !== undefined && ids.has(x.msgId))));

  let s = -1;
  for (let i = selected.length - 1; i >= 0; i--) {
    if (selected[i].summary) {
      s = i;
      break;
    }
  }
  if (s >= 0) {
    const summary = selected[s];
    let boundary: Entry | undefined = summary.parent ? st.entries.get(summary.parent) : undefined;
    if (!boundary?.boundary) {
      boundary = undefined;
      for (let i = summary.idx - 1; i >= 0 && i >= summary.idx - 50; i--) {
        if (st.order[i].boundary) {
          boundary = st.order[i];
          break;
        }
      }
    }
    selected = selected.slice(s);
    const kept = new Set(selected);
    const preserved = preservedAfterCompact(boundary?.boundary, st);
    const extra = preserved.entries.filter((x) => !kept.has(x));
    if (extra.length) {
      let at = preserved.anchor ? selected.findIndex((x) => x.uuid === preserved.anchor) : 0;
      if (at < 0) at = 0;
      selected = [...selected.slice(0, at + 1), ...extra, ...selected.slice(at + 1)];
    }
  }
  return selected;
}

/** Parts in conversation order, without slash commands that only ran locally. */
function activeParts(st: State): Part[] {
  const parts: Part[] = [];
  let pendingCommand = -1;
  for (const e of activeEntries(st)) {
    if (e.localOutput) {
      if (pendingCommand >= 0) parts.splice(pendingCommand, 1);
      pendingCommand = -1;
      continue;
    }
    if (!e.parts.length) continue;
    if (e.command) {
      pendingCommand = parts.length;
      parts.push(...e.parts);
      continue;
    }
    pendingCommand = -1;
    parts.push(...e.parts);
  }
  return parts;
}

function pickTitle(st: State): string {
  const fromSummary = [...st.summaries].reverse().find((s) => !s.leaf || st.entries.has(s.leaf))?.text;
  return makeTitle(st.customTitle) || makeTitle(st.aiTitle) || makeTitle(st.agentName) || makeTitle(fromSummary) || makeTitle(st.firstPrompt) || 'Claude Code session';
}

/**
 * Parses a transcript. With [expectCwd], stops early and returns null as soon as the session's
 * folder (the first `cwd` in it) turns out to be a different one.
 */
export async function parseClaudeFile(file: string, id: string, ctx: Ctx, expectCwd?: string): Promise<ParsedSession | null> {
  const st: State = { cwd: null, entries: new Map(), order: [], leaf: null, summaries: [] };
  let mismatch = false;
  await forEachLine(file, (line) => {
    const o = fastToolResult(line) ?? parseLine(line);
    if (!o) return;
    const known = st.cwd !== null;
    onLine(o, st, ctx);
    if (!known && st.cwd !== null && expectCwd !== undefined && !samePath(st.cwd, expectCwd, ctx.platform)) {
      mismatch = true;
      return false;
    }
  });
  if (mismatch) return null;
  return { id, cwd: st.cwd, title: pickTitle(st), parts: activeParts(st) };
}

// ---------------------------------------------------------------------------------------------
// API

async function sessionFiles(cwd: string, ctx: Ctx): Promise<(FileInfo & { id: string })[]> {
  const out: (FileInfo & { id: string })[] = [];
  for (const dir of await projectDirs(cwd, ctx)) {
    for (const d of await readDirSafe(dir)) {
      if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
      const id = d.name.slice(0, -'.jsonl'.length);
      if (!isValidId(id) || id.startsWith('agent-')) continue;
      const f = await statFile(path.join(dir, d.name));
      if (f) out.push({ ...f, id });
    }
  }
  return out;
}

async function summaryFor(f: FileInfo & { id: string }, cwd: string, ctx: Ctx): Promise<CachedSummary | null> {
  const key = cacheKey('claude', f, ctx.platform);
  const hit = getCached(key);
  if (hit) return hit;
  const parsed = await parseClaudeFile(f.file, f.id, ctx, cwd);
  if (!parsed) return null;
  const s = summarize(parsed, f);
  putCached(key, s);
  return s;
}

export async function listClaudeSessions(cwd: string, ctx: Ctx): Promise<AgentSessionSummary[]> {
  const files = await sessionFiles(cwd, ctx);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: AgentSessionSummary[] = [];
  const seen = new Set<string>();
  for (const f of files.slice(0, MAX_SESSIONS)) {
    if (seen.has(f.id)) continue;
    const s = await summaryFor(f, cwd, ctx);
    if (!s || !s.messageCount || !samePath(s.cwd, cwd, ctx.platform)) continue;
    seen.add(f.id);
    out.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, messageCount: s.messageCount });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readClaudeSession(cwd: string, id: string, ctx: Ctx): Promise<ImportedSession | null> {
  if (!isValidId(id) || id.startsWith('agent-')) return null;
  for (const dir of await projectDirs(cwd, ctx)) {
    const file = path.join(dir, `${id}.jsonl`);
    if (path.dirname(file) !== dir) continue;
    const f = await statFile(file);
    if (!f) continue;
    const parsed = await parseClaudeFile(file, id, ctx, cwd);
    if (!parsed || !samePath(parsed.cwd, cwd, ctx.platform)) continue;
    const c = convert(parsed, f.mtimeMs);
    putCached(cacheKey('claude', f, ctx.platform), { id, cwd: parsed.cwd, title: parsed.title, updatedAt: c.updatedAt, messageCount: c.messages.length });
    return { id, title: parsed.title, cwd: parsed.cwd ?? cwd, updatedAt: c.updatedAt, messages: c.messages, truncated: c.truncated };
  }
  return null;
}
