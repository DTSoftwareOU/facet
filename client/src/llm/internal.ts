/**
 * Shared adapter plumbing (port of JsonExt.kt, StreamHelpers.kt and ToolWire.kt): tolerant JSON
 * accessors, the HTTP/SSE transport with error tagging, the <think> tag splitter, citation
 * de-duplication and client tool-calling helpers.
 */
import { b64, buf, hex, randomBytes, utf8 } from '../core/bytes';
import { isObject } from '../core/json';
import { readSse, type SseEvent } from '../core/sse';
import { platform } from '../platform';
import { HttpStatusError, TransportError } from './errors';
import type { ProviderKind } from './providers';
import type { Citation, ModelPricing, QuirkStore, Usage } from './types';

/** Price lookups (a PricingCatalog, or anything with the same priceFor). */
export interface PriceLookup {
  priceFor(kind: ProviderKind, modelId: string): ModelPricing | null | undefined;
}

/** Constructor options shared by the chat adapters. */
export interface ClientOptions {
  /** Defaults to platform().fetch (subject to CORS on the website). */
  fetch?: typeof fetch;
  quirks: QuirkStore;
  /** Fills ModelInfo.pricing in listModels(). */
  pricing?: PriceLookup | null;
}

export type JsonObject = Record<string, unknown>;

// ------------------------------------------------------------------ JSON

/** Parsed JSON, or undefined when the text isn't JSON (null is a valid value). */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseObject(text: string): JsonObject | null {
  const v = tryParseJson(text);
  return isObject(v) ? v : null;
}

export function obj(o: unknown, key: string): JsonObject | null {
  const v = isObject(o) ? o[key] : undefined;
  return isObject(v) ? v : null;
}

export function arr(o: unknown, key: string): unknown[] | null {
  const v = isObject(o) ? o[key] : undefined;
  return Array.isArray(v) ? v : null;
}

export function str(o: unknown, key: string): string | null {
  const v = isObject(o) ? o[key] : undefined;
  return typeof v === 'string' ? v : null;
}

