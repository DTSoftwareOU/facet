import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { listAgentSessions, readAgentSession, type AgentOptions } from '../src/agents';
import { encodeProjectDir, fastToolResult } from '../src/agents/claudeCode';
import {
  buildMessages,
  code,
  commandText,
  displayPath,
  forEachLine,
  keepNewest,
  makeTitle,
  patchLine,
  ranLine,
  samePath,
  slashPath,
  stripInjected,
} from '../src/agents/common';

// All fixtures are synthetic: they mimic the shapes of real transcripts, not their content.

let tmp: string;
let homeCount = 0;
before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'facet-agents-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function newHome(): string {
  const h = path.join(tmp, `home${++homeCount}`);
  mkdirSync(h, { recursive: true });
  return h;
}

const WIN = (home: string): AgentOptions => ({ home, env: {}, platform: 'win32' });
const POSIX = (home: string): AgentOptions => ({ home, env: {}, platform: 'linux' });

const T0 = Date.parse('2026-03-01T09:00:00.000Z');
const iso = (n: number) => new Date(T0 + n * 1000).toISOString();

function writeLines(file: string, lines: unknown[], mtime?: Date): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

// ---------------------------------------------------------------------------------------------
// Claude Code fixtures

class ClaudeLog {
  lines: unknown[] = [];
  last: string | null = null;
  private n = 0;
  constructor(
    readonly cwd: string,
    readonly id = 'aaaaaaaa-0000-4000-8000-000000000001',
  ) {}

  private next() {
    this.n++;
    return { uuid: `${this.id.slice(0, 8)}-${String(this.n).padStart(4, '0')}`, timestamp: iso(this.n) };
  }

  /** Appends a chained entry; returns its uuid. */
  entry(type: string, fields: Record<string, unknown>, opts: { parent?: string | null; keepLast?: boolean } = {}): string {
    const { uuid, timestamp } = this.next();
    const parentUuid = opts.parent !== undefined ? opts.parent : this.last;
    this.lines.push({ parentUuid, isSidechain: false, type, ...fields, uuid, timestamp, cwd: this.cwd, sessionId: this.id, version: '2.1.0' });
    if (!opts.keepLast) this.last = uuid;
    return uuid;
  }

  user(content: unknown, fields: Record<string, unknown> = {}, opts: { parent?: string | null; keepLast?: boolean } = {}): string {
    return this.entry('user', { message: { role: 'user', content }, ...fields }, opts);
  }

  assistant(content: unknown[], msgId: string, fields: Record<string, unknown> = {}, opts: { parent?: string | null; keepLast?: boolean } = {}): string {
    return this.entry('assistant', { message: { id: msgId, type: 'message', role: 'assistant', model: 'claude-test', content }, ...fields }, opts);
  }

  toolResult(): string {
    return this.user([{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'tool output that must not appear' }], { toolUseResult: { stdout: 'x' } });
  }

  raw(obj: unknown): void {
    this.lines.push(obj);
  }

  write(home: string, mtime?: Date, dirName = encodeProjectDir(this.cwd)): string {
    return writeLines(path.join(home, '.claude', 'projects', dirName, `${this.id}.jsonl`), this.lines, mtime);
  }
}

const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (name: string, input: unknown) => ({ type: 'tool_use', id: 'toolu_1', name, input });

const CWD = 'C:\\Work\\My App';

function basicClaudeSession(): ClaudeLog {
  const log = new ClaudeLog(CWD);
  log.raw({ type: 'mode', mode: 'normal', sessionId: log.id });
  log.raw({ type: 'ai-title', aiTitle: 'Old title', sessionId: log.id });
  log.user('Fix the failing test\nin src/app.ts', { origin: { kind: 'human' }, promptSource: 'typed' });
  log.entry('attachment', { attachment: { type: 'environment', content: 'Working directory: …' } });
  log.assistant([{ type: 'thinking', thinking: 'secret reasoning', signature: 's' }], 'msg_1');
  log.assistant([text('Let me look.')], 'msg_1');
  log.assistant([toolUse('Read', { file_path: 'C:\\Work\\My App\\src\\app.ts' })], 'msg_1');
  log.toolResult();
  log.assistant([toolUse('Bash', { command: 'npm test -- --watch=false\n  && echo done', description: 'Run tests' })], 'msg_2');
  log.toolResult();
  log.assistant([toolUse('Edit', { file_path: 'c:/work/my app/src/app.ts', old_string: 'a', new_string: 'b' })], 'msg_3');
  log.toolResult();
  log.assistant(
    [
      toolUse('Write', { file_path: 'D:\\notes\\todo.md', content: 'x' }),
      toolUse('Grep', { pattern: 'TODO', path: 'C:\\Work\\My App\\src' }),
      toolUse('Glob', { pattern: '**/*.ts' }),
      toolUse('LS', { path: 'C:\\Work\\My App\\docs' }),
      toolUse('WebFetch', { url: 'https://example.com/docs', prompt: 'p' }),
      toolUse('WebSearch', { query: 'vitest watch' }),
      toolUse('TodoWrite', { todos: [] }),
      toolUse('Task', { description: 'Explore the code', prompt: 'p', subagent_type: 'Explore' }),
      toolUse('mcp__github__create_issue', { title: 't' }),
      toolUse('MultiEdit', { file_path: 'C:\\Work\\My App\\a.ts', edits: [] }),
      toolUse('NotebookEdit', { notebook_path: 'C:\\Work\\My App\\n.ipynb' }),
      toolUse('FooTool', {}),
    ],
    'msg_4',
  );
  log.toolResult();
  log.assistant([text('Fixed it.')], 'msg_5');
  // Slash command that ran locally, an interruption, a background-task notification: all dropped.
  log.user('<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>', { isMeta: true });
  log.user('<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>');
  log.user('<local-command-stdout>Set model to something</local-command-stdout>');
  log.user([text('[Request interrupted by user]')]);
  log.user('<task-notification>\n<status>completed</status>\n</task-notification>', { origin: { kind: 'task-notification' } });
  log.user([text('<ide_opened_file>The user opened src/app.ts in the IDE.</ide_opened_file>'), text('Now add docs')], { origin: { kind: 'human' } });
  log.assistant([text('API Error: 500 internal')], 'msg_err', { isApiErrorMessage: true });
  log.assistant([text('No response requested.')], 'msg_syn', { message: { id: 'msg_syn', role: 'assistant', model: '<synthetic>', content: [text('No response requested.')] } });
  // An old-style sidechain (sub-agent) in the same file.
  const parent = log.last;
  log.entry('user', { isSidechain: true, message: { role: 'user', content: 'SIDECHAIN PROMPT' } }, { parent, keepLast: true });
  log.raw({ parentUuid: parent, isSidechain: true, type: 'assistant', message: { id: 'side', role: 'assistant', content: [text('SIDECHAIN SECRET')] }, uuid: 'side-1', timestamp: iso(500), cwd: CWD });
  log.assistant([text('Docs added.'), { type: 'server_tool_use', id: 'srv', name: 'web_search', input: { query: 'jsdoc' } }], 'msg_6');
  log.entry('attachment', { attachment: { type: 'queued_command', prompt: 'Also update the README', commandMode: 'prompt', origin: { kind: 'human' } } });
  log.entry('attachment', { attachment: { type: 'queued_command', prompt: '<task-notification>x</task-notification>', commandMode: 'task-notification' } });
  log.assistant([text('README updated.')], 'msg_7');
  log.user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }]);
  log.assistant([text('Nice screenshot.')], 'msg_8');
  log.user('<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>src</command-args>');
  log.user([text('Expanded review prompt that the user never typed.')], { isMeta: true });
  log.assistant([text('Reviewed.')], 'msg_9');
  log.raw({ type: 'ai-title', aiTitle: 'Fix the failing test', sessionId: log.id });
  log.raw({ type: 'last-prompt', lastPrompt: 'x', leafUuid: log.last, sessionId: log.id });
  return log;
}

