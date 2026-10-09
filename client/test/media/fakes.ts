/** Test doubles for media tests: a scripted fetch that records requests, sample files and a fake platform. */
import { vi } from 'vitest';
import { utf8 } from '../../src/core/bytes';
import type { ProviderKind } from '../../src/llm/providers';
import { normalizeModel, type ModelInfo, type ModelOutput, type ProviderConfig } from '../../src/llm/types';
import { setPlatform, type Platform } from '../../src/platform';

export const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const mp3 = new Uint8Array([...utf8('ID3'), ...new Array(64).fill(7)]);
export const mp4 = new Uint8Array([0, 0, 0, 0x18, ...utf8('ftypmp42'), ...new Array(32).fill(0)]);

export interface Recorded {
  url: URL;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
  /** The JSON request body. */
  json(): any;
  /** The multipart request body. */
  form(): FormData;
}

type Reply = Response | ((req: Recorded) => Response | Promise<Response>);

/** A scripted server: replies are queued in order, like OkHttp's MockWebServer. */
export class FakeServer {
  private replies: Reply[] = [];
  private unread: Recorded[] = [];
  readonly requests: Recorded[] = [];

  enqueue(reply: Reply): this {
    this.replies.push(reply);
    return this;
  }

  json(body: unknown, status = 200): this {
    return this.enqueue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  }

  bytes(b: Uint8Array, type: string): this {
    return this.enqueue(new Response(b.slice(), { headers: { 'Content-Type': type } }));
  }

  /** The oldest request not yet taken. */
  take(): Recorded {
    const r = this.unread.shift();
    if (!r) throw new Error('No more requests were made.');
    return r;
  }

  get pending(): number {
    return this.replies.length;
  }

  fetch: typeof fetch = async (input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body;
    const rec: Recorded = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
      json: () => JSON.parse(String(body)),
      form: () => body as FormData,
    };
    this.requests.push(rec);
    this.unread.push(rec);
    const next = this.replies.shift();
    if (!next) throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    return typeof next === 'function' ? next(rec) : next;
  };
}

export function config(kind: ProviderKind, baseUrl = 'https://api.test/v1'): ProviderConfig {
  return { id: 'p', kind, label: kind.displayName, baseUrl, apiKey: 'key-123', headers: {} };
}

export function model(id: string, output: ModelOutput, displayName = id): ModelInfo {
  return normalizeModel({ id, displayName, output });
}

export function useFakePlatform(corsLimited: boolean): void {
  setPlatform({
    kind: corsLimited ? 'web' : 'desktop',
    corsLimited,
    fetch: () => Promise.reject(new Error('Tests pass their own fetch.')),
  } as unknown as Platform);
}

const realSetTimeout = globalThis.setTimeout;

/** Drives fake timers until [p] settles (for polled jobs), then returns its result. */
export async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  while (!done) {
    await vi.advanceTimersByTimeAsync(250);
    await new Promise((r) => realSetTimeout(r, 0));
  }
  return p;
}
