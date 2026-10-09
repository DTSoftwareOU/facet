/**
 * Capability inference and display names for model ids (port of ModelCatalog.kt). Live metadata
 * (Anthropic Models API, OpenRouter /models) wins where available; these heuristics fill the gaps,
 * and the adapters' self-healing retry corrects any wrong guess at request time.
 * Import as a namespace (`import * as ModelCatalog from './catalog'`) to mirror the Android calls.
 */
import { MEDIA_NAMES } from './media/catalog';
import { ProviderKinds, type ProviderKind } from './providers';
import {
  defaultCaps,
  NO_REASONING,
  type Effort,
  type ModelCaps,
  type ModelInfo,
  type ReasoningKind,
  type ReasoningSupport,
} from './types';

/** A ModelInfo with the Android defaults for unspecified fields. */
export function modelInfo(id: string, displayName: string, over: Partial<ModelInfo> = {}): ModelInfo {
  return { id, displayName, contextWindow: null, maxOutput: null, caps: defaultCaps(), pricing: null, createdAt: null, output: 'TEXT', ...over };
}

function reasoning(kind: ReasoningKind = 'NONE', efforts: Effort[] = [], defaultEffort: Effort | null = null, summaries = false): ReasoningSupport {
  return { kind, efforts, defaultEffort, summaries };
}

const is = (kind: ProviderKind, other: ProviderKind): boolean => kind.id === other.id;

// ---------------------------------------------------------------- Claude

export type ClaudeTier = 'OPUS' | 'SONNET' | 'HAIKU' | 'FABLE' | 'MYTHOS';

/** How a Claude model turns thinking off for effort NONE. */
export type ThinkingOff = 'DISABLED' | 'BETWEEN_TOOLS' | 'OMIT' | 'CANNOT';

const FULL_EFFORT: Effort[] = ['LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX'];
const BUDGET_LEVELS: Effort[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'MAX'];

export class ClaudeModel {
  constructor(
    readonly tier: ClaudeTier,
    readonly major: number,
    readonly minor: number,
  ) {}

  get version(): number {
    return this.major + this.minor / 10;
  }

  atLeast(maj: number, min = 0): boolean {
    return this.major > maj || (this.major === maj && this.minor >= min);
  }

  get adaptive(): boolean {
    switch (this.tier) {
      case 'FABLE':
      case 'MYTHOS':
        return true;
      case 'OPUS':
      case 'SONNET':
        return this.atLeast(4, 6);
      case 'HAIKU':
        return this.atLeast(5);
    }
  }

  /** Older models with manual `budget_tokens` extended thinking. */
  get budgetThinking(): boolean {
    if (this.adaptive) return false;
    switch (this.tier) {
      case 'OPUS':
        return this.atLeast(4);
      case 'SONNET':
        return this.atLeast(3, 7);
      case 'HAIKU':
        return this.atLeast(4, 5);
      default:
        return false;
    }
  }

  /** Thinking runs when `thinking` is omitted. */
  get thinkingOnByDefault(): boolean {
    return this.tier === 'FABLE' || this.tier === 'MYTHOS' || this.atLeast(5);
  }

  get thinkingOff(): ThinkingOff {
    switch (this.tier) {
      case 'FABLE':
      case 'MYTHOS':
        return 'CANNOT';
      case 'OPUS':
        return this.atLeast(5, 5) ? 'CANNOT' : this.atLeast(4, 7) ? 'DISABLED' : 'OMIT';
      case 'SONNET':
        return this.atLeast(5, 5) ? 'BETWEEN_TOOLS' : this.atLeast(5) ? 'DISABLED' : 'OMIT';
      case 'HAIKU':
        return this.atLeast(5) ? 'DISABLED' : 'OMIT';
    }
  }

  get defaultEffort(): Effort {
    if (this.tier === 'OPUS' && this.atLeast(5, 5)) return 'MEDIUM';
    if (this.tier === 'HAIKU' && this.atLeast(5)) return 'MEDIUM';
    return 'HIGH';
  }

  get effortLevels(): Effort[] {
    const t = this.tier;
    if (t === 'FABLE' || t === 'MYTHOS') return FULL_EFFORT;
    if (t === 'OPUS' && this.atLeast(4, 7)) return FULL_EFFORT;
    if (t === 'OPUS' && this.atLeast(4, 6)) return ['LOW', 'MEDIUM', 'HIGH', 'MAX'];
    if (t === 'SONNET' && this.atLeast(5)) return FULL_EFFORT;
    if (t === 'SONNET' && this.atLeast(4, 6)) return ['LOW', 'MEDIUM', 'HIGH', 'MAX'];
    if (t === 'HAIKU' && this.atLeast(5)) return FULL_EFFORT;
    return [];
  }

