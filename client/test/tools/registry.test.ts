import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, FacetDb, setDb } from '../../src/data/db';
import type { AttachmentEntity, McpServerEntity } from '../../src/data/entities';
import { DEFAULT_LOCAL, defaultSynced, type LocalPrefs, type SettingsStore, type SyncedPrefs } from '../../src/data/prefs';
import { defaultCaps, defaultParams, type ModelCaps, type GenParams } from '../../src/llm/types';
import { platform, type ComputerBridge } from '../../src/platform';
import { McpManager } from '../../src/tools/mcpManager';
import { MAX_RESULT_CHARS, MAX_TOOL_ROUNDS, READER_NOTE, ToolRegistry, YOLO_TOOL_ROUNDS, type MediaToolService } from '../../src/tools/registry';
import { SkillRepository } from '../../src/tools/skills';
import { searchKind } from '../../src/tools/types';
import { WebSearch, type SearchConfig } from '../../src/tools/webSearch';
import { FakeNet, installPlatform, json } from '../mcp/fakes';

let net: FakeNet;
let mcp: McpManager;
let skills: SkillRepository;
let synced: SyncedPrefs;
let local: LocalPrefs;
let search: SearchConfig | null;

const settings = { get synced() { return synced; }, get local() { return local; } } as unknown as SettingsStore;

/** The app resolves a chat's computer (remote/computers.ts); here: this PC's bridge in the chat's folder. */
function registry(extra: { media?: MediaToolService; workspaceFor?: (id: string | null | undefined) => Promise<string> } = {}) {
  const { workspaceFor, ...rest } = extra;
  return new ToolRegistry({
    search: new WebSearch(),
    searchConfig: async () => search,
    mcp,
    skills,
    settings,
    ...rest,
    computerFor: async (id) => {
      const bridge = platform().computer;
      if (!bridge) return null;
      const folder = (await workspaceFor?.(id)) || local.defaultWorkspace || (await bridge.defaultWorkspace());
      return {
        local: true, hostId: 'me', name: 'DESK', folder, bridge,
        listFolders: async () => ({ path: null, parent: null, folders: [], places: [] }),
        agentSessions: async () => [],
        readAgentSession: async () => null,
      };
    },
  });
}

const params = (over: Partial<GenParams> = {}) => defaultParams({ tools: true, ...over });
const caps = (over: Partial<ModelCaps> = {}) => defaultCaps({ tools: true, ...over });

async function server(name: string, tools: object[], over: Partial<McpServerEntity> = {}): Promise<McpServerEntity> {
  const e = await mcp.add(name, `https://${name.toLowerCase().replace(/\W/g, '')}.test/mcp`, 'NONE', {});
  await db().mcpServers.update(e.id, { toolsJson: JSON.stringify(tools), toolsFetchedAt: 1, ...over });
  return (await mcp.get(e.id))!;
}

beforeEach(() => {
  setDb(new FacetDb('test-' + Math.random()));
  net = new FakeNet();
  installPlatform(net);
  mcp = new McpManager();
  skills = new SkillRepository();
  synced = defaultSynced();
  local = { ...DEFAULT_LOCAL };
  search = null;
});

describe('limits', () => {
  it('match Android', () => {
    expect([MAX_TOOL_ROUNDS, YOLO_TOOL_ROUNDS, MAX_RESULT_CHARS]).toEqual([12, 40, 30_000]);
    expect(ToolRegistry.MAX_TOOL_ROUNDS).toBe(12);
  });
});

