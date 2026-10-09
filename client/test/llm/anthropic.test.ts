import { beforeEach, describe, expect, it } from 'vitest';
import { AnthropicClient } from '../../src/llm/anthropic';
import { claudeCaps } from '../../src/llm/catalog';
import { InMemoryQuirkStore } from '../../src/llm/quirks';
import { defaultParams, type ChatMessage, type ChatRequest, type GenParams, type ModelCaps } from '../../src/llm/types';
import {
  collect,
  completed,
  config,
  failed,
  json,
  lastOf,
  MockServer,
  only,
  ofType,
  sse,
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

const client = () => new AnthropicClient(config('anthropic', server), { fetch: server.fetch, quirks });

function request(
  over: { model?: string; params?: GenParams; messages?: ChatMessage[]; caps?: ModelCaps } = {},
): ChatRequest {
  const model = over.model ?? 'claude-opus-5-5';
  return {
    model,
    system: 'Be brief.',
    messages: over.messages ?? [user('Hi')],
    params: over.params ?? defaultParams({ effort: 'HIGH' }),
    caps: over.caps ?? claudeCaps(model),
    tools: [],
  };
}

const parse = (s: string) => JSON.parse(s);

describe('AnthropicClient', () => {
  it('streams text and summarized thinking', async () => {
    server.enqueue(sse('anthropic_thinking.txt'));
    const events = await collect(client(), request());

    expect(events[0]).toEqual({ type: 'started', model: 'claude-opus-5-5' });
    expect(thinkingOf(events)).toBe('Considering the question.');
    expect(textOf(events)).toBe('Hello world');
    expect(ofType(events, 'thinkingStarted')).toHaveLength(1);
    expect(ofType(events, 'thinkingEnded')).toHaveLength(1);
    expect(lastOf(events, 'usage').usage).toEqual({ inputTokens: 420, outputTokens: 42, cacheReadTokens: 300, cacheWriteTokens: 100, reasoningTokens: 0 });

    const done = completed(events);
    expect(done.stopReason).toBe('END');
    expect(done.blocks!.style).toBe('ANTHROPIC');
    const blocks = parse(done.blocks!.json);
    expect(blocks[0].type).toBe('thinking');
    expect(blocks[0].signature).toBe('sigABC');
    expect(blocks[1].text).toBe('Hello world');

    const recorded = server.takeRequest();
    expect(recorded.url.pathname).toBe('/v1/messages');
    expect(recorded.headers.get('x-api-key')).toBe('sk-test-key-1234567890');
    expect(recorded.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(recorded.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(recorded.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const body = recorded.json();
    expect(body.thinking.type).toBe('adaptive');
    expect(body.thinking.display).toBe('summarized');
    expect(body.output_config.effort).toBe('high');
    expect(body.fallbacks).toBe('default');
    expect(body.cache_control.type).toBe('ephemeral');
    expect(body.max_tokens).toBe(64_000);
    expect(body.temperature).toBeUndefined();
    expect(body.system[0].text).toBe('Be brief.');
  });

  it('omitted thinking still signals thinking, and max_tokens stops', async () => {
    server.enqueue(sse('anthropic_omitted.txt'));
    const events = await collect(client(), request({ params: defaultParams({ effort: 'LOW', showThinking: false }) }));
    expect(events).toContainEqual({ type: 'thinkingStarted' });
    expect(events).toContainEqual({ type: 'thinkingEnded' });
    expect(thinkingOf(events)).toBe('');
    expect(completed(events).stopReason).toBe('MAX_TOKENS');
    const body = server.takeRequest().json();
    expect(body.thinking.display).toBe('omitted');
    expect(body.output_config.effort).toBe('low');
  });

  it('web search emits queries and citations', async () => {
    server.enqueue(sse('anthropic_websearch.txt'));
    const events = await collect(client(), request({ model: 'claude-sonnet-5-5', params: defaultParams({ effort: 'MEDIUM', webSearch: true }) }));
    expect(ofType(events, 'webSearch')).toEqual([
      { type: 'webSearch', query: 'facet app', done: false },
      { type: 'webSearch', query: 'facet app', done: true },
    ]);
    const citations = lastOf(events, 'citations').citations;
    expect(citations.map((c) => c.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(citations[0].snippet).toBe('Facet is an app');
    expect(textOf(events)).toBe('Facet is an app.');

    const blocks = parse(completed(events).blocks!.json);
    expect(blocks[0].input.query).toBe('facet app');
    expect(blocks[1].type).toBe('web_search_tool_result');
    expect(blocks[1].content[0].page_age).toBeNull(); // provider content kept verbatim for replay
    expect(blocks[2].citations).toHaveLength(1);

    const tools = server.takeRequest().json().tools;
    expect(tools[0].type).toBe('web_search_20260209');
  });

  it('continues after pause_turn', async () => {
    server.enqueue(sse('anthropic_pause_1.txt'));
    server.enqueue(sse('anthropic_pause_2.txt'));
    const events = await collect(client(), request({ params: defaultParams({ effort: 'HIGH', webSearch: true }) }));
    expect(textOf(events)).toBe('Searching. Here is the result.');
    expect(ofType(events, 'started')).toHaveLength(1);
    const done = completed(events);
    expect(done.stopReason).toBe('END');
    expect(parse(done.blocks!.json)).toHaveLength(4);
    expect(lastOf(events, 'usage').usage.inputTokens).toBe(40 + 60);

    server.takeRequest();
    const second = server.takeRequest().json();
    const last = second.messages[second.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content[last.content.length - 1].type).toBe('server_tool_use');
  });

  it('refusal completes with a notice', async () => {
    server.enqueue(sse('anthropic_refusal.txt'));
    const events = await collect(client(), request({ model: 'claude-fable-5-1', params: defaultParams({ effort: 'HIGH' }) }));
    const notice = only(events, 'notice');
    expect(notice.text).toContain('declined');
    expect(notice.text).toContain('cybersecurity');
    expect(completed(events).stopReason).toBe('REFUSAL');
  });

  it('fallback block produces a notice and is dropped from replay', async () => {
    server.enqueue(sse('anthropic_fallback.txt'));
    const events = await collect(client(), request({ model: 'claude-fable-5-1' }));
    expect(ofType(events, 'notice').some((n) => n.text.includes('claude-opus-4-8'))).toBe(true);
    const done = completed(events);
    expect(done.blocks!.model).toBe('claude-opus-4-8');
    expect(parse(done.blocks!.json).some((b: any) => b.type === 'fallback')).toBe(false);
  });

  it('replays thinking blocks with drop_block binding', async () => {
    server.enqueue(sse('anthropic_thinking.txt'));
    const prior = '[{"type":"thinking","thinking":"earlier","signature":"sigOLD"},{"type":"text","text":"Earlier answer"}]';
    const messages: ChatMessage[] = [
      user('First'),
      { role: 'ASSISTANT', parts: [{ type: 'text', text: 'Earlier answer' }], blocks: { style: 'ANTHROPIC', model: 'claude-opus-5-5', json: prior } },
      user('Second'),
    ];
    await collect(client(), request({ messages }));
    const recorded = server.takeRequest();
    expect(recorded.headers.get('anthropic-beta')).toContain('thinking-binding-controls-2026-08-01');
    const body = recorded.json();
    expect(body.thinking.block_binding.prefix_mismatch_behavior).toBe('drop_block');
    expect(body.messages[1].content[0].signature).toBe('sigOLD');
  });

  it('a signature error strips thinking and retries', async () => {
    server.enqueue(json(400, '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."}}'));
    server.enqueue(sse('anthropic_thinking.txt'));
    const prior = '[{"type":"thinking","thinking":"x","signature":"bad"},{"type":"text","text":"Prev"}]';
    const messages: ChatMessage[] = [
      user('First'),
      { role: 'ASSISTANT', parts: [{ type: 'text', text: 'Prev' }], blocks: { style: 'ANTHROPIC', model: 'claude-opus-5-5', json: prior } },
      user('Again'),
    ];
    const events = await collect(client(), request({ messages }));
    completed(events);
    server.takeRequest();
    const retry = server.takeRequest().json();
    expect(retry.messages[1].content.some((b: any) => b.type === 'thinking')).toBe(false);
    expect(retry.thinking.block_binding).toBeUndefined();
  });

  it('maps an auth error', async () => {
    server.enqueue(json(401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'));
    const events = await collect(client(), request());
    expect(events).toHaveLength(1);
    const f = failed(events);
    expect(f.error.kind).toBe('AUTH');
    expect(f.error.message).toBe('Anthropic rejected this API key. Check it in Providers.');
  });

  it('maps a rate limit with Retry-After', async () => {
    server.enqueue(json(429, '{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', { 'retry-after': '30' }));
    const events = await collect(client(), request());
    expect(events).toHaveLength(1);
    const f = failed(events);
    expect(f.error.kind).toBe('RATE_LIMIT');
    expect(f.error.retryAfterSeconds).toBe(30);
    expect(f.error.message).toContain('30s');
  });

  it('drops a rejected temperature and remembers it', async () => {
    server.enqueue(json(400, '{"type":"error","error":{"type":"invalid_request_error","message":"temperature: this model does not support the temperature parameter"}}'));
    server.enqueue(sse('anthropic_thinking.txt'));
    const model = 'claude-sonnet-4-5';
    const caps = { ...claudeCaps(model), sampling: true };
    const events = await collect(client(), request({ model, params: defaultParams({ temperature: 0.4 }), caps }));
    completed(events);
    expect(server.takeRequest().json().temperature).toBe(0.4);
    expect(server.takeRequest().json().temperature).toBeUndefined();
    expect(quirks.dropped('p1', model).has('temperature')).toBe(true);

    // Next request omits it up front.
    server.enqueue(sse('anthropic_thinking.txt'));
    await collect(client(), request({ model, params: defaultParams({ temperature: 0.4 }), caps }));
    expect(server.takeRequest().json().temperature).toBeUndefined();
  });

  it('steps down an unsupported effort', async () => {
    server.enqueue(json(400, '{"type":"error","error":{"type":"invalid_request_error","message":"output_config.effort: Input should be \'low\', \'medium\', \'high\' or \'max\'"}}'));
    server.enqueue(sse('anthropic_thinking.txt'));
    const events = await collect(client(), request({ params: defaultParams({ effort: 'XHIGH' }) }));
    completed(events);
    expect(server.takeRequest().json().output_config.effort).toBe('xhigh');
    expect(server.takeRequest().json().output_config.effort).toBe('high');
    expect(quirks.dropped('p1', 'claude-opus-5-5').has('effort:xhigh')).toBe(true);
  });

  it('caps max_tokens when the model reports its ceiling', async () => {
    server.enqueue(json(400, '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-1"}}'));
    server.enqueue(sse('anthropic_thinking.txt'));
    const model = 'claude-opus-4-1';
    const events = await collect(client(), request({ model, params: defaultParams({ maxOutputTokens: 64000 }) }));
    completed(events);
    expect(server.takeRequest().json().max_tokens).toBe(64000);
    expect(server.takeRequest().json().max_tokens).toBe(32000);
    expect(quirks.dropped('p1', model).has('max_tokens:32000')).toBe(true);
  });

  it('maps effort NONE per family', async () => {
    // Opus 5.5 can't disable thinking: adaptive + low effort.
    server.enqueue(sse('anthropic_thinking.txt'));
    await collect(client(), request({ model: 'claude-opus-5-5', params: defaultParams({ effort: 'NONE' }) }));
    let body = server.takeRequest().json();
    expect(body.thinking.type).toBe('adaptive');
    expect(body.output_config.effort).toBe('low');

    // Sonnet 5.5 uses between_tools, with no other thinking fields.
    server.enqueue(sse('anthropic_thinking.txt'));
    await collect(client(), request({ model: 'claude-sonnet-5-5', params: defaultParams({ effort: 'NONE' }) }));
    body = server.takeRequest().json();
    expect(body.thinking).toEqual({ type: 'between_tools' });
    expect(body.output_config).toBeUndefined();

    // Opus 4.8 disables.
    server.enqueue(sse('anthropic_thinking.txt'));
    await collect(client(), request({ model: 'claude-opus-4-8', params: defaultParams({ effort: 'NONE' }) }));
    body = server.takeRequest().json();
    expect(body.thinking.type).toBe('disabled');

    // Budget-era model: thinking enabled with a budget below max_tokens.
    server.enqueue(sse('anthropic_thinking.txt'));
    await collect(client(), request({ model: 'claude-sonnet-4-5', params: defaultParams({ effort: 'MEDIUM' }) }));
    body = server.takeRequest().json();
    expect(body.thinking.type).toBe('enabled');
    expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
  });

  it('keeps utility requests lean', async () => {
    server.enqueue(sse('anthropic_thinking.txt'));
    await collect(client(), {
      model: 'claude-opus-4-8',
      system: null,
      messages: [user('Title this')],
      params: defaultParams({ webSearch: true, effort: 'MAX' }),
      caps: claudeCaps('claude-opus-4-8'),
      utility: true,
      tools: [],
    });
    const body = server.takeRequest().json();
    expect(body.max_tokens).toBe(1024);
    expect(body.tools).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
    expect(body.cache_control).toBeUndefined();
    expect(body.thinking.type).toBe('disabled');
  });

  it('turns images and PDFs into content blocks', async () => {
    server.enqueue(sse('anthropic_thinking.txt'));
    const msg: ChatMessage = {
      role: 'USER',
      parts: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
        { type: 'document', mimeType: 'application/pdf', name: 'a.pdf', bytes: new Uint8Array([4, 5]) },
      ],
    };
    await collect(client(), request({ messages: [msg] }));
    const content = server.takeRequest().json().messages[0].content;
    expect(content.map((b: any) => b.type)).toEqual(['image', 'document', 'text']);
    expect(content[0].source.data).toBe('AQID');
    expect(content[1].title).toBe('a.pdf');
  });

  it('lists models with pagination and capabilities', async () => {
    server.enqueue(json(200, '{"data":[{"type":"model","id":"claude-opus-5-5","display_name":"Claude Opus 5.5","created_at":"2026-06-01T00:00:00Z","max_input_tokens":1000000,"max_tokens":128000,"capabilities":{"image_input":{"supported":true},"thinking":{"supported":true,"types":{"enabled":{"supported":false},"adaptive":{"supported":true}}},"effort":{"supported":true,"low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},"xhigh":{"supported":true},"max":{"supported":true}}}}],"has_more":true,"first_id":"claude-opus-5-5","last_id":"claude-opus-5-5"}'));
    server.enqueue(json(200, '{"data":[{"type":"model","id":"claude-haiku-4-5-20251001","display_name":"Claude Haiku 4.5","created_at":"2025-10-01T00:00:00Z","max_input_tokens":200000,"max_tokens":64000,"capabilities":{"image_input":{"supported":true},"thinking":{"supported":true,"types":{"enabled":{"supported":true},"adaptive":{"supported":false}}},"effort":{"supported":false}}}],"has_more":false}'));
    const models = await client().listModels();
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5-20251001']);
    const opus = models[0];
    expect(opus.displayName).toBe('Claude Opus 5.5');
    expect(opus.contextWindow).toBe(1_000_000);
    expect(opus.maxOutput).toBe(128_000);
    expect(opus.createdAt).toBe(Date.UTC(2026, 5, 1));
    expect(opus.caps.reasoning.kind).toBe('EFFORT');
    expect(opus.caps.reasoning.efforts).not.toContain('NONE'); // can't disable on Opus 5.5
    expect(opus.caps.reasoning.defaultEffort).toBe('MEDIUM');
    expect(opus.caps.refusalFallback && opus.caps.fastMode && !opus.caps.sampling).toBe(true);
    const haiku = models[1];
    expect(haiku.caps.reasoning.kind).toBe('BUDGET');
    expect(haiku.caps.sampling).toBe(true);
    const first = server.takeRequest();
    expect(first.url.searchParams.get('limit')).toBe('1000');
    expect(first.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(server.takeRequest().url.searchParams.get('after_id')).toBe('claude-opus-5-5');
  });

  it('verify throws an LlmException for a bad key', async () => {
    server.enqueue(json(401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'));
    await expect(client().verify()).rejects.toMatchObject({ error: { kind: 'AUTH' } });
    expect(server.takeRequest().url.searchParams.get('limit')).toBe('1');
  });

  it('fails on a truncated stream', async () => {
    const full = sse('anthropic_thinking.txt').body;
    server.enqueue({ ...sse('anthropic_thinking.txt'), body: full.slice(0, full.indexOf('event: message_delta')) });
    const events = await collect(client(), request());
    expect(textOf(events)).toBe('Hello world');
    expect(failed(events).error.kind).toBe('NETWORK');
  });

  it('fails with the stream error event', async () => {
    server.enqueue({
      ...sse('anthropic_thinking.txt'),
      body: 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":1}}}\n\n' +
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    });
    const events = await collect(client(), request());
    expect(failed(events).error.kind).toBe('OVERLOADED');
    expect(ofType(events, 'completed')).toHaveLength(0);
  });
});
