/**
 * OpenAI-compatible Chat Completions adapter for every non-first-party preset and custom endpoints
 * (port of OpenAiChatClient.kt). Handles the dialects: reasoning fields (DeepSeek reasoning_content,
 * OpenRouter/Groq reasoning, reasoning_details, <think> tags), Perplexity citations, OpenRouter
 * plugins and headers, Gemini's thought config and id-less tool calls, Mistral's tool id format.
 */
import { fromUtf8 } from '../core/bytes';
import { isObject } from '../core/json';
import { canRun, chatByMetadata, compatCaps, displayName, GEMINI_MEDIA_DEFAULTS, isCompatChatModel, looksVision, mediaOutput, metadataCaps, perplexityModels } from './catalog';
import { extractMessage, fromHttp, fromNetwork, fromStream, HttpStatusError, TransportError, truncatedStream, unexpected } from './errors';
import {
  arr,
  type ClientOptions,
  CitationCollector,
  dataUrl,
  headersOf,
  isAbortError,
  isBlank,
  type JsonObject,
  long,
  obj,
  tryParseJson,
  parseObject,
  type PriceLookup,
  readText,
  resolveFetch,
  sameUsage,
  type Segment,
  send,
  sseEvents,
  str,
  stringsOf,
  ThinkTagSplitter,
  timeoutSignal,
  ToolWire,
} from './internal';
import { openRouterPricing } from './pricing';
import { normalizeBaseUrl, ProviderKinds } from './providers';
import { applyHeal, diagnose, type HealAction, maxTokensCap, type ParamSpec, recordHeal, resolveEffort } from './quirks';
import {
  type ChatMessage,
  type ChatRequest,
  defaultCaps,
  type Effort,
  EFFORTS,
  EFFORT_INFO,
  type LlmClient,
  LlmException,
  type ModelCaps,
  type ModelInfo,
  type ModelOutput,
  NO_REASONING,
  type Part,
  type ProviderConfig,
  type QuirkStore,
  type StopReason,
  type StreamEvent,
  type Usage,
} from './types';

const MAX_HEALS = 3;
const SHORT_CALL_MS = 60_000;
const SPEC_ORDER = ['extra_body', 'effort', 'reasoning', 'stream_options', 'web_search', 'temperature', 'top_p', 'max_tokens'];

interface ToolAcc {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

class StreamState {
  started = false;
  finished = false;
  model: string;
  usage: Usage | null = null;
  finishReason: string | null = null;
  thinkingOpen = false;
  splitter = new ThinkTagSplitter();
  citations = new CitationCollector();
  perplexityCitationsSeen = 0;
  text = '';
  reasoning = '';
  tools = new Map<number, ToolAcc>();

  constructor(readonly request: ChatRequest) {
    this.model = request.model;
  }

  /** Tool calls in index order. */
  sortedTools(): [number, ToolAcc][] {
    return [...this.tools.entries()].sort((a, b) => a[0] - b[0]);
  }
}

interface Built {
  body: JsonObject;
  sent: ParamSpec[];
  effort: Effort | null;
  clientTools: boolean;
  hasToolHistory: boolean;
}

export class OpenAiChatClient implements LlmClient {
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
    this.base = normalizeBaseUrl(config.baseUrl) || normalizeBaseUrl(config.kind.defaultBaseUrl);
  }

  private is(kind: { id: string }): boolean {
    return this.config.kind.id === kind.id;
  }

  private headers(extra?: Record<string, string>): Headers {
    return headersOf(
      isBlank(this.config.apiKey) ? null : { Authorization: `Bearer ${this.config.apiKey}` },
      // OpenRouter app attribution; both headers are allowed by its CORS policy.
      this.is(ProviderKinds.OPENROUTER) ? { 'HTTP-Referer': 'https://facet.dtsoftware.io', 'X-Title': 'Facet' } : null,
      this.config.headers,
      extra,
    );
  }

  private async request(path: string, init: RequestInit = {}): Promise<string> {
    try {
      const res = await send(this.fetchFn, `${this.base}/${path}`, { method: 'GET', ...init, headers: this.headers(init.headers as Record<string, string> | undefined), signal: timeoutSignal(SHORT_CALL_MS) });
      return await readText(res);
    } catch (e) {
      if (e instanceof HttpStatusError) throw new LlmException(fromHttp(this.config, null, e));
      throw new LlmException(fromNetwork(this.config, e));
    }
  }

