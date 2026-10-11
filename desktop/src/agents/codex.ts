/**
 * Codex sessions ("rollouts"): `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`,
 * and `archived_sessions/` for archived ones. Titles given with /rename are in `session_index.jsonl`.
 *
 * Current files are `{"timestamp","type","payload"}` lines: `session_meta` first (id, cwd), then
 * `response_item` (model input/output items: messages, function/custom tool calls, reasoning…),
 * `event_msg` (UI events; newer versions log finished tool runs as `item_completed`), `turn_context`
 * and `compacted`. The oldest files have a bare `{"id","timestamp",…}` first line followed by bare
 * response items, with the folder only in the `<environment_context>` message.
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
  changesLine,
  code,
  commandText,
  convert,
  displayPath,
  forEachLine,
  getCached,
  isValidId,
  listItems,
  makeTitle,
  oneLine,
  parseLine,
  parseTime,
  patchLine,
  putCached,
  ranLine,
  readDirSafe,
  samePath,
  statAll,
  str,
  stripInjected,
  summarize,
  toolLine,
} from './common';

export function codexHome(ctx: Ctx): string {
  const env = ctx.env.CODEX_HOME?.trim();
  return env ? path.resolve(env) : path.join(ctx.home, '.codex');
}

const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
const UUID_IN_NAME_RE = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

/** Rollout files under `sessions/` (YYYY/MM/DD) and `archived_sessions/` (flat or dated). */
async function rolloutFiles(ctx: Ctx): Promise<FileInfo[]> {
  const root = codexHome(ctx);
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const d of await readDirSafe(dir)) {
      if (d.isFile() && ROLLOUT_RE.test(d.name)) found.push(path.join(dir, d.name));
      else if (d.isDirectory() && depth < 3 && /^\d{1,4}$/.test(d.name)) await walk(path.join(dir, d.name), depth + 1);
    }
  };
  await walk(path.join(root, 'sessions'), 0);
  await walk(path.join(root, 'archived_sessions'), 0);
  return statAll(found);
}

// ---------------------------------------------------------------------------------------------
// Tool lines

/**
 * What a tool line is about. Newer versions log each finished tool run as an `item_completed`
 * event as well; when a session has those for a category, they replace the model-side calls of
 * that category (they are more precise, and code-mode `exec` scripts are only readable that way).
 */
type Category = 'shell' | 'patch' | 'mcp' | 'web' | 'image' | 'code' | 'other';

interface ToolPart extends Part {
  category?: Category;
  fromItem?: boolean;
}

