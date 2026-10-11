/**
 * Provider-agnostic contract between the chat engine/UI and provider adapters (port of
 * LlmTypes.kt). Enum-like string unions use the Android enum NAMES, because they are stored in
 * synced JSON (GenParams, ModelInfo, ProviderBlocks) that both apps read and write.
 */
import { msg, type Msg } from '../i18n';
import type { ProviderKind } from './providers';

/** Wire protocol a provider speaks. MEDIA providers make images, video, speech, music or transcripts, but no chat. */
export type ApiStyle = 'ANTHROPIC' | 'OPENAI_RESPONSES' | 'OPENAI_CHAT' | 'MEDIA';

/** A configured provider instance (one API key). Secrets are decrypted only in memory. */
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
}

/** Reasoning effort levels across providers. Not every model supports every level. */
export type Effort = 'NONE' | 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH' | 'MAX';
export const EFFORTS: readonly Effort[] = ['NONE', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX'];
/** `label` is shown with tm(). */
export const EFFORT_INFO: Record<Effort, { wire: string; label: Msg }> = {
  NONE: { wire: 'none', label: msg('Off') },
  MINIMAL: { wire: 'minimal', label: msg('Minimal') },
  LOW: { wire: 'low', label: msg('Low') },
  MEDIUM: { wire: 'medium', label: msg('Medium') },
  HIGH: { wire: 'high', label: msg('High') },
  XHIGH: { wire: 'xhigh', label: msg('Extra high') },
  MAX: { wire: 'max', label: msg('Max') },
};

export type Verbosity = 'LOW' | 'MEDIUM' | 'HIGH';
/** `label` is shown with tm(). */
export const VERBOSITY_INFO: Record<Verbosity, { wire: string; label: Msg }> = {
  LOW: { wire: 'low', label: msg('Concise') },
  MEDIUM: { wire: 'medium', label: msg('Balanced') },
  HIGH: { wire: 'high', label: msg('Detailed') },
};

/**
 * How a model exposes reasoning control. NONE: no control. EFFORT: discrete levels (OpenAI
 * reasoning.effort, Anthropic output_config.effort, compat reasoning_effort). BUDGET: token
 * budget (older Anthropic models: thinking.type=enabled + budget_tokens); levels map to budgets.
 */
export type ReasoningKind = 'NONE' | 'EFFORT' | 'BUDGET';

export interface ReasoningSupport {
  kind: ReasoningKind;
  /** Supported effort levels, ascending. Empty when kind is NONE. */
  efforts: Effort[];
  /** Provider default level, if known. */
  defaultEffort?: Effort | null;
  /** Whether the model streams readable reasoning summaries/thinking text. */
  summaries: boolean;
}

export interface ModelCaps {
  vision: boolean;
  pdf: boolean;
  reasoning: ReasoningSupport;
  webSearch: boolean;
  /** Accepts temperature/top_p. */
  sampling: boolean;
  /** OpenAI text.verbosity. */
  verbosity: boolean;
  /** OpenAI reasoning.mode = "pro". */
  proMode: boolean;
  /** Anthropic speed = "fast" (premium pricing). */
  fastMode: boolean;
  /** Anthropic server-side refusal fallbacks ("fallbacks": "default"). */
  refusalFallback: boolean;
  /** Supports function/tool calling (client tools: Facet search, MCP, skills, computer). */
  tools: boolean;
}

export const NO_REASONING: ReasoningSupport = { kind: 'NONE', efforts: [], defaultEffort: null, summaries: false };

export function defaultCaps(over: Partial<ModelCaps> = {}): ModelCaps {
  return {
    vision: false,
    pdf: false,
    reasoning: NO_REASONING,
    webSearch: false,
    sampling: true,
    verbosity: false,
    proMode: false,
    fastMode: false,
    refusalFallback: false,
    tools: true,
    ...over,
  };
}

/** Fills missing fields of caps read from JSON written by any app version. */
export function normalizeCaps(raw: unknown): ModelCaps {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<ModelCaps>;
  const r = (c.reasoning ?? {}) as Partial<ReasoningSupport>;
  return defaultCaps({
    ...c,
    reasoning: {
      kind: r.kind ?? 'NONE',
      efforts: Array.isArray(r.efforts) ? r.efforts : [],
      defaultEffort: r.defaultEffort ?? null,
      summaries: r.summaries ?? false,
    },
  });
}

/** USD per 1M tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number | null;
  cacheWrite?: number | null;
}

/** What a model produces. Chat pickers list TEXT models; the others are media models chosen in Settings. */
export type ModelOutput = 'TEXT' | 'IMAGE' | 'VIDEO' | 'SPEECH' | 'MUSIC' | 'TRANSCRIPTION';
/** `label` is shown with tm(); `noun` and `what` are English, for file names and model-facing text. */
export const MODEL_OUTPUT_INFO: Record<ModelOutput, { label: Msg; noun: string; what: string }> = {
  TEXT: { label: msg('Chat'), noun: 'chat', what: 'chat' },
  IMAGE: { label: msg('Images'), noun: 'image', what: 'images' },
  VIDEO: { label: msg('Video'), noun: 'video', what: 'video' },
  SPEECH: { label: msg('Speech'), noun: 'speech', what: 'speech' },
  MUSIC: { label: msg('Music & sound'), noun: 'music', what: 'music' },
  TRANSCRIPTION: { label: msg('Transcription'), noun: 'transcription', what: 'transcripts' },
};

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow?: number | null;
  maxOutput?: number | null;
  caps: ModelCaps;
  pricing?: ModelPricing | null;
  createdAt?: number | null;
  output: ModelOutput;
}

