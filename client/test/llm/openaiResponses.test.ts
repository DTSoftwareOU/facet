import { beforeEach, describe, expect, it } from 'vitest';
import { openAiCaps } from '../../src/llm/catalog';
import { OpenAiResponsesClient } from '../../src/llm/openaiResponses';
import { InMemoryQuirkStore } from '../../src/llm/quirks';
import { defaultParams, type ChatMessage, type ChatRequest, type GenParams } from '../../src/llm/types';
import { collect, completed, config, failed, json, lastOf, MockServer, ofType, sse, textOf, thinkingOf, user } from './helpers';

let server: MockServer;
let quirks: InMemoryQuirkStore;

beforeEach(() => {
  server = new MockServer();
  quirks = new InMemoryQuirkStore();
});

const client = () => new OpenAiResponsesClient(config('openai', server, '/v1'), { fetch: server.fetch, quirks });

function request(over: { model?: string; params?: GenParams; messages?: ChatMessage[] } = {}): ChatRequest {
  const model = over.model ?? 'gpt-5.5';
  return {
    model,
    system: 'You are helpful.',
    messages: over.messages ?? [user('Tell me about Facet')],
    params: over.params ?? defaultParams({ effort: 'HIGH', webSearch: true }),
    caps: openAiCaps(model),
    tools: [],
  };
}

