/**
 * Maps transport and provider failures to user-facing LlmErrors (port of LlmErrors.kt), plus the
 * website's extra failure mode: providers whose APIs don't allow requests from web pages (CORS).
 * Never leaks API keys.
 */
import { isObject } from '../core/json';
import { platform } from '../platform';
import { ProviderKinds } from './providers';
import { isContextLength } from './quirks';
import { LlmException, type LlmError, type ProviderConfig } from './types';

const KEY_LIKE = /\b(sk-ant-|sk-or-|sk-proj-|sk-|xai-|gsk_|pplx-|csk-|fw_|AIza)[A-Za-z0-9_\-*.]{6,}/g;
const MAX_DETAIL = 600;
const MAX_BODY = 64 * 1024;

/** A non-2xx HTTP response. `body` is the (truncated) response body, used for error mapping and healing. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
  }

  /** Consumes the response body. Retry-After is only readable cross-origin when the provider exposes it. */
  static async from(res: Response): Promise<HttpStatusError> {
    let body = '';
    try {
      body = (await res.text()).slice(0, MAX_BODY);
    } catch {
      // keep empty
    }
    return new HttpStatusError(res.status, body, parseRetryAfter(res.headers.get('retry-after')));
  }
}

/** The request never got a response (`connect`) or the connection dropped mid-body (`read`). */
export class TransportError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly phase: 'connect' | 'read',
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TransportError';
  }
}

export function parseRetryAfter(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const n = Number(value.trim());
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.ceil(n));
}

export function providerName(config: ProviderConfig): string {
  if (config.kind.id !== ProviderKinds.CUSTOM.id) return config.kind.displayName;
  return config.label.trim() === '' ? 'The endpoint' : config.label;
}

