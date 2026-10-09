/** Anthropic Messages API adapter (raw HTTP, streaming). Port of AnthropicClient.kt. */
import { b64, fromUtf8 } from '../core/bytes';
import { isObject } from '../core/json';
import { claudeCaps, claudeCapsFromApi, displayName, normalizeId, parseClaude, type ThinkingOff } from './catalog';
import {
  extractMessage,
  fromHttp,
  fromNetwork,
  fromStream,
  HttpStatusError,
  TransportError,
  truncatedStream,
  unexpected,
} from './errors';
import {
  arr,
  bool,
  type ClientOptions,
  CitationCollector,
  headersOf,
  isAbortError,
  isBlank,
  type JsonObject,
  long,
  type PriceLookup,
  obj,
  tryParseJson,
  parseObject,
  readText,
  resolveFetch,
  send,
  sseEvents,
  str,
  supported,
  timeoutSignal,
  ToolWire,
} from './internal';
import { normalizeBaseUrl } from './providers';
import { applyHeal, diagnose, type HealAction, maxTokensCap, type ParamSpec, recordHeal, resolveEffort } from './quirks';
import {
  addUsage,
  type ChatMessage,
  type ChatRequest,
  type Effort,
  EFFORT_INFO,
  emptyUsage,
  type LlmClient,
  LlmException,
  type ModelInfo,
  type Part,
  type ProviderConfig,
  type QuirkStore,
  type StopReason,
  type StreamEvent,
  type Usage,
} from './types';

export const ANTHROPIC_API_VERSION = '2023-06-01';
export const BETA_THINKING_BINDING = 'thinking-binding-controls-2026-08-01';
export const BETA_FALLBACK = 'server-side-fallback-2026-07-01';
export const BETA_FAST = 'fast-mode-2026-02-01';
const MAX_HEALS = 3;
const MAX_PAUSE_ROUNDS = 5;
const MAX_MODEL_PAGES = 10;
const DEFAULT_MAX_TOKENS = 64_000;
const FALLBACK_MAX_TOKENS = 16_000;
const UTILITY_MAX_TOKENS = 1_024;
const SHORT_CALL_MS = 60_000;
const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);
const SERVER_TOOL_TYPES = new Set(['server_tool_use', 'web_search_tool_result', 'web_fetch_tool_result']);
const SPEC_ORDER = [
  'eager_input_streaming', 'block_binding', 'display', 'effort', 'fallbacks', 'speed', 'web_search_v2', 'cache_control',
  'temperature', 'top_p', 'web_search', 'thinking', 'max_tokens',
];

type RoundOutcome = 'DONE' | 'CONTINUE' | 'FAILED' | 'ABORTED';

/** State that spans pause_turn continuation rounds. */
class TurnState {
  blocks: JsonObject[] = [];
  usageDone: Usage = emptyUsage();
  usageRound: Usage = emptyUsage();
  servedModel: string;
  started = false;
  emittedAnything = false;
  stopReason: StopReason = 'END';
  rounds = 0;
  citations = new CitationCollector();
  lastQuery: string | null = null;

  constructor(readonly request: ChatRequest) {
    this.servedModel = request.model;
  }

  pausedContent(): JsonObject[] | null {
    return this.blocks.length === 0 ? null : [...this.blocks];
  }

  get usage(): Usage {
    return addUsage(this.usageDone, this.usageRound);
  }
}

class BlockBuilder {
  readonly type: string;
  text = '';
  thinking = '';
  signature: string | null = null;
  partialJson = '';
  citations: unknown[] = [];

  constructor(readonly start: JsonObject) {
    this.type = str(start, 'type') ?? '';
  }

  build(): JsonObject {
    switch (this.type) {
      case 'text': {
        const out: JsonObject = { ...this.start, text: this.text };
        const existing = arr(this.start, 'citations') ?? [];
        if (existing.length > 0 || this.citations.length > 0) out.citations = [...existing, ...this.citations];
        else if ('citations' in this.start) out.citations = [];
        return out;
      }
      case 'thinking': {
        const out: JsonObject = { ...this.start, thinking: this.thinking };
        if (this.signature != null) out.signature = this.signature;
        return out;
      }
      case 'tool_use':
      case 'server_tool_use':
      case 'mcp_tool_use': {
        const input = isBlank(this.partialJson) ? undefined : tryParseJson(this.partialJson);
        return input !== undefined ? { ...this.start, input } : this.start;
      }
      default:
        return this.start;
    }
  }
}