  /** temperature / top_p accepted (removed from Opus 4.7+, Sonnet 5+, Haiku 5+, Fable). */
  get sampling(): boolean {
    switch (this.tier) {
      case 'OPUS':
      case 'SONNET':
        return !this.atLeast(4, 7) && !(this.tier === 'SONNET' && this.atLeast(5));
      case 'HAIKU':
        return !this.atLeast(5);
      default:
        return false;
    }
  }

  get fastMode(): boolean {
    return this.tier === 'OPUS' && this.atLeast(4, 8);
  }

  get refusalFallback(): boolean {
    switch (this.tier) {
      case 'FABLE':
        return true;
      case 'OPUS':
        return this.atLeast(5);
      case 'SONNET':
        return this.atLeast(5, 5);
      default:
        return false;
    }
  }

  /** Supports `web_search_20260209` (dynamic filtering). */
  get webSearchV2(): boolean {
    return (this.tier === 'OPUS' || this.tier === 'SONNET') && this.atLeast(4, 6);
  }

  get defaultMaxOutput(): number {
    const t = this.tier;
    if (t === 'FABLE' || t === 'MYTHOS') return 128_000;
    if ((t === 'OPUS' || t === 'SONNET') && this.atLeast(4, 6)) return 128_000;
    if (t === 'HAIKU' && this.atLeast(5)) return 128_000;
    if (t === 'HAIKU' && this.atLeast(4, 5)) return 64_000;
    if (t === 'SONNET' && this.atLeast(3, 7)) return 64_000;
    if (t === 'OPUS' && this.atLeast(4, 5)) return 64_000;
    if (t === 'OPUS' && this.atLeast(4)) return 32_000;
    return 8_192;
  }
}

const CLAUDE_NEW = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?=-|$)/;
const CLAUDE_OLD = /claude-(\d+)(?:-(\d))?-(opus|sonnet|haiku)/;

export function parseClaude(id: string): ClaudeModel | null {
  const s = afterLast(id.toLowerCase(), '/');
  const m = CLAUDE_NEW.exec(s);
  if (m) return new ClaudeModel(m[1].toUpperCase() as ClaudeTier, Number(m[2]), m[3] ? Number(m[3]) : 0);
  const o = CLAUDE_OLD.exec(s);
  if (o) return new ClaudeModel(o[3].toUpperCase() as ClaudeTier, Number(o[1]), o[2] ? Number(o[2]) : 0);
  return null;
}

/** Heuristic Claude capabilities, used when the Models API omits `capabilities`. */
export function claudeCaps(id: string): ModelCaps {
  const c = parseClaude(id);
  if (!c) return defaultCaps({ vision: true, pdf: true, webSearch: true, sampling: true });
  let r: ReasoningSupport;
  if (c.adaptive) {
    const levels = c.effortLevels;
    r = reasoning(
      'EFFORT',
      [...(c.thinkingOff !== 'CANNOT' ? (['NONE'] as Effort[]) : []), ...(levels.length > 0 ? levels : (['HIGH'] as Effort[]))],
      c.thinkingOnByDefault ? c.defaultEffort : 'NONE',
      true,
    );
  } else if (c.budgetThinking) {
    r = reasoning('BUDGET', [...BUDGET_LEVELS], 'NONE', true);
  } else {
    r = NO_REASONING;
  }
  return defaultCaps({
    vision: c.major >= 3,
    pdf: c.major >= 3,
    reasoning: r,
    webSearch: true,
    sampling: c.sampling,
    fastMode: c.fastMode,
    refusalFallback: c.refusalFallback,
  });
}