describe('Claude Code conversion', () => {
  it('keeps prompts and replies, summarizes tools and drops everything injected', async () => {
    const home = newHome();
    const log = basicClaudeSession();
    log.write(home);
    const s = await readAgentSession('claude', CWD, log.id, WIN(home));
    assert.ok(s);
    assert.equal(s.id, log.id);
    assert.equal(s.cwd, CWD);
    assert.equal(s.title, 'Fix the failing test');
    assert.equal(s.truncated, false);
    assert.deepEqual(
      s.messages.map((m) => [m.role, m.text]),
      [
        ['user', 'Fix the failing test\nin src/app.ts'],
        [
          'assistant',
          [
            'Let me look.',
            '',
            '› Read src/app.ts',
            '› Ran `npm test -- --watch=false && echo done`',
            '› Edited src/app.ts',
            '› Wrote D:\\notes\\todo.md',
            '› Searched for `TODO` in src',
            '› Listed files matching `**/*.ts`',
            '› Listed docs',
            '› Fetched https://example.com/docs',
            '› Searched the web for `vitest watch`',
            '› Updated the plan',
            '› Ran a sub-agent: Explore the code',
            '› Used github: create_issue',
            '› Edited a.ts',
            '› Edited n.ipynb',
            '› Used FooTool',
            '',
            'Fixed it.',
          ].join('\n'),
        ],
        ['user', 'Now add docs'],
        ['assistant', 'Docs added.\n\n› Searched the web for `jsdoc`'],
        ['user', 'Also update the README'],
        ['assistant', 'README updated.'],
        ['user', '[image]'],
        ['assistant', 'Nice screenshot.'],
        ['user', '/review src'],
        ['assistant', 'Reviewed.'],
      ],
    );
    assert.equal(s.messages[0].at, Date.parse(iso(1)));
    assert.ok(s.messages.every((m) => typeof m.at === 'number'));
    assert.equal(s.updatedAt, s.messages[s.messages.length - 1].at);
    const all = s.messages.map((m) => m.text).join('\n');
    for (const leaked of ['secret reasoning', 'tool output', 'SIDECHAIN', 'API Error', 'No response requested', 'Caveat', '/model', 'Set model', 'interrupted', 'task-notification', 'ide_opened_file', 'Expanded review']) {
      assert.ok(!all.includes(leaked), `leaked: ${leaked}`);
    }
  });

  it('lists the session with its title and message count', async () => {
    const home = newHome();
    const log = basicClaudeSession();
    log.write(home);
    const list = await listAgentSessions('claude', CWD, WIN(home));
    const s = await readAgentSession('claude', CWD, log.id, WIN(home));
    assert.ok(s);
    assert.equal(s.messages.length, 10);
    assert.deepEqual(list, [{ id: log.id, title: 'Fix the failing test', updatedAt: s.updatedAt, messageCount: 10 }]);
  });

  it('follows the active branch after a rewind and keeps parallel tool calls', async () => {
    const home = newHome();
    const log = new ClaudeLog(CWD);
    log.user('First prompt');
    const b = log.assistant([text('First answer.')], 'm1');
    log.user('Abandoned prompt');
    log.assistant([text('Abandoned answer.')], 'm2');
    // The user rewound to after "First answer." and asked something else.
    log.user('Edited prompt', {}, { parent: b });
    const p = log.assistant([text('Reading both.')], 'm3');
    log.assistant([toolUse('Read', { file_path: 'C:\\Work\\My App\\a.ts' })], 'm3', {}, { parent: p, keepLast: true });
    log.assistant([toolUse('Read', { file_path: 'C:\\Work\\My App\\b.ts' })], 'm3', {}, { parent: p });
    log.toolResult();
    log.assistant([text('Both read.')], 'm4');
    log.write(home);
    const s = await readAgentSession('claude', CWD, log.id, WIN(home));
    assert.ok(s);
    assert.deepEqual(
      s.messages.map((m) => m.text),
      ['First prompt', 'First answer.', 'Edited prompt', 'Reading both.\n\n› Read a.ts\n› Read b.ts\n\nBoth read.'],
    );
  });

  it('starts a compacted session from its latest summary, then the preserved messages', async () => {
    const home = newHome();
    const log = new ClaudeLog(CWD);
    log.user('OLD PROMPT about the parser');
    log.assistant([text('Old answer.')], 'm1');
    log.raw({ type: 'ai-title', aiTitle: '', sessionId: log.id });
    log.user('Another old prompt');
    const kept = log.assistant([text('Preserved reply.')], 'm2');
    const boundary = log.entry(
      'system',
      { subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false, logicalParentUuid: kept, compactMetadata: { trigger: 'auto', preTokens: 1 } },
      { parent: null },
    );
    const summary = log.user(
      'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. The user wants a faster parser.',
      { isCompactSummary: true, isVisibleInTranscriptOnly: true },
    );
    (log.lines.find((l) => (l as { uuid?: string }).uuid === boundary) as { compactMetadata: unknown }).compactMetadata = {
      trigger: 'auto',
      preservedSegment: { headUuid: kept, anchorUuid: summary, tailUuid: kept },
      preservedMessages: { anchorUuid: summary, uuids: [kept], allUuids: [kept] },
    };
    log.entry('attachment', { attachment: { type: 'file', filename: 'x' } });
    log.user('New prompt after compaction');
    log.assistant([text('New answer.')], 'm3');
    log.write(home);
    const s = await readAgentSession('claude', CWD, log.id, WIN(home));
    assert.ok(s);
    assert.deepEqual(
      s.messages.map((m) => [m.role, m.text]),
      [
        ['user', 'Summary of the earlier conversation:\n\n1. The user wants a faster parser.'],
        ['assistant', 'Preserved reply.'],
        ['user', 'New prompt after compaction'],
        ['assistant', 'New answer.'],
      ],
    );
    // No title entry with text: the first real prompt (not the summary).
    assert.equal(s.title, 'OLD PROMPT about the parser');
  });

  it('treats an old-style continuation file as starting with a summary', async () => {
    const home = newHome();
    const log = new ClaudeLog(CWD);
    log.user('This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\nAnalysis: things happened.');
    log.user('Please go on');
    log.assistant([text('Going on.')], 'm1');
    log.write(home);
    const s = await readAgentSession('claude', CWD, log.id, WIN(home));
    assert.ok(s);
    assert.deepEqual(
      s.messages.map((m) => m.text),
      ['Summary of the earlier conversation:\n\nAnalysis: things happened.\n\nPlease go on', 'Going on.'],
    );
    assert.equal(s.title, 'Please go on');
  });

  it('picks titles: custom title, newest AI title, agent name, summary, first prompt', async () => {
    const home = newHome();
    const make = (id: string, extra: unknown[], prompt = 'A first prompt\nsecond line') => {
      const log = new ClaudeLog(CWD, id);
      log.user(prompt);
      log.assistant([text('ok')], 'm');
      for (const e of extra) log.raw(e);
      log.write(home);
      return log;
    };
    const custom = make('t-custom', [{ type: 'ai-title', aiTitle: 'AI' }, { type: 'custom-title', customTitle: 'My name' }]);
    const ai = make('t-ai', [{ type: 'ai-title', aiTitle: 'First AI' }, { type: 'agent-name', agentName: 'agent' }, { type: 'ai-title', aiTitle: 'Newest AI' }]);
    const agent = make('t-agent', [{ type: 'agent-name', agentName: 'named-agent' }]);
    const summaryLog = new ClaudeLog(CWD, 't-summary');
    summaryLog.user('prompt');
    const leaf = summaryLog.assistant([text('ok')], 'm');
    summaryLog.raw({ type: 'summary', summary: 'Summary of another session', leafUuid: 'not-in-this-file' });
    summaryLog.raw({ type: 'summary', summary: 'Parser work', leafUuid: leaf });
    summaryLog.write(home);
    const long = make('t-long', [], `   ${'word '.repeat(40)}\nmore`);
    const opts = WIN(home);
    const title = async (id: string) => (await readAgentSession('claude', CWD, id, opts))?.title;
    assert.equal(await title(custom.id), 'My name');
    assert.equal(await title(ai.id), 'Newest AI');
    assert.equal(await title(agent.id), 'named-agent');
    assert.equal(await title(summaryLog.id), 'Parser work');
    const t = await title(long.id);
    assert.equal(t?.length, 80);
    assert.ok(t?.endsWith('…') && t.startsWith('word word'));
  });

  it('truncates to the newest 300,000 characters without cutting messages', async () => {
    const home = newHome();
    const log = new ClaudeLog(CWD);
    log.user('a'.repeat(150_000));
    log.assistant([text('b'.repeat(100_000))], 'm1');
    log.user('c'.repeat(100_000));
    log.assistant([text('d'.repeat(90_000))], 'm2');
    log.write(home);
    const s = await readAgentSession('claude', CWD, log.id, WIN(home));
    assert.ok(s);
    assert.equal(s.truncated, true);
    assert.deepEqual(s.messages.map((m) => [m.role, m.text[0], m.text.length]), [
      ['assistant', 'b', 100_000],
      ['user', 'c', 100_000],
      ['assistant', 'd', 90_000],
    ]);
    const list = await listAgentSessions('claude', CWD, WIN(home));
    assert.equal(list[0].messageCount, 3);
  });

  it('keeps the end of a single oversize message', () => {
    const big = `${'x'.repeat(350_000)}THE END`;
    const r = keepNewest([{ role: 'user', text: 'old' }, { role: 'assistant', text: big }]);
    assert.equal(r.truncated, true);
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].text.length, 300_000);
    assert.ok(r.messages[0].text.startsWith('…') && r.messages[0].text.endsWith('THE END'));
    assert.deepEqual(keepNewest([{ role: 'user', text: 'hi' }]), { messages: [{ role: 'user', text: 'hi' }], truncated: false });
  });

  it('matches folders case-insensitively on Windows, with any separators', async () => {
    const home = newHome();
    const log = new ClaudeLog('c:\\Work\\My App');
    log.user('hello');
    log.assistant([text('hi')], 'm');
    log.write(home); // in "c--Work-My-App"
    for (const cwd of ['C:\\Work\\My App', 'c:/work/my app/', 'C:\\WORK\\My App\\', 'C:/Work/./sub/../My App']) {
      const list = await listAgentSessions('claude', cwd, WIN(home));
      assert.equal(list.length, 1, cwd);
      assert.ok(await readAgentSession('claude', cwd, log.id, WIN(home)), cwd);
    }
    assert.deepEqual(await listAgentSessions('claude', 'C:\\Work\\My App2', WIN(home)), []);
  });

  it('is case-sensitive on other platforms', async () => {
    const home = newHome();
    const log = new ClaudeLog('/home/me/proj');
    log.user('hello');
    log.assistant([text('hi')], 'm');
    log.write(home);
    assert.equal((await listAgentSessions('claude', '/home/me/proj/', POSIX(home))).length, 1);
    assert.equal((await listAgentSessions('claude', '/home/me/Proj', POSIX(home))).length, 0);
    assert.equal(await readAgentSession('claude', '/home/me/Proj', log.id, POSIX(home)), null);
  });

  it('tells apart folders that share an encoded name', async () => {
    const home = newHome();
    const a = new ClaudeLog('C:\\Work\\My App', 'sess-a');
    a.user('in my app');
    a.assistant([text('a')], 'm');
    a.write(home);
    const b = new ClaudeLog('C:\\Work\\My-App', 'sess-b');
    b.user('in my-app');
    b.assistant([text('b')], 'm');
    b.write(home);
    assert.equal(encodeProjectDir('C:\\Work\\My App'), encodeProjectDir('C:\\Work\\My-App'));
    assert.deepEqual((await listAgentSessions('claude', 'C:\\Work\\My App', WIN(home))).map((s) => s.id), ['sess-a']);
    assert.deepEqual((await listAgentSessions('claude', 'C:\\Work\\My-App', WIN(home))).map((s) => s.id), ['sess-b']);
    assert.equal(await readAgentSession('claude', 'C:\\Work\\My App', 'sess-b', WIN(home)), null);
  });

  it('decides the folder by the first cwd, even when the session later moved into a subfolder', async () => {
    const home = newHome();
    const log = new ClaudeLog(CWD);
    log.user('start');
    log.assistant([text('cd into src')], 'm');
    log.lines.push({ ...(log.lines[log.lines.length - 1] as object), uuid: 'later', parentUuid: log.last, cwd: 'C:\\Work\\My App\\src', message: { id: 'm2', role: 'assistant', content: [text('in src now')] } });
    log.write(home);
    const s = await readAgentSession('claude', CWD, log.id, WIN(home));
    assert.deepEqual(s?.messages.map((m) => m.text), ['start', 'cd into src\n\nin src now']);
    assert.equal(await readAgentSession('claude', 'C:\\Work\\My App\\src', log.id, WIN(home)), null);
  });

  it('honors CLAUDE_CONFIG_DIR', async () => {
    const home = newHome();
    const config = path.join(home, 'custom-claude');
    const log = new ClaudeLog(CWD);
    log.user('hello');
    log.assistant([text('hi')], 'm');
    writeLines(path.join(config, 'projects', encodeProjectDir(CWD), `${log.id}.jsonl`), log.lines);
    assert.equal((await listAgentSessions('claude', CWD, WIN(home))).length, 0);
    assert.equal((await listAgentSessions('claude', CWD, { home, env: { CLAUDE_CONFIG_DIR: config }, platform: 'win32' })).length, 1);
  });

  it('lists the 50 newest sessions, newest first, and skips empty ones and sub-agent files', async () => {
    const home = newHome();
    for (let i = 0; i < 55; i++) {
      const log = new ClaudeLog(CWD, `s${String(i).padStart(2, '0')}`);
      log.user(`prompt ${i}`);
      log.assistant([text('ok')], 'm');
      // Inner timestamps follow the file order.
      for (const l of log.lines as { timestamp: string }[]) l.timestamp = new Date(T0 + i * 60_000).toISOString();
      log.write(home, new Date(T0 + i * 60_000));
    }
    const empty = new ClaudeLog(CWD, 'only-local-commands');
    empty.entry('system', { subtype: 'local_command', content: '<command-name>/resume</command-name>' });
    empty.write(home, new Date(T0 + 100 * 60_000));
    const agent = new ClaudeLog(CWD, 'agent-a1b2c3');
    agent.user('sub-agent prompt');
    agent.assistant([text('sub-agent reply')], 'm');
    agent.write(home, new Date(T0 + 101 * 60_000));
    const list = await listAgentSessions('claude', CWD, WIN(home));
    // The empty session took one of the 50 parse slots; agent-* files are never candidates.
    assert.equal(list.length, 49);
    assert.equal(list[0].id, 's54');
    assert.equal(list[48].id, 's06');
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].updatedAt >= list[i].updatedAt);
    assert.equal(list[0].title, 'prompt 54');
    assert.equal(list[0].messageCount, 2);
    assert.equal(list[0].updatedAt, T0 + 54 * 60_000);
  });

  it('rejects bad ids and never leaves the project folder', async () => {
    const home = newHome();
    const log = new ClaudeLog(CWD);
    log.user('hello');
    log.assistant([text('hi')], 'm');
    log.write(home);
    // A session file one level up, which a traversal would reach.
    writeLines(path.join(home, '.claude', 'projects', 'secret.jsonl'), log.lines);
    const opts = WIN(home);
    for (const id of ['../secret', '..\\secret', 'a/b', 'a\\b', '', '.', 'x'.repeat(101), 'id.jsonl', 'C:secret', ' secret']) {
      assert.equal(await readAgentSession('claude', CWD, id, opts), null, JSON.stringify(id));
      assert.equal(await readAgentSession('codex', CWD, id, opts), null, JSON.stringify(id));
    }
    assert.equal(await readAgentSession('claude', CWD, 'does-not-exist', opts), null);
    assert.ok(await readAgentSession('claude', CWD, log.id, opts));
    // @ts-expect-error: callers over IPC can send anything.
    assert.equal(await readAgentSession('claude', CWD, 42, opts), null);
  });

  it('survives malformed lines and missing folders', async () => {
    const home = newHome();
    const log = new ClaudeLog(CWD);
    log.user('hello');
    log.raw('{"type":"user", "message": {"role": "user", "content": "trunc');
    log.raw('not json at all');
    log.raw('[1,2,3]');
    log.raw('null');
    log.raw({ type: 'assistant', uuid: 'weird', parentUuid: log.last, message: { content: 'plain string reply', id: 'w' }, cwd: CWD, timestamp: 'not a date' });
    log.raw({ type: 'user', uuid: 'weird2', parentUuid: 'weird', message: null, cwd: CWD });
    log.raw({ type: 'assistant', uuid: 'weird3', parentUuid: 'weird2', message: { content: [null, 5, { type: 'tool_use' }, { type: 'text', text: 7 }], id: 'w3' }, cwd: CWD });
    log.write(home);
    const s = await readAgentSession('claude', CWD, log.id, WIN(home));
    assert.deepEqual(s?.messages.map((m) => m.text), ['hello', 'plain string reply\n\n› Used a tool']);
    assert.deepEqual(await listAgentSessions('claude', 'C:\\Nowhere', WIN(home)), []);
    assert.deepEqual(await listAgentSessions('claude', CWD, WIN(path.join(home, 'missing'))), []);
    assert.deepEqual(await listAgentSessions('claude', '', WIN(home)), []);
    assert.equal(await readAgentSession('claude', CWD, 'abc', WIN(path.join(home, 'missing'))), null);
  });

  it('reads ids from huge tool-result lines without parsing them', async () => {
    const home = newHome();
    const log = new ClaudeLog(CWD);
    log.user('Look at the screenshot output');
    log.assistant([toolUse('Bash', { command: 'make screenshot' })], 'm1');
    // Same key order as Claude Code writes.
    const uuid = '0c9e7a1e-6a8e-4e4e-9a51-1f0b1c2d3e4f';
    const big = {
      parentUuid: log.last,
      isSidechain: false,
      promptId: 'p',
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(200_000) } }] }] },
      uuid,
      timestamp: iso(50),
      toolUseResult: { uuid: 'nested-not-this-one' },
      cwd: CWD,
      sessionId: log.id,
    };
    const line = Buffer.from(JSON.stringify(big));
    assert.deepEqual(fastToolResult(line), { type: 'user', uuid, parentUuid: log.last, isSidechain: false, message: { role: 'user', content: [] } });
    assert.equal(fastToolResult(Buffer.from(JSON.stringify({ ...big, message: { role: 'user', content: 'x'.repeat(70_000) } }))), undefined);
    assert.equal(fastToolResult(Buffer.from(JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user' }))), undefined);
    log.raw(big);
    log.last = uuid;
    log.assistant([text('The screenshot looks right.')], 'm2');
    log.write(home);
    const s = await readAgentSession('claude', CWD, log.id, WIN(home));
    assert.deepEqual(s?.messages.map((m) => m.text), ['Look at the screenshot output', '› Ran `make screenshot`\n\nThe screenshot looks right.']);
  });
});