describe('prepare', () => {
  it('offers Facet search only to models that need it and the page reader with tools', async () => {
    const r = registry();
    const names = async (p: GenParams, c: ModelCaps) => (await r.prepare(p, c)).defs.map((d) => d.spec.name);
    expect(await names(params({ webSearch: true }), caps())).toEqual(['fetch_page']); // no search key
    search = { kind: searchKind('search.tavily')!, apiKey: 'k', baseUrl: 'https://api.tavily.com' };
    expect(await names(params({ webSearch: true }), caps())).toEqual(['web_search', 'fetch_page']);
    expect(await names(params({ webSearch: true }), caps({ webSearch: true }))).toEqual(['fetch_page']);
    synced = { ...synced, preferNativeSearch: false };
    expect(await names(params({ webSearch: true }), caps({ webSearch: true }))).toEqual(['web_search', 'fetch_page']);
    expect(await names(params({ webSearch: true, tools: false }), caps())).toEqual(['web_search', 'fetch_page']);
    expect(await names(params({ webSearch: false, tools: false }), caps())).toEqual([]);
    expect(await names(params({ webSearch: true }), caps({ tools: false }))).toEqual([]);
  });

  it('lists on-demand skills, adds always-on ones to the prompt, and offers bundled files', async () => {
    await skills.save({ name: 'meeting-notes', description: 'Turn notes into minutes.', instructions: 'Use sections.' });
    await skills.save({ name: 'house-style', description: 'Style', instructions: 'Write plainly.', alwaysOn: true });
    const off = await skills.save({ name: 'disabled-one', description: 'x', instructions: 'y' });
    await skills.setEnabled(off.id, false);
    let p = await registry().prepare(params(), caps());
    const use = p.byName.get('use_skill')!;
    expect(use.kind).toBe('SKILL');
    expect(use.spec.description).toContain('Available skills:\n- meeting-notes: Turn notes into minutes.');
    expect(use.spec.description).not.toContain('disabled-one');
    expect(p.byName.has('read_skill_file')).toBe(false);
    expect(p.systemAddendum).toBe('## Skill: house-style\nWrite plainly.');
    await skills.save({ name: 'with-files', description: 'd', instructions: 'i', resources: [{ path: 'ref.md', content: 'R' }] });
    p = await registry().prepare(params(), caps());
    expect(p.byName.has('read_skill_file')).toBe(true);
    expect((await registry().prepare(params({ tools: false }), caps())).systemAddendum).toBeNull();
  });

  it('names MCP tools uniquely and applies approval rules', async () => {
    const tools = [
      { name: 'search', description: '  Find things  ', readOnlyHint: true, inputSchemaJson: '{"type":"object"}' },
      { name: 'Delete Item', title: 'Delete', inputSchemaJson: ' ' },
      { name: 'delete-item!', inputSchemaJson: '{}' },
      { name: 'hidden', inputSchemaJson: '{}' },
      { name: 'trusted', inputSchemaJson: '{}' },
    ];
    const a = await server('My Big Workspace Server', tools, { instructions: 'Prefer search.', disabledToolsJson: '["hidden"]', autoApprovedJson: '["trusted"]' });
    const b = await server('Other', [{ name: 'search', inputSchemaJson: '{}' }]);
    let p = await registry().prepare(params(), caps());
    const mcpDefs = p.defs.filter((d) => d.kind === 'MCP');
    expect(mcpDefs.map((d) => d.spec.name)).toEqual([
      'mcp_my_big_workspa_search',
      'mcp_my_big_workspa_delete_item',
      'mcp_my_big_workspa_delete-item',
      'mcp_my_big_workspa_trusted',
      'mcp_other_search',
    ]);
    const [s, del, del2, trusted] = mcpDefs;
    expect(s).toMatchObject({ serverId: a.id, serverName: 'My Big Workspace Server', remoteName: 'search', needsApproval: false });
    expect(s.spec.description).toBe('[My Big Workspace Server] Find things');
    expect(del.spec.description).toBe('[My Big Workspace Server] Delete');
    expect(del.spec.inputSchemaJson).toBe('{"type":"object","properties":{}}');
    expect(del.needsApproval).toBe(true); // WRITES and not read-only
    expect(del2.remoteName).toBe('delete-item!');
    expect(trusted.needsApproval).toBe(false);
    expect(p.systemAddendum).toBe('## Tools from My Big Workspace Server\nPrefer search.');

    await mcp.setApproval(a.id, 'ALWAYS');
    p = await registry().prepare(params(), caps());
    expect(p.byName.get('mcp_my_big_workspa_search')!.needsApproval).toBe(true);
    expect(p.byName.get('mcp_my_big_workspa_trusted')!.needsApproval).toBe(false);
    await mcp.setApproval(a.id, 'NEVER');
    p = await registry().prepare(params(), caps());
    expect(p.byName.get('mcp_my_big_workspa_delete_item')!.needsApproval).toBe(false);

    p = await registry().prepare(params({ disabledMcpServers: [b.id] }), caps());
    expect(p.byName.has('mcp_other_search')).toBe(false);
    await mcp.setEnabled(a.id, false);
    p = await registry().prepare(params(), caps());
    expect(p.defs.some((d) => d.serverId === a.id)).toBe(false);
  });

  it('skips local servers when this app cannot run them', async () => {
    await server('Local', [{ name: 'x', inputSchemaJson: '{}' }], { stdio: { command: 'npx', args: [] } });
    expect((await registry().prepare(params(), caps())).defs.some((d) => d.kind === 'MCP')).toBe(false);
  });

  it('offers media tools for configured media models', async () => {
    const media: MediaToolService = {
      resolve: async (o) => (o === 'IMAGE' ? { model: { displayName: 'Imagen $1' } } : o === 'VIDEO' ? { model: { displayName: 'Veo' } } : null),
      create: async () => {
        throw new Error('unused');
      },
    };
    let p = await registry({ media }).prepare(params(), caps());
    expect(p.defs.filter((d) => d.kind === 'MEDIA').map((d) => [d.spec.name, d.needsApproval, d.output])).toEqual([
      ['generate_image', false, 'IMAGE'],
      ['generate_video', true, 'VIDEO'],
    ]);
    expect(p.byName.get('generate_image')!.spec.description).toContain('Create an image with Imagen $1 and show it');
    synced = { ...synced, media: { ...synced.media, chatTools: false } };
    p = await registry({ media }).prepare(params(), caps());
    expect(p.defs.some((d) => d.kind === 'MEDIA')).toBe(false);
  });
});