/** Merges Anthropic Models API `capabilities` with family knowledge. */
export function claudeCapsFromApi(
  id: string,
  imageInput: boolean | null,
  adaptive: boolean | null,
  enabled: boolean | null,
  effortLevels: Effort[] | null,
): ModelCaps {
  const base = claudeCaps(id);
  const c = parseClaude(id);
  const canOff = c ? c.thinkingOff !== 'CANNOT' : true;
  let r: ReasoningSupport;
  if (adaptive === true) {
    const known = effortLevels ?? c?.effortLevels ?? [];
    const levels: Effort[] = known.length > 0 ? known : ['HIGH'];
    r = reasoning(
      'EFFORT',
      [...(canOff ? (['NONE'] as Effort[]) : []), ...levels],
      c?.thinkingOnByDefault === true ? (levels.includes(c.defaultEffort) ? c.defaultEffort : levels[levels.length - 1]) : 'NONE',
      true,
    );
  } else if (enabled === true) {
    r = reasoning('BUDGET', [...BUDGET_LEVELS], 'NONE', true);
  } else if (adaptive === false && enabled === false) {
    r = NO_REASONING;
  } else {
    r = base.reasoning;
  }
  return { ...base, vision: imageInput ?? base.vision, pdf: imageInput ?? base.pdf, reasoning: r };
}

// ---------------------------------------------------------------- OpenAI

const DATE_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;
const OPENAI_EXCLUDE = [
  'embedding', 'tts', 'whisper', 'transcribe', 'dall-e', 'gpt-image', 'image', 'moderation',
  'realtime', 'audio', 'search-preview', 'search-api', 'computer-use', 'babbage', 'davinci',
  'instruct', 'sora', 'deep-research', 'codex-mini-latest', 'omni',
];

export function isOpenAiChatModel(id: string): boolean {
  const s = id.toLowerCase();
  if (OPENAI_EXCLUDE.some((x) => s.includes(x))) return false;
  if (s.startsWith('ft:')) return true;
  return s.startsWith('gpt-') || s.startsWith('chatgpt-') || /^o\d/.test(s);
}

/** Drops dated snapshots when the undated alias is also listed. */
export function hideDatedDuplicates(ids: Iterable<string>): Set<string> {
  const set = new Set(ids);
  const out = new Set<string>();
  for (const id of set) {
    const m = DATE_SUFFIX.exec(id);
    if (!m || !set.has(id.slice(0, m.index) + id.slice(m.index + m[0].length))) out.add(id);
  }
  return out;
}

interface OaVersion {
  major: number;
  minor: number;
  atLeast(maj: number, min?: number): boolean;
}

function gptVersion(s: string): OaVersion | null {
  const m = /^gpt-(\d+)(?:\.(\d+))?/.exec(s);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] ? Number(m[2]) : 0;
  return { major, minor, atLeast: (maj, min = 0) => major > maj || (major === maj && minor >= min) };
}

export function openAiCaps(id: string): ModelCaps {
  const s = removePrefix(id.toLowerCase(), 'openai/');
  if (/^o(\d+)/.test(s)) {
    const miniOld = s.startsWith('o1-mini') || s.startsWith('o3-mini');
    const pro = s.includes('-pro');
    return defaultCaps({
      // The first o1 previews shipped without function calling.
      tools: !(s.startsWith('o1-mini') || s.startsWith('o1-preview')),
      vision: !miniOld,
      pdf: !miniOld,
      reasoning: reasoning('EFFORT', pro ? ['HIGH'] : ['LOW', 'MEDIUM', 'HIGH'], pro ? 'HIGH' : 'MEDIUM', !s.startsWith('o1')),
      webSearch: s.startsWith('o3') || s.startsWith('o4'),
      sampling: false,
    });
  }
  const v = gptVersion(s);
  if (v && v.major >= 5 && !s.includes('chat')) {
    const pro = /-pro\b/.test(s);
    const codex = s.includes('codex');
    let efforts: Effort[];
    let def: Effort | null = 'MEDIUM';
    if (v.atLeast(5, 6) || v.major >= 6) {
      if (s.includes('astra')) efforts = ['LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX'];
      else if (v.atLeast(6, 1) && s.includes('sol')) efforts = ['LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX'];
      else if (pro) efforts = ['MEDIUM', 'HIGH', 'XHIGH', 'MAX'];
      else efforts = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX'];
      if (pro) def = 'HIGH';
    } else if (v.atLeast(5, 2)) {
      efforts = pro ? ['MEDIUM', 'HIGH', 'XHIGH'] : ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH'];
      def = pro ? 'HIGH' : v.atLeast(5, 5) ? 'MEDIUM' : null;
    } else if (v.atLeast(5, 1)) {
      if (s.includes('codex-max')) efforts = ['LOW', 'MEDIUM', 'HIGH', 'XHIGH'];
      else if (codex) efforts = ['LOW', 'MEDIUM', 'HIGH'];
      else if (pro) efforts = ['HIGH'];
      else efforts = ['NONE', 'LOW', 'MEDIUM', 'HIGH'];
      def = codex ? 'MEDIUM' : pro ? 'HIGH' : 'NONE';
    } else {
      if (pro) efforts = ['HIGH'];
      else if (codex) efforts = ['LOW', 'MEDIUM', 'HIGH'];
      else efforts = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];
      if (pro) def = 'HIGH';
    }
    return defaultCaps({
      vision: true,
      pdf: true,
      reasoning: reasoning('EFFORT', efforts, def, true),
      webSearch: !(s.includes('nano') && !v.atLeast(5, 1)),
      sampling: false,
      verbosity: !codex,
      proMode: (v.atLeast(5, 6) || v.major >= 6) && !pro,
    });
  }
  // Non-reasoning chat models (gpt-4o, gpt-4.1, gpt-5-chat, chatgpt-4o, gpt-4-turbo, gpt-3.5…).
  const vision = s.includes('gpt-4o') || s.includes('gpt-4.1') || s.includes('4-turbo') || s.includes('chatgpt') ||
    s.includes('vision') || (v != null && v.major >= 5);
  const webSearch = (s.includes('gpt-4o') || s.includes('gpt-4.1') || (v != null && v.major >= 5)) && !s.includes('nano');
  // ChatGPT snapshot aliases don't support function calling.
  return defaultCaps({ vision, pdf: vision, webSearch, sampling: true, tools: !s.startsWith('chatgpt-') });
}