/** Fills missing fields of a ModelInfo read from JSON. */
export function normalizeModel(raw: any): ModelInfo {
  return {
    id: String(raw?.id ?? ''),
    displayName: String(raw?.displayName ?? raw?.id ?? ''),
    contextWindow: raw?.contextWindow ?? null,
    maxOutput: raw?.maxOutput ?? null,
    caps: normalizeCaps(raw?.caps),
    pricing: raw?.pricing ?? null,
    createdAt: raw?.createdAt ?? null,
    output: raw?.output ?? 'TEXT',
  };
}

/** Per-conversation generation settings. Null/undefined = provider default. */
export interface GenParams {
  effort?: Effort | null;
  showThinking: boolean;
  verbosity?: Verbosity | null;
  proMode: boolean;
  fastMode: boolean;
  temperature?: number | null;
  topP?: number | null;
  maxOutputTokens?: number | null;
  webSearch: boolean;
  /** Offer MCP tools and skills to the model in this chat. */
  tools: boolean;
  /** MCP server ids turned off for this chat. */
  disabledMcpServers: string[];
}

export function defaultParams(over: Partial<GenParams> = {}): GenParams {
  return {
    effort: null,
    showThinking: true,
    verbosity: null,
    proMode: false,
    fastMode: false,
    temperature: null,
    topP: null,
    maxOutputTokens: null,
    webSearch: false,
    tools: true,
    disabledMcpServers: [],
    ...over,
  };
}

export function parseParams(json: string | null | undefined): GenParams {
  if (!json) return defaultParams();
  try {
    const raw = JSON.parse(json);
    return defaultParams(raw && typeof raw === 'object' ? raw : {});
  } catch {
    return defaultParams();
  }
}

export type Role = 'USER' | 'ASSISTANT';

export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; bytes: Uint8Array }
  /** PDF or other document the provider can read natively. */
  | { type: 'document'; mimeType: string; name: string; bytes: Uint8Array }
  /** Assistant side: the model asked to call a client tool. argumentsJson is a JSON object string. */
  | { type: 'toolCall'; id: string; name: string; argumentsJson: string }
  /** User side: the result of a client tool call, paired with the toolCall id. */
  | { type: 'toolResult'; callId: string; name: string; content: string; isError: boolean };

/**
 * A client-side tool the model may call. inputSchemaJson is a JSON Schema object (as a JSON
 * string) describing the arguments. Names match ^[a-zA-Z0-9_-]{1,64}$.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchemaJson: string;
}

/**
 * Raw provider content kept so a turn can be replayed losslessly to the same provider
 * (Anthropic thinking blocks with signatures, OpenAI reasoning items with encrypted content).
 * json is a JSON array string: Anthropic `content` blocks or OpenAI Responses `output` items.
 */
