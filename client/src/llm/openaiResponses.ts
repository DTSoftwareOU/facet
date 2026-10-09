/** OpenAI Responses API adapter (`/v1/responses`, stateless `store:false`). Port of OpenAiResponsesClient.kt. */
import { fromUtf8 } from '../core/bytes';
import { isObject } from '../core/json';
import { displayName, hideDatedDuplicates, isOpenAiChatModel, mediaOutput, canRun, openAiCaps } from './catalog';
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
  send,
  sseEvents,
  str,
  timeoutSignal,
  ToolWire,
} from './internal';
import { normalizeBaseUrl } from './providers';
import { applyHeal, diagnose, type HealAction, maxTokensCap, type ParamSpec, recordHeal, resolveEffort } from './quirks';
import {
  type ChatMessage,
  type ChatRequest,
  defaultCaps,
  type Effort,
  EFFORTS,
  EFFORT_INFO,
  emptyUsage,
  type LlmClient,
  LlmException,
  type ModelInfo,
  type ModelOutput,
  type Part,
  type ProviderConfig,
  type QuirkStore,
  type StopReason,
  type StreamEvent,
  type Usage,
  VERBOSITY_INFO,
} from './types';

const MAX_HEALS = 3;
const SHORT_CALL_MS = 60_000;
const SPEC_ORDER = ['summary', 'mode', 'effort', 'verbosity', 'include', 'web_search', 'temperature', 'top_p', 'max_output_tokens', 'reasoning'];

class StreamState {
  started = false;
  finished = false;
  model: string;
  usage: Usage = emptyUsage();
  refusal = false;
  thinkingOpen = false;
  citations = new CitationCollector();
  outputItems: JsonObject[] = [];
  toolCalls = 0;

  constructor(readonly request: ChatRequest) {
    this.model = request.model;
  }
}

interface Built {
  body: JsonObject;
  sent: ParamSpec[];
  effort: Effort | null;
  replayed: boolean;
  clientTools: boolean;
}