  // ------------------------------------------------------------------ models

  async listModels(): Promise<ModelInfo[]> {
    const kind = this.config.kind;
    if (this.is(ProviderKinds.PERPLEXITY)) {
      return perplexityModels().map((m) => ({ ...m, pricing: this.pricing?.priceFor(kind, m.id) ?? null }));
    }
    const json = parseObject(await this.request('models'));
    const data = arr(json, 'data') ?? arr(json, 'models');
    if (!data) return [];
    const models = data.filter(isObject);
    if (this.is(ProviderKinds.OPENROUTER)) {
      return models.map((m) => this.openRouterModel(m)).filter((m): m is ModelInfo => m != null);
    }
    const listed: ModelInfo[] = [];
    for (const m of models) {
      const rawId = str(m, 'id') ?? str(m, 'name');
      if (rawId == null) continue;
      const id = rawId.startsWith('models/') ? rawId.slice('models/'.length) : rawId;
      const output = this.outputOf(id, str(m, 'type'));
      if (output == null) continue;
      if (output === 'TEXT' && chatByMetadata(m) === false) continue;
      const created = long(m, 'created');
      listed.push({
        id,
        displayName: (this.is(ProviderKinds.GOOGLE) ? str(m, 'display_name') : null) ?? displayName(kind, id),
        contextWindow: long(m, 'context_length') ?? long(m, 'context_window') ?? long(m, 'max_context_length'),
        maxOutput: null,
        caps: output === 'TEXT' ? metadataCaps(compatCaps(kind, id), m) : defaultCaps({ tools: false }),
        pricing: this.pricing?.priceFor(kind, id) ?? null,
        createdAt: created != null ? created * 1000 : null,
        output,
      });
    }
    if (this.is(ProviderKinds.GOOGLE)) {
      // Gemini's OpenAI-compatible list may leave out media models; add the current ones it lacks.
      return [...listed, ...GEMINI_MEDIA_DEFAULTS.filter((d) => !listed.some((m) => m.output === d.output))];
    }
    return listed;
  }

  /** Chat, a runnable media kind, or null to leave the model out (embeddings, rerankers, unsupported media). */
  private outputOf(id: string, type: string | null): ModelOutput | null {
    let typed: ModelOutput | null = null;
    // Together labels every model with a type.
    switch (type?.toLowerCase()) {
      case 'chat':
      case 'language':
      case 'code':
        typed = 'TEXT';
        break;
      case 'image':
        typed = 'IMAGE';
        break;
      case 'audio':
        typed = 'SPEECH';
        break;
      case 'transcribe':
        typed = 'TRANSCRIPTION';
        break;
      case 'video':
        typed = 'VIDEO';
        break;
      case 'embedding':
      case 'rerank':
      case 'moderation':
        return null;
    }
    const output = typed ?? mediaOutput(this.config.kind, id) ?? (isCompatChatModel(id) ? 'TEXT' : null);
    return output != null && canRun(this.config.kind, output) ? output : null;
  }