describe('computer tools', () => {
  let calls: { name: string; args: string; ctx: { cwd: string; callId: string } }[];
  let cancels: string[];
  let release: (() => void) | null;

  function computer(over: Partial<ComputerBridge> = {}): ComputerBridge {
    return {
      info: async () => ({ os: 'Windows 11', shell: 'PowerShell 7.4', home: 'C:\\Users\\me', user: 'me', hostname: 'DESK' }),
      tools: async () => [
        { name: 'run_command', description: 'Run a command', inputSchemaJson: '{"type":"object","properties":{"command":{"type":"string"}}}', readOnly: false },
        { name: 'read_file', description: 'Read a file', inputSchemaJson: '{"type":"object"}', readOnly: true },
        { name: 'fetch_page', description: 'Clashes with Facet', inputSchemaJson: '', readOnly: true },
      ],
      call: async (name, args, ctx) => {
        calls.push({ name, args, ctx });
        return { content: 'ok', isError: false, label: 'Ran npm test' };
      },
      cancel: async (id) => {
        cancels.push(id);
        release?.();
      },
      defaultWorkspace: async () => 'C:\\Users\\me\\Facet',
      pickFolder: async () => null,
      open: async () => {},
      ...over,
    };
  }

  beforeEach(() => {
    calls = [];
    cancels = [];
    release = null;
  });

  it('offers one tool per bridge tool with approvals from Settings and a system note', async () => {
    installPlatform(net, { computer: computer() });
    const workspaceFor = vi.fn(async (id: string | null | undefined) => (id === 'c1' ? 'D:\\projects\\site' : ''));
    let p = await registry({ workspaceFor }).prepare(params(), caps(), 'c1');
    const defs = p.defs.filter((d) => d.kind === 'COMPUTER');
    expect(defs.map((d) => [d.spec.name, d.remoteName, d.serverName, d.needsApproval])).toEqual([
      ['run_command', 'run_command', 'Computer', true],
      ['read_file', 'read_file', 'Computer', false],
      ['computer_fetch_page', 'fetch_page', 'Computer', false],
    ]);
    expect(defs[2].spec.inputSchemaJson).toBe('{"type":"object","properties":{}}');
    expect(workspaceFor).toHaveBeenCalledWith('c1');
    expect(p.systemAddendum).toContain("You can use the user's computer (Windows 11, DESK) through the computer tools");
    expect(p.systemAddendum).toContain('Commands run in PowerShell 7.4.');
    expect(p.systemAddendum).toContain('The working folder for this chat is D:\\projects\\site;');

    local = { ...local, computerApproval: 'ALWAYS' };
    p = await registry({ workspaceFor }).prepare(params(), caps(), 'c1');
    expect(p.defs.filter((d) => d.kind === 'COMPUTER').every((d) => d.needsApproval)).toBe(true);
    local = { ...local, computerApproval: 'NEVER' };
    p = await registry({ workspaceFor }).prepare(params(), caps(), 'other');
    expect(p.defs.filter((d) => d.kind === 'COMPUTER').some((d) => d.needsApproval)).toBe(false);
    expect(p.systemAddendum).toContain('The working folder for this chat is C:\\Users\\me\\Facet;'); // fell back to the bridge default
  });

  it('is off without the bridge, the setting, chat tools or model support', async () => {
    const count = async () => (await registry().prepare(params(), caps())).defs.filter((d) => d.kind === 'COMPUTER').length;
    expect(await count()).toBe(0);
    installPlatform(net, { computer: computer() });
    expect(await count()).toBe(3);
    local = { ...local, computerTools: false };
    expect(await count()).toBe(0);
    local = { ...local, computerTools: true };
    expect((await registry().prepare(params({ tools: false }), caps())).defs).toEqual([]);
    expect((await registry().prepare(params(), caps({ tools: false }))).defs).toEqual([]);
    installPlatform(net, { computer: computer({ tools: async () => Promise.reject(new Error('bridge down')) }) });
    expect(await count()).toBe(0);
  });

  it('runs a tool in the chat folder with the call id and takes the label from the bridge', async () => {
    installPlatform(net, { computer: computer() });
    local = { ...local, defaultWorkspace: 'E:\\work' };
    const r = registry();
    const p = await r.prepare(params(), caps(), 'c1');
    const out = await r.execute(p.byName.get('run_command')!, '{"command":"npm test"}', { conversationId: 'c1', callId: 'call-7' });
    expect(out).toEqual({ content: 'ok', isError: false, label: 'Ran npm test' });
    expect(calls).toEqual([{ name: 'run_command', args: '{"command":"npm test"}', ctx: { cwd: 'E:\\work', callId: 'call-7' } }]);
    await r.execute(p.byName.get('computer_fetch_page')!, '', { conversationId: 'c1' });
    expect(calls[1].name).toBe('fetch_page');
    expect(calls[1].args).toBe('{}');
    expect(calls[1].ctx.callId).toHaveLength(22); // a fresh id when the engine gives none
  });

  it('cancels the running command when the reply is stopped', async () => {
    installPlatform(net, {
      computer: computer({
        call: (name, args, ctx) =>
          new Promise((resolve) => {
            calls.push({ name, args, ctx });
            release = () => resolve({ content: 'Stopped.', isError: true });
          }),
      }),
    });
    const r = registry();
    const def = (await r.prepare(params(), caps())).byName.get('run_command')!;
    const ctrl = new AbortController();
    const running = r.execute(def, '{"command":"sleep 100"}', { callId: 'call-9', signal: ctrl.signal });
    await new Promise((res) => setTimeout(res, 5));
    ctrl.abort();
    expect(await running).toMatchObject({ content: 'Stopped.', isError: true, label: 'Computer: run_command' });
    expect(cancels).toEqual(['call-9']);
  });
});