// ---------------------------------------------------------------------------------------------
// Codex fixtures

class CodexLog {
  lines: unknown[] = [];
  private n = 0;
  constructor(
    readonly id: string,
    readonly cwd: string,
    meta = true,
  ) {
    if (meta) this.add('session_meta', { id, timestamp: iso(0), cwd, originator: 'codex_cli_rs', cli_version: '0.50.0', instructions: null, git: { branch: 'main' } });
  }

  add(type: string, payload: unknown): void {
    this.n++;
    this.lines.push({ timestamp: iso(this.n), type, payload });
  }

  item(payload: unknown): void {
    this.add('response_item', payload);
  }

  user(...texts: string[]): void {
    this.item({ type: 'message', role: 'user', content: texts.map((t) => ({ type: 'input_text', text: t })) });
  }

  assistant(t: string): void {
    this.item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] });
  }

  call(name: string, args: unknown): void {
    this.item({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: `call_${this.n}` });
    this.item({ type: 'function_call_output', call_id: `call_${this.n}`, output: '{"output":"must not appear"}' });
  }

  write(home: string, opts: { mtime?: Date; archived?: boolean; day?: string } = {}): string {
    const name = `rollout-2026-03-01T09-00-00-${this.id}.jsonl`;
    const dir = opts.archived ? path.join(home, '.codex', 'archived_sessions') : path.join(home, '.codex', 'sessions', ...(opts.day ?? '2026/03/01').split('/'));
    return writeLines(path.join(dir, name), this.lines, opts.mtime);
  }
}

