/**
 * Interface translations, gettext style: the English text is the key.
 *
 *   t('Delete chat')                                   plain text
 *   t('Rename {name}', { name })                       {placeholders}
 *   tn('{count} tool', '{count} tools', n)             plurals (Intl.PluralRules)
 *   const LABEL = msg('Square'); … tm(LABEL)           marked now, translated when shown
 *
 * Catalogs live in ./locales/<code>.json and map English text to translated text; a plural key
 * (the English "other" form) maps to { one, few, many, other, … }. English has no catalog, and
 * anything missing from a catalog falls back to English. Only the active language is loaded
 * (dynamic import), before the first render, so the page never flashes English.
 *
 * `scripts/i18n-keys.mjs` lists every key from the source: arguments of t(), tn(), msg() and
 * tRich() must be string literals. Text sent to models (system prompts, tool schemas) and log
 * output stay English and don't go through t().
 */

export const LOCALES = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'zh-CN', name: '简体中文', dir: 'ltr' },
  { code: 'hi', name: 'हिन्दी', dir: 'ltr' },
  { code: 'es', name: 'Español', dir: 'ltr' },
  { code: 'ar', name: 'العربية', dir: 'rtl' },
  { code: 'fr', name: 'Français', dir: 'ltr' },
  { code: 'bn', name: 'বাংলা', dir: 'ltr' },
  { code: 'pt-BR', name: 'Português (Brasil)', dir: 'ltr' },
  { code: 'ru', name: 'Русский', dir: 'ltr' },
  { code: 'id', name: 'Bahasa Indonesia', dir: 'ltr' },
  { code: 'ur', name: 'اردو', dir: 'rtl' },
  { code: 'de', name: 'Deutsch', dir: 'ltr' },
  { code: 'ja', name: '日本語', dir: 'ltr' },
  { code: 'mr', name: 'मराठी', dir: 'ltr' },
  { code: 'te', name: 'తెలుగు', dir: 'ltr' },
  { code: 'tr', name: 'Türkçe', dir: 'ltr' },
  { code: 'ta', name: 'தமிழ்', dir: 'ltr' },
  { code: 'vi', name: 'Tiếng Việt', dir: 'ltr' },
  { code: 'ko', name: '한국어', dir: 'ltr' },
  { code: 'it', name: 'Italiano', dir: 'ltr' },
] as const;

export type Locale = (typeof LOCALES)[number]['code'];
/** The stored choice: a locale, or 'auto' to follow the system languages. */
export type LanguagePref = 'auto' | Locale;

type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;
export type Catalog = Record<string, string | PluralForms>;
export type Vars = Record<string, string | number>;

/** A string marked for translation with msg(); translate it where it's shown with tm(). */
export type Msg = string & { readonly __msg: unique symbol };

const CODES = new Set<string>(LOCALES.map((l) => l.code));

export function isLocale(code: unknown): code is Locale {
  return typeof code === 'string' && CODES.has(code);
}

/**
 * The best supported locale for a list of BCP 47 tags in preference order (navigator.languages):
 * an exact match first, then the language alone (pt-PT → pt-BR, zh-TW → zh-CN, en-GB → en).
 */
export function matchLocale(preferred: readonly string[] | null | undefined): Locale {
  for (const raw of preferred ?? []) {
    if (!raw) continue;
    const tag = raw.trim().replace(/_/g, '-').toLowerCase();
    const exact = LOCALES.find((l) => l.code.toLowerCase() === tag);
    if (exact) return exact.code;
    const lang = tag.split('-')[0];
    const byLang = LOCALES.find((l) => l.code.toLowerCase().split('-')[0] === lang);
    if (byLang) return byLang.code;
  }
  return 'en';
}

/** The locale a preference means on this system. */
export function resolveLocale(pref: string | null | undefined, preferred: readonly string[] | null | undefined = systemLanguages()): Locale {
  return isLocale(pref) ? pref : matchLocale(preferred);
}

export function systemLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

// ---- state ----

let current: Locale = 'en';
let catalog: Catalog = {};
let initialized = false;
let pluralRules = new Intl.PluralRules('en');
const englishRules = new Intl.PluralRules('en');
let numberFormat = new Intl.NumberFormat('en');

const loaders = import.meta.glob<{ default: Catalog }>('./locales/*.json');

/** Loads a locale's catalog (nothing for English). */
export async function loadCatalog(code: Locale): Promise<Catalog> {
  if (code === 'en') return {};
  const load = loaders[`./locales/${code}.json`];
  if (!load) return {};
  return (await load()).default;
}

