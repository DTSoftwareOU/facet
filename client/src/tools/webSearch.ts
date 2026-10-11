/**
 * Web search over the user's chosen API, plus a page reader (port of WebSearch.kt). Nothing is
 * proxied through Facet. On the website, most pages can't be read directly (CORS), so the reader
 * falls back to Jina Reader and says so.
 */
import { isObject } from '../core/json';
import { formatList, locale, t } from '../i18n';
import type { Citation } from '../llm/types';
import { platform } from '../platform';
import { SEARCH_KINDS, type SearchKind } from './types';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string | null;
}

/** A configured search backend (bring your own key). */
export interface SearchConfig {
  kind: SearchKind;
  apiKey: string;
  baseUrl: string;
}

export class SearchException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchException';
  }
}

/** A page read by [WebSearch.fetchPage]. */
export interface FetchedPage {
  title: string;
  text: string;
  /** True when the page was read through Jina Reader because the browser couldn't load it directly. */
  viaReader: boolean;
}

export interface FetchPageOptions {
  maxChars?: number;
  /** A Jina key to authenticate Jina Reader requests (the website's fallback). */
  jinaKey?: string | null;
  signal?: AbortSignal;
}

const TIMEOUT_MS = 30_000;
const MAX_PAGE_BYTES = 3_000_000;
export const JINA_READER = 'https://r.jina.ai/';
const PAGE_ACCEPT = 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5';
const PAGE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Facet/1.0 (+https://facet.dtsoftware.io)';

/** A signal that aborts after [ms] or when [outer] aborts; [timedOut] tells which. */
function deadline(ms: number, outer?: AbortSignal) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  const onAbort = () => ctrl.abort(outer?.reason);
  if (outer?.aborted) ctrl.abort(outer.reason);
  else outer?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

/** Form-style query encoding (spaces as +), like Java's URLEncoder. */
const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');

const str = (o: unknown, k: string): string => {
  if (!isObject(o)) return '';
  const v = o[k];
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
};

/** Search backends that answer requests from web pages, for the website's error message. */
function browserKinds(): string {
  const names = SEARCH_KINDS.filter((k) => k.browserOk).map((k) => k.displayName);
  // English house style has no serial comma; other languages list names their own way.
  if (locale() !== 'en') return formatList(names, 'disjunction');
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names.join('');
}

export class WebSearch {
  /**
   * Page reads can be triggered by text a model read elsewhere, so they never reach this device's
   * own network (router, LAN devices, localhost). [allowPrivateAddresses] turns that off (tests,
   * self-hosted setups). Only literal addresses and local names can be checked here, before the
   * request and again on the final URL after redirects.
   */
  constructor(private readonly options: { allowPrivateAddresses?: boolean } = {}) {}

  async search(config: SearchConfig, query: string, count = 6, signal?: AbortSignal): Promise<SearchResult[]> {
    const q = query.trim().slice(0, 400);
    if (!q) throw new SearchException('The search query was empty.');
    const name = config.kind.displayName;
    if (platform().corsLimited && !config.kind.browserOk) {
      throw new SearchException(
        t('{service} doesn\'t accept requests from web browsers, so it can\'t search here. Switch to {alternatives} in Settings → Web search, or use the Facet app for Windows or Android.', { service: name, alternatives: browserKinds() }),
      );
    }
    const n = Math.min(10, Math.max(1, Math.trunc(count) || 1));
    const base = config.baseUrl.replace(/\/+$/, '');
    let url: string;
    let init: RequestInit;
    switch (config.kind.id) {
      case 'search.brave':
        url = `${base}/res/v1/web/search?q=${enc(q)}&count=${n}&text_decorations=false`;
        init = { headers: { 'X-Subscription-Token': config.apiKey, Accept: 'application/json' } };
        break;
      case 'search.tavily':
        url = `${base}/search`;
        init = {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, max_results: n, search_depth: 'basic' }),
        };
        break;
      case 'search.exa':
        url = `${base}/search`;
        init = {
          method: 'POST',
          headers: { 'x-api-key': config.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, numResults: n, contents: { text: { maxCharacters: 1200 } } }),
        };
        break;
      case 'search.jina':
        url = `${base}/?q=${enc(q)}`;
        init = { headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json', 'X-Respond-With': 'no-content' } };
        break;
      case 'search.searxng':
        url = `${base}/search?q=${enc(q)}&format=json`;
        init = { headers: { Accept: 'application/json' } };
        break;
      default:
        throw new SearchException(t('{service} isn\'t a search service Facet knows.', { service: name }));
    }
    const d = deadline(TIMEOUT_MS, signal);
    let body: string;
    try {
      const resp = await platform().fetch(url, { ...init, signal: d.signal });
      body = await resp.text();
      if (!resp.ok) {
        throw new SearchException(
          resp.status === 401 || resp.status === 403
            ? t('{service} rejected the search key. Check it in Settings → Web search.', { service: name })
            : resp.status === 429
              ? t('{service} rate limit reached. Try again shortly.', { service: name })
              : t('{service} search failed (HTTP {status}).', { service: name, status: String(resp.status) }),
        );
      }
    } catch (e) {
      if (e instanceof SearchException) throw e;
      if (signal?.aborted) throw e;
      if (d.timedOut()) throw new SearchException(t('{service} didn\'t answer in time. Try again.', { service: name }));
      throw new SearchException(
        platform().corsLimited
          ? t('Couldn\'t reach {service}. Check your connection; if the service blocks requests from web browsers, use the Facet app for Windows or Android.', { service: name })
          : t('Couldn\'t reach {service}. Check your connection.', { service: name }),
      );
    } finally {
      d.done();
    }
    return this.parse(config.kind, body).slice(0, n);
  }

  private parse(kind: SearchKind, body: string): SearchResult[] {
    let root: unknown;
    try {
      root = JSON.parse(body);
    } catch {
      root = null;
    }
    if (!isObject(root)) throw new SearchException(t('The search service returned something unexpected.'));
    const items =
      kind.id === 'search.brave' ? (isObject(root.web) ? root.web.results : undefined)
        : kind.id === 'search.jina' ? root.data
          : root.results;
    if (!Array.isArray(items)) return [];
    const out: SearchResult[] = [];
    for (const o of items) {
      if (!isObject(o)) continue;
      const url = str(o, 'url');
      if (!url.trim()) continue;
      const snippet =
        kind.id === 'search.brave' ? str(o, 'description')
          : kind.id === 'search.exa' ? str(o, 'text')
            : kind.id === 'search.jina' ? str(o, 'description') || str(o, 'content')
              : str(o, 'content');
      out.push({
        title: str(o, 'title').trim() ? str(o, 'title') : url,
        url,
        snippet: HtmlText.stripTags(snippet).slice(0, 800),
        published: str(o, 'age').trim() ? str(o, 'age') : str(o, 'publishedDate').trim() ? str(o, 'publishedDate') : null,
      });
    }
    return out;
  }

  /** Formats results for the model, numbered so it can cite them. */
  formatResults(query: string, results: SearchResult[]): string {
    if (results.length === 0) return `No results for "${query}".`;
    let out = `Search results for "${query}":\n\n`;
    results.forEach((r, i) => {
      out += `[${i + 1}] ${r.title}\n${r.url}\n`;
      if (r.published != null) out += `Published: ${r.published}\n`;
      if (r.snippet.trim()) out += `${r.snippet}\n`;
      out += '\n';
    });
    return out + 'Cite sources inline with their URLs as Markdown links. Use fetch_page to read a result in full when the snippet isn\'t enough.';
  }

  citations(results: SearchResult[]): Citation[] {
    return results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet.slice(0, 200) }));
  }

  /** Downloads a page and returns readable text (title + main text), at most [maxChars]. */
  async fetchPage(url: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
    const maxChars = options.maxChars ?? 40_000;
    const clean = url.trim();
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) throw new SearchException('Only http and https links can be read.');
    let parsed: URL;
    try {
      parsed = new URL(clean);
    } catch {
      throw new SearchException("That link isn't a valid web address.");
    }
    if (!this.options.allowPrivateAddresses && isPrivateHost(parsed.hostname)) {
      throw new SearchException("Facet doesn't read pages on local or private networks.");
    }
    const headers: Record<string, string> = { Accept: PAGE_ACCEPT };
    if (!platform().corsLimited) headers['User-Agent'] = PAGE_USER_AGENT;
    const d = deadline(TIMEOUT_MS, options.signal);
    try {
      let resp: Response;
      try {
        resp = await platform().fetch(clean, { headers, signal: d.signal, redirect: 'follow' });
      } catch (e) {
        if (options.signal?.aborted) throw e;
        if (d.timedOut()) throw new SearchException('That page took too long to load.');
        // On the website a page that doesn't allow cross-origin reads fails like a network error.
        if (platform().corsLimited && e instanceof TypeError) return await this.readViaJina(clean, maxChars, options.jinaKey ?? null, d.signal);
        throw new SearchException("Couldn't load that page. Check the link and your connection.");
      }
      if (!this.options.allowPrivateAddresses && resp.url && isPrivateHost(safeHost(resp.url))) {
        resp.body?.cancel().catch(() => {});
        throw new SearchException("Facet doesn't read pages on local or private networks.");
      }
      if (!resp.ok) {
        resp.body?.cancel().catch(() => {});
        throw new SearchException(`That page returned HTTP ${resp.status}.`);
      }
      const type = (resp.headers.get('Content-Type') ?? '').toLowerCase();
      if (type.includes('pdf') || type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/')) {
        resp.body?.cancel().catch(() => {});
        throw new SearchException(`That link points to a ${type.split(';')[0].trim()} file, which can't be read as text.`);
      }
      const raw = decodeText(await readCapped(resp, MAX_PAGE_BYTES), type);
      if (type.includes('html') || raw.trimStart().startsWith('<')) {
        const page = HtmlText.extract(raw);
        return { title: page.title, text: page.text.slice(0, maxChars), viaReader: false };
      }
      return { title: '', text: raw.slice(0, maxChars), viaReader: false };
    } catch (e) {
      if (e instanceof SearchException || options.signal?.aborted) throw e;
      if (d.timedOut()) throw new SearchException('That page took too long to load.');
      throw new SearchException("Couldn't load that page. Check the link and your connection.");
    } finally {
      d.done();
    }
  }

  /** Reads a page through Jina Reader (r.jina.ai), which allows requests from web pages. */
  private async readViaJina(url: string, maxChars: number, jinaKey: string | null, signal: AbortSignal): Promise<FetchedPage> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;
    const resp = await platform().fetch(JINA_READER + url, { headers, signal });
    if (!resp.ok) {
      resp.body?.cancel().catch(() => {});
      const why = resp.status === 429 || resp.status === 402
        ? "Jina Reader's free limit was reached. Add a Jina Search key in Settings → Web search, or"
        : resp.status === 401 || resp.status === 403
          ? 'Jina Reader rejected the Jina key. Check it in Settings → Web search, or'
          : `Jina Reader couldn't read it either (HTTP ${resp.status}). Try another link, or`;
      throw new SearchException(`This website doesn't let browsers load it directly. ${why} use the Facet app for Windows or Android.`);
    }
    const body = await resp.text();
    let title = '';
    let text = body;
    try {
      const json = JSON.parse(body);
      const data = isObject(json) && isObject(json.data) ? json.data : null;
      if (data) {
        title = str(data, 'title');
        text = str(data, 'content');
      }
    } catch {
      // Plain-text answer: "Title: …" then "Markdown Content:".
      const m = /^Title:\s*(.*)$/m.exec(body);
      if (m) title = m[1].trim();
      const marker = body.indexOf('Markdown Content:');
      if (marker >= 0) text = body.slice(marker + 'Markdown Content:'.length).trim();
    }
    return { title: title.trim(), text: text.trim().slice(0, maxChars), viaReader: true };
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Reads at most [max] bytes of a body, then stops the download. */
async function readCapped(resp: Response, max: number): Promise<Uint8Array> {
  if (!resp.body) return new Uint8Array(0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(size, max));
  let o = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, out.length - o);
    out.set(c.subarray(0, n), o);
    o += n;
    if (o >= out.length) break;
  }
  return out;
}