  private openRouterModel(m: JsonObject): ModelInfo | null {
    const id = str(m, 'id');
    if (id == null) return null;
    const kind = this.config.kind;
    const arch = obj(m, 'architecture');
    const outputs = stringsOf(arr(arch, 'output_modalities'));
    const created = long(m, 'created');
    const createdAt = created != null ? created * 1000 : null;
    // Models that draw (e.g. Gemini image models) go to the image list; they answer through chat completions.
    if (outputs.includes('image')) {
      return {
        id,
        displayName: str(m, 'name') ?? displayName(kind, id),
        contextWindow: null,
        maxOutput: null,
        caps: defaultCaps({ tools: false }),
        pricing: openRouterPricing(obj(m, 'pricing')),
        createdAt,
        output: 'IMAGE',
      };
    }
    if (outputs.length > 0 && !outputs.includes('text')) return null;
    const inputs = stringsOf(arr(arch, 'input_modalities'));
    const paramList = arr(m, 'supported_parameters');
    const params = paramList ? new Set(stringsOf(paramList)) : null;
    const reasons = params != null && (params.has('reasoning') || params.has('include_reasoning'));
    const caps: ModelCaps = defaultCaps({
      vision: inputs.length > 0 ? inputs.includes('image') : looksVision(id),
      pdf: inputs.includes('file'),
      reasoning: reasons ? { kind: 'EFFORT', efforts: ['LOW', 'MEDIUM', 'HIGH'], defaultEffort: null, summaries: true } : NO_REASONING,
      webSearch: true,
      sampling: params?.has('temperature') ?? true,
      tools: params?.has('tools') ?? true,
    });
    return {
      id,
      displayName: str(m, 'name') ?? displayName(kind, id),
      contextWindow: long(m, 'context_length'),
      maxOutput: long(obj(m, 'top_provider'), 'max_completion_tokens'),
      caps,
      pricing: openRouterPricing(obj(m, 'pricing')),
      createdAt,
      output: 'TEXT',
    };
  }

  async verify(): Promise<void> {
    if (this.is(ProviderKinds.PERPLEXITY)) {
      // Perplexity has no models endpoint; a one-token completion checks the key.
      const body = { model: 'sonar', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
      await this.request('chat/completions', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    } else {
      await this.request('models');
    }
  }

  // ------------------------------------------------------------------ streaming

  async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const config = this.config;
    const dropped = new Set(this.quirks.dropped(config.id, request.model));
    let heals = 0;
    let includeReasoning = false;
    try {
      while (true) {
        if (signal?.aborted) return;
        const built = await this.buildBody(request, dropped, includeReasoning);
        let res: Response;
        try {
          res = await send(this.fetchFn, `${this.base}/chat/completions`, {
            method: 'POST',
            headers: this.headers({ Accept: 'text/event-stream', 'Content-Type': 'application/json' }),
            body: JSON.stringify(built.body),
            signal,
          });
        } catch (e) {
          if (signal?.aborted || isAbortError(e)) return;
          if (!(e instanceof HttpStatusError)) {
            yield { type: 'failed', error: fromNetwork(config, e) };
            return;
          }
          const msg = extractMessage(e.body);
          // DeepSeek-style thinking + tools: the tool loop must echo reasoning_content back.
          if (e.status === 400 && !includeReasoning && built.hasToolHistory && msg.toLowerCase().includes('reasoning_content')) {
            includeReasoning = true;
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
        yield* this.consume(res, new StreamState(request), signal);
        return;
      }
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) return;
      yield { type: 'failed', error: e instanceof TransportError ? fromNetwork(config, e) : unexpected(config, e) };
    }
  }

  private async *consume(res: Response, s: StreamState, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    for await (const ev of sseEvents(res, signal)) {
      if (signal?.aborted) return;
      if (s.finished) break;
      const data = ev.data.trim();
      if (data === '[DONE]') {
        yield* this.finish(s);
        continue;
      }
      const json = parseObject(data);
      if (!json) continue;
      const err = json.error;
      if (err != null) {
        s.finished = true;
        yield* this.closeThinking(s);
        const type = str(err, 'type') ?? long(err, 'code')?.toString() ?? str(err, 'code');
        yield { type: 'failed', error: fromStream(this.config, s.request.model, type, str(err, 'message') ?? (typeof err === 'string' ? err : null)) };
        continue;
      }
      if (!s.started) {
        s.started = true;
        s.model = str(json, 'model') ?? s.model;
        yield { type: 'started', model: s.model };
      }
      yield* this.handleCitations(json, s);
      const choices = arr(json, 'choices');
      const choice = choices && isObject(choices[0]) ? choices[0] : null;
      if (choice) {
        const delta = obj(choice, 'delta') ?? obj(choice, 'message');
        if (delta) yield* this.handleDelta(delta, s);
        const reason = str(choice, 'finish_reason');
        if (reason != null) s.finishReason = reason;
      }
      const u = obj(json, 'usage') ?? obj(obj(json, 'x_groq'), 'usage');
      if (u) {
        const usage = parseUsage(u);
        if (!sameUsage(s.usage, usage)) {
          s.usage = usage;
          yield { type: 'usage', usage };
        }
      }
    }
    if (signal?.aborted) return;
    if (!s.finished) {
      // Some servers end the stream without [DONE] after the final chunk.
      if (s.started && s.finishReason != null) yield* this.finish(s);
      else yield { type: 'failed', error: truncatedStream(this.config) };
    }
  }

  private *handleDelta(delta: JsonObject, s: StreamState): Generator<StreamEvent> {
    // Reasoning fields used by various providers (DeepSeek, OpenRouter, Groq, xAI, vLLM…).
    const details = arr(delta, 'reasoning_details');
    const joined = details ? details.map((d) => (isObject(d) ? (str(d, 'text') ?? str(d, 'summary') ?? '') : '')).join('') : '';
    const reasoning = str(delta, 'reasoning_content') ?? str(delta, 'reasoning') ?? (joined !== '' ? joined : null);
    if (reasoning) yield* this.emitThinking(reasoning, s);

    const content = delta.content;
    if (typeof content === 'string') {
      yield* this.emitContent(content, s);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!isObject(part)) continue;
        switch (str(part, 'type')) {
          case 'text': {
            const t = str(part, 'text');
            if (t != null) yield* this.emitContent(t, s);
            break;
          }
          case 'thinking': {
            const th = part.thinking;
            const t = Array.isArray(th) ? th.map((x) => str(x, 'text') ?? '').join('') : typeof th === 'string' ? th : '';
            if (t) yield* this.emitThinking(t, s);
            break;
          }
        }
      }
    }
    const anns = arr(delta, 'annotations');
    if (anns) {
      let changed = false;
      for (const a of anns) {
        if (!isObject(a)) continue;
        const c = obj(a, 'url_citation') ?? a;
        changed = s.citations.add(str(c, 'url'), str(c, 'title'), str(c, 'content')) || changed;
      }
      if (changed) yield { type: 'citations', citations: s.citations.snapshot() };
    }
    for (const el of arr(delta, 'tool_calls') ?? []) if (isObject(el)) yield* this.handleToolFragment(el, s);
  }