describe('OpenAiResponsesClient', () => {
  it('streams reasoning, search, text and usage', async () => {
    server.enqueue(sse('openai_reasoning.txt'));
    const events = await collect(client(), request());

    expect(events[0]).toEqual({ type: 'started', model: 'gpt-5.5' });
    expect(thinkingOf(events)).toBe('**Planning** the answer\n\nChecking sources');
    expect(ofType(events, 'thinkingStarted')).toHaveLength(1);
    expect(ofType(events, 'thinkingEnded')).toHaveLength(1);
    expect(ofType(events, 'webSearch')).toEqual([
      { type: 'webSearch', query: null, done: false },
      { type: 'webSearch', query: 'facet android', done: true },
    ]);
    expect(textOf(events)).toBe('Facet is great.');
    expect(lastOf(events, 'citations').citations.map((c) => c.url)).toEqual(['https://facet.dtsoftware.io']);
    expect(lastOf(events, 'usage').usage).toEqual({ inputTokens: 100, outputTokens: 250, cacheReadTokens: 40, cacheWriteTokens: 0, reasoningTokens: 180 });
    const done = completed(events);
    expect(done.stopReason).toBe('END');
    expect(done.blocks!.style).toBe('OPENAI_RESPONSES');
    const items = JSON.parse(done.blocks!.json);
    expect(items).toHaveLength(3);
    expect(items[0].encrypted_content).toBe('gAAAA_enc');

    const recorded = server.takeRequest();
    expect(recorded.url.pathname).toBe('/v1/responses');
    expect(recorded.headers.get('Authorization')).toBe('Bearer sk-test-key-1234567890');
    const body = recorded.json();
    expect(body.store).toBe(false);
    expect(body.instructions).toBe('You are helpful.');
    expect(body.reasoning.effort).toBe('high');
    expect(body.reasoning.summary).toBe('auto');
    expect(body.include[0]).toBe('reasoning.encrypted_content');
    expect(body.tools[0].type).toBe('web_search');
    expect(body.temperature).toBeUndefined();
    expect(body.input[0].content[0].type).toBe('input_text');
  });

  it('treats incomplete as max tokens', async () => {
    server.enqueue(sse('openai_incomplete.txt'));
    const events = await collect(client(), request({ model: 'gpt-4.1', params: defaultParams({ temperature: 0.3 }) }));
    expect(textOf(events)).toBe('Partial');
    expect(completed(events).stopReason).toBe('MAX_TOKENS');
    const body = server.takeRequest().json();
    expect(body.reasoning).toBeUndefined();
    expect(body.temperature).toBe(0.3);
  });

  it('maps a failed response to an error', async () => {
    server.enqueue(sse('openai_failed.txt'));
    const events = await collect(client(), request());
    expect(failed(events).error.kind).toBe('SERVER');
  });

  it('replays output items only for the same model', async () => {
    const items = '[{"id":"rs_1","type":"reasoning","encrypted_content":"enc","summary":[]},{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Prev","annotations":[]}]}]';
    const history: ChatMessage[] = [
      user('One'),
      { role: 'ASSISTANT', parts: [{ type: 'text', text: 'Prev' }], blocks: { style: 'OPENAI_RESPONSES', model: 'gpt-5.5', json: items } },
      user('Two'),
    ];
    server.enqueue(sse('openai_reasoning.txt'));
    await collect(client(), request({ messages: history }));
    const input = server.takeRequest().json().input;
    expect(input[1].type).toBe('reasoning');
    expect(input[1].encrypted_content).toBe('enc');

    server.enqueue(sse('openai_reasoning.txt'));
    await collect(client(), request({ model: 'gpt-5.4', messages: history }));
    const input2 = server.takeRequest().json().input;
    expect(input2[1].role).toBe('assistant');
    expect(input2[1].content[0].type).toBe('output_text');
  });

  it('resends history as text when replayed items are rejected', async () => {
    const items = '[{"id":"rs_1","type":"reasoning","encrypted_content":"enc","summary":[]},{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Prev","annotations":[]}]}]';
    const history: ChatMessage[] = [
      user('One'),
      { role: 'ASSISTANT', parts: [{ type: 'text', text: 'Prev' }], blocks: { style: 'OPENAI_RESPONSES', model: 'gpt-5.5', json: items } },
      user('Two'),
    ];
    server.enqueue(json(400, '{"error":{"message":"Item with id \'rs_1\' not found.","type":"invalid_request_error"}}'));
    server.enqueue(sse('openai_reasoning.txt'));
    completed(await collect(client(), request({ messages: history })));
    expect(server.takeRequest().json().input[1].type).toBe('reasoning');
    expect(server.takeRequest().json().input[1].role).toBe('assistant');
  });

  it('steps down an unsupported effort using the listed values', async () => {
    server.enqueue(json(400, '{"error":{"message":"Unsupported value: \'reasoning.effort\' does not support \'minimal\' with this model. Supported values are: \'low\', \'medium\', and \'high\'.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_value"}}'));
    server.enqueue(sse('openai_reasoning.txt'));
    const events = await collect(client(), request({ model: 'gpt-5', params: defaultParams({ effort: 'MINIMAL' }) }));
    completed(events);
    expect(server.takeRequest().json().reasoning.effort).toBe('minimal');
    expect(server.takeRequest().json().reasoning.effort).toBe('low');
    expect(quirks.dropped('p1', 'gpt-5').has('effort:minimal')).toBe(true);
  });

  it('drops summaries when the organization is unverified', async () => {
    server.enqueue(json(400, '{"error":{"message":"Your organization must be verified to generate reasoning summaries. Please go to: https://platform.openai.com/settings/organization/general","type":"invalid_request_error","param":"reasoning.summary","code":"unsupported_value"}}'));
    server.enqueue(sse('openai_reasoning.txt'));
    const events = await collect(client(), request());
    completed(events);
    server.takeRequest();
    expect(server.takeRequest().json().reasoning.summary).toBeUndefined();
    expect(quirks.dropped('p1', 'gpt-5.5').has('summary')).toBe(true);
  });

  it('sends pro mode and verbosity', async () => {
    server.enqueue(sse('openai_reasoning.txt'));
    await collect(client(), request({ model: 'gpt-5.6-sol', params: defaultParams({ effort: 'MAX', proMode: true, verbosity: 'LOW' }) }));
    const body = server.takeRequest().json();
    expect(body.reasoning.mode).toBe('pro');
    expect(body.reasoning.effort).toBe('max');
    expect(body.text.verbosity).toBe('low');
  });

  it('filters and names models', async () => {
    server.enqueue(json(200, `{"object":"list","data":[
      {"id":"gpt-5.5","object":"model","created":1770000000,"owned_by":"system"},
      {"id":"gpt-5.5-2026-04-23","object":"model","created":1769000000,"owned_by":"system"},
      {"id":"text-embedding-3-large","object":"model","created":1700000000,"owned_by":"system"},
      {"id":"whisper-1","object":"model","created":1600000000,"owned_by":"system"},
      {"id":"gpt-image-1","object":"model","created":1740000000,"owned_by":"system"},
      {"id":"o4-mini","object":"model","created":1744000000,"owned_by":"system"},
      {"id":"gpt-4o-mini-tts","object":"model","created":1742000000,"owned_by":"system"},
      {"id":"gpt-realtime","object":"model","created":1756000000,"owned_by":"system"},
      {"id":"dall-e-3","object":"model","created":1698000000,"owned_by":"system"},
      {"id":"gpt-4.1","object":"model","created":1744300000,"owned_by":"system"},
      {"id":"gpt-4o-mini","object":"model","created":1721000000,"owned_by":"system"}
    ]}`));
    const all = await client().listModels();
    const models = all.filter((m) => m.output === 'TEXT');
    expect(models.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-4.1', 'o4-mini', 'gpt-4o-mini']);
    // Media models are kept and sorted by what they make; embeddings and realtime models are left out.
    const media = Object.fromEntries(all.filter((m) => m.output !== 'TEXT').map((m) => [m.id, m.output]));
    expect(media).toEqual({ 'gpt-4o-mini-tts': 'SPEECH', 'gpt-image-1': 'IMAGE', 'dall-e-3': 'IMAGE', 'whisper-1': 'TRANSCRIPTION' });
    expect(models.map((m) => m.displayName)).toEqual(['GPT-5.5', 'GPT-4.1', 'o4-mini', 'GPT-4o mini']);
    expect(models[0].caps.reasoning.kind).toBe('EFFORT');
    expect(models[3].caps.sampling && models[3].caps.vision).toBe(true);
    expect(models[0].createdAt).toBe(1770000000 * 1000);
  });
});