/** Decodes with the charset the server declared (UTF-8 when missing or unknown). */
function decodeText(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unknown label: fall through to UTF-8.
    }
  }
  return new TextDecoder().decode(bytes);
}

/** Small, dependency-free HTML → readable text converter. */
export const HtmlText = {
  extract(html: string): { title: string; text: string } {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const pageTitle = titleMatch ? HtmlText.decode(HtmlText.stripTags(titleMatch[1])).trim() : '';
    // After the whole <body …> tag (Android keeps its closing ">" in the text).
    const bodyAt = html.indexOf('<body');
    const bodyEnd = bodyAt >= 0 ? html.indexOf('>', bodyAt) : -1;
    let body = bodyAt < 0 ? html : bodyEnd >= 0 ? html.slice(bodyEnd + 1) : html.slice(bodyAt + 5);
    body = body.replace(/<!--[\s\S]*?-->/g, ' ');
    body = body.replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|template|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    const main = Array.from(body.matchAll(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/gi), (m) => m[2]).join('\n');
    if (main.length > 500) body = main;
    body = body.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) =>
      '\n\n' + '#'.repeat(Number(level)) + ' ' + HtmlText.stripTags(inner).trim() + '\n\n');
    body = body.replace(/<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const text = HtmlText.stripTags(inner).trim();
      return text ? `${text} (${href})` : '';
    });
    body = body.replace(/<li[^>]*>/gi, '\n- ');
    body = body.replace(/<\/t[dh]>/gi, ' | ');
    body = body.replace(/<(br|\/p|\/div|\/section|\/article|\/tr|\/li|\/h[1-6]|\/blockquote|\/pre)[^>]*>/gi, '\n');
    body = body.replace(/<[^>]+>/g, ' ');
    body = HtmlText.decode(body);
    body = body.split(/\r\n|\r|\n/).map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n');
    body = body.replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
    return { title: pageTitle, text: body };
  },

  stripTags(s: string): string {
    return HtmlText.decode(s.replace(/<[^>]+>/g, '')).trim();
  },

  decode(s: string): string {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e: string) => {
      try {
        if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
        if (e.startsWith('#')) return /^#\d+$/.test(e) ? String.fromCodePoint(parseInt(e.slice(1), 10)) : m;
      } catch {
        return m;
      }
      return NAMED_ENTITIES[e] ?? m;
    });
  },
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', middot: '·',
};

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const b = parts.map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