  /**
   * Accumulates a streamed tool-call fragment. Ids and names may arrive only on the first fragment;
   * some providers (Gemini compat) omit `index` and ids, so a fragment with a name starts a new call.
   */
  private *handleToolFragment(o: JsonObject, s: StreamState): Generator<StreamEvent> {
    const fn = obj(o, 'function');
    const rawName = str(fn, 'name');
    const name = rawName ? rawName : null;
    const index = long(o, 'index') ?? (name != null || s.tools.size === 0 ? s.tools.size : Math.max(...s.tools.keys()));
    let acc = s.tools.get(index);
    if (!acc) s.tools.set(index, (acc = { id: '', name: '', args: '', started: false }));
    const id = str(o, 'id');
    if (id != null && !isBlank(id) && acc.id === '') acc.id = id;
    if (name != null && acc.name === '') acc.name = name;
    const args = fn?.arguments;
    if (typeof args === 'string') acc.args += args;
    else if (isObject(args)) acc.args += JSON.stringify(args);
    if (!acc.started && acc.name !== '') {
      if (acc.id === '') acc.id = ToolWire.newId(index);
      acc.started = true;
      yield* this.closeThinking(s);
      yield { type: 'toolCallStarted', id: acc.id, name: acc.name };
    }
  }

  private *emitThinking(text: string, s: StreamState): Generator<StreamEvent> {
    if (!s.thinkingOpen) {
      s.thinkingOpen = true;
      yield { type: 'thinkingStarted' };
    }
    s.reasoning += text;
    yield { type: 'thinking', text };
  }

  private *emitContent(text: string, s: StreamState): Generator<StreamEvent> {
    if (!text) return;
    for (const seg of s.splitter.feed(text)) yield* this.emitSegment(seg, s);
  }

  private *emitSegment(seg: Segment, s: StreamState): Generator<StreamEvent> {
    if (seg.thinking) {
      yield* this.emitThinking(seg.text, s);
    } else {
      yield* this.closeThinking(s);
      s.text += seg.text;
      yield { type: 'text', text: seg.text };
    }
  }