/** Removes anything that looks like a credential, including the configured key itself. */
export function redact(text: string, apiKey: string | null | undefined): string {
  let out = text;
  if (apiKey && apiKey.trim() !== '' && apiKey.length >= 6) out = out.split(apiKey).join('[redacted]');
  return out.replace(KEY_LIKE, '[redacted]');
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

const s = (o: unknown, k: string): string | null => (isObject(o) && typeof o[k] === 'string' ? (o[k] as string) : null);

/** Best-effort extraction of the human message from a provider error body. */
export function extractMessage(body: string): string {
  const json = parseObject(body);
  if (!json) return body.trim().slice(0, MAX_DETAIL);
  const err = json.error;
  const fromErr = isObject(err) ? (s(err, 'message') ?? s(err, 'type')) : typeof err === 'string' ? err : null;
  const msg = fromErr ?? s(json, 'message') ?? s(json, 'detail') ?? s(json.detail, 'message');
  return (msg ?? body).trim().slice(0, MAX_DETAIL);
}

function errorCode(body: string): string | null {
  const json = parseObject(body);
  if (!json) return null;
  const err = isObject(json.error) ? json.error : null;
  return s(err, 'code') ?? s(err, 'type') ?? s(json, 'code');
}

const quoted = (model: string | null | undefined): string => (model ? `“${model}”` : 'this model');

export function fromHttp(config: ProviderConfig, model: string | null | undefined, e: HttpStatusError): LlmError {
  const provider = providerName(config);
  const raw = redact(extractMessage(e.body), config.apiKey);
  const m = raw.toLowerCase();
  const code = (errorCode(e.body) ?? '').toLowerCase();
  const modelName = quoted(model);
  const status = e.status;
  const err = (kind: LlmError['kind'], message: string): LlmError => ({
    kind,
    message,
    httpStatus: status,
    retryAfterSeconds: e.retryAfterSeconds,
    detail: raw.trim() === '' ? null : raw,
  });

  const creditProblem = m.includes('credit balance') || code.includes('insufficient_quota') || m.includes('insufficient credits') ||
    m.includes('billing') || m.includes('exceeded your current quota') || m.includes('payment required') || m.includes('out of credits');
  if (status === 401) return err('AUTH', `${provider} rejected this API key. Check it in Providers.`);
  if (status === 402 || creditProblem) {
    return err('QUOTA', `${provider} says this account is out of credits or over its spending limit. Add credits with ${provider}, then retry.`);
  }
  if (status === 403 && m.includes('verif')) {
    return err('PERMISSION', `${provider} requires organization verification for ${modelName}. Verify your organization in the ${provider} dashboard, or pick another model.`);
  }
  if (status === 403) return err('PERMISSION', `${provider} denied access to ${modelName} with this key. Check the key's permissions or pick another model.`);
  if (status === 404) return err('NOT_FOUND', `${provider} couldn't find ${modelName}. It may be retired, or this key can't use it.`);
  if (status === 413 || isContextLength(raw)) {
    return err('CONTEXT_LENGTH', `This conversation is too long for ${modelName}. Start a new chat, remove attachments, or pick a model with a larger context window.`);
  }
  if (status === 429) {
    const it = e.retryAfterSeconds;
    const wait = it == null ? ' Try again in a moment.' : it <= 90 ? ` Try again in ${it}s.` : ` Try again in ${Math.floor((it + 59) / 60)} min.`;
    return err('RATE_LIMIT', `${provider} is rate-limiting this key.${wait}`);
  }
  if (status === 408) return err('TIMEOUT', `${provider} took too long to respond. Try again.`);
  if (status === 529 || ((status === 503 || status === 502) && m.includes('overload')) || code.includes('overloaded')) {
    return err('OVERLOADED', `${provider} is overloaded right now. Try again shortly, or switch models.`);
  }
  if (status >= 500 && status <= 599) return err('SERVER', `${provider} had a server error (HTTP ${status}). Try again.`);
  if (status === 400 || status === 422) {
    const shown = raw.slice(0, 220).trim() === '' ? 'invalid request' : raw.slice(0, 220);
    return err('BAD_REQUEST', `${provider} rejected the request: ${shown}`);
  }
  return err('UNKNOWN', `${provider} returned HTTP ${status}${raw.trim() !== '' ? `: ${raw.slice(0, 200)}` : '.'}`);
}

function corsLimited(): boolean {
  try {
    return platform().corsLimited;
  } catch {
    return false;
  }
}

function offline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function isLocal(config: ProviderConfig): boolean {
  return config.kind.id === ProviderKinds.OLLAMA.id || config.kind.id === ProviderKinds.LMSTUDIO.id;
}

/**
 * A failed fetch (no HTTP response) or a connection lost mid-response. Browsers report CORS
 * rejections, DNS failures and refused connections alike as a bare TypeError, so on the website
 * the message says what's likely: the provider's known CORS support decides between "this
 * provider never works from a browser" and "blocked or unreachable".
 */
export function fromNetwork(config: ProviderConfig, error: unknown, phase: 'connect' | 'read' = 'connect'): LlmError {
  if (error instanceof HttpStatusError) return fromHttp(config, null, error);
  const cause = error instanceof TransportError ? error.cause : error;
  const p = error instanceof TransportError ? error.phase : phase;
  const provider = providerName(config);
  const detail = redact(cause instanceof Error ? (cause.message || cause.name) : String(cause), config.apiKey);
  const name = (cause as { name?: string } | null)?.name;

  if (name === 'TimeoutError' || name === 'AbortError') {
    return { kind: 'TIMEOUT', message: `${provider} took too long to respond. Try again.`, detail };
  }
  if (p === 'read') {
    return { kind: 'NETWORK', message: `Lost the connection to ${provider} before the response finished. Try again.`, detail };
  }
  const local = isLocal(config);
  if (corsLimited()) {
    if (config.kind.browserOk === false) {
      return {
        kind: 'BROWSER_BLOCKED',
        message: `${provider} doesn't accept requests from web browsers. Use it in the Facet app for Windows or Android, or pick another provider.`,
        detail,
      };
    }
    if (offline()) return { kind: 'NETWORK', message: `Can't reach ${provider}. Check your connection.`, detail };
    if (local) {
      return {
        kind: 'NETWORK',
        message: `Can't reach ${provider} at ${config.baseUrl}. Make sure it's running and accepts requests from web pages (Ollama: set OLLAMA_ORIGINS; LM Studio: enable CORS), or use the Facet app for Windows.`,
        detail,
      };
    }
    return {
      kind: 'NETWORK',
      message: `${provider} couldn't be reached, or the browser blocked the request. Some endpoints don't accept requests from web browsers; if this is one of them, use the Facet app for Windows or Android.`,
      detail,
    };
  }
  return {
    kind: 'NETWORK',
    message: local
      ? `Can't reach ${provider} at ${config.baseUrl}. Make sure it's running and reachable from this computer.`
      : `Can't reach ${provider}. Check your connection.`,
    detail,
  };
}

/** Errors reported inside a stream (`event: error`, `response.failed`, `{"error":…}` chunks). */
export function fromStream(config: ProviderConfig, model: string | null | undefined, type: string | null | undefined, message: string | null | undefined): LlmError {
  const provider = providerName(config);
  const raw = redact(message ?? '', config.apiKey).slice(0, MAX_DETAIL);
  const t = (type ?? '').toLowerCase();
  const m = raw.toLowerCase();
  if (t.includes('overloaded') || m.includes('overloaded')) {
    return { kind: 'OVERLOADED', message: `${provider} is overloaded right now. Try again shortly, or switch models.`, detail: raw };
  }
  if (t.includes('rate_limit') || m.includes('rate limit')) {
    return { kind: 'RATE_LIMIT', message: `${provider} is rate-limiting this key. Try again in a moment.`, detail: raw };
  }
  if (t.includes('quota') || t.includes('insufficient') || m.includes('credit')) {
    return { kind: 'QUOTA', message: `${provider} says this account is out of credits or over its spending limit. Add credits with ${provider}, then retry.`, detail: raw };
  }
  if (t.includes('authentication') || t.includes('invalid_api_key')) {
    return { kind: 'AUTH', message: `${provider} rejected this API key. Check it in Providers.`, detail: raw };
  }
  if (isContextLength(raw)) {
    return { kind: 'CONTEXT_LENGTH', message: `This conversation is too long for ${quoted(model)}. Start a new chat or remove attachments.`, detail: raw };
  }
  if (t.includes('server') || t.includes('api_error')) {
    return { kind: 'SERVER', message: `${provider} had a server error mid-response. Try again.`, detail: raw };
  }
  return {
    kind: 'UNKNOWN',
    message: `${provider} stopped with an error${raw.trim() !== '' ? `: ${raw.slice(0, 200)}` : '.'}`,
    detail: raw.trim() === '' ? null : raw,
  };
}

export function truncatedStream(config: ProviderConfig): LlmError {
  return { kind: 'NETWORK', message: `The connection to ${providerName(config)} closed before the response finished. Try again.` };
}

/** Something unexpected went wrong while handling a response (a bug, or a response we can't parse). */
export function unexpected(config: ProviderConfig, error: unknown): LlmError {
  return {
    kind: 'UNKNOWN',
    message: `Something went wrong reading the response from ${providerName(config)}.`,
    detail: error instanceof Error ? error.message : String(error),
  };
}

/** Any thrown value → LlmError (for callers that catch around listModels/verify or their own requests). */
export function toLlmError(config: ProviderConfig, error: unknown, model?: string | null): LlmError {
  if (error instanceof LlmException) return error.error;
  if (error instanceof HttpStatusError) return fromHttp(config, model, error);
  if (error instanceof TransportError) return fromNetwork(config, error);
  if (error instanceof TypeError) return fromNetwork(config, error, 'connect');
  return unexpected(config, error);
}