describe('execute', () => {
  it('rejects arguments that are not a JSON object', async () => {
    const def = (await registry().prepare(params(), caps())).byName.get('fetch_page')!;
    expect(await registry().execute(def, '[1]')).toEqual({ content: 'The tool arguments were not valid JSON. Send a JSON object matching the schema.', isError: true });
  });

  it('searches and cites results', async () => {
    search = { kind: searchKind('search.tavily')!, apiKey: 'k', baseUrl: 'https://api.tavily.com' };
    net.handler = () => json({ results: [{ title: 'Rent in Porto', url: 'https://p.example', content: 'Prices rose.' }] });
    const r = registry();
    const def = (await r.prepare(params({ webSearch: true }), caps())).byName.get('web_search')!;
    const out = await r.execute(def, '{"query":" rent prices in Porto ","max_results":"3"}');
    expect(out.label).toBe('Searched “rent prices in Porto”');
    expect(out.content).toContain('[1] Rent in Porto');
    expect(out.citations).toEqual([{ url: 'https://p.example', title: 'Rent in Porto', snippet: 'Prices rose.' }]);
    expect(JSON.parse(net.requests[0].body).max_results).toBe(3);
    search = null;
    expect(await r.execute(def, '{"query":"x"}')).toEqual({ content: "Web search isn't set up.", isError: true });
  });

  it('reads pages, noting the Jina Reader fallback on the website', async () => {
    net.handler = () => new Response('<html><title>Page</title><body><p>Words</p></body></html>', { headers: { 'Content-Type': 'text/html' } });
    const r = registry();
    const def = (await r.prepare(params(), caps())).byName.get('fetch_page')!;
    expect(await r.execute(def, '{"url":"https://www.site.example/a"}')).toEqual({
      content: '# Page\nhttps://www.site.example/a\n\nWords',
      citations: [{ url: 'https://www.site.example/a', title: 'Page' }],
      label: 'Read site.example',
    });

    installPlatform(net, { corsLimited: true, kind: 'web' });
    search = { kind: searchKind('search.jina')!, apiKey: 'jina-key', baseUrl: 'https://s.jina.ai' };
    net.handler = (req) => {
      if (req.url.startsWith('https://r.jina.ai/')) return json({ data: { title: '', content: '' } });
      throw new TypeError('Failed to fetch');
    };
    const out = await r.execute(def, '{"url":"https://news.example/x"}');
    expect(out.content).toBe(`${READER_NOTE}\nhttps://news.example/x\n\n(The page had no readable text.)`);
    expect(out.citations).toEqual([{ url: 'https://news.example/x', title: 'news.example' }]);
    expect(net.requests.find((q) => q.url.startsWith('https://r.jina.ai/'))!.headers.get('Authorization')).toBe('Bearer jina-key');
  });

  it('loads skills and their files', async () => {
    await skills.save({ name: 'pdf-tools', description: 'd', instructions: 'Read carefully.', resources: [{ path: 'docs/ref.md', content: 'Reference' }] });
    const r = registry();
    const p = await r.prepare(params(), caps());
    expect(await r.execute(p.byName.get('use_skill')!, '{"name":"PDF-Tools"}')).toEqual({
      content: '# Skill: pdf-tools\n\nRead carefully.\n\nBundled files (read with read_skill_file):\n- docs/ref.md\n',
      label: 'Used skill pdf-tools',
    });
    expect(await r.execute(p.byName.get('read_skill_file')!, '{"skill":"pdf-tools","path":"/docs/ref.md"}')).toEqual({ content: 'Reference', label: 'Read docs/ref.md from pdf-tools' });
    expect(await r.execute(p.byName.get('read_skill_file')!, '{"skill":"pdf-tools","path":"nope.md"}')).toEqual({ content: 'The skill pdf-tools has no file "nope.md".', isError: true });
    expect(await r.execute(p.byName.get('use_skill')!, '{"name":"missing"}')).toEqual({ content: 'No enabled skill named "missing".', isError: true });
  });

  it('calls MCP tools with normalized arguments and the abort signal', async () => {
    const s = await server('Docs', [{ name: 'lookup', inputSchemaJson: '{}' }]);
    const call = vi.spyOn(mcp, 'call').mockResolvedValue({ text: '', isError: false, images: [{ mimeType: 'image/png', bytes: new Uint8Array(1) }] });
    const r = registry();
    const def = (await r.prepare(params(), caps())).byName.get('mcp_docs_lookup')!;
    const signal = new AbortController().signal;
    const out = await r.execute(def, ' { "q" : 1 } ', { signal });
    expect(call).toHaveBeenCalledWith(s.id, 'lookup', '{"q":1}', signal);
    expect(out).toEqual({ content: "(No output.)\n\n[The tool also returned 1 image(s), which aren't shown to the model.]", isError: false, label: 'Docs: lookup' });
    call.mockResolvedValue({ text: ' ', isError: true, images: [] });
    expect((await r.execute(def, '{}')).content).toBe('The tool failed without a message.');
  });

  it('creates media in the chat', async () => {
    const att: AttachmentEntity = {
      id: 'a1', conversationId: 'c1', kind: 'image', mimeType: 'image/png', name: 'image.png', sizeBytes: 10, width: 1024, height: 768,
      hasFile: 1, uploaded: false, localOnly: false, createdAt: 1, updatedAt: 1, deleted: 0, dirty: 1,
    };
    const create = vi.fn(async () => ({ attachment: att, model: { displayName: 'Imagen' } }));
    const media: MediaToolService = { resolve: async (o) => (o === 'IMAGE' ? { model: { displayName: 'Imagen' } } : null), create };
    const r = registry({ media });
    const def = (await r.prepare(params(), caps())).byName.get('generate_image')!;
    const progress = vi.fn();
    const out = await r.execute(def, '{"prompt":"a red tram","aspect_ratio":"Landscape"}', { conversationId: 'c1', onProgress: progress });
    expect(create).toHaveBeenCalledWith('IMAGE', 'a red tram', 'c1', 'LANDSCAPE', null, progress);
    expect(out.label).toBe('Created image with Imagen');
    expect(out.content).toBe(
      "Created the image with Imagen (image/png, 1024×768). It is already shown to the user below your message; don't link or describe a file path. Briefly say what you made, and offer changes.",
    );
    expect(out.attachments).toEqual([{ id: 'a1', kind: 'image', mimeType: 'image/png', name: 'image.png', sizeBytes: 10, width: 1024, height: 768 }]);
    expect(await r.execute(def, '{"prompt":"x"}')).toEqual({ content: 'Media can only be created in a chat.', isError: true });
    expect(await r.execute(def, '{"prompt":" "}', { conversationId: 'c1' })).toEqual({ content: 'Describe what to create in "prompt".', isError: true });
  });
});