  private *closeThinking(s: StreamState): Generator<StreamEvent> {
    if (s.thinkingOpen) {
      s.thinkingOpen = false;
      yield { type: 'thinkingEnded' };
    }
  }

  private *handleCitations(json: JsonObject, s: StreamState): Generator<StreamEvent> {
    let changed = false;
    for (const r of arr(json, 'search_results') ?? []) {
      if (isObject(r)) changed = s.citations.add(str(r, 'url'), str(r, 'title'), str(r, 'snippet')) || changed;
    }
    // Perplexity repeats the full citation list on every chunk; only reprocess when it grows.
    const list = arr(json, 'citations');
    if (list && list.length !== s.perplexityCitationsSeen) {
      s.perplexityCitationsSeen = list.length;
      for (const c of list) {
        if (typeof c === 'string') changed = s.citations.add(c, null) || changed;
        else if (isObject(c)) changed = s.citations.add(str(c, 'url'), str(c, 'title')) || changed;
      }
    }
    if (changed) yield { type: 'citations', citations: s.citations.snapshot() };
  }

  private *finish(s: StreamState): Generator<StreamEvent> {
    if (s.finished) return;
    s.finished = true;
    for (const seg of s.splitter.flush()) yield* this.emitSegment(seg, s);
    yield* this.closeThinking(s);
    const calls = s.sortedTools().map(([, c]) => c).filter((c) => c.name !== '');
    for (const c of calls) {
      if (!c.started) {
        c.started = true;
        yield { type: 'toolCallStarted', id: c.id, name: c.name };
      }
      yield { type: 'toolCallReady', id: c.id, name: c.name, argumentsJson: ToolWire.normalizeArgs(c.args) };
    }
    let stop: StopReason;
    if (s.finishReason === 'length') stop = 'MAX_TOKENS';
    else if (s.finishReason === 'content_filter') stop = 'REFUSAL';
    else if (calls.length > 0) stop = 'TOOL_USE';
    else stop = 'END';
    if (stop === 'REFUSAL') yield { type: 'notice', text: `${s.model} stopped because of a content filter.` };
    let blocks = null;
    if (calls.length > 0) {
      // Kept so a provider that requires it (DeepSeek thinking + tools) can get reasoning_content back.
      const message: JsonObject = {
        role: 'assistant',
        content: s.text,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: ToolWire.normalizeArgs(c.args) } })),
      };
      if (s.reasoning !== '') message.reasoning_content = s.reasoning;
      blocks = { style: 'OPENAI_CHAT' as const, model: s.model, json: JSON.stringify([message]) };
    }
    yield { type: 'completed', stopReason: stop, blocks };
  }

  // ------------------------------------------------------------------ request body

  private async buildBody(req: ChatRequest, dropped: Set<string>, includeReasoning: boolean): Promise<Built> {
    const caps = req.caps;
    const sent: ParamSpec[] = [];
    const utility = req.utility === true;
    const clientTools = !utility && caps.tools && !dropped.has('tools') && !this.is(ProviderKinds.PERPLEXITY) ? req.tools : [];
    const hasToolHistory = req.messages.some((m) => m.parts.some((p) => p.type === 'toolCall' || p.type === 'toolResult'));
    const messages = await this.buildMessages(req, caps, includeReasoning);

    let effort: Effort | null = null;
    const body: JsonObject = { model: req.model, stream: true, messages };
    if (!dropped.has('stream_options') && !this.is(ProviderKinds.PERPLEXITY)) {
      body.stream_options = { include_usage: true };
      sent.push({ key: 'stream_options', tokens: ['stream_options', 'include_usage'] });
    }

    // Output limit
    const cap = maxTokensCap(dropped);
    const max = req.params.maxOutputTokens ?? (utility ? 1_024 : null);
    const finalMax = max != null && cap != null ? Math.min(max, cap) : (max ?? cap);
    if (finalMax != null) {
      const field = dropped.has('max_tokens') ? 'max_completion_tokens' : 'max_tokens';
      if (!(field === 'max_completion_tokens' && dropped.has('max_completion_tokens'))) {
        body[field] = Math.max(16, finalMax);
        sent.push({ key: 'max_tokens', tokens: [field] });
      }
    }

    // Reasoning
    const r = caps.reasoning;
    if (r.kind === 'EFFORT') {
      const requested: Effort | null = utility ? minEffort(r.efforts) : (req.params.effort ?? null);
      if (requested == null) effort = null;
      else if (requested === 'NONE' && r.efforts.includes('NONE') && !dropped.has('effort:none') && !dropped.has('effort')) effort = 'NONE';
      else if (requested === 'NONE') effort = resolveEffort('MINIMAL', r.efforts, dropped);
      else effort = resolveEffort(requested, r.efforts, dropped);
    }
    if (this.is(ProviderKinds.OPENROUTER)) {
      const hide = !req.params.showThinking || utility;
      if ((effort != null || hide) && r.kind === 'EFFORT' && !dropped.has('reasoning')) {
        const reasoning: JsonObject = {};
        if (effort != null) {
          if (effort === 'NONE') reasoning.enabled = false;
          else reasoning.effort = EFFORT_INFO[effort].wire;
        }
        if (hide) reasoning.exclude = true;
        body.reasoning = reasoning;
        sent.push({ key: 'reasoning', tokens: ['reasoning'] });
      }
      if (effort != null) sent.push({ key: 'effort', tokens: ['effort'] });
    } else if (effort != null && !dropped.has('reasoning_effort')) {
      body.reasoning_effort = EFFORT_INFO[effort].wire;
      sent.push({ key: 'effort', tokens: ['reasoning_effort', 'reasoning effort', 'effort'] });
    }
    if (this.is(ProviderKinds.GOOGLE) && r.summaries && req.params.showThinking && !utility && effort !== 'NONE' && !dropped.has('extra_body')) {
      body.extra_body = { google: { thinking_config: { include_thoughts: true } } };
      sent.push({ key: 'extra_body', tokens: ['extra_body', 'include_thoughts', 'thinking_config'] });
    }

    // Web search (OpenRouter web plugin)
    if (this.is(ProviderKinds.OPENROUTER) && req.params.webSearch && caps.webSearch && !utility && !dropped.has('web_search')) {
      body.plugins = [{ id: 'web' }];
      sent.push({ key: 'web_search', tokens: ['plugins', 'web'] });
    }

    // Sampling
    if (caps.sampling) {
      const t = req.params.temperature;
      if (t != null && !dropped.has('temperature')) {
        body.temperature = t;
        sent.push({ key: 'temperature', tokens: ['temperature'] });
      }
      const p = req.params.topP;
      if (p != null && !dropped.has('top_p')) {
        body.top_p = p;
        sent.push({ key: 'top_p', tokens: ['top_p'] });
      }
    }

    // Client tools (function calling); tool_choice stays at the default "auto".
    if (clientTools.length > 0) {
      body.tools = clientTools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: ToolWire.schema(t.inputSchemaJson) },
      }));
    }
    const ordered = [...sent].sort((a, b) => SPEC_ORDER.indexOf(a.key) - SPEC_ORDER.indexOf(b.key));
    return { body, sent: ordered, effort, clientTools: clientTools.length > 0, hasToolHistory };
  }

  /** Tool call ids as this provider accepts them (Mistral: 9 alphanumeric characters). */
  private async wireId(id: string): Promise<string> {
    const raw = isBlank(id) ? 'call_0' : id;
    return this.is(ProviderKinds.MISTRAL) ? ToolWire.mistralId(raw) : raw;
  }

  private async buildMessages(req: ChatRequest, caps: ModelCaps, includeReasoning: boolean): Promise<JsonObject[]> {
    const out: JsonObject[] = [];

    /** Appends a plain message, merging into the previous one of the same role (strict-alternation providers). */
    const addPlain = (role: string, content: unknown) => {
      const last = out[out.length - 1];
      const lastContent = last?.content;
      if (last && last.role === role && role !== 'system' && role !== 'tool' && !('tool_calls' in last) && lastContent != null) {
        out[out.length - 1] = { role, content: mergeContent(lastContent, content) };
      } else {
        out.push({ role, content });
      }
    };

    if (req.system && req.system.trim() !== '') out.push({ role: 'system', content: req.system });
    for (const m of req.messages) {
      if (m.role === 'USER') {
        const results = m.parts.filter((p) => p.type === 'toolResult');
        for (const r of results) {
          out.push({
            role: 'tool',
            tool_call_id: await this.wireId(r.callId),
            content: (r.isError ? 'Error: ' : '') + (isBlank(r.content) ? '(no output)' : r.content),
          });
        }
        const rest = m.parts.filter((p) => p.type !== 'toolResult' && p.type !== 'toolCall');
        if (rest.length > 0 || results.length === 0) addPlain('user', this.userContent(rest, caps));
      } else {
        const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
        const calls = m.parts.filter((p) => p.type === 'toolCall');
        if (calls.length === 0) {
          addPlain('assistant', isBlank(text) ? '(no response)' : text);
        } else {
          const toolCalls: JsonObject[] = [];
          for (const c of calls) {
            toolCalls.push({ id: await this.wireId(c.id), type: 'function', function: { name: c.name, arguments: ToolWire.replayArgs(c.argumentsJson) } });
          }
          const msg: JsonObject = { role: 'assistant', content: text, tool_calls: toolCalls };
          if (includeReasoning) {
            const stored = storedReasoning(m);
            if (stored != null) msg.reasoning_content = stored;
          }
          out.push(msg);
        }
      }
    }
    return out;
  }

  private userContent(parts: Part[], caps: ModelCaps): unknown {
    const hasMedia = parts.some((p) => p.type !== 'text');
    if (!hasMedia) {
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
      return isBlank(text) ? '(empty message)' : text;
    }
    const out: JsonObject[] = [];
    for (const p of parts) {
      switch (p.type) {
        case 'text':
          if (!isBlank(p.text)) out.push({ type: 'text', text: p.text });
          break;
        case 'image':
          out.push({ type: 'image_url', image_url: { url: dataUrl(p.mimeType, p.bytes) } });
          break;
        case 'document':
          if (p.mimeType === 'application/pdf' && (caps.pdf || this.is(ProviderKinds.OPENROUTER))) {
            out.push({ type: 'file', file: { filename: isBlank(p.name) ? 'document.pdf' : p.name, file_data: dataUrl(p.mimeType, p.bytes) } });
          } else if (p.mimeType === 'application/pdf') {
            out.push({ type: 'text', text: `[Attached PDF “${p.name}” can't be read by this model.]` });
          } else {
            out.push({ type: 'text', text: `File: ${p.name}\n\`\`\`\n${fromUtf8(p.bytes)}\n\`\`\`` });
          }
          break;
        default:
          break;
      }
    }
    return out;
  }
}