// ---------------------------------------------------------------- OpenAI-compatible

const COMPAT_EXCLUDE = [
  'embed', 'tts', 'whisper', 'transcribe', 'dall-e', 'imagen', 'flux', 'stable-diffusion', 'sdxl',
  'moderation', 'rerank', 'guard', 'audio', 'speech', '-image', 'image-', 'veo', 'lyria', 'aqa',
  'bge-', 'e5-', 'nomic', 'playai', 'orpheus', 'distil-whisper', 'ocr', 'realtime', 'shield',
];

export function isCompatChatModel(id: string): boolean {
  const s = id.toLowerCase();
  return !COMPAT_EXCLUDE.some((x) => s.includes(x));
}

const VISION_HINTS = [
  'vision', '-vl', 'vl-', 'pixtral', 'llava', 'llama-4', 'llama4', 'scout', 'maverick', 'gemma-3', 'gemma3',
  'gemini', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'claude', 'grok-4', 'grok-2-vision', 'qwen2.5-vl', 'qwen3-vl',
  'mistral-medium', 'mistral-small-3', 'mistral-large-3', 'mistral-large-2512', 'magistral-medium', 'magistral-small',
  'ministral-3', 'minicpm-v', 'moondream', 'internvl', 'glm-4.5v', 'kimi-vl',
];

export function looksVision(id: string): boolean {
  const s = id.toLowerCase();
  return VISION_HINTS.some((x) => s.includes(x));
}

const REASONING_HINTS = [
  'reason', 'think', '-r1', 'r1-', 'qwq', 'gpt-oss', 'qwen3', 'magistral', 'deepseek-v3.1', 'deepseek-v3.2',
  'sonar-reasoning', 'kimi-k2-thinking', 'glm-4.5', 'glm-4.6', 'phi-4-reasoning', 'o1', 'o3', 'o4',
];