/** Makes [code] the active language with [messages] (tests, and initI18n after loading). */
export function setLocale(code: Locale, messages: Catalog = {}): void {
  current = code;
  catalog = messages;
  pluralRules = new Intl.PluralRules(code);
  numberFormat = new Intl.NumberFormat(code);
  initialized = true;
}

/**
 * Picks the language from the preference, loads its catalog and sets <html lang dir>. Call once,
 * before the first render. A catalog that fails to load leaves the interface in English.
 */
export async function initI18n(pref: string | null | undefined): Promise<Locale> {
  const code = resolveLocale(pref);
  let messages: Catalog = {};
  try {
    messages = await loadCatalog(code);
  } catch (e) {
    console.error('Facet: could not load the', code, 'translation', e);
  }
  setLocale(code, messages);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = code;
    document.documentElement.dir = direction(code);
  }
  return code;
}

/** The active locale (also the locale for dates and numbers). */
export function locale(): Locale {
  return current;
}

export function direction(code: Locale = current): 'ltr' | 'rtl' {
  return LOCALES.find((l) => l.code === code)?.dir ?? 'ltr';
}

export function isRtl(): boolean {
  return direction() === 'rtl';
}

// ---- translation ----

let warned = false;
function checkReady(source: string) {
  // A t() call at module level runs before the catalog loads and stays English.
  if (!initialized && !warned && import.meta.env?.DEV && typeof document !== 'undefined') {
    warned = true;
    console.warn('Facet: t() was called before initI18n(); this text stays English:', source);
  }
}

// First-strong isolate / pop directional isolate: keeps a Latin name or path inside an
// Arabic sentence (and the punctuation around it) in the right order.
const FSI = '⁨';
const PDI = '⁩';

function value(v: string | number): string {
  if (typeof v === 'number') return numberFormat.format(v);
  return direction() === 'rtl' && v ? FSI + v + PDI : v;
}

/** Fills {name} placeholders. Numbers are formatted for the active locale. */
export function format(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? value(vars[name]) : m));
}

/** Translates [source] (a string literal) and fills its placeholders. */
export function t(source: string, vars?: Vars): string {
  checkReady(source);
  const entry = catalog[source];
  return format(typeof entry === 'string' && entry ? entry : source, vars);
}

/**
 * A count-dependent message. [one] and [other] are the English forms; the catalog key is
 * [other]. `{count}` is filled with [count] unless [vars] sets it.
 */
export function tn(one: string, other: string, count: number, vars?: Vars): string {
  checkReady(other);
  const entry = catalog[other];
  let text: string | undefined;
  if (entry && typeof entry === 'object') text = entry[pluralRules.select(count)] ?? entry.other;
  if (!text) text = englishRules.select(count) === 'one' ? one : other;
  return format(text, { count, ...vars });
}

/** Marks a string literal for translation without translating it yet (module-level tables). */
export function msg(source: string): Msg {
  return source as Msg;
}

/** Translates a string marked with msg(). */
export function tm(source: Msg, vars?: Vars): string {
  checkReady(source);
  const entry = catalog[source];
  return format(typeof entry === 'string' && entry ? entry : source, vars);
}

/** The translated text for [source] without placeholders filled (tRich fills them with elements). */
export function lookup(source: string): string {
  checkReady(source);
  const entry = catalog[source];
  return typeof entry === 'string' && entry ? entry : source;
}

/** Text without the direction isolates t() adds in right-to-left languages, for text saved as data (titles, names). */
export function plain(text: string): string {
  return text.replace(/[⁨⁩]/g, '');
}

/** Joins whole sentences: with a space, or directly after the full-width stops of Chinese and Japanese. */
export function sentences(...parts: (string | null | undefined | false)[]): string {
  const list = parts.filter((p): p is string => !!p && p.trim() !== '');
  const tight = current === 'ja' || current === 'zh-CN';
  return list.join(tight ? '' : ' ');
}

/** A number in the active locale. */
export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return options ? new Intl.NumberFormat(current, options).format(n) : numberFormat.format(n);
}

/** Lists names the way the active language does ("a, b and c"). */
export function formatList(items: string[], type: 'conjunction' | 'disjunction' = 'conjunction'): string {
  try {
    return new Intl.ListFormat(current, { style: 'long', type }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** The name of [code] in the active language ("German" in English, "Allemand" in French). */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([current], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