export interface ProviderBlocks {
  style: ApiStyle;
  model: string;
  json: string;
}

export interface ChatMessage {
  role: Role;
  parts: Part[];
  blocks?: ProviderBlocks | null;
}

export interface ChatRequest {
  model: string;
  system?: string | null;
  messages: ChatMessage[];
  params: GenParams;
  caps: ModelCaps;
  /** Used for short utility calls (titles): no thinking, low effort, small output. */
  utility?: boolean;
  /** The model's output-token ceiling from ModelInfo.maxOutput, used to size max_tokens when unset. */
  modelMaxOutput?: number | null;
  /** Client tools offered to the model. Empty = no function calling. */
  tools: ToolSpec[];
}

export interface Citation {
  url: string;
  title?: string | null;
  snippet?: string | null;
}

/**
 * Token usage for one assistant turn, normalized across providers: inputTokens counts ALL prompt
 * tokens including cache reads and writes; outputTokens includes reasoningTokens.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/** TOOL_USE: the model stopped to call client tools; run them and continue the turn. */
export type StopReason = 'END' | 'MAX_TOKENS' | 'REFUSAL' | 'CANCELLED' | 'ERROR' | 'TOOL_USE';

export type ErrorKind =
  | 'AUTH' | 'PERMISSION' | 'RATE_LIMIT' | 'QUOTA' | 'CONTEXT_LENGTH' | 'BAD_REQUEST' | 'NOT_FOUND'
  | 'OVERLOADED' | 'SERVER' | 'NETWORK' | 'TIMEOUT' | 'REFUSAL' | 'UNKNOWN'
  /** The provider doesn't accept requests from web pages (no CORS); use the desktop or Android app. */
  | 'BROWSER_BLOCKED';

export interface LlmError {
  kind: ErrorKind;
  /** User-facing sentence: what happened and what to do. */
  message: string;
  httpStatus?: number | null;
  retryAfterSeconds?: number | null;
  /** Raw provider message for the details view. */
  detail?: string | null;
}

export class LlmException extends Error {
  constructor(readonly error: LlmError) {
    super(error.message);
    this.name = 'LlmException';
  }
}

export type StreamEvent =
  /** Request accepted; model is the model actually serving (may differ after a fallback). */
  | { type: 'started'; model: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  /** Model is reasoning but not exposing text (hidden/omitted thinking). */
  | { type: 'thinkingStarted' }
  | { type: 'thinkingEnded' }
  | { type: 'webSearch'; query: string | null; done: boolean }
  /** Cumulative, de-duplicated list of sources seen so far this turn (replace, don't append). */
  | { type: 'citations'; citations: Citation[] }
  /** Cumulative usage for the turn so far (replace, don't add). */
  | { type: 'usage'; usage: Usage }
  /** Informational, e.g. "Answered by claude-opus-4-8 after a refusal fallback." */
  | { type: 'notice'; text: string }
  /** The model began writing a call to client tool `name` (arguments still streaming). */
  | { type: 'toolCallStarted'; id: string; name: string }
  /** A complete client tool call. All calls of a step arrive before `completed` with TOOL_USE. */
  | { type: 'toolCallReady'; id: string; name: string; argumentsJson: string }
  | { type: 'completed'; stopReason: StopReason; blocks: ProviderBlocks | null }
  | { type: 'failed'; error: LlmError };

export interface LlmClient {
  readonly config: ProviderConfig;

  /** Lists models with capabilities (live metadata when the provider exposes it). */
  listModels(): Promise<ModelInfo[]>;

  /**
   * Streams one assistant turn. Iterating starts the request; aborting `signal` cancels it.
   * Always ends with exactly one `completed` or `failed` event (unless aborted, which ends the
   * iteration without a terminal event).
   */
  stream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;

  /** Cheap authenticated call to validate the key. Throws LlmException on failure. */
  verify(): Promise<void>;
}

/** Remembers request parameters a given model rejected, so retries and future calls omit them. */
export interface QuirkStore {
  dropped(providerId: string, model: string): Set<string>;
  markDropped(providerId: string, model: string, param: string): void;
}
