/** Cancellation, browser (CORS) failures, dropped connections and cross-platform replay blocks. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicClient } from '../../src/llm/anthropic';
import { claudeCaps, compatCaps, openAiCaps } from '../../src/llm/catalog';
import { CitationCollector, ThinkTagSplitter, ToolWire } from '../../src/llm/internal';
import { OpenAiChatClient } from '../../src/llm/openaiChat';
import { OpenAiResponsesClient } from '../../src/llm/openaiResponses';
import { providerKind } from '../../src/llm/providers';
import { InMemoryQuirkStore } from '../../src/llm/quirks';
import { defaultParams, LlmException, type ChatMessage, type ChatRequest, type LlmClient, type StreamEvent } from '../../src/llm/types';
import { setPlatform, type Platform } from '../../src/platform';
import { collect, completed, config, failed, MockServer, resource, sse, sseBody, textOf, user } from './helpers';

let server: MockServer;
let quirks: InMemoryQuirkStore;

function installPlatform(corsLimited: boolean, fetchFn?: typeof fetch): void {
  setPlatform({ kind: corsLimited ? 'web' : 'desktop', corsLimited, fetch: fetchFn ?? server.fetch } as unknown as Platform);
}

beforeEach(() => {
  server = new MockServer();
  quirks = new InMemoryQuirkStore();
  installPlatform(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const anthropicRequest = (messages: ChatMessage[] = [user('Hi')]): ChatRequest => ({
  model: 'claude-opus-5-5', system: null, messages, params: defaultParams({ effort: 'HIGH' }), caps: claudeCaps('claude-opus-5-5'), tools: [],
});
const chatRequest = (kind: string, model = 'm'): ChatRequest => ({
  model, system: null, messages: [user('Hi')], params: defaultParams(), caps: compatCaps(providerKind(kind), model), tools: [],
});
const offlineFetch: typeof fetch = async () => {
  throw new TypeError('Failed to fetch');
};

describe('cancellation', () => {
  it('ends the iteration without a terminal event when aborted mid-stream', async () => {
    server.enqueue({ ...sse('anthropic_thinking.txt'), hang: true });
    const client = new AnthropicClient(config('anthropic', server), { fetch: server.fetch, quirks });
    const ac = new AbortController();
    const events: StreamEvent[] = [];
    for await (const ev of client.stream(anthropicRequest(), ac.signal)) {
      events.push(ev);
      if (ev.type === 'text') ac.abort();
    }
    expect(textOf(events)).toBe('Hello');
    expect(events.some((e) => e.type === 'completed' || e.type === 'failed')).toBe(false);
    expect(server.cancelled).toBe(1);
  });

  it('stops while waiting for a stalled stream', async () => {
    const full = resource('chat_deepseek.txt');
    server.enqueue({ ...sseBody(full.slice(0, full.indexOf('data:', 10))), hang: true });
    const client = new OpenAiChatClient(config('deepseek', server, '/v1'), { fetch: server.fetch, quirks });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const events = await collect(client, chatRequest('deepseek', 'deepseek-reasoner'), ac.signal);
    expect(events.map((e) => e.type)).toEqual(['started', 'thinkingStarted', 'thinking']);
    expect(server.cancelled).toBe(1);
  });

  it('sends nothing when already aborted', async () => {
    const client = new OpenAiResponsesClient(config('openai', server, '/v1'), { fetch: server.fetch, quirks });
    const ac = new AbortController();
    ac.abort();
    const req: ChatRequest = { model: 'gpt-5.5', system: null, messages: [user('Hi')], params: defaultParams(), caps: openAiCaps('gpt-5.5'), tools: [] };
    expect(await collect(client, req, ac.signal)).toEqual([]);
    expect(server.requestCount).toBe(0);
  });

  it('releases the connection when the consumer stops early', async () => {
    server.enqueue(sse('openai_reasoning.txt'));
    const client = new OpenAiResponsesClient(config('openai', server, '/v1'), { fetch: server.fetch, quirks });
    const req: ChatRequest = { model: 'gpt-5.5', system: null, messages: [user('Hi')], params: defaultParams(), caps: openAiCaps('gpt-5.5'), tools: [] };
    for await (const ev of client.stream(req)) if (ev.type === 'thinking') break;
    expect(server.cancelled).toBe(1);
  });
});

describe('network failures', () => {
  const run = (client: LlmClient, req: ChatRequest) => collect(client, req).then(failed);

  it('says a provider without CORS support only works in the apps', async () => {
    installPlatform(true);
    const client = new OpenAiChatClient(config('fireworks', server, '/v1'), { fetch: offlineFetch, quirks });
    const { error } = await run(client, chatRequest('fireworks'));
    expect(error.kind).toBe('BROWSER_BLOCKED');
    expect(error.message).toBe("Fireworks doesn't accept requests from web browsers. Use it in the Facet app for Windows or Android, or pick another provider.");
    await expect(client.listModels()).rejects.toSatisfy((e) => e instanceof LlmException && e.error.kind === 'BROWSER_BLOCKED');
  });

  it('says blocked-or-unreachable on the website for providers that allow browsers', async () => {
    installPlatform(true);
    const client = new OpenAiChatClient(config('custom', server, '/v1'), { fetch: offlineFetch, quirks });
    const { error } = await run(client, chatRequest('custom'));
    expect(error.kind).toBe('NETWORK');
    expect(error.message).toContain("couldn't be reached, or the browser blocked the request");
    expect(error.message).toContain("don't accept requests from web browsers");
  });

  it('says to check the connection when the browser is offline', async () => {
    installPlatform(true);
    vi.stubGlobal('navigator', { onLine: false });
    const client = new AnthropicClient(config('anthropic', server), { fetch: offlineFetch, quirks });
    const { error } = await run(client, anthropicRequest());
    expect(error).toMatchObject({ kind: 'NETWORK', message: "Can't reach Anthropic. Check your connection." });
  });

  it('explains local servers need CORS on the website', async () => {
    installPlatform(true);
    const client = new OpenAiChatClient(config('ollama', server, '/v1', ''), { fetch: offlineFetch, quirks });
    const { error } = await run(client, chatRequest('ollama'));
    expect(error.message).toContain('OLLAMA_ORIGINS');
  });

  it('says the server is unreachable in the Windows app', async () => {
    const client = new OpenAiChatClient(config('groq', server, '/v1'), { fetch: offlineFetch, quirks });
    const { error } = await run(client, chatRequest('groq'));
    expect(error).toMatchObject({ kind: 'NETWORK', message: "Can't reach Groq. Check your connection." });
  });

  it('reports a connection lost mid-response', async () => {
    const text = resource('chat_deepseek.txt');
    const fetchFn: typeof fetch = async () => {
      const bytes = new TextEncoder().encode(text.slice(0, 300));
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          setTimeout(() => c.error(new TypeError('network error')), 5);
        },
      });
      return new Response(body, { status: 200 });
    };
    const client = new OpenAiChatClient(config('deepseek', server, '/v1'), { fetch: fetchFn, quirks });
    const events = await collect(client, chatRequest('deepseek', 'deepseek-reasoner'));
    expect(events[0].type).toBe('started');
    expect(failed(events).error).toMatchObject({ kind: 'NETWORK', message: 'Lost the connection to DeepSeek before the response finished. Try again.' });
  });

  it('uses the platform fetch by default', async () => {
    server.enqueue(sse('chat_tool_step2.txt'));
    installPlatform(false, server.fetch);
    const client = new OpenAiChatClient(config('groq', server, '/v1'), { quirks });
    expect(textOf(await collect(client, chatRequest('groq')))).toBe('Lima is 20°C.');
  });
});

describe('replay blocks match the Android adapters', () => {
  it('stores Anthropic content blocks exactly as Kotlin does', async () => {
    server.enqueue(sse('anthropic_thinking.txt'));
    server.enqueue(sse('anthropic_tool_step1.txt'));
    const client = new AnthropicClient(config('anthropic', server), { fetch: server.fetch, quirks });
    const thinking = completed(await collect(client, anthropicRequest()));
    expect(thinking.blocks).toEqual({
      style: 'ANTHROPIC',
      model: 'claude-opus-5-5',
      json: '[{"type":"thinking","thinking":"Considering the question.","signature":"sigABC"},{"type":"text","text":"Hello world"}]',
    });
    const tools = completed(await collect(client, anthropicRequest()));
    expect(tools.blocks!.json).toBe(
      '[{"type":"text","text":"Let me check both cities."},' +
      '{"type":"tool_use","id":"toolu_01A","name":"get_weather","input":{"city":"Paris"}},' +
      '{"type":"tool_use","id":"toolu_01B","name":"get_weather","input":{"city":"Rome"}}]',
    );

    // Replayed verbatim on the next turn, signatures included.
    server.takeRequest();
    server.takeRequest();
    server.enqueue(sse('anthropic_tool_step2.txt'));
    await collect(client, anthropicRequest([user('Hi'), { role: 'ASSISTANT', parts: [{ type: 'text', text: 'Hello world' }], blocks: thinking.blocks }, user('More')]));
    expect(server.takeRequest().json().messages[1].content).toEqual(JSON.parse(thinking.blocks!.json));
  });

  it('stores Responses output items and replays them unchanged', async () => {
    server.enqueue(sse('openai_reasoning.txt'));
    const client = new OpenAiResponsesClient(config('openai', server, '/v1'), { fetch: server.fetch, quirks });
    const req: ChatRequest = { model: 'gpt-5.5', system: null, messages: [user('Hi')], params: defaultParams(), caps: openAiCaps('gpt-5.5'), tools: [] };
    const done = completed(await collect(client, req));
    const response = JSON.parse(resource('openai_reasoning.txt').split('\n').filter((l) => l.startsWith('data: ')).pop()!.slice(6)).response;
    expect(JSON.parse(done.blocks!.json)).toEqual(response.output);

    server.takeRequest();
    server.enqueue(sse('openai_tool_step2.txt'));
    await collect(client, { ...req, messages: [user('Hi'), { role: 'ASSISTANT', parts: [{ type: 'text', text: 'Facet is great.' }], blocks: done.blocks }, user('More')] });
    expect(server.takeRequest().json().input.slice(1, 4)).toEqual(response.output);
  });

  it('stores Chat Completions tool steps exactly as Kotlin does', async () => {
    server.enqueue(sse('chat_tool_step1.txt'));
    const client = new OpenAiChatClient(config('groq', server, '/v1'), { fetch: server.fetch, quirks });
    const done = completed(await collect(client, { ...chatRequest('groq', 'llama-3.3-70b'), tools: [{ name: 'get_weather', description: 'd', inputSchemaJson: '{}' }] }));
    expect(done.blocks).toEqual({
      style: 'OPENAI_CHAT',
      model: 'llama-3.3-70b',
      json: '[{"role":"assistant","content":"Checking.","tool_calls":[{"id":"call_x1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Lima\\"}"}}]}]',
    });
  });
});

describe('stream helpers', () => {
  const split = (chunks: string[]) => {
    const s = new ThinkTagSplitter();
    const segs = chunks.flatMap((c) => s.feed(c)).concat(s.flush());
    return {
      thinking: segs.filter((x) => x.thinking).map((x) => x.text).join(''),
      text: segs.filter((x) => !x.thinking).map((x) => x.text).join(''),
    };
  };

  it('splits think and thought tags only at the start', () => {
    expect(split(['  <thou', 'ght>plan</tho', 'ught>\n\nAnswer'])).toEqual({ thinking: 'plan', text: 'Answer' });
    expect(split(['Answer <think>not reasoning</think>'])).toEqual({ thinking: '', text: 'Answer <think>not reasoning</think>' });
    expect(split(['<thi'])).toEqual({ thinking: '', text: '<thi' });
    expect(split(['<think>unterminated</th'])).toEqual({ thinking: 'unterminated</th', text: '' });
    expect(split(['   '])).toEqual({ thinking: '', text: '   ' });
  });

  it('de-duplicates citations by URL and fills missing fields', () => {
    const c = new CitationCollector();
    expect(c.add('https://a', null)).toBe(true);
    expect(c.add('https://a', 'A')).toBe(true);
    expect(c.add('https://a', 'Other')).toBe(false);
    expect(c.add('  ', 'blank')).toBe(false);
    expect(c.snapshot()).toEqual([{ url: 'https://a', title: 'A', snippet: null }]);
  });

  it('normalizes tool arguments and schemas', async () => {
    expect(ToolWire.normalizeArgs('')).toBe('{}');
    expect(ToolWire.normalizeArgs('{ "a" : 1 }')).toBe('{"a":1}');
    expect(ToolWire.normalizeArgs('{"a"')).toBe('{"a"');
    expect(ToolWire.replayArgs('[1]')).toBe('{}');
    expect(ToolWire.schema('{"properties":{}}')).toEqual({ type: 'object', properties: {} });
    expect(ToolWire.schema('nope')).toEqual({ type: 'object', properties: {} });
    expect(ToolWire.safeId('call.1:x')).toBe('call_1_x');
    expect(await ToolWire.mistralId('abcDEF123')).toBe('abcDEF123');
    expect(await ToolWire.mistralId('toolu_01A')).toBe(await ToolWire.mistralId('toolu_01A'));
    expect(ToolWire.toolsUnsupported('This model does not support function calling')).toBe(true);
    expect(ToolWire.toolsUnsupported('Missing `reasoning_content` field')).toBe(false);
  });
});