interface Built {
  body: JsonObject;
  betas: Set<string>;
  sent: ParamSpec[];
  effort: Effort | null;
  replaysThinking: boolean;
  clientTools: boolean;
}

export class AnthropicClient implements LlmClient {
  private readonly fetchFn: typeof fetch;
  private readonly quirks: QuirkStore;
  private readonly pricing: PriceLookup | null;
  private readonly base: string;

  constructor(
    readonly config: ProviderConfig,
    options: ClientOptions,
  ) {
    this.fetchFn = resolveFetch(options.fetch);
    this.quirks = options.quirks;
    this.pricing = options.pricing ?? null;
    this.base = normalizeBaseUrl(config.baseUrl).replace(/\/v1$/, '') || 'https://api.anthropic.com';
  }

  private headers(extra?: Record<string, string>): Headers {
    return headersOf(
      {
        'x-api-key': this.config.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        // Required for CORS from the website; harmless from the Windows app.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      this.config.headers,
      extra,
    );
  }

  private async getText(url: string): Promise<string> {
    try {
      const res = await send(this.fetchFn, url, { method: 'GET', headers: this.headers(), signal: timeoutSignal(SHORT_CALL_MS) });
      return await readText(res);
    } catch (e) {
      if (e instanceof HttpStatusError) throw new LlmException(fromHttp(this.config, null, e));
      throw new LlmException(fromNetwork(this.config, e));
    }
  }

  // ------------------------------------------------------------------ models

  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const url = new URL(`${this.base}/v1/models`);
      url.searchParams.set('limit', '1000');
      if (after) url.searchParams.set('after_id', after);
      const json = parseObject(await this.getText(url.toString()));
      if (!json) return out;
      for (const m of arr(json, 'data') ?? []) if (isObject(m)) out.push(this.toModelInfo(m));
      if (bool(json, 'has_more') !== true) return out;
      after = str(json, 'last_id');
      if (!after) return out;
    }
    return out;
  }

  private toModelInfo(m: JsonObject): ModelInfo {
    const id = str(m, 'id') ?? '';
    const caps = obj(m, 'capabilities');
    let effortLevels: Effort[] | null = null;
    if (caps) {
      if (supported(caps, 'effort') === false) {
        effortLevels = [];
      } else {
        const levels = (['LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX'] as Effort[]).filter((e) => supported(caps, 'effort', EFFORT_INFO[e].wire) === true);
        effortLevels = levels.length > 0 ? levels : null;
      }
    }
    const thinkingOff = caps != null && supported(caps, 'thinking') === false ? false : null;
    const modelCaps = caps == null ? claudeCaps(id) : claudeCapsFromApi(
      id,
      supported(caps, 'image_input'),
      supported(caps, 'thinking', 'types', 'adaptive') ?? thinkingOff,
      supported(caps, 'thinking', 'types', 'enabled') ?? thinkingOff,
      effortLevels,
    );
    const created = str(m, 'created_at');
    const createdMs = created ? Date.parse(created) : NaN;
    return {
      id,
      displayName: str(m, 'display_name') ?? displayName(this.config.kind, id),
      contextWindow: long(m, 'max_input_tokens'),
      maxOutput: long(m, 'max_tokens') ?? parseClaude(id)?.defaultMaxOutput ?? null,
      caps: modelCaps,
      pricing: this.pricing?.priceFor(this.config.kind, id) ?? null,
      createdAt: Number.isFinite(createdMs) ? createdMs : null,
      output: 'TEXT',
    };
  }

  async verify(): Promise<void> {
    await this.getText(`${this.base}/v1/models?limit=1`);
  }

  // ------------------------------------------------------------------ streaming

  async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const config = this.config;
    const dropped = new Set(this.quirks.dropped(config.id, request.model));
    let stripThinking = false;
    let heals = 0;
    const turn = new TurnState(request);
    try {
      while (true) {
        if (signal?.aborted) return;
        const built = this.buildBody(request, dropped, stripThinking, turn.pausedContent());
        const extra: Record<string, string> = { accept: 'text/event-stream', 'content-type': 'application/json' };
        if (built.betas.size > 0) extra['anthropic-beta'] = [...built.betas].join(',');
        let res: Response;
        try {
          res = await send(this.fetchFn, `${this.base}/v1/messages`, {
            method: 'POST',
            headers: this.headers(extra),
            body: JSON.stringify(built.body),
            signal,
          });
        } catch (e) {
          if (signal?.aborted || isAbortError(e)) return;
          if (!(e instanceof HttpStatusError)) {
            yield { type: 'failed', error: fromNetwork(config, e) };
            return;
          }
          if (turn.emittedAnything) {
            yield { type: 'failed', error: fromHttp(config, request.model, e) };
            return;
          }
          const msg = extractMessage(e.body);
          if (e.status === 400 && !stripThinking && built.replaysThinking && isSignatureProblem(msg.toLowerCase())) {
            stripThinking = true;
            continue;
          }
          if ((e.status === 400 || e.status === 422) && heals < MAX_HEALS) {
            const action: HealAction | null = built.clientTools && ToolWire.toolsUnsupported(msg)
              ? { type: 'drop', key: 'tools' }
              : diagnose(msg, built.sent, built.effort, request.caps.reasoning.efforts);
            if (action) {
              heals++;
              recordHeal(this.quirks, config.id, request.model, action);
              applyHeal(dropped, action);
              continue;
            }
          }
          yield { type: 'failed', error: fromHttp(config, request.model, e) };
          return;
        }
        const outcome = yield* this.runRound(res, turn, signal);
        if (outcome === 'ABORTED' || outcome === 'FAILED') return;
        if (outcome === 'CONTINUE') {
          if (turn.rounds >= MAX_PAUSE_ROUNDS) {
            turn.stopReason = 'END';
            yield this.finish(turn);
            return;
          }
          continue;
        }
        yield this.finish(turn);
        return;
      }
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) return;
      yield { type: 'failed', error: e instanceof TransportError ? fromNetwork(config, e) : unexpected(config, e) };
    }
  }

  private async *runRound(res: Response, turn: TurnState, signal?: AbortSignal): AsyncGenerator<StreamEvent, RoundOutcome> {
    turn.rounds++;
    turn.usageRound = emptyUsage();
    const open = new Map<number, BlockBuilder>();
    const finished = new Map<number, JsonObject>();
    let roundStop: string | null = null;
    let sawStop = false;

    for await (const ev of sseEvents(res, signal)) {
      if (signal?.aborted) return 'ABORTED';
      const json = parseObject(ev.data);
      if (!json) continue;
      switch (str(json, 'type') ?? ev.event) {
        case 'message_start': {
          const msg = obj(json, 'message');
          const model = str(msg, 'model');
          if (model != null) turn.servedModel = model;
          if (!turn.started) {
            turn.started = true;
            turn.emittedAnything = true;
            yield { type: 'started', model: turn.servedModel };
            if (model != null && !sameModel(model, turn.request.model)) {
              yield { type: 'notice', text: `Answered by ${model} instead of ${turn.request.model} (automatic fallback).` };
            }
          }
          const usage = obj(msg, 'usage');
          if (usage) {
            turn.usageRound = parseUsage(usage, turn.usageRound);
            yield { type: 'usage', usage: turn.usage };
          }
          break;
        }
        case 'content_block_start': {
          const index = long(json, 'index');
          const block = obj(json, 'content_block');
          if (index == null || !block) break;
          const b = new BlockBuilder(block);
          open.set(index, b);
          switch (b.type) {
            case 'thinking':
            case 'redacted_thinking':
              yield { type: 'thinkingStarted' };
              break;
            case 'tool_use':
              turn.emittedAnything = true;
              yield { type: 'toolCallStarted', id: str(block, 'id') ?? '', name: str(block, 'name') ?? '' };
              break;
            case 'web_search_tool_result': {
              const content = block.content;
              let changed = false;
              if (Array.isArray(content)) {
                for (const r of content) {
                  if (str(r, 'type') === 'web_search_result') changed = turn.citations.add(str(r, 'url'), str(r, 'title')) || changed;
                }
              }
              yield { type: 'webSearch', query: turn.lastQuery, done: true };
              if (changed) yield { type: 'citations', citations: turn.citations.snapshot() };
              break;
            }
            case 'fallback': {
              const from = str(obj(block, 'from'), 'model');
              const to = str(obj(block, 'to'), 'model');
              if (to != null) turn.servedModel = to;
              yield {
                type: 'notice',
                text: from != null && to != null
                  ? `${from} declined this request; ${to} answered instead.`
                  : 'Another model answered after the requested model declined.',
              };
              break;
            }
          }
          break;
        }
        case 'content_block_delta': {
          const index = long(json, 'index');
          const b = index == null ? undefined : open.get(index);
          const delta = obj(json, 'delta');
          if (!b || !delta) break;
          switch (str(delta, 'type')) {
            case 'text_delta': {
              const t = str(delta, 'text');
              if (t) {
                b.text += t;
                yield { type: 'text', text: t };
              }
              break;
            }
            case 'thinking_delta': {
              const t = str(delta, 'thinking');
              if (t) {
                b.thinking += t;
                yield { type: 'thinking', text: t };
              }
              break;
            }
            case 'signature_delta':
              b.signature = str(delta, 'signature');
              break;
            case 'input_json_delta': {
              const pj = str(delta, 'partial_json');
              if (pj != null) b.partialJson += pj;
              break;
            }
            case 'citations_delta': {
              const c = obj(delta, 'citation');
              if (c) {
                b.citations.push(c);
                if (turn.citations.add(str(c, 'url'), str(c, 'title'), str(c, 'cited_text'))) {
                  yield { type: 'citations', citations: turn.citations.snapshot() };
                }
              }
              break;
            }
          }
          break;
        }
        case 'content_block_stop': {
          const index = long(json, 'index');
          const b = index == null ? undefined : open.get(index);
          if (index == null || !b) break;
          open.delete(index);
          const built = b.build();
          finished.set(index, built);
          switch (b.type) {
            case 'thinking':
            case 'redacted_thinking':
              yield { type: 'thinkingEnded' };
              break;
            case 'tool_use': {
              // Eager input streaming: arguments may be truncated or invalid; the engine validates.
              const raw = b.partialJson;
              const args = isBlank(raw) ? JSON.stringify(obj(b.start, 'input') ?? {}) : ToolWire.normalizeArgs(raw);
              yield { type: 'toolCallReady', id: str(b.start, 'id') ?? '', name: str(b.start, 'name') ?? '', argumentsJson: args };
              break;
            }
            case 'server_tool_use':
              if (str(built, 'name') === 'web_search') {
                turn.lastQuery = str(obj(built, 'input'), 'query');
                yield { type: 'webSearch', query: turn.lastQuery, done: false };
              }
              break;
          }
          break;
        }
        case 'message_delta': {
          const d = obj(json, 'delta');
          if (d) {
            const stop = str(d, 'stop_reason');
            if (stop != null) roundStop = stop;
            if (stop === 'refusal') {
              yield { type: 'notice', text: refusalNotice(turn.servedModel, str(obj(d, 'stop_details'), 'category')) };
            }
          }
          const usage = obj(json, 'usage');
          if (usage) {
            turn.usageRound = parseUsage(usage, turn.usageRound);
            yield { type: 'usage', usage: turn.usage };
          }
          break;
        }
        case 'message_stop':
          sawStop = true;
          break;
        case 'error': {
          const err = obj(json, 'error');
          yield { type: 'failed', error: fromStream(this.config, turn.request.model, str(err, 'type'), str(err, 'message')) };
          return 'FAILED';
        }
        default:
          break; // ping and future event types
      }
    }
    if (signal?.aborted) return 'ABORTED';
    // Blocks still open when the stream ended are kept as-is.
    for (const [i, b] of open) if (!finished.has(i)) finished.set(i, b.build());
    for (const i of [...finished.keys()].sort((a, b) => a - b)) turn.blocks.push(finished.get(i)!);
    turn.usageDone = turn.usage;
    turn.usageRound = emptyUsage();

    if (!sawStop && roundStop == null) {
      yield { type: 'failed', error: truncatedStream(this.config) };
      return 'FAILED';
    }
    switch (roundStop) {
      case 'pause_turn':
        return 'CONTINUE';
      case 'max_tokens':
      case 'model_context_window_exceeded':
        turn.stopReason = 'MAX_TOKENS';
        return 'DONE';
      case 'refusal':
        turn.stopReason = 'REFUSAL';
        return 'DONE';
      case 'tool_use':
        turn.stopReason = 'TOOL_USE';
        return 'DONE';
      default:
        turn.stopReason = 'END';
        return 'DONE';
    }
  }

  private finish(turn: TurnState): StreamEvent {
    const blocks = cleanForReplay(turn.blocks);
    return { type: 'completed', stopReason: turn.stopReason, blocks: { style: 'ANTHROPIC', model: turn.servedModel, json: JSON.stringify(blocks) } };
  }

  // ------------------------------------------------------------------ request body

  private buildBody(req: ChatRequest, dropped: Set<string>, stripThinking: boolean, paused: JsonObject[] | null): Built {
    const claude = parseClaude(req.model);
    const caps = req.caps;
    const betas = new Set<string>();
    const sent: ParamSpec[] = [];
    const utility = req.utility === true;
    const webSearch = req.params.webSearch && caps.webSearch && !utility && !dropped.has('web_search');
    const clientTools = !utility && caps.tools && !dropped.has('tools') ? req.tools : [];

    // max_tokens
    const cap = maxTokensCap(dropped);
    let maxTokens = req.params.maxOutputTokens ??
      (utility ? UTILITY_MAX_TOKENS : Math.min(req.modelMaxOutput ?? claude?.defaultMaxOutput ?? FALLBACK_MAX_TOKENS, DEFAULT_MAX_TOKENS));
    if (cap != null) maxTokens = Math.min(maxTokens, cap);
    maxTokens = Math.max(1, maxTokens);

    // thinking + effort
    const requested: Effort | null = utility ? 'NONE' : (req.params.effort ?? null);
    const display = req.params.showThinking && !utility ? 'summarized' : 'omitted';
    let thinkingMode: string | null = null;
    let effort: Effort | null = null;
    switch (caps.reasoning.kind) {
      case 'EFFORT':
        if (requested === 'NONE') {
          const off: ThinkingOff = claude?.thinkingOff ?? 'OMIT';
          if (off === 'DISABLED') thinkingMode = 'disabled';
          else if (off === 'BETWEEN_TOOLS') thinkingMode = 'between_tools';
          else if (off === 'CANNOT') {
            thinkingMode = 'adaptive';
            effort = resolveEffort('LOW', caps.reasoning.efforts, dropped);
          }
        } else {
          effort = resolveEffort(requested, caps.reasoning.efforts, dropped);
          if (requested != null || claude?.thinkingOnByDefault === true) thinkingMode = 'adaptive';
        }
        break;
      case 'BUDGET':
        if (requested != null && requested !== 'NONE') thinkingMode = 'enabled';
        break;
      case 'NONE':
        break;
    }
    if (dropped.has('thinking') && thinkingMode != null) thinkingMode = null;

    // messages
    let replaysThinking = false;
    const messages: JsonObject[] = [];
    for (const m of req.messages) {
      if (m.role === 'USER') {
        messages.push({ role: 'user', content: userContent(m.parts) });
      } else {
        const content = assistantContent(m, stripThinking, webSearch);
        if (content.some((b) => THINKING_TYPES.has(str(b, 'type') ?? ''))) replaysThinking = true;
        messages.push({ role: 'assistant', content });
      }
    }
    if (paused != null) {
      const content = paused.filter((b) => !isEmptyText(b));
      if (content.some((b) => THINKING_TYPES.has(str(b, 'type') ?? ''))) replaysThinking = true;
      messages.push({ role: 'assistant', content });
    }

    let thinking: JsonObject | null = null;
    if (thinkingMode != null) {
      thinking = { type: thinkingMode };
      if (thinkingMode === 'adaptive') {
        if (!dropped.has('display')) {
          thinking.display = display;
          sent.push({ key: 'display', tokens: ['thinking.display', 'display'] });
        }
      } else if (thinkingMode === 'enabled') {
        const budget = Math.max(1024, Math.min(budgetFor(requested ?? 'MEDIUM'), maxTokens - 1024));
        if (maxTokens <= 1024 + 1024) maxTokens = budget + 4096;
        thinking.budget_tokens = budget;
      }
      const bindable = thinkingMode === 'adaptive' || thinkingMode === 'enabled';
      if (replaysThinking && bindable && !dropped.has('block_binding')) {
        thinking.block_binding = { prefix_mismatch_behavior: 'drop_block' };
        betas.add(BETA_THINKING_BINDING);
        sent.push({ key: 'block_binding', tokens: ['block_binding', 'prefix_mismatch', 'thinking-binding'] });
      }
      sent.push({ key: 'thinking', tokens: ['thinking', 'budget_tokens'] });
    }

    const body: JsonObject = { model: req.model, max_tokens: maxTokens, stream: true };
    if (req.system && req.system.trim() !== '') body.system = [{ type: 'text', text: req.system }];
    body.messages = messages;
    if (thinking) body.thinking = thinking;
    if (effort != null) {
      body.output_config = { effort: EFFORT_INFO[effort].wire };
      sent.push({ key: 'effort', tokens: ['output_config.effort', 'effort', 'output_config'] });
    }
    const thinkingOn = thinkingMode === 'adaptive' || thinkingMode === 'enabled';
    if (caps.sampling && !thinkingOn) {
      const t = req.params.temperature;
      if (t != null && !dropped.has('temperature')) {
        body.temperature = Math.min(1, Math.max(0, t));
        sent.push({ key: 'temperature', tokens: ['temperature'] });
      }
      const p = req.params.topP;
      if (p != null && !dropped.has('top_p')) {
        body.top_p = p;
        sent.push({ key: 'top_p', tokens: ['top_p'] });
      }
    }
    const eager = clientTools.length > 0 && !dropped.has('eager_input_streaming');
    if (webSearch || clientTools.length > 0) {
      const v2 = claude?.webSearchV2 === true && !dropped.has('web_search_v2');
      const tools: JsonObject[] = [];
      if (webSearch) tools.push({ type: v2 ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 5 });
      for (const t of clientTools) {
        const tool: JsonObject = { name: t.name, description: t.description, input_schema: ToolWire.schema(t.inputSchemaJson) };
        if (eager) tool.eager_input_streaming = true;
        tools.push(tool);
      }
      body.tools = tools;
      if (webSearch) {
        if (v2) sent.push({ key: 'web_search_v2', tokens: ['web_search_20260209'] });
        // With client tools present, a generic "tools" error isn't evidence against web search.
        sent.push({ key: 'web_search', tokens: clientTools.length === 0 ? ['web_search', 'tools'] : ['web_search'] });
      }
      if (eager) sent.push({ key: 'eager_input_streaming', tokens: ['eager_input_streaming'] });
    }
    if (!utility && !dropped.has('cache_control')) {
      body.cache_control = { type: 'ephemeral' };
      sent.push({ key: 'cache_control', tokens: ['cache_control'] });
    }
    if (!utility && caps.refusalFallback && !dropped.has('fallbacks')) {
      body.fallbacks = 'default';
      betas.add(BETA_FALLBACK);
      sent.push({ key: 'fallbacks', tokens: ['fallbacks', 'fallback', 'server-side-fallback'] });
    }
    if (!utility && req.params.fastMode && caps.fastMode && !dropped.has('speed')) {
      body.speed = 'fast';
      betas.add(BETA_FAST);
      sent.push({ key: 'speed', tokens: ['speed', 'fast-mode', 'fast mode'] });
    }
    sent.push({ key: 'max_tokens', tokens: ['max_tokens'] });
    // Specific params first so the healer blames the narrowest one.
    const rank = (k: string) => {
      const i = SPEC_ORDER.indexOf(k);
      return i < 0 ? SPEC_ORDER.length : i;
    };
    const ordered = [...sent].sort((a, b) => rank(a.key) - rank(b.key));
    return { body, betas, sent: ordered, effort, replaysThinking, clientTools: clientTools.length > 0 };
  }
}