/** Capabilities for an OpenAI-compatible provider model without live metadata. */
export function compatCaps(kind: ProviderKind, id: string): ModelCaps {
  const s = removePrefix(id.toLowerCase(), 'models/');
  const textOnly = defaultCaps({ vision: looksVision(s), pdf: false, sampling: true });
  const showsReasoning = REASONING_HINTS.some((x) => s.includes(x)) && !s.includes('non-reasoning');
  if (is(kind, ProviderKinds.GOOGLE)) {
    const major = /gemini-(\d+)/.exec(s);
    const gem3 = major != null && Number(major[1]) >= 3;
    const thinks = gem3 || s.includes('gemini-2.5');
    const efforts: Effort[] = !thinks ? [] : s.includes('pro') ? ['LOW', 'MEDIUM', 'HIGH'] : ['NONE', 'LOW', 'MEDIUM', 'HIGH'];
    return defaultCaps({
      vision: !s.includes('gemma') || looksVision(s),
      pdf: false,
      tools: !s.includes('gemma'),
      reasoning: thinks ? reasoning('EFFORT', efforts, null, true) : NO_REASONING,
      sampling: true,
    });
  }
  if (is(kind, ProviderKinds.DEEPSEEK)) {
    const reasoner = s.includes('reasoner') || s.includes('r1');
    return defaultCaps({ reasoning: reasoning('NONE', [], null, reasoner), sampling: !reasoner });
  }
  if (is(kind, ProviderKinds.XAI)) {
    const mini3 = s.includes('grok-3-mini');
    return defaultCaps({
      vision: looksVision(s) || s.includes('grok-4'),
      reasoning: mini3 ? reasoning('EFFORT', ['LOW', 'HIGH'], 'LOW', true) : NO_REASONING,
      sampling: true,
    });
  }
  if (is(kind, ProviderKinds.PERPLEXITY)) {
    return defaultCaps({
      reasoning: reasoning('NONE', [], null, s.includes('reasoning') || s.includes('deep-research')),
      sampling: true,
      tools: false,
    });
  }
  if (s.includes('gpt-oss')) return { ...textOnly, reasoning: reasoning('EFFORT', ['LOW', 'MEDIUM', 'HIGH'], 'MEDIUM', true) };
  if (showsReasoning) return { ...textOnly, reasoning: reasoning('NONE', [], null, true) };
  return textOnly;
}

type Json = Record<string, unknown>;
const jobj = (o: unknown, k: string): Json | null => {
  const v = (o as Json | null)?.[k];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
};
const jbool = (o: unknown, k: string): boolean | null => {
  const v = (o as Json | null)?.[k];
  return typeof v === 'boolean' ? v : null;
};
const jstrings = (o: unknown, k: string): string[] | null => {
  const v = (o as Json | null)?.[k];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : null;
};

/**
 * Refines name-based [base] capabilities with what an OpenAI-compatible provider's model list
 * reports, when it reports anything: Mistral's `capabilities`, Fireworks' `supports_*` flags,
 * `input_modalities` (Hugging Face, xAI, OpenRouter-style routers), Vercel's `tags`, and
 * Hugging Face's per-provider `supports_tools`. Reported values win over the guesses.
 */
export function metadataCaps(base: ModelCaps, m: unknown): ModelCaps {
  let caps = base;
  const reasons = () => {
    if (caps.reasoning.kind === 'NONE' && !caps.reasoning.summaries) caps = { ...caps, reasoning: reasoning('NONE', [], null, true) };
  };
  const c = jobj(m, 'capabilities');
  if (c) {
    const vision = jbool(c, 'vision') ?? jbool(c, 'image_input') ?? jbool(c, 'supports_vision');
    if (vision != null) caps = { ...caps, vision };
    const tools = jbool(c, 'function_calling') ?? jbool(c, 'tools') ?? jbool(c, 'tool_calling') ?? jbool(c, 'supports_tools');
    if (tools != null) caps = { ...caps, tools };
    if (jbool(c, 'reasoning') === true || jbool(c, 'thinking') === true) reasons();
  }
  const vision = jbool(m, 'supports_image_input') ?? jbool(m, 'supports_vision') ?? jbool(m, 'vision');
  if (vision != null) caps = { ...caps, vision };
  const tools = jbool(m, 'supports_tools') ?? jbool(m, 'supports_function_calling');
  if (tools != null) caps = { ...caps, tools };
  if (jbool(m, 'supports_reasoning') === true) reasons();
  const inputs = jstrings(jobj(m, 'architecture'), 'input_modalities') ?? jstrings(m, 'input_modalities');
  if (inputs && inputs.length) caps = { ...caps, vision: inputs.includes('image'), pdf: caps.pdf || inputs.includes('file') || inputs.includes('pdf') };
  const tags = jstrings(m, 'tags') ?? [];
  if (tags.includes('vision') || tags.includes('image-input')) caps = { ...caps, vision: true };
  if (tags.includes('file-input')) caps = { ...caps, pdf: true };
  if (tags.includes('tool-use') || tags.includes('tools')) caps = { ...caps, tools: true };
  if (tags.includes('reasoning')) reasons();
  const providers = (m as Json | null)?.providers;
  if (Array.isArray(providers)) {
    const flags = providers.map((p) => jbool(p, 'supports_tools')).filter((x): x is boolean => x != null);
    if (flags.length) caps = { ...caps, tools: flags.some(Boolean) };
  }
  return caps;
}

/** False when the model list says a model can't chat (Mistral `completion_chat`, Fireworks `supports_chat`). */
export function chatByMetadata(m: unknown): boolean | null {
  return jbool(jobj(m, 'capabilities'), 'completion_chat') ?? jbool(m, 'supports_chat');
}

