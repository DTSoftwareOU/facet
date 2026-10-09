/**
 * Self-healing request parameters (port of Quirks.kt and PrefsQuirkStore.kt). When a provider
 * rejects a parameter for a model ("temperature is not supported", "max_tokens must be at most
 * 32000", "effort 'xhigh' is invalid"), adapters diagnose the 400, remember the quirk and retry
 * without it. Quirk keys are opaque strings such as `temperature`, `effort:xhigh` or
 * `max_tokens:32000`, persisted per provider and model so later requests skip the failed round trip.
 */
import { EFFORTS, type Effort, EFFORT_INFO, type QuirkStore } from './types';

/** Minimal Web Storage surface, so tests and other hosts can supply their own. */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** localStorage when usable (it can be missing, or throw in private windows and sandboxed frames). */
export function browserStorage(): KeyValueStorage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    if (!s) return null;
    const probe = '__facet_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/** Non-persistent QuirkStore (tests, or hosts without storage). */
export class InMemoryQuirkStore implements QuirkStore {
  private map = new Map<string, Set<string>>();

  dropped(providerId: string, model: string): Set<string> {
    return new Set(this.map.get(`${providerId}|${model}`) ?? []);
  }

  markDropped(providerId: string, model: string, param: string): void {
    const k = `${providerId}|${model}`;
    let set = this.map.get(k);
    if (!set) this.map.set(k, (set = new Set()));
    set.add(param);
  }
}

/**
 * QuirkStore persisted in localStorage (this device only, like Android's SharedPreferences
 * "facet_quirks"). Re-read on every lookup so quirks learned in another tab apply here too. Falls
 * back to memory when storage is unavailable or full.
 */
export class LocalQuirkStore implements QuirkStore {
  private memory = new InMemoryQuirkStore();

  constructor(
    private readonly storage: KeyValueStorage | null = browserStorage(),
    private readonly key = 'facet_quirks',
  ) {}

