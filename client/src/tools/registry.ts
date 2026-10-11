/**
 * Decides which client tools a model gets for a reply and runs them (port of ToolRegistry.kt):
 * Facet web search + page reader (for models without built-in search), skills, MCP tools, media
 * generation, and in the Windows app the user's computer (commands and files).
 */
import { newId } from '../core/ids';
import { isObject } from '../core/json';
import { t } from '../i18n';
import { attachmentRef, type AttachmentEntity } from '../data/entities';
import type { Aspect, SettingsStore } from '../data/prefs';
import type { GenParams, ModelCaps, ModelOutput } from '../llm/types';
import { platform, type ComputerInfo } from '../platform';
import type { ChatComputer } from '../remote/computers';
import { createdWithLabel, fetchLabel, localizeComputerLabel, searchLabel, skillLabel } from './labels';
import type { McpManager } from './mcpManager';
import type { SkillRepository } from './skills';
import type { ToolContext, ToolDef, ToolOutcome } from './types';
import type { SearchConfig, WebSearch } from './webSearch';

/** The tools prepared for one reply, plus any extra system instructions they bring. */
export interface PreparedTools {
  defs: ToolDef[];
  systemAddendum: string | null;
  byName: Map<string, ToolDef>;
}

export function preparedTools(defs: ToolDef[] = [], systemAddendum: string | null = null): PreparedTools {
  return { defs, systemAddendum, byName: new Map(defs.map((d) => [d.spec.name, d])) };
}

/** Makes images, video, speech and music for chat tools (implemented by the media service). */
export interface MediaToolService {
  /** The media model to use for [output], or null when none is configured. */
  resolve(output: ModelOutput): Promise<{ model: { displayName: string } } | null>;
  create(
    output: ModelOutput,
    prompt: string,
    conversationId: string,
    aspect: Aspect | null,
    seconds: number | null,
    onProgress: (label: string) => void,
  ): Promise<{ attachment: AttachmentEntity; model: { displayName: string } }>;
}

export interface ToolRegistryDeps {
  search: WebSearch;
  /** The configured bring-your-own-key search backend, if any. */
  searchConfig: () => Promise<SearchConfig | null>;
  mcp: McpManager;
  skills: SkillRepository;
  settings: SettingsStore;
  media?: MediaToolService;
  /** The computer a chat's tools run on (this PC, or a PC reached through the relay), if any. */
  computerFor?: (conversationId: string | null | undefined) => Promise<ChatComputer | null>;
}

export const WEB_SEARCH = 'web_search';
export const FETCH_PAGE = 'fetch_page';
export const USE_SKILL = 'use_skill';
export const READ_SKILL_FILE = 'read_skill_file';
/** Tool rounds per reply before Facet stops the model; YOLO mode allows longer runs. */
export const MAX_TOOL_ROUNDS = 12;
export const YOLO_TOOL_ROUNDS = 40;
export const EMPTY_SCHEMA = '{"type":"object","properties":{}}';
/** Cap on tool output kept in history (sent to the model and stored identically). */
export const MAX_RESULT_CHARS = 30_000;
/** The server name computer tools show with (ToolDef.serverName, ToolCallRecord.serverName). */
export const COMPUTER_SERVER_NAME = 'Computer';

const WEB_SEARCH_DESC =
  'Search the web for current information. Use for recent events, facts you aren\'t sure about, prices, or anything that may have changed. Returns numbered results with URLs and snippets.';
const WEB_SEARCH_SCHEMA =
  '{"type":"object","properties":{"query":{"type":"string","description":"A focused search query"},"max_results":{"type":"integer","minimum":1,"maximum":10}},"required":["query"],"additionalProperties":false}';
const FETCH_PAGE_DESC = 'Read the text of a web page by URL, e.g. a search result or a link the user shared.';
const FETCH_PAGE_SCHEMA =
  '{"type":"object","properties":{"url":{"type":"string","description":"An http(s) URL"}},"required":["url"],"additionalProperties":false}';
const USE_SKILL_SCHEMA =
  '{"type":"object","properties":{"name":{"type":"string","description":"Skill name from the list"}},"required":["name"],"additionalProperties":false}';
const READ_SKILL_FILE_SCHEMA =
  '{"type":"object","properties":{"skill":{"type":"string"},"path":{"type":"string"}},"required":["skill","path"],"additionalProperties":false}';