export function perplexityModels(): ModelInfo[] {
  return ([
    ['sonar', 'Sonar'],
    ['sonar-pro', 'Sonar Pro'],
    ['sonar-reasoning', 'Sonar Reasoning'],
    ['sonar-reasoning-pro', 'Sonar Reasoning Pro'],
    ['sonar-deep-research', 'Sonar Deep Research'],
  ] as const).map(([id, name]) => modelInfo(id, name, { contextWindow: 128_000, caps: compatCaps(ProviderKinds.PERPLEXITY, id) }));
}

/** Default capabilities for a model id the user typed in (no live metadata), by wire protocol. */
export function inferCaps(kind: ProviderKind, id: string): ModelCaps {
  if (kind.style === 'ANTHROPIC') return claudeCaps(id);
  if (kind.style === 'OPENAI_RESPONSES') return openAiCaps(id);
  return compatCaps(kind, id);
}

// ---------------------------------------------------------------- Media models

// The media half of ModelCatalog lives with the media client; re-exported so callers have one catalog.
export { canRun, GEMINI_MEDIA_DEFAULTS, mediaOutput, mediaProviderModels, preferredMedia } from './media/catalog';

// ---------------------------------------------------------------- Display names

const WORD_MAP: Record<string, string> = {
  gpt: 'GPT', oss: 'OSS', llama: 'Llama', qwen: 'Qwen', deepseek: 'DeepSeek',
  grok: 'Grok', gemini: 'Gemini', gemma: 'Gemma', mistral: 'Mistral', mixtral: 'Mixtral',
  claude: 'Claude', sonar: 'Sonar', kimi: 'Kimi', glm: 'GLM', phi: 'Phi', it: 'IT',
  vl: 'VL', r1: 'R1', qwq: 'QwQ', ai: 'AI', api: 'API', pixtral: 'Pixtral',
  codestral: 'Codestral', magistral: 'Magistral', devstral: 'Devstral', ministral: 'Ministral',
  nemotron: 'Nemotron', hermes: 'Hermes', instruct: 'Instruct',
};

export function displayName(kind: ProviderKind, id: string): string {
  const raw = removePrefix(id, 'models/');
  const lower = raw.toLowerCase();
  if (Object.hasOwn(MEDIA_NAMES, lower)) return MEDIA_NAMES[lower];
  if (is(kind, ProviderKinds.OPENAI) || raw.startsWith('gpt-') || raw.startsWith('chatgpt-')) {
    const name = openAiDisplayName(raw);
    if (name) return name;
  }
  return afterLast(raw, '/').split(/[-_ ]/).filter((w) => w !== '').map((w) => {
    const lw = w.toLowerCase();
    if (Object.hasOwn(WORD_MAP, lw)) return WORD_MAP[lw];
    if (/^\d+(\.\d+)?[bmk]$/.test(lw)) return lw.toUpperCase();
    if (/^[a-z]\d$/.test(lw)) return lw.toUpperCase();
    if (/^\d/.test(lw)) return lw;
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  }).join(' ');
}

function openAiDisplayName(id: string): string | null {
  const s = id.toLowerCase();
  if (/^o\d/.test(s)) return s;
  const chatgpt = s.startsWith('chatgpt-');
  const rest = removePrefix(removePrefix(s, 'chatgpt-'), 'gpt-');
  if (rest === s) return null;
  const tokens = rest.split('-');
  const version = tokens[0];
  if (!/^\d/.test(version)) return null;
  const tail = tokens.slice(1).map((t) => {
    if (t === 'mini' || t === 'nano' || t === 'latest' || t === 'preview') return t;
    if (t === 'oss') return 'OSS';
    return /^\d/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1);
  }).join(' ');
  const head = (chatgpt ? 'ChatGPT-' : 'GPT-') + version;
  return tail === '' ? head : `${head} ${tail}`;
}

/** Strips date stamps / aliases so ids compare across providers. */
export function normalizeId(id: string): string {
  let s = afterLast(id.toLowerCase(), '/');
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon);
  s = removeSuffix(s.replace(DATE_SUFFIX, ''), '-latest');
  return s.replace(/\./g, '-');
}

function afterLast(s: string, ch: string): string {
  const i = s.lastIndexOf(ch);
  return i < 0 ? s : s.slice(i + 1);
}

function removePrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

function removeSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}