  private read(): Record<string, string[]> {
    if (!this.storage) return {};
    try {
      const raw = JSON.parse(this.storage.getItem(this.key) ?? '{}');
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  dropped(providerId: string, model: string): Set<string> {
    const stored = this.read()[`${providerId}|${model}`];
    const out = this.memory.dropped(providerId, model);
    if (Array.isArray(stored)) for (const p of stored) if (typeof p === 'string') out.add(p);
    return out;
  }

  markDropped(providerId: string, model: string, param: string): void {
    this.memory.markDropped(providerId, model, param);
    if (!this.storage) return;
    const all = this.read();
    const k = `${providerId}|${model}`;
    const next = new Set(Array.isArray(all[k]) ? all[k] : []);
    if (next.has(param)) return;
    next.add(param);
    all[k] = [...next];
    try {
      this.storage.setItem(this.key, JSON.stringify(all));
    } catch {
      // Quota or privacy mode: the in-memory copy still covers this session.
    }
  }

  clear(): void {
    this.memory = new InMemoryQuirkStore();
    try {
      this.storage?.removeItem(this.key);
    } catch {
      // ignore
    }
  }
}

/** A request parameter an adapter sent, with the substrings that identify it in error messages. */
export interface ParamSpec {
  key: string;
  tokens: string[];
}

export type HealAction =
  | { type: 'drop'; key: string }
  /** `unsupported` effort level rejected; `replacement` is the next level to try (null = drop effort). */
  | { type: 'effortValue'; unsupported: Effort; replacement: Effort | null }
  | { type: 'capMaxTokens'; max: number };

const QUOTED = /['"`]([a-z_]+)['"`]/g;
const MAX_TOKEN_PATTERNS = [
  /> ?(\d{3,7}),? which is the maximum/,
  /at most (\d{3,7})/,
  /maximum (?:allowed )?(?:value |number of (?:output |completion )?tokens )?(?:is |of )?(\d{3,7})/,
  /less than or equal to (\d{3,7})/,
  /<= ?(\d{3,7})/,
];

const ordinal = (e: Effort): number => EFFORTS.indexOf(e);

/** True when a provider error says the conversation doesn't fit (never healed by dropping params). */
export function isContextLength(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('prompt is too long') || m.includes('context length') || m.includes('context_length') ||
    m.includes('context window') || m.includes('maximum context') || m.includes('too many tokens') ||
    m.includes('input is too long') || m.includes('reduce the length') || m.includes('exceeds the context');
}

/**
 * Turns "this parameter isn't supported for this model" style 400s into a corrective action.
 * `sent` is ordered most specific first, so the narrowest matching parameter is blamed.
 * Context-length errors are never healed.
 */
export function diagnose(message: string, sent: ParamSpec[], effort: Effort | null, supportedEfforts: Effort[]): HealAction | null {
  if (message.trim() === '' || isContextLength(message)) return null;
  const m = message.toLowerCase();
  const sentKeys = new Set(sent.map((s) => s.key));

  if (sentKeys.has('max_tokens') || sentKeys.has('max_output_tokens')) {
    const mentionsMax = m.includes('max_tokens') || m.includes('max_output_tokens') || m.includes('max_completion_tokens');
    // "Use 'max_completion_tokens' instead" is a rename, not a ceiling.
    if (mentionsMax && !(m.includes('max_completion_tokens') && sentKeys.has('max_tokens') && m.includes('instead'))) {
      for (const p of MAX_TOKEN_PATTERNS) {
        const n = Number.parseInt(p.exec(m)?.[1] ?? '', 10);
        if (Number.isFinite(n)) return { type: 'capMaxTokens', max: n };
      }
    }
  }

  if (effort != null && effort !== 'NONE' && sentKeys.has('effort') && m.includes('effort')) {
    const valueProblem = m.includes(EFFORT_INFO[effort].wire) || m.includes('unsupported value') || m.includes('invalid value') ||
      m.includes('should be') || m.includes('must be one of') || m.includes('supported values');
    if (valueProblem) {
      const listed = new Set<Effort>();
      for (const match of m.matchAll(QUOTED)) {
        const e = EFFORTS.find((x) => EFFORT_INFO[x].wire === match[1]);
        if (e && e !== effort) listed.add(e);
      }
      const candidates = listed.size > 0 ? [...listed] : supportedEfforts.filter((e) => e !== effort && e !== 'NONE');
      return { type: 'effortValue', unsupported: effort, replacement: nearestEffort(effort, candidates.sort((a, b) => ordinal(a) - ordinal(b))) };
    }
  }

  const blamed = sent.find((spec) => spec.tokens.some((t) => m.includes(t)));
  return blamed ? { type: 'drop', key: blamed.key } : null;
}

/** Highest supported level at or below `requested`, else the lowest above it. */
export function nearestEffort(requested: Effort, supported: Effort[]): Effort | null {
  if (supported.length === 0) return null;
  if (supported.includes(requested)) return requested;
  const below = supported.filter((e) => ordinal(e) < ordinal(requested));
  if (below.length > 0) return below.reduce((a, b) => (ordinal(b) > ordinal(a) ? b : a));
  return supported.reduce((a, b) => (ordinal(b) < ordinal(a) ? b : a));
}

/**
 * Resolves the effort to send for a model, honoring quirks (`effort` dropped entirely, or
 * individual `effort:<wire>` levels rejected). NONE is handled by adapters, not here.
 */
export function resolveEffort(requested: Effort | null | undefined, supported: Effort[], dropped: Set<string>): Effort | null {
  if (requested == null || requested === 'NONE' || dropped.has('effort')) return null;
  const levels = supported.filter((e) => e !== 'NONE');
  const pool = (levels.length > 0 ? levels : EFFORTS.filter((e) => e !== 'NONE'))
    .filter((e) => !dropped.has(`effort:${EFFORT_INFO[e].wire}`));
  return nearestEffort(requested, pool);
}

/** The quirk keys a heal action adds. */
function healKeys(action: HealAction): string[] {
  switch (action.type) {
    case 'drop':
      return [action.key];
    case 'effortValue': {
      const keys = [`effort:${EFFORT_INFO[action.unsupported].wire}`];
      if (action.replacement == null) keys.push('effort');
      return keys;
    }
    case 'capMaxTokens':
      return [`max_tokens:${action.max}`];
  }
}

/** Remembers a heal action for future requests. */
export function recordHeal(store: QuirkStore, providerId: string, model: string, action: HealAction): void {
  for (const k of healKeys(action)) store.markDropped(providerId, model, k);
}

/** Applies a heal action to the parameters dropped for the retry in progress. */
export function applyHeal(dropped: Set<string>, action: HealAction): void {
  for (const k of healKeys(action)) dropped.add(k);
}

/** Smallest `max_tokens:N` cap learned for this model, if any. */
export function maxTokensCap(dropped: Set<string>): number | null {
  let min: number | null = null;
  for (const d of dropped) {
    if (!d.startsWith('max_tokens:')) continue;
    const n = Number.parseInt(d.slice('max_tokens:'.length), 10);
    if (Number.isFinite(n) && (min == null || n < min)) min = n;
  }
  return min;
}
