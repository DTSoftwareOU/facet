import { beforeEach, describe, expect, it } from 'vitest';
import { compatCaps } from '../../src/llm/catalog';
import { OpenAiChatClient } from '../../src/llm/openaiChat';
import { InMemoryQuirkStore } from '../../src/llm/quirks';
import { providerKind } from '../../src/llm/providers';
import { defaultCaps, defaultParams, type ChatMessage, type ChatRequest, type GenParams } from '../../src/llm/types';
import {
  collect,
  completed,
  config,
  failed,
  json,
  lastOf,
  MockServer,
  sse,
  sseBody,
  textOf,
  thinkingOf,
  user,
} from './helpers';

let server: MockServer;
let quirks: InMemoryQuirkStore;

beforeEach(() => {
  server = new MockServer();
  quirks = new InMemoryQuirkStore();
});

const client = (kind: string, key = 'sk-test-key-1234567890') =>
  new OpenAiChatClient(config(kind, server, '/v1', key), { fetch: server.fetch, quirks });

function request(kind: string, model: string, params: GenParams = defaultParams(), messages: ChatMessage[] = [user('Hi')]): ChatRequest {
  return { model, system: 'System prompt', messages, params, caps: compatCaps(providerKind(kind), model), tools: [] };
}

describe('OpenAiChatClient', () => {
  it('streams DeepSeek reasoning_content', async () => {
    server.enqueue(sse('chat_deepseek.txt'));
    const events = await collect(client('deepseek'), request('deepseek', 'deepseek-reasoner', defaultParams({ temperature: 0.7 })));
    expect(events[0]).toEqual({ type: 'started', model: 'deepseek-reasoner' });
    expect(thinkingOf(events)).toBe('Let me think more.');
    expect(textOf(events)).toBe('Answer here.');
    expect(events.findIndex((e) => e.type === 'thinkingEnded')).toBeLessThan(events.findIndex((e) => e.type === 'text'));
    expect(lastOf(events, 'usage').usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 4, cacheWriteTokens: 0, reasoningTokens: 12 });
    expect(events[events.length - 1]).toEqual({ type: 'completed', stopReason: 'END', blocks: null });

    const recorded = server.takeRequest();
    expect(recorded.url.pathname).toBe('/v1/chat/completions');
    const body = recorded.json();
    expect(body.temperature).toBeUndefined(); // reasoner rejects sampling params
    expect(body.stream_options.include_usage).toBe(true);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].content).toBe('Hi');
  });

  it('handles OpenRouter reasoning, annotations and the usage chunk', async () => {
    server.enqueue(sse('chat_openrouter.txt'));
    const caps = defaultCaps({ reasoning: { kind: 'EFFORT', efforts: ['LOW', 'MEDIUM', 'HIGH'], defaultEffort: null, summaries: true }, webSearch: true });
    const req: ChatRequest = { model: 'anthropic/claude-sonnet-4.5', system: null, messages: [user('Which?')], params: defaultParams({ effort: 'HIGH', webSearch: true }), caps, tools: [] };
    const events = await collect(client('openrouter'), req);
    expect(thinkingOf(events)).toBe('Weighing options carefully');
    expect(textOf(events)).toBe('Pick B.');
    const citations = lastOf(events, 'citations').citations;
    expect(citations).toHaveLength(1);
    expect(citations[0].snippet).toBe('B is best');
    expect(lastOf(events, 'usage').usage).toEqual({ inputTokens: 120, outputTokens: 64, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 30 });
    expect(completed(events).stopReason).toBe('MAX_TOKENS');

    const recorded = server.takeRequest();
    expect(recorded.headers.get('HTTP-Referer')).toBe('https://facet.dtsoftware.io');
    expect(recorded.headers.get('X-Title')).toBe('Facet');
    expect(recorded.headers.get('User-Agent')).toBeNull();
    const body = recorded.json();
    expect(body.reasoning.effort).toBe('high');
    expect(body.plugins[0].id).toBe('web');
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('splits <think> tags across chunks', async () => {
    server.enqueue(sse('chat_think_tags.txt'));
    const events = await collect(client('groq'), request('groq', 'qwen3-32b'));
    expect(thinkingOf(events)).toBe('Hmm, ok');
    expect(textOf(events)).toBe('Final answer with <think> literal');
  });

  it('collects Perplexity citations', async () => {
    server.enqueue(sse('chat_perplexity.txt'));
    const events = await collect(client('perplexity'), request('perplexity', 'sonar-pro'));
    const citations = lastOf(events, 'citations').citations;
    expect(citations.map((c) => c.url)).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(citations[0].title).toBe('A site');
    expect(textOf(events)).toBe('Per [1], yes.');
    expect(server.takeRequest().json().stream_options).toBeUndefined();
  });

  it('reads the Groq reasoning field and x_groq usage', async () => {
    server.enqueue(sse('chat_groq_reasoning.txt'));
    const events = await collect(client('groq'), request('groq', 'openai/gpt-oss-120b', defaultParams({ effort: 'LOW' })));
    expect(thinkingOf(events)).toBe('Short plan.');
    expect(textOf(events)).toBe('Result.');
    expect(lastOf(events, 'usage').usage.outputTokens).toBe(7);
    expect(server.takeRequest().json().reasoning_effort).toBe('low');
  });

  it('sends no auth header for local providers', async () => {
    server.enqueue(sse('chat_think_tags.txt'));
    await collect(client('ollama', ''), request('ollama', 'llama3.2'));
    expect(server.takeRequest().headers.get('Authorization')).toBeNull();
  });

  it('switches to max_completion_tokens when asked', async () => {
    server.enqueue(json(400, '{"error":{"message":"Unsupported parameter: \'max_tokens\' is not supported with this model. Use \'max_completion_tokens\' instead.","type":"invalid_request_error","param":"max_tokens","code":"unsupported_parameter"}}'));
    server.enqueue(sse('chat_deepseek.txt'));
    const events = await collect(client('custom'), request('custom', 'some-model', defaultParams({ maxOutputTokens: 500 })));
    completed(events);
    expect(server.takeRequest().json().max_tokens).toBe(500);
    const retry = server.takeRequest().json();
    expect(retry.max_tokens).toBeUndefined();
    expect(retry.max_completion_tokens).toBe(500);
  });

  it('drops a rejected reasoning_effort', async () => {
    server.enqueue(json(400, '{"error":{"message":"reasoning_effort is not supported for this model","type":"invalid_request_error"}}'));
    server.enqueue(sse('chat_groq_reasoning.txt'));
    const events = await collect(client('together'), request('together', 'openai/gpt-oss-20b', defaultParams({ effort: 'HIGH' })));
    completed(events);
    expect(server.takeRequest().json().reasoning_effort).toBe('high');
    expect(server.takeRequest().json().reasoning_effort).toBeUndefined();
    expect(quirks.dropped('p1', 'openai/gpt-oss-20b').has('effort')).toBe(true);
  });

  it('fails on a stream error chunk', async () => {
    server.enqueue(sseBody('data: {"error":{"message":"Provider returned error","code":502}}\n\n'));
    const events = await collect(client('openrouter'), request('openrouter', 'x/y'));
    expect(failed(events).error.detail).toBe('Provider returned error');
  });

  it('fails on a truncated stream', async () => {
    server.enqueue(sseBody('data: {"model":"m","choices":[{"index":0,"delta":{"content":"Half"},"finish_reason":null}]}\n\n'));
    const events = await collect(client('custom'), request('custom', 'm'));
    expect(textOf(events)).toBe('Half');
    expect(failed(events).error.kind).toBe('NETWORK');
  });

  it('finishes without [DONE] once a finish_reason arrived', async () => {
    server.enqueue(sseBody('data: {"model":"m","choices":[{"index":0,"delta":{"content":"All"},"finish_reason":"stop"}]}\n\n'));
    const events = await collect(client('custom'), request('custom', 'm'));
    expect(completed(events).stopReason).toBe('END');
  });

  it('turns images into content parts', async () => {
    server.enqueue(sse('chat_deepseek.txt'));
    const msg: ChatMessage = { role: 'USER', parts: [{ type: 'text', text: 'Describe' }, { type: 'image', mimeType: 'image/jpeg', bytes: new Uint8Array([9, 9]) }] };
    await collect(client('xai'), request('xai', 'grok-4', defaultParams(), [msg]));
    const content = server.takeRequest().json().messages[1].content;
    expect(content[1].type).toBe('image_url');
    expect(content[1].image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('lists OpenRouter models with live metadata', async () => {
    server.enqueue(json(200, `{"data":[
      {"id":"anthropic/claude-sonnet-4.5","name":"Anthropic: Claude Sonnet 4.5","created":1759000000,"context_length":1000000,
       "architecture":{"input_modalities":["text","image","file"],"output_modalities":["text"]},
       "pricing":{"prompt":"0.000003","completion":"0.000015","input_cache_read":"0.0000003"},
       "supported_parameters":["reasoning","include_reasoning","max_tokens","tools"],
       "top_provider":{"max_completion_tokens":64000}},
      {"id":"black-forest-labs/flux-pro","name":"Flux","architecture":{"input_modalities":["text"],"output_modalities":["image"]},"pricing":{"prompt":"0","completion":"0"}}
    ]}`));
    const models = await client('openrouter').listModels();
    // Image-output models go to the image list.
    expect(models.find((m) => m.id === 'black-forest-labs/flux-pro')!.output).toBe('IMAGE');
    const text = models.filter((m) => m.output === 'TEXT');
    expect(text).toHaveLength(1);
    const m = text[0];
    expect(m.displayName).toBe('Anthropic: Claude Sonnet 4.5');
    expect(m.caps.vision && m.caps.pdf && m.caps.webSearch).toBe(true);
    expect(m.caps.sampling).toBe(false);
    expect(m.caps.reasoning.kind).toBe('EFFORT');
    expect(m.pricing!.input).toBeCloseTo(3.0, 9);
    expect(m.pricing!.output).toBeCloseTo(15.0, 9);
    expect(m.pricing!.cacheRead!).toBeCloseTo(0.3, 9);
    expect(m.maxOutput).toBe(64000);
    expect(m.createdAt).toBe(1759000000 * 1000);
  });

  it('strips the Gemini models/ prefix and filters the list', async () => {
    server.enqueue(json(200, '{"object":"list","data":[{"id":"models/gemini-2.5-flash","object":"model","owned_by":"google"},{"id":"models/text-embedding-004","object":"model","owned_by":"google"},{"id":"models/gemini-2.5-pro","object":"model","owned_by":"google"}]}'));
    const all = await client('google').listModels();
    const models = all.filter((m) => m.output === 'TEXT');
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
    // The list had no media models, so the current Gemini ones are added (one per kind); embeddings stay out.
    expect(new Set(all.filter((m) => m.output !== 'TEXT').map((m) => m.output))).toEqual(new Set(['IMAGE', 'VIDEO', 'SPEECH', 'MUSIC']));
    expect(all.some((m) => m.id.includes('embedding'))).toBe(false);
    expect(models[0].displayName).toBe('Gemini 2.5 Flash');
    expect(models[0].caps.reasoning.efforts).toContain('NONE');
    expect(models[1].caps.reasoning.efforts).not.toContain('NONE');
  });

  it('lists static Perplexity models without a request', async () => {
    const models = await client('perplexity').listModels();
    expect(models.some((m) => m.id === 'sonar-pro')).toBe(true);
    expect(server.requestCount).toBe(0);
  });

  it('verifies Perplexity with a one-token completion', async () => {
    server.enqueue(json(200, '{"choices":[]}'));
    await client('perplexity').verify();
    const r = server.takeRequest();
    expect(r.method).toBe('POST');
    expect(r.url.pathname).toBe('/v1/chat/completions');
    expect(r.json().max_tokens).toBe(1);
  });

  it('asks Gemini for thought summaries and OpenRouter to hide reasoning when thinking is off', async () => {
    server.enqueue(sse('chat_think_tags.txt'));
    await collect(client('google'), request('google', 'gemini-2.5-flash', defaultParams({ effort: 'LOW' })));
    const gemini = server.takeRequest().json();
    expect(gemini.extra_body.google.thinking_config.include_thoughts).toBe(true);
    expect(gemini.reasoning_effort).toBe('low');

    server.enqueue(sse('chat_think_tags.txt'));
    const caps = defaultCaps({ reasoning: { kind: 'EFFORT', efforts: ['LOW', 'MEDIUM', 'HIGH'], defaultEffort: null, summaries: true } });
    await collect(client('openrouter'), { model: 'x/y', system: null, messages: [user('Hi')], params: defaultParams({ showThinking: false }), caps, tools: [] });
    expect(server.takeRequest().json().reasoning).toEqual({ exclude: true });
  });
});