/** First line of a page read through Jina Reader on the website. */
export const READER_NOTE = '(Read through Jina Reader, because this website doesn\'t let browsers load it directly.)';

interface MediaToolSpec {
  name: string;
  noun: string;
  description: string;
  schema: string;
}

const MEDIA_TOOLS: Partial<Record<ModelOutput, MediaToolSpec>> = {
  IMAGE: {
    name: 'generate_image',
    noun: 'image',
    description:
      'Create an image with {model} and show it to the user. Use for any request to draw, paint, design, illustrate or ' +
      'picture something (photos, art, logos, diagrams). Write a rich, specific visual prompt in English; include style, ' +
      'subject, composition, lighting and any text to render.',
    schema:
      '{"type":"object","properties":{"prompt":{"type":"string","description":"Detailed description of the image"},"aspect_ratio":{"type":"string","enum":["square","portrait","landscape"]}},"required":["prompt"],"additionalProperties":false}',
  },
  VIDEO: {
    name: 'generate_video',
    noun: 'video',
    description:
      'Create a short video clip (a few seconds, with sound when the model supports it) with {model} and show it to the user. ' +
      'It takes a minute or more. Describe the scene, motion, camera and audio.',
    schema:
      '{"type":"object","properties":{"prompt":{"type":"string","description":"Scene, action, camera movement and sound"},"aspect_ratio":{"type":"string","enum":["landscape","portrait"]}},"required":["prompt"],"additionalProperties":false}',
  },
  SPEECH: {
    name: 'generate_speech',
    noun: 'audio clip',
    description:
      'Turn text into natural spoken audio with {model} and give the user the clip. Use when they ask to hear something, ' +
      'want a voiceover, or want audio of a text.',
    schema:
      '{"type":"object","properties":{"text":{"type":"string","description":"Exactly what to say"}},"required":["text"],"additionalProperties":false}',
  },
  MUSIC: {
    name: 'generate_music',
    noun: 'track',
    description:
      'Compose music or a sound effect with {model} and give the user the audio. Describe genre, mood, instruments, ' +
      'tempo and structure (or the sound, for effects).',
    schema:
      '{"type":"object","properties":{"prompt":{"type":"string","description":"Genre, mood, instruments, tempo; or the sound to make"},"seconds":{"type":"integer","minimum":3,"maximum":300}},"required":["prompt"],"additionalProperties":false}',
  },
};
const MEDIA_ORDER: ModelOutput[] = ['IMAGE', 'VIDEO', 'SPEECH', 'MUSIC'];