function parseArgs(raw: unknown): Json {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** A shell command, recognizing apply_patch run through the shell. */
function shellLine(cmd: unknown, cwd: string | null, platform: NodeJS.Platform): { text: string; category: Category } {
  if (Array.isArray(cmd) && (cmd[0] === 'apply_patch' || cmd[0] === 'applypatch') && typeof cmd[1] === 'string') {
    return { text: patchLine(cmd[1], cwd, platform), category: 'patch' };
  }
  const text = commandText(cmd);
  if (text.includes('*** Begin Patch') && /^\s*(apply_patch|applypatch)\b/.test(text)) return { text: patchLine(text, cwd, platform), category: 'patch' };
  return { text: ranLine(text), category: 'shell' };
}

function webLine(action: Json, query?: unknown): string {
  const a: Json = action && typeof action === 'object' ? action : {};
  const type = typeof a.type === 'string' ? a.type.toLowerCase().replace(/_/g, '') : '';
  if (type === 'openpage') return str(a.url) ? toolLine(`› Fetched ${a.url}`) : '› Fetched a web page';
  if (type === 'findinpage') {
    const pat = str(a.pattern);
    return toolLine(`› Searched for ${pat ? code(oneLine(pat, 120)) : 'text'}${str(a.url) ? ` in ${a.url}` : ''}`);
  }
  const queries: string[] = Array.isArray(a.queries) ? a.queries.filter((q: unknown): q is string => typeof q === 'string' && !!q.trim()) : [];
  const q = str(a.query) ?? queries[0] ?? str(query);
  if (!q) return '› Searched the web';
  const more = queries.length > 1 ? ` and ${queries.length - 1} more` : '';
  return toolLine(`› Searched the web for ${code(oneLine(q, 120))}${more}`);
}

function mcpLine(server: unknown, tool: unknown): string {
  const s = str(server);
  const t = str(tool);
  return toolLine(`› Used ${s ? `${s}: ` : ''}${t ?? 'a tool'}`);
}

/** A `function_call` / `custom_tool_call` from the model. */
function callLine(name: unknown, args: Json, rawInput: unknown, namespace: unknown, cwd: string | null, platform: NodeJS.Platform): { text: string; category: Category } | null {
  const n = typeof name === 'string' ? name : '';
  const p = (v: unknown) => displayPath(v, cwd, platform);
  switch (n) {
    case 'shell':
    case 'container.exec':
    case 'shell_command':
    case 'local_shell':
    case 'exec_command':
    case 'unified_exec':
      return shellLine(args.command ?? args.cmd, cwd, platform);
    case 'apply_patch': {
      const patch = typeof rawInput === 'string' ? rawInput : str(args.input) ?? str(args.patch) ?? '';
      return { text: patchLine(patch, cwd, platform), category: 'patch' };
    }
    case 'exec':
    case 'js_exec':
      // Code mode: a script that calls other tools, each logged as its own item_completed event.
      return { text: '› Ran a script', category: 'code' };
    case 'write_stdin':
      return typeof args.chars === 'string' && args.chars ? { text: '› Sent input to a running command', category: 'other' } : null;
    case 'update_plan':
      return { text: '› Updated the plan', category: 'other' };
    case 'view_image': {
      const f = p(args.path);
      return { text: f ? toolLine(`› Viewed ${f}`) : '› Viewed an image', category: 'image' };
    }
    case 'web_search':
      return { text: webLine(args.action, args.query), category: 'web' };
    case 'read_file': {
      const f = p(args.file_path ?? args.path);
      return { text: f ? toolLine(`› Read ${f}`) : '› Read a file', category: 'other' };
    }
    case 'list_dir': {
      const d = p(args.dir_path ?? args.path);
      return { text: d ? toolLine(`› Listed ${d}`) : '› Listed a folder', category: 'other' };
    }
    case 'grep_files': {
      const pat = str(args.pattern);
      const d = p(args.path);
      return { text: pat ? toolLine(`› Searched for ${code(oneLine(pat, 120))}${d && d !== '.' ? ` in ${d}` : ''}`) : '› Searched files', category: 'other' };
    }
    case 'request_user_input':
    case 'request_user_input_async': {
      const first = Array.isArray(args.questions) ? args.questions[0] : undefined;
      const q = str(first?.question) ?? str(first?.header) ?? str(first?.title);
      return { text: q ? toolLine(`› Asked the user: ${q}`) : '› Asked the user a question', category: 'other' };
    }
    case 'spawn_agent': {
      const what = str(args.description) ?? str(args.message) ?? str(args.prompt);
      return { text: what ? toolLine(`› Ran a sub-agent: ${oneLine(what, 120)}`) : '› Ran a sub-agent', category: 'other' };
    }
  }
  const ns = str(namespace);
  if (ns && ns !== 'functions') return { text: mcpLine(ns, n), category: 'mcp' };
  if (n.startsWith('mcp__')) {
    const rest = n.slice(5);
    const i = rest.indexOf('__');
    return { text: i > 0 ? mcpLine(rest.slice(0, i), rest.slice(i + 2)) : mcpLine(undefined, rest), category: 'mcp' };
  }
  const i = n.indexOf('__');
  if (i > 0) return { text: mcpLine(n.slice(0, i), n.slice(i + 2)), category: 'mcp' };
  return { text: toolLine(`› Used ${n || 'a tool'}`), category: 'other' };
}

/** A command run, from an `item_completed` CommandExecution: reads, listings and searches are named as such. */
function commandItemLine(item: Json, cwd: string | null, platform: NodeJS.Platform): string {
  const parsed: Json[] = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : Array.isArray(item.parsedCmd) ? item.parsedCmd : Array.isArray(item.commandActions) ? item.commandActions : [];
  const kinds = new Set(parsed.map((c) => (c && typeof c.type === 'string' ? c.type.toLowerCase() : 'unknown')));
  const p = (v: unknown) => displayPath(v, cwd, platform);
  if (parsed.length && kinds.size === 1) {
    if (kinds.has('read')) {
      const files = parsed.map((c) => p(c.path) || str(c.name) || '').filter(Boolean);
      if (files.length) return toolLine(`› Read ${listItems(files)}`);
    } else if (kinds.has('list_files') || kinds.has('listfiles')) {
      const d = p(parsed[0].path);
      return toolLine(`› Listed ${d || '.'}`);
    } else if (kinds.has('search')) {
      const q = str(parsed[0].query);
      const d = p(parsed[0].path);
      if (q) return toolLine(`› Searched for ${code(oneLine(q, 120))}${d && d !== '.' ? ` in ${d}` : ''}`);
    }
  }
  return shellLine(item.command, cwd, platform).text;
}

/** FileChange `changes`: `{path: {type}}` in rollouts, `[{path, kind}]` in the app-server protocol. */
function fileChangeLine(changes: unknown, cwd: string | null, platform: NodeJS.Platform): string {
  const groups: Record<'Edited' | 'Created' | 'Deleted', string[]> = { Edited: [], Created: [], Deleted: [] };
  const add = (file: unknown, kind: unknown) => {
    const f = displayPath(file, cwd, platform);
    if (!f) return;
    const k = typeof kind === 'string' ? kind.toLowerCase() : kind && typeof kind === 'object' && typeof (kind as Json).type === 'string' ? (kind as Json).type.toLowerCase() : '';
    groups[k === 'add' ? 'Created' : k === 'delete' ? 'Deleted' : 'Edited'].push(f);
  };
  if (Array.isArray(changes)) {
    for (const c of changes) if (c && typeof c === 'object') add(c.path, c.kind ?? c.type);
  } else if (changes && typeof changes === 'object') {
    for (const [file, c] of Object.entries(changes as Record<string, Json>)) add(file, c && typeof c === 'object' ? c.type ?? c.kind : undefined);
  }
  return changesLine(groups);
}

/** A tool run logged as `event_msg` / `item_completed`. Messages and reasoning are taken from response items instead. */
function itemLine(item: Json, cwd: string | null, platform: NodeJS.Platform): { text: string; category: Category } | null {
  const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
  switch (type) {
    case 'commandexecution':
      return { text: commandItemLine(item, cwd, platform), category: 'shell' };
    case 'filechange':
      return { text: fileChangeLine(item.changes, cwd, platform), category: 'patch' };
    case 'mcptoolcall':
      return { text: mcpLine(item.server, item.tool), category: 'mcp' };
    case 'websearch':
      return { text: webLine(item.action, item.query), category: 'web' };
    case 'extension': {
      const kind = str(item.kind) ?? '';
      if (/web\.?search/i.test(kind)) return { text: webLine(item.action, item.query), category: 'web' };
      return { text: toolLine(`› Used ${kind || 'an extension'}`), category: 'other' };
    }
    case 'imageview': {
      const f = displayPath(item.path, cwd, platform);
      return { text: f ? toolLine(`› Viewed ${f}`) : '› Viewed an image', category: 'image' };
    }
    case 'collabagenttoolcall':
      return { text: '› Ran a sub-agent', category: 'other' };
    case 'todolist':
      return { text: '› Updated the plan', category: 'other' };
    case 'imagegeneration':
      return { text: '› Generated an image', category: 'other' };
  }
  if (type.endsWith('toolcall')) return { text: toolLine(`› Used ${str(item.tool) ?? item.type}`), category: 'other' };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Parsing

interface State {
  id?: string;
  cwd: string | null;
  metaSeen: boolean;
  lineNo: number;
  parts: ToolPart[];
  /** Whether the session logs `item_completed` tool events, and the categories they covered. */
  hasItems: boolean;
  itemCategories: Set<Category>;
  firstPrompt?: string;
}

const IDE_REQUEST_RE = /^# Context from my IDE setup:[\s\S]*?## My request for Codex:\s*\n([\s\S]*)$/;

/** A user text item: the prompt, or injected context to drop. */
function userText(raw: string, at: number | undefined, st: State): void {
  let t = raw.trim();
  if (!t) return;
  if (st.cwd === null && t.startsWith('<environment_context>')) {
    const m = /<cwd>([^<]*)<\/cwd>/.exec(t);
    if (m && m[1].trim()) st.cwd = m[1].trim();
  }
  if (/^<\/?image\b[^>]*>$/.test(t)) return;
  if (/^# AGENTS\.md instructions for /.test(t)) return;
  const ide = IDE_REQUEST_RE.exec(t);
  if (ide) t = ide[1].trim();
  t = stripInjected(t);
  if (!t) return;
  if (st.firstPrompt === undefined) st.firstPrompt = t;
  st.parts.push({ role: 'user', kind: 'text', text: t, at });
}

function tool(st: State, text: string, at: number | undefined, category: Category, fromItem = false): void {
  st.parts.push({ role: 'assistant', kind: 'tool', text, at, category, fromItem });
}

function responseItem(p: Json, at: number | undefined, st: State, ctx: Ctx): void {
  switch (p.type) {
    case 'message': {
      const content: Json[] = Array.isArray(p.content) ? p.content : typeof p.content === 'string' ? [{ type: 'input_text', text: p.content }] : [];
      if (p.role === 'user') {
        for (const c of content) {
          if (!c || typeof c !== 'object') continue;
          if ((c.type === 'input_text' || c.type === 'text') && typeof c.text === 'string') userText(c.text, at, st);
          else if (c.type === 'input_image' || c.type === 'image') st.parts.push({ role: 'user', kind: 'image', text: '[image]', at });
        }
      } else if (p.role === 'assistant') {
        for (const c of content) {
          if (c && (c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string' && c.text.trim()) {
            st.parts.push({ role: 'assistant', kind: 'text', text: c.text, at });
          }
        }
      }
      return;
    }
    case 'function_call': {
      const r = callLine(p.name, parseArgs(p.arguments), undefined, p.namespace, st.cwd, ctx.platform);
      if (r) tool(st, r.text, at, r.category);
      return;
    }
    case 'custom_tool_call': {
      const r = callLine(p.name, {}, p.input, p.namespace, st.cwd, ctx.platform);
      if (r) tool(st, r.text, at, r.category);
      return;
    }
    case 'local_shell_call': {
      const r = shellLine(p.action?.command, st.cwd, ctx.platform);
      tool(st, r.text, at, r.category);
      return;
    }
    case 'web_search_call':
      tool(st, webLine(p.action, p.query), at, 'web');
      return;
    case 'image_generation_call':
      tool(st, '› Generated an image', at, 'other');
      return;
  }
  if (typeof p.type === 'string' && p.type.endsWith('_call') && !p.type.endsWith('_output')) {
    tool(st, toolLine(`› Used ${p.type.slice(0, -'_call'.length)}`), at, 'other');
  }
}

function onLine(o: Json, st: State, ctx: Ctx): void {
  st.lineNo++;
  const at = parseTime(o.timestamp);
  if (typeof o.type === 'string' && 'payload' in o) {
    const p = o.payload;
    if (!p || typeof p !== 'object') return;
    switch (o.type) {
      case 'session_meta':
        if (!st.metaSeen) {
          st.metaSeen = true;
          st.id = str(p.id) ?? str(p.session_id);
          if (st.cwd === null && str(p.cwd)) st.cwd = p.cwd;
        }
        return;
      case 'turn_context':
        if (st.cwd === null && str(p.cwd)) st.cwd = p.cwd;
        return;
      case 'response_item':
        responseItem(p, at, st, ctx);
        return;
      case 'event_msg':
        if (p.type === 'item_completed' && p.item && typeof p.item === 'object') {
          const line = itemLine(p.item, st.cwd, ctx.platform);
          if (line) {
            st.hasItems = true;
            if (line.category !== 'other') st.itemCategories.add(line.category);
            tool(st, line.text, at ?? parseTime(p.completed_at_ms), line.category, true);
          }
        }
        return;
    }
    return;
  }
  // The oldest format: a bare meta line, then bare response items.
  if (st.lineNo === 1 && o.type === undefined && typeof o.id === 'string') {
    st.metaSeen = true;
    st.id = o.id;
    return;
  }
  if (o.record_type !== undefined) return;
  if (typeof o.type === 'string') responseItem(o, at, st, ctx);
}

const SKIP_BIG_RE = /"type":"(?:response_item","payload":\{"type":"(?:function_call_output|custom_tool_call_output|local_shell_call_output|reasoning|tool_search_output)"|event_msg","payload":\{"type":"(?:token_count|exec_command_end|exec_command_output_delta|patch_apply_end|mcp_tool_call_end|agent_reasoning|agent_reasoning_raw_content|web_search_end|user_message|agent_message)"|compacted"|world_state")/;

/** Big lines that never matter (tool output, reasoning, compaction history) are skipped unparsed. */
function skipBig(line: Buffer): boolean {
  if (line.length < 64 * 1024) return false;
  return SKIP_BIG_RE.test(line.toString('utf8', 0, 512));
}

export async function parseCodexFile(file: string, ctx: Ctx, expectCwd?: string): Promise<ParsedSession | null> {
  const st: State = { cwd: null, metaSeen: false, lineNo: 0, parts: [], hasItems: false, itemCategories: new Set() };
  let mismatch = false;
  await forEachLine(file, (line) => {
    if (skipBig(line)) {
      st.lineNo++;
      return;
    }
    const o = parseLine(line);
    if (!o) {
      st.lineNo++;
      return;
    }
    const known = st.cwd !== null;
    onLine(o, st, ctx);
    if (!known && st.cwd !== null && expectCwd !== undefined && !samePath(st.cwd, expectCwd, ctx.platform)) {
      mismatch = true;
      return false;
    }
  });
  if (mismatch) return null;
  const id = st.id ?? UUID_IN_NAME_RE.exec(path.basename(file))?.[1];
  if (!id) return null;
  const items = st.itemCategories;
  const parts = st.hasItems ? st.parts.filter((p) => p.fromItem || !p.category || !(p.category === 'code' || items.has(p.category))) : st.parts;
  return { id, cwd: st.cwd, title: makeTitle(st.firstPrompt), parts: parts.map(({ role, kind, text, at }) => (at !== undefined ? { role, kind, text, at } : { role, kind, text })) };
}

/** The id and folder of a rollout, from its first lines. */
interface Head { id?: string; cwd?: string }
const heads = new Map<string, Head>();

async function readHead(file: string): Promise<Head> {
  const cached = heads.get(file);
  if (cached?.id && cached.cwd) return cached;
  const head: Head = {};
  let n = 0;
  await forEachLine(
    file,
    (line) => {
      n++;
      if (skipBig(line)) return n < 64;
      const o = parseLine(line);
      if (o) {
        const p = o.payload && typeof o.payload === 'object' ? o.payload : undefined;
        if (o.type === 'session_meta' && p) {
          head.id ??= str(p.id) ?? str(p.session_id);
          head.cwd ??= str(p.cwd);
        } else if (o.type === 'turn_context' && p) {
          head.cwd ??= str(p.cwd);
        } else if (n === 1 && o.type === undefined && typeof o.id === 'string') {
          head.id ??= o.id;
        } else {
          const msg = o.type === 'response_item' ? p : o.type === 'message' ? o : undefined;
          if (msg?.type === 'message' && msg.role === 'user' && Array.isArray(msg.content)) {
            for (const c of msg.content) {
              const m = typeof c?.text === 'string' && c.text.trimStart().startsWith('<environment_context>') ? /<cwd>([^<]*)<\/cwd>/.exec(c.text) : null;
              if (m && m[1].trim()) head.cwd ??= m[1].trim();
            }
          }
        }
      }
      return !(head.id && head.cwd) && n < 64;
    },
    64 * 1024,
  );
  head.id ??= UUID_IN_NAME_RE.exec(path.basename(file))?.[1];
  if (head.id && head.cwd) {
    if (heads.size > 5000) heads.clear();
    heads.set(file, head);
  }
  return head;
}

/** Thread names set with /rename, newest last. */
async function threadNames(ctx: Ctx): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await forEachLine(path.join(codexHome(ctx), 'session_index.jsonl'), (line) => {
    const o = parseLine(line);
    if (o && typeof o.id === 'string' && typeof o.thread_name === 'string' && o.thread_name.trim()) names.set(o.id, o.thread_name);
  });
  return names;
}

// ---------------------------------------------------------------------------------------------
// API

const MAX_HEAD_SCANS = 2000;

async function summaryFor(f: FileInfo, cwd: string, ctx: Ctx): Promise<CachedSummary | null> {
  const key = cacheKey('codex', f, ctx.platform);
  const hit = getCached(key);
  if (hit) return hit;
  const parsed = await parseCodexFile(f.file, ctx, cwd);
  if (!parsed) return null;
  const s = summarize(parsed, f);
  putCached(key, s);
  return s;
}

export async function listCodexSessions(cwd: string, ctx: Ctx): Promise<AgentSessionSummary[]> {
  const files = await rolloutFiles(ctx);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const names = await threadNames(ctx);
  const out: AgentSessionSummary[] = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const f of files.slice(0, MAX_HEAD_SCANS)) {
    if (parsed >= MAX_SESSIONS) break;
    const head = await readHead(f.file);
    if (!samePath(head.cwd, cwd, ctx.platform) || (head.id && seen.has(head.id))) continue;
    parsed++;
    const s = await summaryFor(f, cwd, ctx);
    if (!s || !s.messageCount || seen.has(s.id) || !samePath(s.cwd, cwd, ctx.platform)) continue;
    seen.add(s.id);
    out.push({ id: s.id, title: makeTitle(names.get(s.id)) || s.title || 'Codex session', updatedAt: s.updatedAt, messageCount: s.messageCount });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readCodexSession(cwd: string, id: string, ctx: Ctx): Promise<ImportedSession | null> {
  if (!isValidId(id)) return null;
  const files = await rolloutFiles(ctx);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // The file name normally ends with the session id; otherwise look for it in the files' meta.
  const byName = files.filter((f) => path.basename(f.file).endsWith(`-${id}.jsonl`));
  const tried = new Set<string>();
  const attempt = async (f: FileInfo): Promise<ImportedSession | null> => {
    tried.add(f.file);
    const parsed = await parseCodexFile(f.file, ctx, cwd);
    if (!parsed || parsed.id !== id || !samePath(parsed.cwd, cwd, ctx.platform)) return null;
    const c = convert(parsed, f.mtimeMs);
    putCached(cacheKey('codex', f, ctx.platform), { id, cwd: parsed.cwd, title: parsed.title, updatedAt: c.updatedAt, messageCount: c.messages.length });
    const names = await threadNames(ctx);
    const title = makeTitle(names.get(id)) || parsed.title || 'Codex session';
    return { id, title, cwd: parsed.cwd ?? cwd, updatedAt: c.updatedAt, messages: c.messages, truncated: c.truncated };
  };
  for (const f of byName) {
    const s = await attempt(f);
    if (s) return s;
  }
  for (const f of files.slice(0, MAX_HEAD_SCANS)) {
    if (tried.has(f.file)) continue;
    const head = await readHead(f.file);
    if (head.id !== id || !samePath(head.cwd, cwd, ctx.platform)) continue;
    const s = await attempt(f);
    if (s) return s;
  }
  return null;
}