function minEffort(efforts: Effort[]): Effort | null {
  let min: Effort | null = null;
  for (const e of efforts) if (min == null || EFFORTS.indexOf(e) < EFFORTS.indexOf(min)) min = e;
  return min;
}

function parseUsage(u: JsonObject): Usage {
  return {
    inputTokens: long(u, 'prompt_tokens') ?? long(u, 'input_tokens') ?? 0,
    outputTokens: long(u, 'completion_tokens') ?? long(u, 'output_tokens') ?? 0,
    cacheReadTokens: long(obj(u, 'prompt_tokens_details'), 'cached_tokens') ?? long(u, 'prompt_cache_hit_tokens') ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: long(obj(u, 'completion_tokens_details'), 'reasoning_tokens') ?? 0,
  };
}

/** reasoning_content saved with an OPENAI_CHAT tool step (echoed only when the provider asks for it). */
function storedReasoning(m: ChatMessage): string | null {
  const b = m.blocks;
  if (!b || b.style !== 'OPENAI_CHAT') return null;
  const parsed = tryParseJson(b.json);
  if (!Array.isArray(parsed)) return null;
  for (const el of parsed) {
    const r = str(el, 'reasoning_content');
    if (r != null) return r;
  }
  return '';
}

function mergeContent(a: unknown, b: unknown): unknown {
  if (typeof a === 'string' && typeof b === 'string') return `${a}\n\n${b}`;
  const parts = (e: unknown): unknown[] => (Array.isArray(e) ? e : typeof e === 'string' ? [{ type: 'text', text: e }] : []);
  return [...parts(a), ...parts(b)];
}
