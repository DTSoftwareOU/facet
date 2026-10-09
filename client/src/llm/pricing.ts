/**
 * USD-per-million-token prices for cost estimates (port of PricingCatalog.kt).
 *
 * Sources, in order: a built-in table of first-party prices, then the public OpenRouter model feed
 * (no key needed, cached in localStorage, refreshed at most daily while the user's "Live pricing
 * data" setting is on). Prices are estimates — tiered/long-context pricing isn't modeled.
 */
import { isObject } from '../core/json';
import { normalizeId } from './catalog';
import { arr, obj, resolveFetch, str } from './internal';
import { ProviderKinds, type ProviderKind } from './providers';
import { browserStorage, type KeyValueStorage } from './quirks';
import type { ModelPricing, Usage } from './types';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';
const CACHE_KEY = 'facet_pricing';

interface CacheData {
  fetchedAt: number;
  models: Record<string, ModelPricing>;
}

export interface PricingOptions {
  /** Defaults to platform().fetch. */
  fetch?: typeof fetch;
  /** Where the feed is cached; null keeps it in memory only. Defaults to localStorage. */
  storage?: KeyValueStorage | null;
  clock?: () => number;
}

const FIRST_PARTY = new Set<string>([ProviderKinds.ANTHROPIC.id, ProviderKinds.OPENAI.id, ProviderKinds.GOOGLE.id]);

const VENDOR: Record<string, string> = {
  [ProviderKinds.OPENAI.id]: 'openai',
  [ProviderKinds.ANTHROPIC.id]: 'anthropic',
  [ProviderKinds.GOOGLE.id]: 'google',
  [ProviderKinds.XAI.id]: 'x-ai',
  [ProviderKinds.DEEPSEEK.id]: 'deepseek',
  [ProviderKinds.MISTRAL.id]: 'mistralai',
  [ProviderKinds.PERPLEXITY.id]: 'perplexity',
};

function p(input: number, output: number, cacheRead: number | null = null, cacheWrite: number | null = null): ModelPricing {
  return { input, output, cacheRead, cacheWrite };
}

/** Keys are normalizeId forms. */
export const BUILT_IN_PRICES: Readonly<Record<string, ModelPricing>> = {
  // Anthropic (cache write = 5-minute TTL rate)
  'claude-fable-5-1': p(10.0, 50.0, 0.25, 12.5),
  'claude-mythos-5-1': p(10.0, 50.0, 0.25, 12.5),
  'claude-fable-5': p(10.0, 50.0, 1.0, 12.5),
  'claude-opus-5-5': p(4.0, 20.0, 0.20, 5.0),
  'claude-opus-5': p(5.0, 25.0, 0.50, 6.25),
  'claude-opus-4-8': p(5.0, 25.0, 0.50, 6.25),
  'claude-opus-4-7': p(5.0, 25.0, 0.50, 6.25),
  'claude-opus-4-6': p(5.0, 25.0, 0.50, 6.25),
  'claude-opus-4-5': p(5.0, 25.0, 0.50, 6.25),
  'claude-opus-4-1': p(15.0, 75.0, 1.50, 18.75),
  'claude-opus-4-0': p(15.0, 75.0, 1.50, 18.75),
  'claude-opus-4': p(15.0, 75.0, 1.50, 18.75),
  'claude-sonnet-5-5': p(2.0, 10.0, 0.20, 2.5),
  'claude-sonnet-5': p(2.0, 10.0, 0.20, 2.5),
  'claude-sonnet-4-6': p(3.0, 15.0, 0.30, 3.75),
  'claude-sonnet-4-5': p(3.0, 15.0, 0.30, 3.75),
  'claude-sonnet-4-0': p(3.0, 15.0, 0.30, 3.75),
  'claude-sonnet-4': p(3.0, 15.0, 0.30, 3.75),
  'claude-haiku-5-5': p(0.10, 0.50, 0.01, 0.125),
  'claude-haiku-4-5': p(1.0, 5.0, 0.10, 1.25),
  // OpenAI
  'gpt-4o': p(2.5, 10.0, 1.25),
  'gpt-4o-mini': p(0.15, 0.60, 0.075),
  'gpt-4-1': p(2.0, 8.0, 0.50),
  'gpt-4-1-mini': p(0.40, 1.60, 0.10),
  'gpt-4-1-nano': p(0.10, 0.40, 0.025),
  'o3': p(2.0, 8.0, 0.50),
  'o3-mini': p(1.10, 4.40, 0.55),
  'o4-mini': p(1.10, 4.40, 0.275),
  'gpt-5': p(1.25, 10.0, 0.125),
  'gpt-5-mini': p(0.25, 2.0, 0.025),
  'gpt-5-nano': p(0.05, 0.40, 0.005),
  'gpt-5-1': p(1.25, 10.0, 0.125),
  // Google (≤200K-token prompts)
  'gemini-2-5-pro': p(1.25, 10.0, 0.3125),
  'gemini-2-5-flash': p(0.30, 2.50, 0.075),
  'gemini-2-5-flash-lite': p(0.10, 0.40, 0.025),
};