function privateIpv4(b: number[]): boolean {
  return b[0] === 127 || b[0] === 10 || b[0] === 0 ||
    (b[0] === 172 && (b[1] & 0xf0) === 16) ||
    (b[0] === 192 && b[1] === 168) ||
    (b[0] === 169 && b[1] === 254) ||
    (b[0] === 100 && (b[1] & 0xc0) === 64) ||
    (b[0] >= 224 && b[0] <= 239) ||
    b.every((x) => x === 255);
}

/** Expands an IPv6 literal to 8 groups (with an embedded IPv4 tail), or null. */
function parseIpv6(host: string): number[] | null {
  let s = host.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(':')) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseIpv4(last);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (p: string) => (p ? p.split(':') : []);
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const fill = 8 - head.length - rest.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const zeros: string[] = new Array(halves.length === 2 ? fill : 0).fill('0');
  return [...head, ...zeros, ...rest].map((g) => parseInt(g, 16)).concat(tail);
}

/**
 * Loopback, link-local, private (RFC 1918), carrier-grade NAT, unique-local IPv6, wildcard and
 * multicast addresses, plus local host names. [host] is a URL hostname (IPv6 in brackets or not).
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return true;
  const v4 = parseIpv4(host);
  if (v4) return privateIpv4(v4);
  const v6 = parseIpv6(host);
  if (!v6) return false;
  if (v6.every((g) => g === 0)) return true; // ::
  if (v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) return true; // ::1
  if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) return privateIpv4([v6[6] >> 8, v6[6] & 0xff, v6[7] >> 8, v6[7] & 0xff]);
  const first = v6[0];
  return (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00 || (first & 0xfe00) === 0xfc00;
}