function isSignatureProblem(lower: string): boolean {
  return lower.includes('signature') || lower.includes('bound to a different conversation') ||
    (lower.includes('thinking') && lower.includes('messages.'));
}

function refusalNotice(model: string, category: string | null): string {
  const why = category == null ? '' : category === 'cyber' ? ' (cybersecurity safeguard)' : category === 'bio' ? ' (biology safeguard)' : ` (${category} safeguard)`;
  return `${model} declined to answer this request${why}. Rephrase it or try another model.`;
}

function sameModel(a: string, b: string): boolean {
  return normalizeId(a) === normalizeId(b);
}

/** Anthropic reports uncached input separately from cache reads/writes; fields may arrive in either event. */
function parseUsage(u: JsonObject, prev: Usage): Usage {
  const input = long(u, 'input_tokens');
  const cacheWrite = long(u, 'cache_creation_input_tokens');
  const cacheRead = long(u, 'cache_read_input_tokens');
  const output = long(u, 'output_tokens');
  const prevUncached = prev.inputTokens - prev.cacheReadTokens - prev.cacheWriteTokens;
  const uncached = input ?? prevUncached;
  const cw = cacheWrite ?? prev.cacheWriteTokens;
  const cr = cacheRead ?? prev.cacheReadTokens;
  return {
    inputTokens: uncached + cw + cr,
    outputTokens: output ?? prev.outputTokens,
    cacheReadTokens: cr,
    cacheWriteTokens: cw,
    reasoningTokens: prev.reasoningTokens,
  };
}

