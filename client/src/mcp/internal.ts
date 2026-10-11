/** Protocol constants and shared helpers for the MCP client (port of McpInternal.kt). */
import { b64url, randomBytes, unb64 } from '../core/bytes';
import { isObject } from '../core/json';
import { DEFAULT_INPUT_SCHEMA, type McpCallResult, type McpTool } from './types';

export type Json = Record<string, unknown>;

export const Mcp = {
  /** Newest first; we offer the first in `initialize` and accept any of them back. */
  SUPPORTED_VERSIONS: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as readonly string[],
  LATEST_VERSION: '2025-11-25',
  /** Versions that define the MCP-Protocol-Version request header. */
  VERSIONS_WITH_HEADER: new Set(['2025-11-25', '2025-06-18']),
  CLIENT_NAME: 'Facet AI',
  CLIENT_VERSION: '1.0.0',
  HEADER_SESSION: 'Mcp-Session-Id',
  HEADER_VERSION: 'MCP-Protocol-Version',
  ACCEPT_STREAMABLE: 'application/json, text/event-stream',
};

export function randomUrlSafe(bytes: number): string {
  return b64url(randomBytes(bytes));
}

/** PKCE S256 code challenge for [verifier]. */
export async function s256(verifier: string): Promise<string> {
  const ascii = new Uint8Array(verifier.length);
  for (let i = 0; i < verifier.length; i++) ascii[i] = verifier.charCodeAt(i) & 0x7f;
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', ascii)));
}

/** A JSON value read as a string the way kotlinx `JsonPrimitive.contentOrNull` does (numbers and booleans too). */
export function jstr(o: unknown, key: string): string | null {
  if (!isObject(o)) return null;
  const v = o[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

export function jobj(o: unknown, key: string): Json | null {
  if (!isObject(o)) return null;
  const v = o[key];
  return isObject(v) ? v : null;
}

export function jarr(o: unknown, key: string): unknown[] | null {
  if (!isObject(o)) return null;
  const v = o[key];
  return Array.isArray(v) ? v : null;
}

export function jbool(o: unknown, key: string): boolean | null {
  if (!isObject(o)) return null;
  const v = o[key];
  return typeof v === 'boolean' ? v : null;
}

/** Order-insensitive deep equality of two JSON values. */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEquals(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEquals(a[k], b[k]));
  }
  return false;
}

/** Parses one tools/list entry. */
export function parseTool(o: Json): McpTool | null {
  const name = jstr(o, 'name');
  if (name == null) return null;
  const annotations = jobj(o, 'annotations');
  const schema = jobj(o, 'inputSchema');
  const tool: McpTool = {
    name,
    title: jstr(o, 'title') ?? jstr(annotations, 'title'),
    description: jstr(o, 'description'),
    inputSchemaJson: schema ? JSON.stringify(schema) : DEFAULT_INPUT_SCHEMA,
    readOnlyHint: jbool(annotations, 'readOnlyHint'),
    destructiveHint: jbool(annotations, 'destructiveHint'),
    openWorldHint: jbool(annotations, 'openWorldHint'),
  };
  return tool;
}

/** Flattens a tools/call result into text the model can read, plus any images. */
export function flattenCallResult(result: Json): McpCallResult {
  const texts: string[] = [];
  const images: McpCallResult['images'] = [];
  for (const el of jarr(result, 'content') ?? []) {
    if (!isObject(el)) continue;
    switch (jstr(el, 'type')) {
      case 'text': {
        const t = jstr(el, 'text');
        if (t != null) texts.push(t);
        break;
      }
      case 'image': {
        const data = jstr(el, 'data');
        const mimeType = jstr(el, 'mimeType') ?? 'image/png';
        let bytes: Uint8Array | null = null;
        if (data != null) {
          try {
            bytes = unb64(data);
          } catch {
            bytes = null;
          }
        }
        if (bytes) images.push({ mimeType, bytes });
        else texts.push('[image omitted]');
        break;
      }
      case 'audio':
        texts.push('[audio omitted]');
        break;
      case 'resource': {
        const r = jobj(el, 'resource');
        const uri = jstr(r, 'uri') ?? 'unknown';
        const text = jstr(r, 'text');
        texts.push(text != null ? `[resource: ${uri}]\n${text}` : `[resource: ${uri} (${jstr(r, 'mimeType') ?? 'binary'})]`);
        break;
      }
      case 'resource_link': {
        const uri = jstr(el, 'uri') ?? 'unknown';
        const name = jstr(el, 'name') ?? jstr(el, 'title');
        const desc = jstr(el, 'description');
        let line = '[resource link: ' + (name != null ? `${name} (${uri})` : uri);
        if (desc != null) line += `: ${desc}`;
        texts.push(line + ']');
        break;
      }
      default:
        break;
    }
  }
  const structured = result.structuredContent;
  if (structured !== undefined && structured !== null) {
    const duplicated = texts.some((t) => {
      try {
        return jsonEquals(JSON.parse(t), structured);
      } catch {
        return false;
      }
    });
    if (!duplicated) texts.push(JSON.stringify(structured, null, 2));
  }
  const isError = jbool(result, 'isError') === true;
  const text = texts.join('\n\n') || (isError ? 'The tool reported an error without details.' : '(no output)');
  return { text, isError, images };
}

