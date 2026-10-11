/**
 * HTTP plumbing for media backends: each provider's auth headers, JSON and binary requests with a
 * per-call deadline, abortable polling waits, and the conversion of failures to LlmExceptions
 * (via llm/errors, plus the few cases that read differently for media).
 */
import { isObject } from '../../core/json';
import { t } from '../../i18n';
import { platform } from '../../platform';
import { fromHttp, fromNetwork, HttpStatusError, providerName, TransportError, unexpected } from '../errors';
import { ProviderKinds } from '../providers';
import { LlmException, type ProviderConfig } from '../types';
import { sniff, type MediaFile } from './files';

/** Media requests can take minutes (video, long songs); a single call gives up after this. */
export const CALL_TIMEOUT_MS = 12 * 60_000;
/** Model lists, voice lists and key checks. */
export const SHORT_TIMEOUT_MS = 30_000;

export type Json = Record<string, unknown>;

/** A 2xx response that isn't what the API documents (e.g. HTML instead of JSON). */
export class BadResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadResponseError';
  }
}

export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}

function isTimeoutError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'TimeoutError';
}

/** Trims spaces and trailing slashes so paths can be appended. */
export function trimBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** The provider's auth headers plus the user's extra headers (which win). */
export function mediaHeaders(config: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = {};
  const key = config.apiKey;
  if (key.trim()) {
    switch (config.kind.id) {
      case ProviderKinds.GOOGLE.id: h['x-goog-api-key'] = key; break;
      case ProviderKinds.ELEVENLABS.id: h['xi-api-key'] = key; break;
      case ProviderKinds.BFL.id: h['x-key'] = key; break;
      case ProviderKinds.DEEPGRAM.id: h['Authorization'] = `Token ${key}`; break;
      default: h['Authorization'] = `Bearer ${key}`;
    }
  }
  if (config.kind.id === ProviderKinds.OPENROUTER.id) {
    h['HTTP-Referer'] = 'https://facet.dtsoftware.io';
    h['X-Title'] = 'Facet AI';
  }
  return { ...h, ...config.headers };
}

/** One generation's transport: the provider, which fetch to use and the caller's stop signal. */
export interface Http {
  config: ProviderConfig;
  fetch: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function resolveFetch(f?: typeof fetch): typeof fetch {
  // Resolved per call so tests and previews can install a platform after construction.
  return f ?? ((input, init) => platform().fetch(input, init));
}

/** The caller's signal plus a per-call deadline (like OkHttp's call timeout). */
function callSignal(signal: AbortSignal | undefined, ms: number): AbortSignal | undefined {
  const deadline = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
  if (!signal || !deadline) return signal ?? deadline;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, deadline]) : signal;
}

export interface RequestOptions {
  /** A JSON value, sent as application/json. */
  json?: unknown;
  /** FormData or raw bytes. */
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Send the provider's auth headers (default true). False for result URLs on other hosts. */
  auth?: boolean;
}

/** Sends a request (POST when it has a body). Non-2xx throws HttpStatusError; transport failures TransportError. */
export async function send(http: Http, url: string, o: RequestOptions = {}): Promise<Response> {
  const headers = new Headers(o.auth === false ? {} : mediaHeaders(http.config));
  let body = o.body;
  if (o.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(o.json);
  }
  for (const [k, v] of Object.entries(o.headers ?? {})) headers.set(k, v);
  let res: Response;
  try {
    res = await http.fetch(url, {
      method: body !== undefined ? 'POST' : 'GET',
      headers,
      body,
      signal: callSignal(http.signal, http.timeoutMs ?? CALL_TIMEOUT_MS),
    });
  } catch (e) {
    if (isAbortError(e) || isTimeoutError(e)) throw e;
    throw new TransportError(e, 'connect');
  }
  if (!res.ok) throw await HttpStatusError.from(res);
  return res;
}

async function read<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (isAbortError(e) || isTimeoutError(e)) throw e;
    throw new TransportError(e, 'read');
  }
}

/** A JSON response body (any JSON value). */
export async function requestJsonValue(http: Http, url: string, o: RequestOptions = {}): Promise<unknown> {
  const res = await send(http, url, o);
  const text = await read(() => res.text());
  try {
    return JSON.parse(text);
  } catch {
    throw new BadResponseError("The response wasn't JSON.");
  }
}

/** A JSON object response body. */
export async function requestJson(http: Http, url: string, o: RequestOptions = {}): Promise<Json> {
  const v = await requestJsonValue(http, url, o);
  if (!isObject(v)) throw new BadResponseError("The response wasn't a JSON object.");
  return v;
}

/** A binary response; the type comes from the bytes themselves, else the Content-Type header. */
export async function requestBytes(http: Http, url: string, o: RequestOptions = {}): Promise<MediaFile> {
  const res = await send(http, url, o);
  const bytes = new Uint8Array(await read(() => res.arrayBuffer()));
  const header = res.headers.get('Content-Type')?.split(';')[0].trim();
  return { bytes, mimeType: sniff(bytes) ?? (header || 'application/octet-stream') };
}

/** Downloads a result file. [mime] is used when the bytes aren't a format sniff() knows. */
export async function download(http: Http, url: string, mime: string | null, auth: boolean): Promise<MediaFile> {
  const file = await requestBytes(http, url, { auth });
  return mime != null && sniff(file.bytes) == null ? { bytes: file.bytes, mimeType: mime } : file;
}

/** Waits [ms], or rejects as soon as [signal] aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ------------------------------------------------------------------ errors

/** The website can't call providers that don't send CORS headers; the Windows and Android apps can. */
export function browserBlocked(config: ProviderConfig): LlmException {
  return new LlmException({
    kind: 'BROWSER_BLOCKED',
    message: t('{provider} doesn\'t accept requests from web browsers. Use it in the Facet app for Windows or Android.', { provider: providerName(config) }),
  });
}

/**
 * Converts any failure of a media call to an LlmException. Aborts pass through unchanged (the
 * caller stopped it), as do unexpected errors, so bugs aren't disguised as network trouble.
 */
export function toLlmException(config: ProviderConfig, model: string | null, e: unknown): unknown {
  if (e instanceof LlmException || isAbortError(e)) return e;
  if (e instanceof HttpStatusError) {
    // Media requests have no conversation to shorten: a 413 is an oversized text or recording.
    if (e.status === 413) {
      return new LlmException({
        kind: 'BAD_REQUEST',
        message: t('{provider} says the request is too large. Try a shorter text or recording.', { provider: providerName(config) }),
        httpStatus: 413,
      });
    }
    return new LlmException(fromHttp(config, model, e));
  }
  if (e instanceof TransportError || isTimeoutError(e)) return new LlmException(fromNetwork(config, e));
  if (e instanceof BadResponseError) return new LlmException(unexpected(config, e));
  return e;
}

/** Runs [work], converting its failures with toLlmException. */
export async function guard<T>(config: ProviderConfig, model: string | null, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw toLlmException(config, model, e);
  }
}

/** A whole, translated sentence as an UNKNOWN error (the provider answered, but not with media). */
export function failure(message: string): LlmException {
  return new LlmException({ kind: 'UNKNOWN', message });
}