function budgetFor(e: Effort): number {
  switch (e) {
    case 'NONE':
    case 'MINIMAL':
    case 'LOW':
      return 2_048;
    case 'MEDIUM':
      return 8_192;
    case 'HIGH':
      return 16_384;
    case 'XHIGH':
      return 24_576;
    case 'MAX':
      return 32_000;
  }
}

function userContent(parts: Part[]): JsonObject[] {
  const out: JsonObject[] = [];
  // tool_result blocks must come first in the user turn that follows tool_use.
  for (const r of parts) {
    if (r.type !== 'toolResult') continue;
    const block: JsonObject = { type: 'tool_result', tool_use_id: ToolWire.safeId(r.callId), content: isBlank(r.content) ? '(no output)' : r.content };
    if (r.isError) block.is_error = true;
    out.push(block);
  }
  for (const p of parts) {
    if (p.type === 'image') {
      out.push({ type: 'image', source: { type: 'base64', media_type: p.mimeType, data: b64(p.bytes) } });
    } else if (p.type === 'document') {
      const block: JsonObject = p.mimeType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(p.bytes) } }
        : { type: 'document', source: { type: 'text', media_type: 'text/plain', data: fromUtf8(p.bytes) } };
      if (!isBlank(p.name)) block.title = p.name;
      out.push(block);
    }
  }
  for (const p of parts) if (p.type === 'text' && !isBlank(p.text)) out.push({ type: 'text', text: p.text });
  return out.length === 0 ? [{ type: 'text', text: '(empty message)' }] : out;
}