/** Parameters of the Bearer challenge in a WWW-Authenticate header (keys lowercased). */
export function parseBearerChallenge(header: string | null | undefined): Record<string, string> {
  if (!header || !header.trim()) return {};
  const idx = header.toLowerCase().indexOf('bearer');
  const part = idx >= 0 ? header.slice(idx + 6) : header;
  const out: Record<string, string> = {};
  const regex = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (const m of part.matchAll(regex)) {
    const key = m[1].toLowerCase();
    const value = (m[2] || m[3] || '').replace(/\\"/g, '"');
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/** Parses an http(s) URL (like OkHttp's toHttpUrlOrNull); null for anything else. */
export function httpUrl(s: string | null | undefined): URL | null {
  if (!s) return null;
  try {
    const u = new URL(s.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u : null;
  } catch {
    return null;
  }
}

const trimSlashes = (s: string) => s.replace(/\/+$/, '');

/** Canonical server URI for RFC 8707 resource indicators: lowercase scheme/host, no default port, no query/fragment, no trailing slash. */
export function canonicalResource(url: string): string {
  const u = httpUrl(url);
  if (!u) return trimSlashes(url.trim());
  return u.origin + trimSlashes(u.pathname);
}

export function originOf(url: URL): string {
  return url.origin;
}

/** Builds `<origin>/.well-known/<name><path>` (RFC 8414 §3 / RFC 9728 §3 path insertion). */
export function wellKnown(url: URL, name: string, includePath: boolean): string {
  const path = trimSlashes(url.pathname);
  return originOf(url) + '/.well-known/' + name + (includePath && path ? path : '');
}

/** Pulls `message (code)` out of a JSON-RPC error object. */
export function rpcErrorText(error: Json): string {
  const message = jstr(error, 'message') ?? 'Unknown error';
  const code = jstr(error, 'code');
  return code != null ? `${message} (${code})` : message;
}

/** Serializes async sections (the coroutine Mutex of the Kotlin client). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

export const TIMED_OUT: unique symbol = Symbol('timed out');

export function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}

/**
 * Runs [run] with a signal that aborts after [timeoutMs] or when [outer] aborts. Resolves
 * TIMED_OUT on timeout and rejects with [outer]'s reason when it aborts, even if [run] ignores
 * its signal (so a stuck reader never blocks the caller).
 */
export async function withDeadline<T>(
  timeoutMs: number,
  outer: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T | typeof TIMED_OUT> {
  if (outer?.aborted) throw abortError(outer);
  const ctrl = new AbortController();
  let timedOut = false;
  let stop!: (e: unknown) => void;
  const stopped = new Promise<never>((_, reject) => (stop = reject));
  stopped.catch(() => {});
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
    stop(TIMED_OUT);
  }, timeoutMs);
  const onAbort = () => {
    ctrl.abort(outer?.reason);
    stop(abortError(outer));
  };
  outer?.addEventListener('abort', onAbort, { once: true });
  const task = run(ctrl.signal);
  task.catch(() => {});
  try {
    return await Promise.race([task, stopped]);
  } catch (e) {
    if (timedOut) return TIMED_OUT;
    if (outer?.aborted) throw abortError(outer);
    throw e;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

/** [promise], or a rejection with [signal]'s reason as soon as it aborts. */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Releases a response body we don't read (so the connection can be reused or closed). */
export function discard(response: Response): void {
  response.body?.cancel().catch(() => {});
}