/** Estimated USD cost of `usage` at `pricing`. */
export function cost(pricing: ModelPricing, usage: Usage): number {
  const cached = usage.cacheReadTokens + usage.cacheWriteTokens;
  const uncached = Math.max(0, usage.inputTokens - cached);
  const total = uncached * pricing.input +
    usage.cacheReadTokens * (pricing.cacheRead ?? pricing.input) +
    usage.cacheWriteTokens * (pricing.cacheWrite ?? pricing.input) +
    usage.outputTokens * pricing.output;
  return total / 1_000_000;
}

/** Per-token USD strings from OpenRouter → per-million numbers; negative = variable, skipped. */
export function openRouterPricing(pricing: unknown): ModelPricing | null {
  if (!isObject(pricing)) return null;
  const f = (key: string): number | null => {
    const s = str(pricing, key);
    if (s == null || s.trim() === '') return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
  };
  const input = f('prompt');
  const output = f('completion');
  if (input == null || output == null) return null;
  return { input, output, cacheRead: f('input_cache_read'), cacheWrite: f('input_cache_write') };
}

export function parseOpenRouterFeed(body: string): Record<string, ModelPricing> {
  let data: unknown[] | null = null;
  try {
    data = arr(JSON.parse(body), 'data');
  } catch {
    return {};
  }
  const out: Record<string, ModelPricing> = {};
  for (const m of data ?? []) {
    const id = str(m, 'id');
    if (id == null) continue;
    const price = openRouterPricing(obj(m, 'pricing'));
    if (price) out[id] = price;
  }
  return out;
}

export class PricingCatalog {
  private byFullId = new Map<string, ModelPricing>();
  private byVendorKey = new Map<string, ModelPricing>();
  private inflight: Promise<boolean> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly storage: KeyValueStorage | null;
  private readonly clock: () => number;
  /** When the OpenRouter feed was last fetched (ms), 0 if never. */
  fetchedAt = 0;

  constructor(options: PricingOptions = {}) {
    this.fetchFn = resolveFetch(options.fetch);
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.clock = options.clock ?? Date.now;
    this.loadCache();
  }

  private loadCache(): void {
    try {
      const raw = this.storage?.getItem(CACHE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as CacheData;
      if (isObject(data) && typeof data.fetchedAt === 'number' && isObject(data.models)) this.install(data.models, data.fetchedAt);
    } catch {
      // A corrupt cache is refetched.
    }
  }

  /**
   * Refreshes from OpenRouter when `enabled` (the "Live pricing data" setting) and the cache is
   * older than `maxAgeMs` (0 forces a refresh). Returns true if refreshed; never throws.
   */
  refreshIfStale(options: { enabled?: boolean; maxAgeMs?: number } = {}): Promise<boolean> {
    const { enabled = true, maxAgeMs = DAY_MS } = options;
    if (!enabled) return Promise.resolve(false);
    if (this.clock() - this.fetchedAt < maxAgeMs && this.byFullId.size > 0) return Promise.resolve(false);
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(): Promise<boolean> {
    try {
      const res = await this.fetchFn(OPENROUTER_MODELS, { method: 'GET' });
      if (!res.ok) return false;
      const models = parseOpenRouterFeed(await res.text());
      if (Object.keys(models).length === 0) return false;
      const now = this.clock();
      this.install(models, now);
      try {
        this.storage?.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: now, models } satisfies CacheData));
      } catch {
        // Storage full or unavailable: keep the in-memory copy.
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Price for `modelId` served by `kind`, or null when unknown. */
  priceFor(kind: ProviderKind, modelId: string): ModelPricing | null {
    if (kind.id === ProviderKinds.OPENROUTER.id) {
      const colon = modelId.indexOf(':');
      return this.byFullId.get(modelId) ?? (colon >= 0 ? this.byFullId.get(modelId.slice(0, colon)) : undefined) ?? null;
    }
    const key = normalizeId(modelId);
    if (FIRST_PARTY.has(kind.id) && Object.hasOwn(BUILT_IN_PRICES, key)) return BUILT_IN_PRICES[key];
    const vendor = VENDOR[kind.id];
    if (!vendor) return null;
    return this.byVendorKey.get(`${vendor}/${key}`) ?? null;
  }

  /** Estimated USD cost of `usage` at `pricing`. */
  cost(pricing: ModelPricing, usage: Usage): number {
    return cost(pricing, usage);
  }

  estimate(kind: ProviderKind, modelId: string, usage: Usage): number | null {
    const price = this.priceFor(kind, modelId);
    return price ? cost(price, usage) : null;
  }

  private install(models: Record<string, ModelPricing>, at: number): void {
    const full = new Map<string, ModelPricing>();
    const vendorMap = new Map<string, ModelPricing>();
    for (const [id, price] of Object.entries(models)) {
      full.set(id, price);
      const slash = id.indexOf('/');
      if (slash <= 0) continue;
      const key = `${id.slice(0, slash)}/${normalizeId(id)}`;
      // Prefer the plain variant over ":free"/":beta" duplicates.
      if (!id.includes(':') || !vendorMap.has(key)) vendorMap.set(key, price);
    }
    this.byFullId = full;
    this.byVendorKey = vendorMap;
    this.fetchedAt = at;
  }
}