/** Integer field; numeric strings count too (some providers quote numbers). */
export function long(o: unknown, key: string): number | null {
  const v = isObject(o) ? o[key] : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

export function bool(o: unknown, key: string): boolean | null {
  const v = isObject(o) ? o[key] : undefined;
  return typeof v === 'boolean' ? v : null;
}

/** `obj.a.b.supported` style lookup (Anthropic Models API capabilities). */
export function supported(o: unknown, ...keys: string[]): boolean | null {
  let cur: unknown = o;
  for (const k of [...keys, 'supported']) {
    if (!isObject(cur)) return null;
    cur = cur[k];
  }
  return typeof cur === 'boolean' ? cur : null;
}

export function stringsOf(list: unknown[] | null): string[] {
  return (list ?? []).filter((x): x is string => typeof x === 'string');
}

export function dataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${b64(bytes)}`;
}

export function isBlank(s: string | null | undefined): boolean {
  return s == null || s.trim() === '';
}

export function sameUsage(a: Usage | null, b: Usage): boolean {
  return a != null && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens && a.cacheWriteTokens === b.cacheWriteTokens && a.reasoningTokens === b.reasoningTokens;
}

// ------------------------------------------------------------------ transport

export function resolveFetch(f?: typeof fetch): typeof fetch {
  // Resolved per call so tests and previews can install a platform after construction.
  return f ?? ((input, init) => platform().fetch(input, init));
}

export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}

/** Sends a request. Non-2xx responses throw HttpStatusError; network failures throw TransportError. */
export async function send(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new TransportError(e, 'connect');
  }
  if (!res.ok) throw await HttpStatusError.from(res);
  return res;
}

/** Reads the whole body as text; read failures throw TransportError. */
export async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new TransportError(e, 'read');
  }
}

/** A deadline for short calls (model lists, key checks); streams run until done or stopped. */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

/**
 * SSE events of a streaming response. Read failures surface as TransportError so callers can tell
 * a dropped connection from a bug in event handling.
 */
export async function* sseEvents(res: Response, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  if (!res.body) return;
  const it = readSse(res.body, signal);
  try {
    while (true) {
      let r: IteratorResult<SseEvent>;
      try {
        r = await it.next();
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) return;
        throw new TransportError(e, 'read');
      }
      if (r.done) return;
      yield r.value;
    }
  } finally {
    await it.return(undefined).catch(() => {});
  }
}

/** Sets headers case-insensitively, later values replacing earlier ones (like OkHttp's header()). */
export function headersOf(...sets: (Record<string, string> | null | undefined)[]): Headers {
  const h = new Headers();
  for (const set of sets) if (set) for (const [k, v] of Object.entries(set)) h.set(k, v);
  return h;
}

// ------------------------------------------------------------------ <think> tags

export interface Segment {
  thinking: boolean;
  text: string;
}

const OPEN_TAGS = ['<think>', '<thought>'];
const CLOSE_TAGS = ['</think>', '</thought>'];
const MAX_CLOSE = Math.max(...CLOSE_TAGS.map((t) => t.length));

/**
 * Splits a content stream into visible text and reasoning when a model inlines its reasoning as
 * `<think>…</think>` (or Gemini's `<thought>…</thought>`). An opening tag is only recognized at
 * the very start of the response (ignoring whitespace), so literal tags inside answers survive.
 */
export class ThinkTagSplitter {
  private buf = '';
  private inThink = false;
  private startDecided = false;
  private trimLeading = false;

  feed(chunk: string): Segment[] {
    if (!chunk) return [];
    this.buf += chunk;
    return this.drain(false);
  }

  flush(): Segment[] {
    return this.drain(true);
  }

  private drain(final: boolean): Segment[] {
    const out: Segment[] = [];
    while (this.buf.length > 0) {
      if (!this.inThink) {
        if (!this.startDecided) {
          const firstNonWs = this.buf.search(/\S/);
          if (firstNonWs < 0) {
            if (final) {
              emit(out, false, this.buf);
              this.buf = '';
            }
            break;
          }
          const rest = this.buf.slice(firstNonWs);
          const open = OPEN_TAGS.find((t) => rest.startsWith(t));
          if (open) {
            this.buf = this.buf.slice(firstNonWs + open.length);
            this.inThink = true;
            this.startDecided = true;
            continue;
          }
          if (!final && OPEN_TAGS.some((t) => t.startsWith(rest))) break; // partial tag, wait
          this.startDecided = true;
        }
        let text = this.buf;
        if (this.trimLeading) {
          text = text.replace(/^[\n\r]+/, '');
          if (text === '' && !final) {
            this.buf = '';
            break;
          }
          this.trimLeading = false;
        }
        emit(out, false, text);
        this.buf = '';
      } else {
        const s = this.buf;
        let closeAt = -1;
        let closeLen = 0;
        for (const tag of CLOSE_TAGS) {
          const i = s.indexOf(tag);
          if (i >= 0 && (closeAt < 0 || i < closeAt)) {
            closeAt = i;
            closeLen = tag.length;
          }
        }
        if (closeAt >= 0) {
          emit(out, true, s.slice(0, closeAt));
          this.buf = s.slice(closeAt + closeLen);
          this.inThink = false;
          this.trimLeading = true;
          continue;
        }
        // Hold back a possible partial closing tag.
        const hold = final ? 0 : partialSuffix(s);
        emit(out, true, s.slice(0, s.length - hold));
        this.buf = s.slice(s.length - hold);
        break;
      }
    }
    return out;
  }
}

function partialSuffix(s: string): number {
  for (let n = Math.min(s.length, MAX_CLOSE - 1); n >= 1; n--) {
    const suffix = s.slice(s.length - n);
    if (CLOSE_TAGS.some((t) => t.startsWith(suffix))) return n;
  }
  return 0;
}

function emit(out: Segment[], thinking: boolean, text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.thinking === thinking) last.text += text;
  else out.push({ thinking, text });
}

// ------------------------------------------------------------------ citations

/** De-duplicates sources by URL while preserving first-seen order. */
export class CitationCollector {
  private byUrl = new Map<string, Citation>();

  /** Returns true when the list changed. */
  add(url: string | null | undefined, title: string | null | undefined, snippet?: string | null): boolean {
    if (isBlank(url)) return false;
    const t = isBlank(title) ? null : title!;
    const s = isBlank(snippet) ? null : snippet!;
    const existing = this.byUrl.get(url!);
    if (!existing) {
      this.byUrl.set(url!, { url: url!, title: t, snippet: s });
      return true;
    }
    const merged: Citation = { url: url!, title: existing.title ?? t, snippet: existing.snippet ?? s };
    if (merged.title !== existing.title || merged.snippet !== existing.snippet) {
      this.byUrl.set(url!, merged);
      return true;
    }
    return false;
  }

  isEmpty(): boolean {
    return this.byUrl.size === 0;
  }

  snapshot(): Citation[] {
    return [...this.byUrl.values()];
  }
}

// ------------------------------------------------------------------ client tools

const DEFAULT_SCHEMA = { type: 'object', properties: {} };
const MISTRAL_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Shared helpers for client tool calling across adapters. */
export const ToolWire = {
  /** Parses a tool's JSON Schema; falls back to an empty object schema and always sets `type: object`. */
  schema(json: string): JsonObject {
    const parsed = tryParseJson(json);
    if (!isObject(parsed)) return { ...DEFAULT_SCHEMA, properties: {} };
    return str(parsed, 'type') == null ? { type: 'object', ...parsed } : parsed;
  },

  /** Arguments as an object for providers that need one (Anthropic `input`); invalid JSON becomes `{}`. */
  argsObject(argumentsJson: string): JsonObject {
    const parsed = tryParseJson(argumentsJson);
    return isObject(parsed) ? parsed : {};
  },

  /**
   * Normalizes streamed arguments for toolCallReady: blank → `{}`, a valid object → compact JSON,
   * anything else (truncated/invalid) → the raw text, which the engine reports back to the model.
   */
  normalizeArgs(raw: string): string {
    if (isBlank(raw)) return '{}';
    const parsed = tryParseJson(raw);
    return isObject(parsed) ? JSON.stringify(parsed) : raw;
  },

  /** Arguments string to replay when the stored text isn't a JSON object (keeps requests valid). */
  replayArgs(argumentsJson: string): string {
    const parsed = tryParseJson(argumentsJson);
    return isObject(parsed) ? JSON.stringify(parsed) : '{}';
  },

  /** True when an error message says the model can't use tools/function calling at all. */
  toolsUnsupported(message: string): boolean {
    const m = message.toLowerCase();
    if (m.includes('function calling') || m.includes('function-calling')) {
      return m.includes('not support') || m.includes('unsupported') || m.includes('not available') || m.includes('not enabled') || m.includes('disabled');
    }
    const mentionsTools = m.includes('tool use') || m.includes('tool_use') || m.includes('tools') || m.includes('tool calling') || m.includes('tool calls');
    if (!mentionsTools) return false;
    return m.includes('does not support') || m.includes("doesn't support") || m.includes('not supported') || m.includes('unsupported') ||
      m.includes('not available') || m.includes('not enabled') || m.includes('is not allowed');
  },

  /** Anthropic / Responses-safe id: ^[a-zA-Z0-9_-]+$. */
  safeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'call';
  },

  /**
   * Mistral requires 9-character alphanumeric tool call ids; maps any id to one deterministically
   * (SHA-256, same as Android, so a call and its result always get the same id).
   */
  async mistralId(id: string): Promise<string> {
    if (/^[A-Za-z0-9]{9}$/.test(id)) return id;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf(utf8(id))));
    let out = '';
    for (let i = 0; i < 9; i++) out += MISTRAL_ALPHABET[digest[i] % MISTRAL_ALPHABET.length];
    return out;
  },

  /** A fresh id for providers that omit them (Gemini compat). */
  newId(index: number): string {
    return 'call_' + hex(randomBytes(6)) + '_' + index;
  },
};