const CX1 = '0199a000-0000-7000-8000-000000000001';
const CX2 = '0199a000-0000-7000-8000-000000000002';
const CX3 = '0199a000-0000-7000-8000-000000000003';

function basicCodexSession(): CodexLog {
  const log = new CodexLog(CX1, CWD);
  log.item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>sandbox</permissions instructions>' }] });
  log.user('<environment_context>\n  <cwd>C:\\Work\\My App</cwd>\n  <shell>powershell</shell>\n</environment_context>');
  log.user('# AGENTS.md instructions for C:\\Work\\My App\n\n<INSTRUCTIONS>\nBe nice.\n</INSTRUCTIONS>');
  log.add('turn_context', { cwd: CWD, approval_policy: 'on-request', model: 'gpt-test' });
  log.user('Make the tests pass');
  log.add('event_msg', { type: 'user_message', message: 'Make the tests pass', images: [] });
  log.item({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'secret plan' }], encrypted_content: 'zzz' });
  log.assistant('Running the tests first.');
  log.add('event_msg', { type: 'agent_message', message: 'Running the tests first.' });
  log.call('shell', { command: ['bash', '-lc', 'npm test'], workdir: CWD });
  log.call('shell_command', { command: 'git status --short' });
  log.call('exec_command', { cmd: 'rg -n "TODO" src' });
  log.item({ type: 'local_shell_call', call_id: 'l1', status: 'completed', action: { type: 'exec', command: ['powershell.exe', '-Command', 'Get-ChildItem'] } });
  log.item({ type: 'custom_tool_call', call_id: 'p1', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** Add File: C:\\Work\\My App\\notes.md\n+hi\n*** Delete File: old.txt\n*** End Patch' });
  log.item({ type: 'custom_tool_call_output', call_id: 'p1', output: 'Success' });
  log.call('shell', { command: ['apply_patch', '*** Begin Patch\n*** Update File: README.md\n*** End Patch'] });
  log.call('update_plan', { plan: [{ step: 'a', status: 'completed' }] });
  log.call('view_image', { path: 'C:\\Work\\My App\\shot.png' });
  log.item({ type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'node streams' } });
  log.call('mcp__github__create_issue', { title: 't' });
  log.call('mystery_tool', {});
  log.assistant('All tests pass.');
  log.add('event_msg', { type: 'token_count', info: null });
  log.user('<image name=[Image #1] path="C:\\shot.png">', '</image>');
  log.item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<image name=[Image #1]>' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }, { type: 'input_text', text: '</image>' }] });
  log.assistant('I see the screenshot.');
  log.user('# Context from my IDE setup:\n\n## Active file: src/app.ts\n\n## My request for Codex:\nExplain this file');
  log.assistant('It renders the app.');
  log.add('compacted', { message: '', replacement_history: [] });
  log.user('<turn_aborted>\nThe user interrupted.\n</turn_aborted>');
  return log;
}

describe('Codex conversion', () => {
  it('keeps prompts and replies, summarizes tools and drops injected context', async () => {
    const home = newHome();
    basicCodexSession().write(home);
    const s = await readAgentSession('codex', CWD, CX1, WIN(home));
    assert.ok(s);
    assert.equal(s.id, CX1);
    assert.equal(s.cwd, CWD);
    assert.equal(s.title, 'Make the tests pass');
    assert.deepEqual(
      s.messages.map((m) => [m.role, m.text]),
      [
        ['user', 'Make the tests pass'],
        [
          'assistant',
          [
            'Running the tests first.',
            '',
            '› Ran `npm test`',
            '› Ran `git status --short`',
            '› Ran `rg -n "TODO" src`',
            '› Ran `Get-ChildItem`',
            '› Edited src/app.ts; created notes.md; deleted old.txt',
            '› Edited README.md',
            '› Updated the plan',
            '› Viewed shot.png',
            '› Searched the web for `node streams`',
            '› Used github: create_issue',
            '› Used mystery_tool',
            '',
            'All tests pass.',
          ].join('\n'),
        ],
        ['user', '[image]'],
        ['assistant', 'I see the screenshot.'],
        ['user', 'Explain this file'],
        ['assistant', 'It renders the app.'],
      ],
    );
    assert.equal(s.messages[0].at, Date.parse(iso(6)));
    const all = s.messages.map((m) => m.text).join('\n');
    for (const leaked of ['secret plan', 'must not appear', 'Be nice', 'environment_context', 'sandbox', 'interrupted', 'Active file']) {
      assert.ok(!all.includes(leaked), `leaked: ${leaked}`);
    }
  });

  it('uses item_completed tool events when the session has them', async () => {
    const home = newHome();
    const log = new CodexLog(CX2, CWD);
    log.user('Set up the project');
    log.item({ type: 'custom_tool_call', call_id: 'e1', name: 'exec', input: 'text(await tools.exec_command({cmd:"cat src/app.ts"}))', status: 'completed' });
    const done = (item: unknown) => log.add('event_msg', { type: 'item_completed', thread_id: CX2, turn_id: 't', item, started_at_ms: 1, completed_at_ms: 2 });
    done({ type: 'CommandExecution', id: 'x1', command: ['powershell.exe', '-Command', 'Get-Content src/app.ts'], cwd: 'file:///C:/Work/My%20App', parsed_cmd: [{ type: 'read', cmd: 'Get-Content src/app.ts', name: 'app.ts', path: 'C:/Work/My App/src/app.ts' }], aggregated_output: 'secret file content', status: 'completed' });
    done({ type: 'CommandExecution', id: 'x2', command: ['powershell.exe', '-Command', 'npm test'], parsed_cmd: [{ type: 'unknown', cmd: 'npm test' }], aggregated_output: 'out' });
    done({ type: 'CommandExecution', id: 'x3', command: 'ls src', parsed_cmd: [{ type: 'list_files', cmd: 'ls src', path: 'src' }] });
    done({ type: 'FileChange', id: 'x4', changes: { 'C:\\Work\\My App\\src\\app.ts': { type: 'update', unified_diff: '@@' }, 'C:\\Work\\My App\\new.ts': { type: 'add', content: 'x' } }, status: 'completed' });
    done({ type: 'McpToolCall', id: 'x5', server: 'blender', tool: 'get_scene_info', arguments: {}, result: { content: [] } });
    done({ type: 'Extension', kind: 'web.search', id: 'x6', query: 'q', action: { type: 'openPage', url: 'https://example.com/' }, results: [] });
    done({ type: 'Extension', kind: 'web.search', id: 'x7', query: 'q', action: { type: 'search', query: null, queries: ['codex mcp', 'blender mcp'] } });
    done({ type: 'ImageView', id: 'x8', path: 'file:///C:/Work/My%20App/shot.png' });
    done({ type: 'Reasoning', id: 'x9', summary_text: [], raw_content: [] });
    done({ type: 'AgentMessage', id: 'x10', content: [{ type: 'text', text: 'duplicate of the response item' }] });
    done({ type: 'Extension', kind: 'memory.write', id: 'x11' });
    // Model-side calls with no item counterpart stay.
    log.call('request_user_input_async', { questions: [{ question: 'Which style?', options: [] }] });
    log.assistant('Done.');
    log.write(home);
    const s = await readAgentSession('codex', CWD, CX2, WIN(home));
    assert.deepEqual(
      s?.messages.map((m) => m.text),
      [
        'Set up the project',
        [
          '› Read src/app.ts',
          '› Ran `npm test`',
          '› Listed src',
          '› Edited src/app.ts; created new.ts',
          '› Used blender: get_scene_info',
          '› Fetched https://example.com/',
          '› Searched the web for `codex mcp` and 1 more',
          '› Viewed shot.png',
          '› Used memory.write',
          '› Asked the user: Which style?',
          '',
          'Done.',
        ].join('\n'),
      ],
    );
  });

  it('reads the oldest format (bare meta line, folder in the environment context)', async () => {
    const home = newHome();
    const log = new CodexLog(CX3, CWD, false);
    log.lines.push({ id: CX3, timestamp: iso(0), instructions: null, git: null });
    log.lines.push({ record_type: 'state' });
    log.lines.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>c:\\work\\my app</cwd>\n</environment_context>' }] });
    log.lines.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Old prompt' }] });
    log.lines.push({ type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","ls"]}', call_id: 'c' });
    log.lines.push({ type: 'function_call_output', call_id: 'c', output: 'x' });
    log.lines.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Old answer' }] });
    const file = log.write(home, { mtime: new Date(T0 + 5000) });
    assert.ok(file);
    const list = await listAgentSessions('codex', CWD, WIN(home));
    assert.deepEqual(list, [{ id: CX3, title: 'Old prompt', updatedAt: T0 + 5000, messageCount: 2 }]);
    const s = await readAgentSession('codex', CWD, CX3, WIN(home));
    assert.deepEqual(s?.messages, [{ role: 'user', text: 'Old prompt' }, { role: 'assistant', text: '› Ran `ls`\n\nOld answer' }]);
  });

  it('lists matching sessions newest first, including archived ones, with /rename titles', async () => {
    const home = newHome();
    const a = new CodexLog(CX1, CWD);
    a.user('Newest session prompt');
    a.assistant('ok');
    a.write(home, { mtime: new Date(T0 + 3_000_000), day: '2026/03/02' });
    const b = new CodexLog(CX2, 'c:/work/my app/');
    b.user('Archived session prompt');
    b.assistant('ok');
    b.write(home, { mtime: new Date(T0 + 2_000_000), archived: true });
    const c = new CodexLog(CX3, 'C:\\Elsewhere');
    c.user('Other folder');
    c.assistant('ok');
    c.write(home, { mtime: new Date(T0 + 4_000_000) });
    const empty = new CodexLog('0199a000-0000-7000-8000-00000000000e', CWD);
    empty.user('<environment_context><cwd>x</cwd></environment_context>');
    empty.write(home, { mtime: new Date(T0 + 5_000_000) });
    writeLines(path.join(home, '.codex', 'session_index.jsonl'), [
      { id: CX1, thread_name: 'First name', updated_at: iso(1) },
      'garbage',
      { id: CX1, thread_name: 'Renamed session', updated_at: iso(2) },
    ]);
    const list = await listAgentSessions('codex', CWD, WIN(home));
    assert.deepEqual(list.map((s) => [s.id, s.title, s.messageCount]), [
      [CX1, 'Renamed session', 2],
      [CX2, 'Archived session prompt', 2],
    ]);
    assert.equal((await readAgentSession('codex', CWD, CX1, WIN(home)))?.title, 'Renamed session');
    assert.ok(await readAgentSession('codex', CWD, CX2, WIN(home)));
    assert.equal(await readAgentSession('codex', CWD, CX3, WIN(home)), null);
    assert.equal(await readAgentSession('codex', CWD, '0199a000-0000-7000-8000-000000000099', WIN(home)), null);
  });

  it('honors CODEX_HOME and finds sessions whose file name lacks the id', async () => {
    const home = newHome();
    const codexHome = path.join(home, 'elsewhere');
    const log = new CodexLog(CX1, CWD);
    log.user('hello');
    log.assistant('hi');
    writeLines(path.join(codexHome, 'sessions', '2026', '03', '01', 'rollout-2026-03-01T09-00-00.jsonl'), log.lines);
    const opts: AgentOptions = { home, env: { CODEX_HOME: codexHome }, platform: 'win32' };
    assert.deepEqual((await listAgentSessions('codex', CWD, opts)).map((s) => s.id), [CX1]);
    assert.equal((await readAgentSession('codex', CWD, CX1, opts))?.messages.length, 2);
    assert.deepEqual(await listAgentSessions('codex', CWD, WIN(home)), []);
  });

  it('survives malformed files and missing folders', async () => {
    const home = newHome();
    const file = path.join(home, '.codex', 'sessions', '2026', '03', '01', `rollout-2026-03-01T09-00-00-${CX1}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `{"timestamp":"x","type":"session_meta","payload":{"id":"${CX1}","cwd":"C:\\\\Work\\\\My App"}}\n{broken\n\n{"type":"response_item","payload":null}\n{"type":"response_item","payload":{"type":"message","role":"user","content":"string content"}}\n{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{not json"}}\n{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","changes":null}}}`);
    const s = await readAgentSession('codex', CWD, CX1, WIN(home));
    assert.deepEqual(s?.messages.map((m) => m.text), ['string content', '› Ran a command\n› Edited files']);
    assert.deepEqual(await listAgentSessions('codex', CWD, WIN(path.join(home, 'missing'))), []);
    // @ts-expect-error: unknown agents give nothing.
    assert.deepEqual(await listAgentSessions('gemini', CWD, WIN(home)), []);
  });
});

// ---------------------------------------------------------------------------------------------
// Helpers

describe('agent import helpers', () => {
  it('normalizes and compares paths', () => {
    assert.equal(slashPath('C:\\Work\\My App\\', 'win32'), 'C:/Work/My App');
    assert.equal(slashPath('c:/work/../work/./x', 'win32'), 'C:/work/x');
    assert.equal(slashPath('C:\\', 'win32'), 'C:/');
    assert.equal(slashPath('/c/Users/me', 'win32'), 'C:/Users/me');
    assert.equal(slashPath('\\\\?\\C:\\Users\\me', 'win32'), 'C:/Users/me');
    assert.equal(slashPath('file:///C:/Work/My%20App', 'win32'), 'C:/Work/My App');
    assert.equal(slashPath('/home/me//proj/', 'linux'), '/home/me/proj');
    assert.ok(samePath('C:\\Work\\My App', 'c:/work/my app/', 'win32'));
    assert.ok(!samePath('/home/Me', '/home/me', 'linux'));
    assert.ok(!samePath('C:\\Work', null, 'win32'));
  });

  it('shows paths relative to the folder when inside it', () => {
    assert.equal(displayPath('C:\\Work\\My App\\src\\a.ts', 'C:\\Work\\My App', 'win32'), 'src/a.ts');
    assert.equal(displayPath('c:/WORK/my app/src/a.ts', 'C:\\Work\\My App', 'win32'), 'src/a.ts');
    assert.equal(displayPath('C:\\Work\\My Apple\\a.ts', 'C:\\Work\\My App', 'win32'), 'C:\\Work\\My Apple\\a.ts');
    assert.equal(displayPath('C:\\Work\\My App', 'C:\\Work\\My App\\', 'win32'), '.');
    assert.equal(displayPath('src\\b.ts', 'C:\\Work', 'win32'), 'src/b.ts');
    assert.equal(displayPath('/home/me/proj/x.py', '/home/me/proj', 'linux'), 'x.py');
    assert.equal(displayPath('/etc/hosts', '/home/me/proj', 'linux'), '/etc/hosts');
    assert.equal(displayPath(undefined, '/x', 'linux'), '');
  });

  it('unwraps shell argv and formats command lines', () => {
    assert.equal(commandText(['bash', '-lc', 'npm test']), 'npm test');
    assert.equal(commandText(['/bin/zsh', '-c', 'ls -la']), 'ls -la');
    assert.equal(commandText(['C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-Command', 'Get-Item', 'x']), 'Get-Item x');
    assert.equal(commandText(['cmd.exe', '/c', 'dir']), 'dir');
    assert.equal(commandText(['git', 'commit', '-m', 'a message']), 'git commit -m "a message"');
    assert.equal(commandText('echo hi'), 'echo hi');
    assert.equal(commandText(42), '');
    const long = ranLine(`echo ${'x'.repeat(300)}\nsecond line`);
    assert.ok(long.startsWith('› Ran `echo xxx'));
    assert.equal(long.length, '› Ran ``'.length + 120);
    assert.ok(!long.includes('\n'));
    assert.equal(ranLine(''), '› Ran a command');
    assert.equal(code('a `b` c'), '`` a `b` c ``');
  });

  it('lists the files of a patch', () => {
    assert.equal(patchLine('*** Begin Patch\n*** Add File: a.ts\n*** Add File: b.ts\n*** End Patch', '/p', 'linux'), '› Created a.ts, b.ts');
    assert.equal(patchLine('*** Begin Patch\n*** End Patch', '/p', 'linux'), '› Edited files');
    const many = Array.from({ length: 7 }, (_, i) => `*** Update File: f${i}.ts`).join('\n');
    assert.equal(patchLine(many, '/p', 'linux'), '› Edited f0.ts, f1.ts, f2.ts, f3.ts and 3 more');
  });

  it('strips injected context but keeps user content', () => {
    assert.equal(stripInjected('<system-reminder>x</system-reminder>\nreal question'), 'real question');
    assert.equal(stripInjected('question\n<system-reminder>x</system-reminder>'), 'question');
    assert.equal(stripInjected('<environment_context><cwd>x</cwd></environment_context>'), '');
    assert.equal(stripInjected('<pasted_content id="1">my notes</pasted_content> what now?'), '<pasted_content id="1">my notes</pasted_content> what now?');
    assert.equal(stripInjected('<b>bold</b> stays'), '<b>bold</b> stays');
  });

  it('merges same-role parts, joins tool lines and keeps image placeholders only alone', () => {
    const msgs = buildMessages([
      { role: 'user', kind: 'image', text: '[image]', at: 1 },
      { role: 'user', kind: 'image', text: '[image]', at: 2 },
      { role: 'assistant', kind: 'text', text: '  ', at: 3 },
      { role: 'assistant', kind: 'tool', text: '› Ran `a`', at: 4 },
      { role: 'assistant', kind: 'tool', text: '› Ran `a`' },
      { role: 'assistant', kind: 'tool', text: '› Ran `b`' },
      { role: 'assistant', kind: 'text', text: 'done' },
      { role: 'user', kind: 'image', text: '[image]' },
      { role: 'user', kind: 'text', text: 'see this' },
    ]);
    assert.deepEqual(msgs, [
      { role: 'user', text: '[image] [image]', at: 1 },
      { role: 'assistant', text: '› Ran `a` (×2)\n› Ran `b`\n\ndone', at: 4 },
      { role: 'user', text: 'see this' },
    ]);
  });

  it('makes titles from the first non-empty line', () => {
    assert.equal(makeTitle('\n\n  Hello   world  \nmore'), 'Hello world');
    assert.equal(makeTitle(undefined), '');
    const t = makeTitle('é'.repeat(100));
    assert.equal(t.length, 80);
    assert.ok(t.endsWith('…'));
  });

  it('streams lines across chunk boundaries, with CRLF and no final newline', async () => {
    const file = path.join(tmp, 'lines.jsonl');
    writeFileSync(file, '{"a":1}\r\n\n{"b":"ünïcödé"}\n{"c":3}');
    const seen: string[] = [];
    await forEachLine(file, (l) => void seen.push(l.toString('utf8')), 5);
    assert.deepEqual(seen, ['{"a":1}\r', '', '{"b":"ünïcödé"}', '{"c":3}']);
    const firstOnly: string[] = [];
    await forEachLine(file, (l) => (firstOnly.push(l.toString()), false), 3);
    assert.deepEqual(firstOnly, ['{"a":1}\r']);
    const none: string[] = [];
    await forEachLine(path.join(tmp, 'missing.jsonl'), (l) => void none.push(l.toString()));
    assert.deepEqual(none, []);
  });
});
