/**
 * Fake-fetch scaffolding for adapter tests (the counterpart of MockServerTest.kt). Responses are
 * served from recorded SSE text, cut into chunks at odd sizes so events, lines and multi-byte
 * characters split across reads.
 */
import { readFileSync } from 'node:fs';
import { InMemoryQuirkStore } from '../../src/llm/quirks';
import { providerKind, type ProviderKind } from '../../src/llm/providers';
import type { ChatMessage, LlmClient, ChatRequest, ProviderConfig, StreamEvent } from '../../src/llm/types';

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Leave the body open after the last chunk (for abort tests). */
  hang?: boolean;
}

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  bodyText: string;
  json(): any;
}

const CHUNK_SIZES = [7, 31, 1, 64, 13, 2, 97, 5];

/** A body stream cut into irregular chunks. */
export function chunkedStream(text: string, hang = false, onCancel?: () => void): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        if (hang) return new Promise<void>(() => {});
        controller.close();
        return;
      }
      const n = CHUNK_SIZES[i++ % CHUNK_SIZES.length];
      controller.enqueue(bytes.slice(offset, offset + n));
      offset += n;
    },
    cancel() {
      onCancel?.();
    },
  });
}

export function resource(name: string): string {
  return readFileSync(new URL(`./sse/${name}`, import.meta.url), 'utf8');
}

export function sse(name: string): MockResponse {
  return sseBody(resource(name));
}

export function sseBody(body: string): MockResponse {
  return { status: 200, headers: { 'Content-Type': 'text/event-stream' }, body };
}

export function json(status: number, body: string, headers: Record<string, string> = {}): MockResponse {
  return { status, headers: { 'Content-Type': 'application/json', ...headers }, body };
}

export class MockServer {
  private queue: MockResponse[] = [];
  private requests: RecordedRequest[] = [];
  requestCount = 0;
  cancelled = 0;
  readonly baseUrl = 'http://mock.test';

  enqueue(r: MockResponse): void {
    this.queue.push(r);
  }

  takeRequest(): RecordedRequest {
    const r = this.requests.shift();
    if (!r) throw new Error('No request recorded');
    return r;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    this.requestCount++;
    this.requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      bodyText,
      json: () => JSON.parse(bodyText),
    });
    const r = this.queue.shift();
    if (!r) throw new TypeError('Failed to fetch');
    return new Response(chunkedStream(r.body, r.hang, () => this.cancelled++), { status: r.status, headers: r.headers });
  };
}

export function config(kind: ProviderKind | string, server: MockServer, path = '', key = 'sk-test-key-1234567890'): ProviderConfig {
  const k = typeof kind === 'string' ? providerKind(kind) : kind;
  return { id: 'p1', kind: k, label: 'Test', baseUrl: server.baseUrl + path, apiKey: key, headers: {} };
}

export function newQuirks(): InMemoryQuirkStore {
  return new InMemoryQuirkStore();
}

export async function collect(client: LlmClient, request: ChatRequest, signal?: AbortSignal): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of client.stream(request, signal)) out.push(ev);
  return out;
}

export function user(text: string): ChatMessage {
  return { role: 'USER', parts: [{ type: 'text', text }] };
}

export function textOf(events: StreamEvent[]): string {
  return events.map((e) => (e.type === 'text' ? e.text : '')).join('');
}

export function thinkingOf(events: StreamEvent[]): string {
  return events.map((e) => (e.type === 'thinking' ? e.text : '')).join('');
}

export function ofType<T extends StreamEvent['type']>(events: StreamEvent[], type: T): Extract<StreamEvent, { type: T }>[] {
  return events.filter((e): e is Extract<StreamEvent, { type: T }> => e.type === type);
}

export function only<T extends StreamEvent['type']>(events: StreamEvent[], type: T): Extract<StreamEvent, { type: T }> {
  const list = ofType(events, type);
  if (list.length !== 1) throw new Error(`Expected exactly one ${type} event, got ${list.length}`);
  return list[0];
}

export function lastOf<T extends StreamEvent['type']>(events: StreamEvent[], type: T): Extract<StreamEvent, { type: T }> {
  const list = ofType(events, type);
  if (list.length === 0) throw new Error(`No ${type} event`);
  return list[list.length - 1];
}

export function completed(events: StreamEvent[]): Extract<StreamEvent, { type: 'completed' }> {
  const last = events[events.length - 1];
  if (last?.type !== 'completed') throw new Error(`Last event is ${last?.type}: ${JSON.stringify(last)}`);
  return last;
}

export function failed(events: StreamEvent[]): Extract<StreamEvent, { type: 'failed' }> {
  const last = events[events.length - 1];
  if (last?.type !== 'failed') throw new Error(`Last event is ${last?.type}`);
  return last;
}