function assistantContent(m: ChatMessage, stripThinking: boolean, webSearch: boolean): JsonObject[] {
  const blocks = m.blocks;
  if (blocks && blocks.style === 'ANTHROPIC') {
    const parsed = tryParseJson(blocks.json);
    if (Array.isArray(parsed)) {
      const kept = parsed.filter((el): el is JsonObject => {
        const type = str(el, 'type');
        if (type == null) return false;
        if (type === 'fallback') return false;
        if (stripThinking && THINKING_TYPES.has(type)) return false;
        if (!webSearch && SERVER_TOOL_TYPES.has(type)) return false;
        return !isEmptyText(el);
      });
      if (kept.some((b) => !THINKING_TYPES.has(str(b, 'type') ?? ''))) return kept;
    }
  }
  const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
  const calls = m.parts.filter((p) => p.type === 'toolCall');
  const out: JsonObject[] = [];
  if (!isBlank(text) || calls.length === 0) out.push({ type: 'text', text: isBlank(text) ? '(no response)' : text });
  for (const c of calls) out.push({ type: 'tool_use', id: ToolWire.safeId(c.id), name: c.name, input: ToolWire.argsObject(c.argumentsJson) });
  return out;
}

function isEmptyText(el: unknown): boolean {
  return isObject(el) && str(el, 'type') === 'text' && isBlank(str(el, 'text'));
}

/**
 * Prepares the final content for replay: after a mid-output refusal fallback, drop the declined
 * model's thinking / tool_use / unpaired server-tool blocks before the last fallback marker, then
 * drop the markers themselves and empty text blocks.
 */
function cleanForReplay(blocks: JsonObject[]): JsonObject[] {
  let lastFallback = -1;
  blocks.forEach((b, i) => {
    if (str(b, 'type') === 'fallback') lastFallback = i;
  });
  const resultIds = new Set(blocks.map((b) => str(b, 'tool_use_id')).filter((x): x is string => x != null));
  return blocks.filter((b, i) => {
    const type = str(b, 'type');
    if (type === 'fallback') return false;
    if (isEmptyText(b)) return false;
    if (i < lastFallback && (THINKING_TYPES.has(type ?? '') || type === 'tool_use')) return false;
    if (i < lastFallback && type === 'server_tool_use' && !resultIds.has(str(b, 'id') ?? '')) return false;
    return true;
  });
}