export class OpenAiResponsesClient implements LlmClient {
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
    this.base = normalizeBaseUrl(config.baseUrl) || 'https://api.openai.com/v1';
  }

  private headers(extra?: Record<string, string>): Headers {
    return headersOf(
      isBlank(this.config.apiKey) ? null : { Authorization: `Bearer ${this.config.apiKey}` },
      this.config.headers,
      extra,
    );
  }

  private async getText(path: string): Promise<string> {
    try {
      const res = await send(this.fetchFn, `${this.base}/${path}`, { method: 'GET', headers: this.headers(), signal: timeoutSignal(SHORT_CALL_MS) });
      return await readText(res);
    } catch (e) {
      if (e instanceof HttpStatusError) throw new LlmException(fromHttp(this.config, null, e));
      throw new LlmException(fromNetwork(this.config, e));
    }
  }

  // ------------------------------------------------------------------ models

  async listModels(): Promise<ModelInfo[]> {
    const data = arr(parseObject(await this.getText('models')), 'data');
    if (!data) return [];
    const kind = this.config.kind;
    // Chat models, plus image, speech and transcription models (sorted into their kind).
    const entries: { id: string; created: number | null; output: ModelOutput }[] = [];
    for (const m of data) {
      const id = str(m, 'id');
      if (id == null) continue;
      const media = mediaOutput(kind, id);
      const output: ModelOutput | null = isOpenAiChatModel(id) ? 'TEXT' : media != null && canRun(kind, media) ? media : null;
      if (output) entries.push({ id, created: long(m, 'created'), output });
    }
    const visible = hideDatedDuplicates(entries.map((e) => e.id));
    return entries
      .filter((e) => visible.has(e.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map(({ id, created, output }) => ({
        id,
        displayName: displayName(kind, id),
        contextWindow: null,
        maxOutput: null,
        caps: output === 'TEXT' ? openAiCaps(id) : defaultCaps({ tools: false }),
        pricing: this.pricing?.priceFor(kind, id) ?? null,
        createdAt: created != null ? created * 1000 : null,
        output,
      }));
  }

  async verify(): Promise<void> {
    await this.getText('models');
  }

  // ------------------------------------------------------------------ streaming

  async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const config = this.config;
    const dropped = new Set(this.quirks.dropped(config.id, request.model));
    let heals = 0;
    let noReplay = false;
    try {
      while (true) {
        if (signal?.aborted) return;
        const built = this.buildBody(request, dropped, noReplay);
        let res: Response;
        try {
          res = await send(this.fetchFn, `${this.base}/responses`, {
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
          const lower = msg.toLowerCase();
          // Replayed items (encrypted reasoning, item ids) can expire or belong to another org: resend as plain text.
          if (e.status === 400 && built.replayed && !noReplay &&
            (lower.includes('item') || lower.includes('encrypted') || lower.includes('rs_') || lower.includes('msg_') || lower.includes('ws_'))) {
            noReplay = true;
            continue;
          }
          if ((e.status === 400 || e.status === 403 || e.status === 422) && heals < MAX_HEALS) {
            let action: HealAction | null = null;
            if (lower.includes('verif') && lower.includes('summar') && built.sent.some((s) => s.key === 'summary')) {
              // Reasoning summaries need a verified organization; answer without them.
              action = { type: 'drop', key: 'summary' };
            } else if (built.clientTools && ToolWire.toolsUnsupported(msg)) {
              action = { type: 'drop', key: 'tools' };
            } else if (e.status !== 403) {
              action = diagnose(msg, built.sent, built.effort, request.caps.reasoning.efforts);
            }
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
      const json = parseObject(ev.data);
      if (!json) continue;
      const type = str(json, 'type') ?? ev.event;
      switch (type) {
        case 'response.created':
        case 'response.in_progress':
          if (!s.started) {
            s.started = true;
            const model = str(obj(json, 'response'), 'model');
            if (model != null) s.model = model;
            yield { type: 'started', model: s.model };
          }
          break;
        case 'response.output_item.added': {
          const item = obj(json, 'item');
          if (!item) break;
          switch (str(item, 'type')) {
            case 'reasoning':
              if (!s.thinkingOpen) {
                s.thinkingOpen = true;
                yield { type: 'thinkingStarted' };
              }
              break;
            case 'web_search_call':
              yield { type: 'webSearch', query: str(obj(item, 'action'), 'query'), done: false };
              break;
            case 'function_call':
              yield { type: 'toolCallStarted', id: str(item, 'call_id') ?? str(item, 'id') ?? '', name: str(item, 'name') ?? '' };
              break;
          }
          break;
        }
        case 'response.reasoning_summary_part.added':
          if ((long(json, 'summary_index') ?? 0) > 0) yield { type: 'thinking', text: '\n\n' };
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          const d = str(json, 'delta');
          if (d) {
            if (!s.thinkingOpen) {
              s.thinkingOpen = true;
              yield { type: 'thinkingStarted' };
            }
            yield { type: 'thinking', text: d };
          }
          break;
        }
        case 'response.output_item.done': {
          const item = obj(json, 'item');
          if (!item) break;
          s.outputItems.push(item);
          switch (str(item, 'type')) {
            case 'reasoning':
              if (s.thinkingOpen) {
                s.thinkingOpen = false;
                yield { type: 'thinkingEnded' };
              }
              break;
            case 'function_call':
              s.toolCalls++;
              yield {
                type: 'toolCallReady',
                id: str(item, 'call_id') ?? str(item, 'id') ?? '',
                name: str(item, 'name') ?? '',
                argumentsJson: ToolWire.normalizeArgs(str(item, 'arguments') ?? ''),
              };
              break;
            case 'web_search_call': {
              const action = obj(item, 'action');
              yield { type: 'webSearch', query: str(action, 'query'), done: true };
              let changed = false;
              for (const src of arr(action, 'sources') ?? []) changed = s.citations.add(str(src, 'url'), str(src, 'title')) || changed;
              if (changed) yield { type: 'citations', citations: s.citations.snapshot() };
              break;
            }
            case 'message': {
              let changed = false;
              for (const part of arr(item, 'content') ?? []) {
                for (const a of arr(part, 'annotations') ?? []) {
                  if (str(a, 'type') === 'url_citation') changed = s.citations.add(str(a, 'url'), str(a, 'title')) || changed;
                }
              }
              if (changed) yield { type: 'citations', citations: s.citations.snapshot() };
              break;
            }
          }
          break;
        }
        case 'response.output_text.delta': {
          if (s.thinkingOpen) {
            s.thinkingOpen = false;
            yield { type: 'thinkingEnded' };
          }
          const d = str(json, 'delta');
          if (d) yield { type: 'text', text: d };
          break;
        }
        case 'response.refusal.delta': {
          s.refusal = true;
          const d = str(json, 'delta');
          if (d) yield { type: 'text', text: d };
          break;
        }
        case 'response.output_text.annotation.added': {
          const a = obj(json, 'annotation');
          if (a && str(a, 'type') === 'url_citation' && s.citations.add(str(a, 'url'), str(a, 'title'))) {
            yield { type: 'citations', citations: s.citations.snapshot() };
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          const response = obj(json, 'response');
          const usage = obj(response, 'usage');
          if (usage) {
            s.usage = parseUsage(usage);
            yield { type: 'usage', usage: s.usage };
          }
          if (s.thinkingOpen) {
            s.thinkingOpen = false;
            yield { type: 'thinkingEnded' };
          }
          const reason = str(obj(response, 'incomplete_details'), 'reason');
          const output = arr(response, 'output');
          let stop: StopReason;
          if (type === 'response.incomplete' && reason === 'content_filter') stop = 'REFUSAL';
          else if (type === 'response.incomplete') stop = 'MAX_TOKENS';
          else if (s.refusal) stop = 'REFUSAL';
          else if (s.toolCalls > 0 || (output ?? []).some((it) => str(it, 'type') === 'function_call')) stop = 'TOOL_USE';
          else stop = 'END';
          if (stop === 'REFUSAL') yield { type: 'notice', text: `${s.model} declined to answer this request.` };
          const items = output && output.length > 0 ? output : s.outputItems;
          s.finished = true;
          yield {
            type: 'completed',
            stopReason: stop,
            blocks: { style: 'OPENAI_RESPONSES', model: str(response, 'model') ?? s.model, json: JSON.stringify(items) },
          };
          break;
        }
        case 'response.failed': {
          const err = obj(obj(json, 'response'), 'error');
          s.finished = true;
          yield { type: 'failed', error: fromStream(this.config, s.request.model, str(err, 'code'), str(err, 'message')) };
          break;
        }
        case 'error': {
          const err = obj(json, 'error') ?? json;
          s.finished = true;
          yield { type: 'failed', error: fromStream(this.config, s.request.model, str(err, 'code') ?? str(err, 'type'), str(err, 'message')) };
          break;
        }
        default:
          break;
      }
    }
    if (signal?.aborted) return;
    if (!s.finished) yield { type: 'failed', error: truncatedStream(this.config) };
  }

  // ------------------------------------------------------------------ request body

  private buildBody(req: ChatRequest, dropped: Set<string>, noReplay: boolean): Built {
    const caps = req.caps;
    const sent: ParamSpec[] = [];
    const reasoningModel = caps.reasoning.kind === 'EFFORT';
    const utility = req.utility === true;
    let replayed = false;
    const clientTools = !utility && caps.tools && !dropped.has('tools') ? req.tools : [];

    const input: JsonObject[] = [];
    for (const m of req.messages) {
      if (m.role === 'USER') {
        const results = m.parts.filter((p) => p.type === 'toolResult');
        for (const r of results) {
          input.push({ type: 'function_call_output', call_id: r.callId, output: r.isError ? 'Error: ' + r.content : r.content });
        }
        const rest = m.parts.filter((p) => p.type !== 'toolResult' && p.type !== 'toolCall');
        if (rest.length > 0 || results.length === 0) input.push({ role: 'user', content: userContent(rest) });
      } else {
        const items = noReplay ? null : replayItems(m, req.model);
        if (items) {
          replayed = true;
          input.push(...items);
        } else {
          const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
          const calls = m.parts.filter((p) => p.type === 'toolCall');
          if (!isBlank(text) || calls.length === 0) {
            input.push({ role: 'assistant', content: [{ type: 'output_text', text: isBlank(text) ? '(no response)' : text }] });
          }
          for (const c of calls) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: ToolWire.replayArgs(c.argumentsJson) });
        }
      }
    }

    let effort: Effort | null = null;
    const body: JsonObject = { model: req.model, stream: true, store: false };
    if (req.system && req.system.trim() !== '') body.instructions = req.system;
    body.input = input;

    if (reasoningModel && !dropped.has('reasoning')) {
      const supported = caps.reasoning.efforts;
      const requested: Effort | null = utility ? (minEffort(supported) ?? 'LOW') : (req.params.effort ?? null);
      if (requested === 'NONE') {
        effort = supported.includes('NONE') && !dropped.has('effort:none') && !dropped.has('effort') ? 'NONE' : resolveEffort('MINIMAL', supported, dropped);
      } else {
        effort = resolveEffort(requested, supported, dropped);
      }
      const summary = req.params.showThinking && !utility && caps.reasoning.summaries && !dropped.has('summary') && effort !== 'NONE';
      const pro = req.params.proMode && caps.proMode && !utility && !dropped.has('mode');
      if (effort != null || summary || pro) {
        const reasoning: JsonObject = {};
        if (effort != null) reasoning.effort = EFFORT_INFO[effort].wire;
        if (summary) reasoning.summary = 'auto';
        if (pro) reasoning.mode = 'pro';
        body.reasoning = reasoning;
        if (effort != null) sent.push({ key: 'effort', tokens: ['reasoning.effort', 'reasoning_effort', 'effort'] });
        if (summary) sent.push({ key: 'summary', tokens: ['reasoning.summary', 'summary'] });
        if (pro) sent.push({ key: 'mode', tokens: ['reasoning.mode', 'mode'] });
        sent.push({ key: 'reasoning', tokens: ['reasoning'] });
      }
      if (!dropped.has('include')) {
        body.include = ['reasoning.encrypted_content'];
        sent.push({ key: 'include', tokens: ['include', 'encrypted_content'] });
      }
    }
    if (caps.verbosity && !utility && !dropped.has('verbosity') && req.params.verbosity) {
      body.text = { verbosity: VERBOSITY_INFO[req.params.verbosity].wire };
      sent.push({ key: 'verbosity', tokens: ['text.verbosity', 'verbosity'] });
    }
    const webSearch = req.params.webSearch && caps.webSearch && !utility && !dropped.has('web_search');
    if (webSearch || clientTools.length > 0) {
      const tools: JsonObject[] = [];
      if (webSearch) tools.push({ type: 'web_search' });
      for (const t of clientTools) {
        tools.push({ type: 'function', name: t.name, description: t.description, parameters: ToolWire.schema(t.inputSchemaJson), strict: false });
      }
      body.tools = tools;
      // With client tools present, a generic "tools" error isn't evidence against web search.
      if (webSearch) sent.push({ key: 'web_search', tokens: clientTools.length === 0 ? ['web_search', 'tools'] : ['web_search'] });
    }
    const cap = maxTokensCap(dropped);
    const max = req.params.maxOutputTokens ?? (utility ? (reasoningModel ? 2_048 : 256) : null);
    const finalMax = max != null && cap != null ? Math.min(max, cap) : (max ?? cap);
    if (finalMax != null && !dropped.has('max_output_tokens')) {
      body.max_output_tokens = Math.max(16, finalMax);
      sent.push({ key: 'max_output_tokens', tokens: ['max_output_tokens'] });
    }
    if (caps.sampling && !reasoningModel) {
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
    const ordered = [...sent].sort((a, b) => SPEC_ORDER.indexOf(a.key) - SPEC_ORDER.indexOf(b.key));
    return { body, sent: ordered, effort, replayed, clientTools: clientTools.length > 0 };
  }
}

function minEffort(efforts: Effort[]): Effort | null {
  let min: Effort | null = null;
  for (const e of efforts) if (min == null || EFFORTS.indexOf(e) < EFFORTS.indexOf(min)) min = e;
  return min;
}

function parseUsage(u: JsonObject): Usage {
  return {
    inputTokens: long(u, 'input_tokens') ?? 0,
    outputTokens: long(u, 'output_tokens') ?? 0,
    cacheReadTokens: long(obj(u, 'input_tokens_details'), 'cached_tokens') ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: long(obj(u, 'output_tokens_details'), 'reasoning_tokens') ?? 0,
  };
}

/** Stored output items replay only to the model that produced them (encrypted reasoning is model-bound). */
function replayItems(m: ChatMessage, model: string): JsonObject[] | null {
  const b = m.blocks;
  if (!b || b.style !== 'OPENAI_RESPONSES' || b.model !== model) return null;
  const parsed = tryParseJson(b.json);
  if (!Array.isArray(parsed)) return null;
  const items = parsed.filter(isObject);
  return items.some((it) => str(it, 'type') === 'message' || str(it, 'type') === 'function_call') ? items : null;
}

function userContent(parts: Part[]): JsonObject[] {
  const out: JsonObject[] = [];
  for (const p of parts) {
    switch (p.type) {
      case 'text':
        if (!isBlank(p.text)) out.push({ type: 'input_text', text: p.text });
        break;
      case 'image':
        out.push({ type: 'input_image', image_url: dataUrl(p.mimeType, p.bytes) });
        break;
      case 'document':
        if (p.mimeType === 'application/pdf') {
          out.push({ type: 'input_file', filename: isBlank(p.name) ? 'document.pdf' : p.name, file_data: dataUrl(p.mimeType, p.bytes) });
        } else {
          out.push({ type: 'input_text', text: `File: ${p.name}\n\`\`\`\n${fromUtf8(p.bytes)}\n\`\`\`` });
        }
        break;
      default:
        break;
    }
  }
  return out.length === 0 ? [{ type: 'input_text', text: '(empty message)' }] : out;
}
