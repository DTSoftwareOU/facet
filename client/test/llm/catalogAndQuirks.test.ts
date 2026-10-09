import { describe, expect, it } from 'vitest';
import {
  ClaudeModel,
  claudeCaps,
  displayName,
  hideDatedDuplicates,
  inferCaps,
  isOpenAiChatModel,
  normalizeId,
  openAiCaps,
  parseClaude,
} from '../../src/llm/catalog';
import { fromHttp, fromStream, HttpStatusError, parseRetryAfter, redact } from '../../src/llm/errors';
import { cost, PricingCatalog } from '../../src/llm/pricing';
import { providerKind, ProviderKinds } from '../../src/llm/providers';
import {
  diagnose,
  InMemoryQuirkStore,
  LocalQuirkStore,
  maxTokensCap,
  nearestEffort,
  recordHeal,
  resolveEffort,
  type KeyValueStorage,
  type ParamSpec,
} from '../../src/llm/quirks';
import type { ProviderConfig, Usage } from '../../src/llm/types';

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const usage = (over: Partial<Usage>): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, ...over });

describe('ModelCatalog', () => {
  it('parses Claude ids', () => {
    expect(parseClaude('claude-opus-5-5')).toEqual(new ClaudeModel('OPUS', 5, 5));
    expect(parseClaude('claude-opus-4-20250514')).toEqual(new ClaudeModel('OPUS', 4, 0));
    expect(parseClaude('claude-haiku-4-5-20251001')).toEqual(new ClaudeModel('HAIKU', 4, 5));
    expect(parseClaude('claude-3-7-sonnet-20250219')).toEqual(new ClaudeModel('SONNET', 3, 7));
    expect(parseClaude('anthropic/claude-fable-5-1')!.tier).toBe('FABLE');
    expect(parseClaude('gpt-5')).toBeNull();
  });

  it('applies Claude family rules', () => {
    const opus55 = claudeCaps('claude-opus-5-5');
    expect(opus55.sampling).toBe(false);
    expect(opus55.reasoning.efforts).not.toContain('NONE');
    expect(opus55.fastMode && opus55.refusalFallback).toBe(true);
    const sonnet46 = claudeCaps('claude-sonnet-4-6');
    expect(sonnet46.sampling).toBe(true);
    expect(sonnet46.reasoning.efforts).toEqual(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'MAX']);
    expect(claudeCaps('claude-haiku-4-5').reasoning.kind).toBe('BUDGET');
    expect(parseClaude('claude-sonnet-5-5')!.thinkingOff).toBe('BETWEEN_TOOLS');
    expect(parseClaude('claude-fable-5-1')!.thinkingOff).toBe('CANNOT');
    expect(parseClaude('claude-opus-4-6')!.webSearchV2).toBe(true);
    expect(parseClaude('claude-haiku-5-5')!.webSearchV2).toBe(false);
    expect(parseClaude('claude-opus-4-1')!.defaultMaxOutput).toBe(32_000);
  });

  it('infers OpenAI capabilities', () => {
    expect(openAiCaps('gpt-5-mini').reasoning.efforts).toEqual(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);
    expect(openAiCaps('gpt-5.1').reasoning.efforts).toContain('NONE');
    expect(openAiCaps('gpt-5.5').reasoning.efforts).toContain('XHIGH');
    const sol = openAiCaps('gpt-6.1-sol');
    expect(sol.reasoning.efforts).toContain('MAX');
    expect(sol.reasoning.efforts).not.toContain('NONE');
    expect(sol.proMode).toBe(true);
    expect(openAiCaps('gpt-6-astra').reasoning.efforts).not.toContain('NONE');
    expect(openAiCaps('o3-pro').reasoning.efforts).toEqual(['HIGH']);
    const gpt41 = openAiCaps('gpt-4.1');
    expect(gpt41.reasoning.kind).toBe('NONE');
    expect(gpt41.sampling && gpt41.vision && gpt41.webSearch).toBe(true);
    expect(isOpenAiChatModel('text-embedding-3-small')).toBe(false);
    expect(isOpenAiChatModel('gpt-4o-realtime-preview')).toBe(false);
    expect(isOpenAiChatModel('o4-mini')).toBe(true);
    expect(isOpenAiChatModel('gpt-5.1-codex')).toBe(true);
  });

  it('makes display names', () => {
    expect(displayName(ProviderKinds.OPENAI, 'gpt-5.5')).toBe('GPT-5.5');
    expect(displayName(ProviderKinds.OPENAI, 'gpt-4o-mini')).toBe('GPT-4o mini');
    expect(displayName(ProviderKinds.OPENAI, 'gpt-5.6-sol')).toBe('GPT-5.6 Sol');
    expect(displayName(ProviderKinds.OPENAI, 'o3-pro')).toBe('o3-pro');
    expect(displayName(ProviderKinds.GROQ, 'llama-3.3-70b-versatile')).toBe('Llama 3.3 70B Versatile');
    expect(displayName(ProviderKinds.GROQ, 'openai/gpt-oss-120b')).toBe('GPT OSS 120B');
    expect(displayName(ProviderKinds.GOOGLE, 'models/gemini-2.5-pro')).toBe('Gemini 2.5 Pro');
    expect(displayName(ProviderKinds.OPENAI, 'gpt-image-1')).toBe('GPT Image 1');
    expect(displayName(ProviderKinds.MOONSHOT, 'kimi-k2-instruct')).toBe('Kimi K2 Instruct');
  });

  it('normalizes ids and hides dated duplicates', () => {
    expect(normalizeId('anthropic/claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeId('gpt-4.1-mini')).toBe('gpt-4-1-mini');
    expect(normalizeId('deepseek/deepseek-chat:free')).toBe('deepseek-chat');
    expect(normalizeId('mistral-large-latest')).toBe('mistral-large');
    expect(hideDatedDuplicates(['gpt-5.5', 'gpt-5.5-2026-04-23', 'o3-20250416'])).toEqual(new Set(['gpt-5.5', 'o3-20250416']));
  });

  it('infers caps for typed-in models by wire protocol', () => {
    expect(inferCaps(ProviderKinds.ANTHROPIC, 'claude-opus-5-5').refusalFallback).toBe(true);
    expect(inferCaps(ProviderKinds.OPENAI, 'gpt-5.5').verbosity).toBe(true);
    expect(inferCaps(ProviderKinds.GROQ, 'openai/gpt-oss-20b').reasoning.kind).toBe('EFFORT');
  });
});

describe('ParamHealer', () => {
  const sent: ParamSpec[] = [
    { key: 'summary', tokens: ['reasoning.summary', 'summary'] },
    { key: 'effort', tokens: ['reasoning.effort', 'effort'] },
    { key: 'temperature', tokens: ['temperature'] },
    { key: 'max_tokens', tokens: ['max_tokens'] },
  ];

  it('diagnoses rejected parameters', () => {
    expect(diagnose("Unsupported parameter: 'temperature'", sent, null, [])).toEqual({ type: 'drop', key: 'temperature' });
    expect(diagnose('max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-1', sent, null, []))
      .toEqual({ type: 'capMaxTokens', max: 32000 });
    expect(diagnose("Invalid value 'xhigh' for reasoning.effort. Supported values are: 'low', 'medium' and 'high'.", sent, 'XHIGH', []))
      .toEqual({ type: 'effortValue', unsupported: 'XHIGH', replacement: 'HIGH' });
    expect(diagnose('prompt is too long: 250000 tokens > 200000 maximum', sent, null, [])).toBeNull();
    expect(diagnose('Something unrelated broke', sent, null, [])).toBeNull();
  });

  it('resolves effort honoring quirks', () => {
    const levels = ['LOW', 'MEDIUM', 'HIGH', 'XHIGH'] as const;
    expect(resolveEffort('MAX', [...levels], new Set())).toBe('XHIGH');
    expect(resolveEffort('HIGH', [...levels], new Set(['effort:high', 'effort:xhigh']))).toBe('MEDIUM');
    expect(resolveEffort('MINIMAL', [...levels], new Set())).toBe('LOW');
    expect(resolveEffort('HIGH', [...levels], new Set(['effort']))).toBeNull();
    expect(nearestEffort('MEDIUM', [])).toBeNull();
    expect(maxTokensCap(new Set(['max_tokens:64000', 'max_tokens:32000', 'temperature']))).toBe(32000);
  });

  it('records an effort value with no replacement as dropping effort', () => {
    const store = new InMemoryQuirkStore();
    recordHeal(store, 'p', 'm', { type: 'effortValue', unsupported: 'LOW', replacement: null });
    expect(store.dropped('p', 'm')).toEqual(new Set(['effort:low', 'effort']));
  });
});

describe('LocalQuirkStore', () => {
  it('persists quirks per provider and model', () => {
    const storage = memoryStorage();
    const a = new LocalQuirkStore(storage);
    a.markDropped('p1', 'gpt-5', 'temperature');
    a.markDropped('p1', 'gpt-5', 'effort:xhigh');
    a.markDropped('p2', 'gpt-5', 'tools');
    const b = new LocalQuirkStore(storage);
    expect(b.dropped('p1', 'gpt-5')).toEqual(new Set(['temperature', 'effort:xhigh']));
    expect(b.dropped('p2', 'gpt-5')).toEqual(new Set(['tools']));
    expect(b.dropped('p1', 'other')).toEqual(new Set());
    b.clear();
    expect(new LocalQuirkStore(storage).dropped('p1', 'gpt-5')).toEqual(new Set());
  });

  it('falls back to memory without storage or when writes fail', () => {
    const none = new LocalQuirkStore(null);
    none.markDropped('p', 'm', 'top_p');
    expect(none.dropped('p', 'm').has('top_p')).toBe(true);

    const full: KeyValueStorage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
    const store = new LocalQuirkStore(full);
    store.markDropped('p', 'm', 'temperature');
    expect(store.dropped('p', 'm').has('temperature')).toBe(true);
  });
});

describe('LlmErrors', () => {
  const cfg: ProviderConfig = { id: 'p', kind: ProviderKinds.OPENAI, label: 'x', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-proj-SECRETSECRET123', headers: {} };

  it('redacts keys and classifies HTTP errors', () => {
    const err = fromHttp(cfg, 'gpt-5', new HttpStatusError(401, '{"error":{"message":"Incorrect API key provided: sk-proj-SECRETSECRET123. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}'));
    expect(err.kind).toBe('AUTH');
    expect(err.detail).not.toContain('SECRET');
    expect(err.message).not.toContain('SECRET');
    expect(fromHttp(cfg, 'gpt-5', new HttpStatusError(429, '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}')).kind).toBe('QUOTA');
    expect(fromHttp(cfg, 'gpt-5', new HttpStatusError(400, '{"error":{"message":"This model\'s maximum context length is 128000 tokens.","code":"context_length_exceeded"}}')).kind).toBe('CONTEXT_LENGTH');
    expect(fromHttp(cfg, null, new HttpStatusError(529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).kind).toBe('OVERLOADED');
    expect(fromHttp(cfg, 'gpt-5', new HttpStatusError(404, '')).message).toBe("OpenAI couldn't find “gpt-5”. It may be retired, or this key can't use it.");
    expect(fromHttp(cfg, null, new HttpStatusError(429, '{}', 600)).message).toBe('OpenAI is rate-limiting this key. Try again in 10 min.');
    expect(fromHttp(cfg, null, new HttpStatusError(400, '{"error":{"message":"bad thing"}}')).message).toBe('OpenAI rejected the request: bad thing');
    expect(fromHttp({ ...cfg, kind: providerKind('custom'), label: 'My box' }, null, new HttpStatusError(500, '')).message).toBe('My box had a server error (HTTP 500). Try again.');
  });

  it('classifies stream errors and parses Retry-After', () => {
    expect(fromStream(cfg, null, 'rate_limit_error', 'slow down').kind).toBe('RATE_LIMIT');
    expect(fromStream(cfg, null, 'server_error', 'oops').kind).toBe('SERVER');
    expect(fromStream(cfg, null, null, '').message).toBe('OpenAI stopped with an error.');
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('1.2')).toBe(2);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBeNull();
    expect(redact('key xai-abcdefghijkl and sk-ant-api03-zzzzzzzz', null)).toBe('key [redacted] and [redacted]');
  });
});

describe('PricingCatalog', () => {
  it('has built-in prices and computes cost', () => {
    const catalog = new PricingCatalog({ storage: null, fetch: () => Promise.reject(new Error('offline')) });
    const opus = catalog.priceFor(ProviderKinds.ANTHROPIC, 'claude-opus-5-5')!;
    expect(opus.input).toBeCloseTo(4.0, 9);
    expect(catalog.priceFor(ProviderKinds.ANTHROPIC, 'claude-haiku-4-5-20251001')).not.toBeNull();
    expect(catalog.priceFor(ProviderKinds.OPENAI, 'gpt-4.1-mini')).not.toBeNull();
    expect(catalog.priceFor(ProviderKinds.GROQ, 'llama-3.3-70b-versatile')).toBeNull();
    // 1M uncached input + 1M output at $4/$20, plus 1M cache reads at $0.20.
    const u = usage({ inputTokens: 2_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 });
    expect(catalog.cost(opus, u)).toBeCloseTo(24.2, 9);
    expect(cost(opus, u)).toBeCloseTo(24.2, 9);
    expect(catalog.estimate(ProviderKinds.GROQ, 'x', u)).toBeNull();
  });

  it('parses and caches the OpenRouter feed', async () => {
    const feed = `{"data":[
      {"id":"x-ai/grok-4","pricing":{"prompt":"0.000003","completion":"0.000015"}},
      {"id":"openai/gpt-5.5","pricing":{"prompt":"0.000002","completion":"0.000016","input_cache_read":"0.0000002"}},
      {"id":"openrouter/auto","pricing":{"prompt":"-1","completion":"-1"}},
      {"id":"deepseek/deepseek-chat:free","pricing":{"prompt":"0","completion":"0"}}
    ]}`;
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(feed, { status: 200 });
    };
    const storage = memoryStorage();
    let now = 1_000_000;
    const catalog = new PricingCatalog({ fetch: fetchFn, storage, clock: () => now });
    expect(await catalog.refreshIfStale({ enabled: false })).toBe(false); // the setting is off
    expect(urls).toHaveLength(0);
    expect(await catalog.refreshIfStale()).toBe(true);
    expect(urls).toEqual(['https://openrouter.ai/api/v1/models']);
    expect(catalog.priceFor(ProviderKinds.XAI, 'grok-4')!.input).toBeCloseTo(3.0, 9);
    expect(catalog.priceFor(ProviderKinds.OPENAI, 'gpt-5.5')!.output).toBeCloseTo(16.0, 9);
    expect(catalog.priceFor(ProviderKinds.OPENROUTER, 'x-ai/grok-4')!.input).toBeCloseTo(3.0, 9);
    expect(catalog.priceFor(ProviderKinds.OPENROUTER, 'x-ai/grok-4:beta')!.input).toBeCloseTo(3.0, 9);
    expect(catalog.priceFor(ProviderKinds.OPENROUTER, 'openrouter/auto')).toBeNull();
    expect(catalog.priceFor(ProviderKinds.DEEPSEEK, 'deepseek-chat')!.input).toBe(0);
    expect(await catalog.refreshIfStale()).toBe(false); // fresh
    // A new instance loads from the cache without network.
    const reloaded = new PricingCatalog({ storage, fetch: () => Promise.reject(new Error('offline')) });
    expect(reloaded.priceFor(ProviderKinds.XAI, 'grok-4')!.input).toBeCloseTo(3.0, 9);
    expect(reloaded.fetchedAt).toBe(1_000_000);
    // A day later it refreshes again; failures keep the cached prices.
    now += 25 * 60 * 60 * 1000;
    const failing = new PricingCatalog({ storage, clock: () => now, fetch: async () => new Response('nope', { status: 500 }) });
    expect(await failing.refreshIfStale()).toBe(false);
    expect(failing.priceFor(ProviderKinds.XAI, 'grok-4')).not.toBeNull();
  });
});