/** A tool-name-safe slug: lowercase letters, digits, _ and -. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function intOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) return parseInt(v, 10);
  return null;
}

function computerAddendum(info: ComputerInfo | null, cwd: string): string {
  const where = info ? ` (${info.os}${info.hostname ? `, ${info.hostname}` : ''})` : '';
  const shell = info?.shell ? ` Commands run in ${info.shell}.` : '';
  const home = info?.home ? ` The user's home folder is ${info.home}.` : '';
  return (
    `## Computer\nYou can use the user's computer${where} through the computer tools: run commands and read, search and edit files.${shell} ` +
    `The working folder for this chat is ${cwd}; relative paths resolve there.${home} ` +
    'Stay inside the working folder unless the user asks for something else. Look before you change things, keep changes focused, and tell the user what you changed.'
  );
}

export class ToolRegistry {
  static readonly WEB_SEARCH = WEB_SEARCH;
  static readonly FETCH_PAGE = FETCH_PAGE;
  static readonly USE_SKILL = USE_SKILL;
  static readonly READ_SKILL_FILE = READ_SKILL_FILE;
  static readonly MAX_TOOL_ROUNDS = MAX_TOOL_ROUNDS;
  static readonly YOLO_TOOL_ROUNDS = YOLO_TOOL_ROUNDS;
  static readonly EMPTY_SCHEMA = EMPTY_SCHEMA;
  static readonly MAX_RESULT_CHARS = MAX_RESULT_CHARS;

  constructor(private readonly deps: ToolRegistryDeps) {}

  /** The configured BYOK search backend, if any. */
  searchConfig(): Promise<SearchConfig | null> {
    return this.deps.searchConfig();
  }

  /** True when this model will search with Facet's tool rather than its own. */
  async usesFacetSearch(params: GenParams, caps: ModelCaps): Promise<boolean> {
    return params.webSearch && caps.tools && (!caps.webSearch || !this.deps.settings.synced.preferNativeSearch) && (await this.searchConfig()) != null;
  }

  /** The tools for one reply. [conversationId] picks the working folder for computer tools. */
  async prepare(params: GenParams, caps: ModelCaps, conversationId?: string | null): Promise<PreparedTools> {
    const { mcp, skills, settings, media } = this.deps;
    const defs: ToolDef[] = [];
    const addendum: string[] = [];

    const facetSearch = caps.tools && (await this.usesFacetSearch(params, caps));
    if (facetSearch) defs.push(this.def(WEB_SEARCH, WEB_SEARCH_DESC, WEB_SEARCH_SCHEMA, 'SEARCH'));
    // Reading a link needs no search key: offer it with search, or whenever tools are on.
    if (caps.tools && (facetSearch || params.tools)) defs.push(this.def(FETCH_PAGE, FETCH_PAGE_DESC, FETCH_PAGE_SCHEMA, 'FETCH'));

    if (params.tools) {
      const enabledSkills = (await skills.all()).filter((s) => s.enabled);
      for (const s of enabledSkills.filter((s) => s.alwaysOn)) addendum.push(`## Skill: ${s.name}\n${s.instructions}`);
      const onDemand = enabledSkills.filter((s) => !s.alwaysOn);
      if (caps.tools && onDemand.length > 0) {
        const index = onDemand.map((s) => `- ${s.name}: ${s.description}`).join('\n');
        defs.push(this.def(
          USE_SKILL,
          `Load the full instructions of a skill before doing a task it covers. Load a skill whenever its description matches the request, then follow its instructions.\n\nAvailable skills:\n${index}`,
          USE_SKILL_SCHEMA,
          'SKILL',
        ));
        if (onDemand.some((s) => skills.resources(s).length > 0)) {
          defs.push(this.def(READ_SKILL_FILE, "Read a reference file bundled with a skill, by the path listed in that skill's instructions.", READ_SKILL_FILE_SCHEMA, 'SKILL'));
        }
      }

      if (caps.tools) {
        const used = new Set(defs.map((d) => d.spec.name));
        const canStdio = platform().stdio != null;
        for (const server of await mcp.all()) {
          if (!server.enabled || params.disabledMcpServers.includes(server.id) || (server.stdio && !canStdio)) continue;
          const disabled = mcp.disabledTools(server);
          const auto = mcp.autoApproved(server);
          const approval = mcp.approval(server);
          const prefix = 'mcp_' + slug(server.name).slice(0, 14);
          for (const tool of mcp.tools(server)) {
            if (disabled.has(tool.name)) continue;
            let name = (prefix + '_' + slug(tool.name)).slice(0, 64);
            let n = 2;
            while (used.has(name)) name = (prefix + '_' + slug(tool.name)).slice(0, 60) + '_' + n++;
            used.add(name);
            // YOLO is checked when the tool runs, so turning it off mid-reply takes effect.
            const needsApproval = !auto.has(tool.name) && (approval === 'ALWAYS' || (approval === 'WRITES' && tool.readOnlyHint !== true));
            const desc = (`[${server.name}] ` + ((tool.description?.trim() || null) ?? tool.title ?? tool.name)).slice(0, 1024);
            defs.push({
              spec: { name, description: desc, inputSchemaJson: tool.inputSchemaJson.trim() ? tool.inputSchemaJson : EMPTY_SCHEMA },
              kind: 'MCP',
              serverId: server.id,
              serverName: server.name,
              remoteName: tool.name,
              needsApproval,
            });
          }
          if (server.instructions?.trim()) addendum.push(`## Tools from ${server.name}\n${server.instructions.slice(0, 2000)}`);
        }
        await this.addComputerTools(defs, addendum, conversationId);
      }
    }

    if (params.tools && caps.tools && media && settings.synced.media.chatTools) {
      for (const output of MEDIA_ORDER) {
        const choice = await media.resolve(output).catch(() => null);
        if (choice) defs.push(this.mediaTool(output, choice.model.displayName));
      }
    }

    return preparedTools(defs, addendum.length > 0 ? addendum.join('\n\n') : null);
  }

  /** One tool per computer tool the chat's PC offers (docs/REMOTE.md), with approvals from Settings. */
  private async addComputerTools(defs: ToolDef[], addendum: string[], conversationId: string | null | undefined): Promise<void> {
    const local = this.deps.settings.local;
    if (!local.computerTools) return;
    const target = await this.computer(conversationId);
    if (!target) return;
    let tools;
    let info: ComputerInfo | null;
    try {
      [tools, info] = await Promise.all([target.bridge.tools(), target.bridge.info().catch(() => null)]);
    } catch {
      return; // The PC isn't answering: offer no computer tools rather than fail the reply.
    }
    const cwd = target.folder;
    if (tools.length === 0) return;
    const used = new Set(defs.map((d) => d.spec.name));
    for (const tool of tools) {
      let name = tool.name.slice(0, 64);
      if (used.has(name)) {
        const base = ('computer_' + slug(tool.name)).slice(0, 60);
        name = base;
        let n = 2;
        while (used.has(name)) name = base + '_' + n++;
      }
      used.add(name);
      // YOLO is checked when the tool runs, as for MCP.
      const needsApproval = local.computerApproval === 'ALWAYS' || (local.computerApproval === 'WRITES' && !tool.readOnly);
      defs.push({
        spec: { name, description: tool.description, inputSchemaJson: tool.inputSchemaJson.trim() ? tool.inputSchemaJson : EMPTY_SCHEMA },
        kind: 'COMPUTER',
        serverId: null,
        serverName: COMPUTER_SERVER_NAME,
        remoteName: tool.name,
        needsApproval,
      });
    }
    addendum.push(computerAddendum(info, cwd));
  }

  /** The chat's computer and folder, if it has one right now. */
  private async computer(conversationId: string | null | undefined): Promise<ChatComputer | null> {
    try {
      return (await this.deps.computerFor?.(conversationId)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Runs a tool. Failures the tool can describe come back as isError outcomes; unexpected ones
   * throw, and the chat engine turns them into error results (as on Android).
   */
  async execute(def: ToolDef, argumentsJson: string, ctx: ToolContext = {}): Promise<ToolOutcome> {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(argumentsJson.trim() ? argumentsJson : '{}');
      if (!isObject(parsed)) throw new TypeError('not an object');
      args = parsed;
    } catch {
      return { content: 'The tool arguments were not valid JSON. Send a JSON object matching the schema.', isError: true };
    }
    const str = (k: string): string => {
      const v = args[k];
      return typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
    };
    const { search, skills, mcp, media } = this.deps;

    switch (def.kind) {
      case 'SEARCH': {
        const q = str('query');
        const config = await this.searchConfig();
        if (!config) return { content: "Web search isn't set up.", isError: true };
        const results = await search.search(config, q, intOrNull(args.max_results) ?? 6, ctx.signal);
        return { content: search.formatResults(q, results), citations: search.citations(results), label: searchLabel(q.slice(0, 60), true) };
      }
      case 'FETCH': {
        const url = str('url');
        const jinaKey = platform().corsLimited ? await this.jinaKey() : null;
        const page = await search.fetchPage(url, { jinaKey, signal: ctx.signal });
        const host = hostOf(url) ?? url;
        let content = page.viaReader ? READER_NOTE + '\n' : '';
        if (page.title.trim()) content += `# ${page.title}\n`;
        content += `${url}\n\n${page.text.trim() ? page.text : '(The page had no readable text.)'}`;
        return { content, citations: [{ url, title: page.title.trim() ? page.title : host }], label: fetchLabel(host, true) };
      }
      case 'SKILL': {
        if (def.spec.name === USE_SKILL) {
          const name = str('name');
          const s = (await skills.all()).find((x) => x.enabled && x.name.toLowerCase() === name.toLowerCase());
          if (!s) return { content: `No enabled skill named "${name}".`, isError: true };
          const files = skills.resources(s);
          let content = `# Skill: ${s.name}\n\n${s.instructions}`;
          if (files.length > 0) {
            content += '\n\nBundled files (read with read_skill_file):\n';
            for (const f of files) content += `- ${f.path}\n`;
          }
          return { content, label: skillLabel(s.name, '', true) };
        }
        const s = (await skills.all()).find((x) => x.enabled && x.name.toLowerCase() === str('skill').toLowerCase());
        if (!s) return { content: `No enabled skill named "${str('skill')}".`, isError: true };
        const path = str('path').replace(/^\/+/, '');
        const f = skills.resources(s).find((r) => r.path === path);
        if (!f) return { content: `The skill ${s.name} has no file "${str('path')}".`, isError: true };
        return { content: f.content, label: t('Read {path} from {skill}', { path: f.path, skill: s.name }) };
      }
      case 'MEDIA': {
        const output = def.output;
        const spec = output ? MEDIA_TOOLS[output] : undefined;
        if (!output || !spec) return { content: 'Unknown media tool.', isError: true };
        if (!media) return { content: "Media models aren't available.", isError: true };
        const convId = ctx.conversationId;
        if (!convId) return { content: 'Media can only be created in a chat.', isError: true };
        const prompt = str(output === 'SPEECH' ? 'text' : 'prompt');
        if (!prompt) return { content: 'Describe what to create in "prompt".', isError: true };
        const ratio = str('aspect_ratio').toLowerCase();
        const aspect: Aspect | null = ratio === 'portrait' ? 'PORTRAIT' : ratio === 'landscape' ? 'LANDSCAPE' : ratio === 'square' ? 'SQUARE' : null;
        const { attachment: att, model } = await media.create(output, prompt, convId, aspect, intOrNull(args.seconds), ctx.onProgress ?? (() => {}));
        const size = att.width != null && att.height != null ? `, ${att.width}×${att.height}` : '';
        return {
          content:
            `Created the ${spec.noun} with ${model.displayName} (${att.mimeType}${size}). It is already shown to the user ` +
            "below your message; don't link or describe a file path. Briefly say what you made, and offer changes.",
          label: createdWithLabel(output, model.displayName),
          attachments: [attachmentRef(att)],
        };
      }
      case 'MCP': {
        const r = await mcp.call(def.serverId!, def.remoteName!, JSON.stringify(args), ctx.signal);
        let text = r.text.trim() ? r.text : r.isError ? 'The tool failed without a message.' : '(No output.)';
        if (r.images.length > 0) text += `\n\n[The tool also returned ${r.images.length} image(s), which aren't shown to the model.]`;
        return { content: text, isError: r.isError, label: `${def.serverName}: ${def.remoteName}` };
      }
      case 'COMPUTER':
        return this.runComputerTool(def, JSON.stringify(args), ctx);
    }
  }

  private async runComputerTool(def: ToolDef, argumentsJson: string, ctx: ToolContext): Promise<ToolOutcome> {
    const target = await this.computer(ctx.conversationId);
    if (!target) return { content: 'The computer for this chat isn’t available right now (the PC may be offline).', isError: true };
    const computer = target.bridge;
    const remote = def.remoteName ?? def.spec.name;
    const cwd = target.folder;
    const callId = ctx.callId ?? newId();
    const onAbort = () => {
      computer.cancel(callId).catch(() => {});
    };
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await computer.call(remote, argumentsJson, { cwd, callId });
      return { content: r.content, isError: r.isError, label: r.label ? localizeComputerLabel(r.label) : `${COMPUTER_SERVER_NAME}: ${remote}` };
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** The user's Jina key (when Jina is their search service), for the website's page-reading fallback. */
  private async jinaKey(): Promise<string | null> {
    try {
      const config = await this.searchConfig();
      return config?.kind.id === 'search.jina' && config.apiKey ? config.apiKey : null;
    } catch {
      return null;
    }
  }

  private def(name: string, description: string, inputSchemaJson: string, kind: ToolDef['kind']): ToolDef {
    return { spec: { name, description, inputSchemaJson }, kind, needsApproval: false };
  }

  private mediaTool(output: ModelOutput, modelName: string): ToolDef {
    const tool = MEDIA_TOOLS[output]!;
    // Video clips can cost a few dollars each, so they ask first (unless YOLO is on).
    return {
      spec: { name: tool.name, description: tool.description.replace('{model}', () => modelName), inputSchemaJson: tool.schema },
      kind: 'MEDIA',
      needsApproval: output === 'VIDEO',
      output,
    };
  }
}
