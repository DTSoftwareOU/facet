/** Client tool calling (function calling) round trips for every adapter (port of ToolCallingTest.kt). */
import { beforeEach, describe, expect, it } from 'vitest';
import { AnthropicClient } from '../../src/llm/anthropic';
import { claudeCaps, compatCaps, openAiCaps, perplexityModels } from '../../src/llm/catalog';
import { OpenAiChatClient } from '../../src/llm/openaiChat';
import { OpenAiResponsesClient } from '../../src/llm/openaiResponses';
import { providerKind } from '../../src/llm/providers';
import { InMemoryQuirkStore } from '../../src/llm/quirks';
import { defaultParams, type ChatMessage, type ChatRequest, type ProviderBlocks, type ToolSpec } from '../../src/llm/types';
import { collect, completed, config, json, MockServer, only, ofType, sse, textOf, thinkingOf, user } from './helpers';

const weather: ToolSpec = {
  name: 'get_weather',
  description: 'Current weather for a city.',
  inputSchemaJson: '{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}',
};

let server: MockServer;
let quirks: InMemoryQuirkStore;

beforeEach(() => {
  server = new MockServer();
  quirks = new InMemoryQuirkStore();
});

const arr = (s: string) => JSON.parse(s) as any[];

// ------------------------------------------------------------------ Anthropic

describe('Anthropic tool calling', () => {
  const anthropic = () => new AnthropicClient(config('anthropic', server), { fetch: server.fetch, quirks });
  const anthropicRequest = (messages: ChatMessage[], tools: ToolSpec[] = [weather]): ChatRequest => ({
    model: 'claude-opus-5-5', system: 'Be brief.', messages,
    params: defaultParams({ effort: 'LOW' }), caps: claudeCaps('claude-opus-5-5'), tools,
  });

  it('round-trips two steps with parallel calls', async () => {
    server.enqueue(sse('anthropic_tool_step1.txt'));
    const step1 = await collect(anthropic(), anthropicRequest([user('Weather in Paris and Rome?')]));

    expect(step1[0]).toEqual({ type: 'started', model: 'claude-opus-5-5' });
    expect(textOf(step1)).toBe('Let me check both cities.');
    expect(ofType(step1, 'toolCallStarted')).toEqual([
      { type: 'toolCallStarted', id: 'toolu_01A', name: 'get_weather' },
      { type: 'toolCallStarted', id: 'toolu_01B', name: 'get_weather' },
    ]);
    // Streamed argument deltas are joined and normalized to compact JSON.
    expect(ofType(step1, 'toolCallReady')).toEqual([
      { type: 'toolCallReady', id: 'toolu_01A', name: 'get_weather', argumentsJson: '{"city":"Paris"}' },
      { type: 'toolCallReady', id: 'toolu_01B', name: 'get_weather', argumentsJson: '{"city":"Rome"}' },
    ]);
    const done = completed(step1);
    expect(done.stopReason).toBe('TOOL_USE');
    const blocks = arr(done.blocks!.json);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_use']);
    expect(blocks[1].input.city).toBe('Paris');

    const body1 = server.takeRequest().json();
    expect(body1.tools).toHaveLength(1);
    const tool = body1.tools[0];
    expect(tool.name).toBe('get_weather');
    expect(tool.input_schema.type).toBe('object');
    expect(tool.eager_input_streaming).toBe(true);

    // Step 2: replay the step verbatim plus both results in one user message.
    server.enqueue(sse('anthropic_tool_step2.txt'));
    const history: ChatMessage[] = [
      user('Weather in Paris and Rome?'),
      {
        role: 'ASSISTANT',
        parts: [
          { type: 'text', text: 'Let me check both cities.' },
          { type: 'toolCall', id: 'toolu_01A', name: 'get_weather', argumentsJson: '{"city":"Paris"}' },
          { type: 'toolCall', id: 'toolu_01B', name: 'get_weather', argumentsJson: '{"city":"Rome"}' },
        ],
        blocks: done.blocks,
      },
      {
        role: 'USER',
        parts: [
          { type: 'toolResult', callId: 'toolu_01A', name: 'get_weather', content: '18°C', isError: false },
          { type: 'toolResult', callId: 'toolu_01B', name: 'get_weather', content: 'Service unavailable', isError: true },
        ],
      },
    ];
    const step2 = await collect(anthropic(), anthropicRequest(history));
    expect(textOf(step2)).toBe("Paris is 18°C; Rome's lookup failed.");
    expect(completed(step2).stopReason).toBe('END');

    const messages = server.takeRequest().json().messages;
    expect(messages).toHaveLength(3);
    expect(messages[1].content.map((b: any) => b.type)).toEqual(['text', 'tool_use', 'tool_use']);
    expect(messages[1].content).toEqual(blocks); // replayed losslessly
    const results = messages[2].content;
    expect(results.map((b: any) => b.type)).toEqual(['tool_result', 'tool_result']);
    expect(results[0].tool_use_id).toBe('toolu_01A');
    expect(results[0].content).toBe('18°C');
    expect(results[0].is_error).toBeUndefined();
    expect(results[1].is_error).toBe(true);
  });

  it('converts tool history from another provider', async () => {
    server.enqueue(sse('anthropic_tool_step2.txt'));
    const foreign: ProviderBlocks = { style: 'OPENAI_RESPONSES', model: 'gpt-5.5', json: '[]' };
    const history: ChatMessage[] = [
      user('Weather?'),
      { role: 'ASSISTANT', parts: [{ type: 'toolCall', id: 'call_abc', name: 'get_weather', argumentsJson: '{"city":"Oslo"}' }], blocks: foreign },
      { role: 'USER', parts: [{ type: 'toolResult', callId: 'call_abc', name: 'get_weather', content: '9°C', isError: false }] },
    ];
    await collect(anthropic(), anthropicRequest(history));
    const messages = server.takeRequest().json().messages;
    expect(messages[1].content).toHaveLength(1);
    const toolUse = messages[1].content[0];
    expect(toolUse.type).toBe('tool_use');
    expect(toolUse.id).toBe('call_abc');
    expect(toolUse.input.city).toBe('Oslo');
    expect(messages[2].content).toHaveLength(1);
    expect(messages[2].content[0].tool_use_id).toBe('call_abc');
  });

  it('drops tools when the model rejects them', async () => {
    server.enqueue(json(400, '{"type":"error","error":{"type":"invalid_request_error","message":"This model does not support tools."}}'));
    server.enqueue(sse('anthropic_tool_step2.txt'));
    const events = await collect(anthropic(), anthropicRequest([user('Hi')]));
    completed(events);
    expect('tools' in server.takeRequest().json()).toBe(true);
    expect('tools' in server.takeRequest().json()).toBe(false);
    expect(quirks.dropped('p1', 'claude-opus-5-5').has('tools')).toBe(true);
  });

  it('sends no tools key without tools', async () => {
    server.enqueue(sse('anthropic_tool_step2.txt'));
    await collect(anthropic(), anthropicRequest([user('Hi')], []));
    expect('tools' in server.takeRequest().json()).toBe(false);
  });
});

// ------------------------------------------------------------------ OpenAI Responses

describe('Responses tool calling', () => {
  const responses = () => new OpenAiResponsesClient(config('openai', server, '/v1'), { fetch: server.fetch, quirks });
  const responsesRequest = (messages: ChatMessage[]): ChatRequest => ({
    model: 'gpt-5.5', system: 'Be brief.', messages,
    params: defaultParams({ effort: 'LOW' }), caps: openAiCaps('gpt-5.5'), tools: [weather],
  });

  it('round-trips two steps', async () => {
    server.enqueue(sse('openai_tool_step1.txt'));
    const step1 = await collect(responses(), responsesRequest([user('Weather in Oslo?')]));
    expect(thinkingOf(step1)).toBe('Need the weather.');
    expect(only(step1, 'toolCallStarted')).toEqual({ type: 'toolCallStarted', id: 'call_abc', name: 'get_weather' });
    expect(only(step1, 'toolCallReady')).toEqual({ type: 'toolCallReady', id: 'call_abc', name: 'get_weather', argumentsJson: '{"city":"Oslo"}' });
    const done = completed(step1);
    expect(done.stopReason).toBe('TOOL_USE');
    expect(arr(done.blocks!.json).map((i) => i.type)).toEqual(['reasoning', 'function_call']);

    const body1 = server.takeRequest().json();
    expect(body1.tools).toHaveLength(1);
    const fn = body1.tools[0];
    expect(fn.type).toBe('function');
    expect(fn.name).toBe('get_weather');
    expect(fn.strict).toBe(false);
    expect(fn.parameters.type).toBe('object');

    server.enqueue(sse('openai_tool_step2.txt'));
    const history: ChatMessage[] = [
      user('Weather in Oslo?'),
      { role: 'ASSISTANT', parts: [{ type: 'toolCall', id: 'call_abc', name: 'get_weather', argumentsJson: '{"city":"Oslo"}' }], blocks: done.blocks },
      { role: 'USER', parts: [{ type: 'toolResult', callId: 'call_abc', name: 'get_weather', content: '9°C', isError: false }] },
    ];
    const step2 = await collect(responses(), responsesRequest(history));
    expect(textOf(step2)).toBe('Oslo is 9°C.');
    expect(completed(step2).stopReason).toBe('END');

    const input = server.takeRequest().json().input;
    expect(input[0].role).toBe('user');
    expect(input[1].type).toBe('reasoning');
    expect(input[1].encrypted_content).toBe('enc123');
    expect(input[2].type).toBe('function_call');
    expect(input[3].type).toBe('function_call_output');
    expect(input[3].call_id).toBe('call_abc');
    expect(input[3].output).toBe('9°C');
    expect(input).toHaveLength(4);
  });

  it('converts tool history from another provider', async () => {
    server.enqueue(sse('openai_tool_step2.txt'));
    const anthropicBlocks: ProviderBlocks = { style: 'ANTHROPIC', model: 'claude-opus-5-5', json: '[{"type":"tool_use","id":"toolu_9","name":"get_weather","input":{"city":"Oslo"}}]' };
    const history: ChatMessage[] = [
      user('Weather?'),
      { role: 'ASSISTANT', parts: [{ type: 'text', text: 'Checking.' }, { type: 'toolCall', id: 'toolu_9', name: 'get_weather', argumentsJson: '{"city":"Oslo"}' }], blocks: anthropicBlocks },
      { role: 'USER', parts: [{ type: 'toolResult', callId: 'toolu_9', name: 'get_weather', content: 'boom', isError: true }, { type: 'text', text: 'Also, thanks!' }] },
    ];
    await collect(responses(), responsesRequest(history));
    const input = server.takeRequest().json().input;
    expect(input[1].role).toBe('assistant');
    expect(input[2].type).toBe('function_call');
    expect(input[2].call_id).toBe('toolu_9');
    expect(input[2].arguments).toBe('{"city":"Oslo"}');
    expect(input[3].type).toBe('function_call_output');
    expect(input[3].output).toBe('Error: boom');
    expect(input[4].role).toBe('user');
  });
});

// ------------------------------------------------------------------ Chat Completions

describe('Chat Completions tool calling', () => {
  const chat = (kind: string) => new OpenAiChatClient(config(kind, server, '/v1'), { fetch: server.fetch, quirks });
  const chatRequest = (kind: string, model: string, messages: ChatMessage[], tools: ToolSpec[] = [weather]): ChatRequest => ({
    model, system: 'System prompt', messages, params: defaultParams(), caps: compatCaps(providerKind(kind), model), tools,
  });

  it('round-trips two steps', async () => {
    server.enqueue(sse('chat_tool_step1.txt'));
    const step1 = await collect(chat('groq'), chatRequest('groq', 'llama-3.3-70b', [user('Lima weather?')]));
    expect(textOf(step1)).toBe('Checking.');
    expect(only(step1, 'toolCallStarted')).toEqual({ type: 'toolCallStarted', id: 'call_x1', name: 'get_weather' });
    expect(only(step1, 'toolCallReady')).toEqual({ type: 'toolCallReady', id: 'call_x1', name: 'get_weather', argumentsJson: '{"city":"Lima"}' });
    const done = completed(step1);
    expect(done.stopReason).toBe('TOOL_USE');
    expect(done.blocks!.style).toBe('OPENAI_CHAT');
    const stored = arr(done.blocks!.json);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe('Checking.');
    expect(stored[0].tool_calls).toHaveLength(1);
    expect(stored[0].tool_calls[0].id).toBe('call_x1');

    const body1 = server.takeRequest().json();
    expect(body1.tools).toHaveLength(1);
    expect(body1.tools[0].type).toBe('function');
    expect(body1.tools[0].function.name).toBe('get_weather');
    expect(body1.tool_choice).toBeUndefined();

    server.enqueue(sse('chat_tool_step2.txt'));
    const history: ChatMessage[] = [
      user('Lima weather?'),
      { role: 'ASSISTANT', parts: [{ type: 'text', text: 'Checking.' }, { type: 'toolCall', id: 'call_x1', name: 'get_weather', argumentsJson: '{"city":"Lima"}' }], blocks: done.blocks },
      { role: 'USER', parts: [{ type: 'toolResult', callId: 'call_x1', name: 'get_weather', content: '20°C', isError: false }] },
    ];
    const step2 = await collect(chat('groq'), chatRequest('groq', 'llama-3.3-70b', history));
    expect(textOf(step2)).toBe('Lima is 20°C.');
    expect(step2[step2.length - 1]).toEqual({ type: 'completed', stopReason: 'END', blocks: null });

    const messages = server.takeRequest().json().messages;
    expect(messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(messages[2].content).toBe('Checking.');
    expect(messages[2].tool_calls).toHaveLength(1);
    expect(messages[2].tool_calls[0].id).toBe('call_x1');
    expect(messages[2].tool_calls[0].function.arguments).toBe('{"city":"Lima"}');
    expect(messages[2].reasoning_content).toBeUndefined();
    expect(messages[3].tool_call_id).toBe('call_x1');
    expect(messages[3].content).toBe('20°C');
  });

  it('synthesizes ids when Gemini omits them', async () => {
    server.enqueue(sse('chat_tool_gemini.txt'));
    const events = await collect(chat('google'), chatRequest('google', 'gemini-2.5-flash', [user('Weather in Kyiv and Oslo?')]));
    const ready = ofType(events, 'toolCallReady');
    expect(ready.map((r) => r.argumentsJson)).toEqual(['{"city":"Kyiv"}', '{"city":"Oslo"}']);
    expect(ready.every((r) => r.id.trim() !== '')).toBe(true);
    expect(ready[0].id).not.toBe(ready[1].id);
    expect(ofType(events, 'toolCallStarted').map((s) => s.id)).toEqual(ready.map((r) => r.id));
    expect(completed(events).stopReason).toBe('TOOL_USE');
  });

  it('passes invalid arguments through raw', async () => {
    server.enqueue(sse('chat_tool_invalid.txt'));
    const events = await collect(chat('deepseek'), chatRequest('deepseek', 'deepseek-chat', [user('Weather?')]));
    expect(only(events, 'toolCallReady').argumentsJson).toBe('{"city": "Li');
    const done = completed(events);
    expect(done.stopReason).toBe('TOOL_USE');
    const stored = arr(done.blocks!.json);
    expect(stored).toHaveLength(1);
    expect(stored[0].reasoning_content).toBe('Look it up.');
  });

  it('retries with reasoning_content when the provider asks', async () => {
    server.enqueue(json(400, '{"error":{"message":"Missing `reasoning_content` field in the assistant message at message index 2","type":"invalid_request_error"}}'));
    server.enqueue(sse('chat_tool_step2.txt'));
    const blocks: ProviderBlocks = { style: 'OPENAI_CHAT', model: 'deepseek-reasoner', json: '[{"role":"assistant","content":"","tool_calls":[],"reasoning_content":"Think first."}]' };
    const history: ChatMessage[] = [
      user('Weather?'),
      { role: 'ASSISTANT', parts: [{ type: 'toolCall', id: 'call_1', name: 'get_weather', argumentsJson: '{"city":"Lima"}' }], blocks },
      { role: 'USER', parts: [{ type: 'toolResult', callId: 'call_1', name: 'get_weather', content: '20°C', isError: false }] },
    ];
    const events = await collect(chat('deepseek'), chatRequest('deepseek', 'deepseek-reasoner', history));
    completed(events);
    expect(server.takeRequest().json().messages[2].reasoning_content).toBeUndefined();
    expect(server.takeRequest().json().messages[2].reasoning_content).toBe('Think first.');
    expect(quirks.dropped('p1', 'deepseek-reasoner').has('tools')).toBe(false);
  });

  it('drops tools when an Ollama model cannot use them', async () => {
    server.enqueue(json(400, '{"error":{"message":"registry.ollama.ai/library/gemma2:latest does not support tools","type":"api_error"}}'));
    server.enqueue(sse('chat_tool_step2.txt'));
    const events = await collect(chat('ollama'), chatRequest('ollama', 'gemma2', [user('Hi')]));
    expect(textOf(events)).toBe('Lima is 20°C.');
    expect('tools' in server.takeRequest().json()).toBe(true);
    expect('tools' in server.takeRequest().json()).toBe(false);
    expect(quirks.dropped('p1', 'gemma2').has('tools')).toBe(true);

    // Subsequent requests skip tools without another failed round trip.
    server.enqueue(sse('chat_tool_step2.txt'));
    await collect(chat('ollama'), chatRequest('ollama', 'gemma2', [user('Hi')]));
    expect('tools' in server.takeRequest().json()).toBe(false);
  });

  it('maps tool ids for Mistral', async () => {
    server.enqueue(sse('chat_tool_step2.txt'));
    const history: ChatMessage[] = [
      user('Weather?'),
      { role: 'ASSISTANT', parts: [{ type: 'toolCall', id: 'toolu_01A', name: 'get_weather', argumentsJson: 'not json' }], blocks: null },
      { role: 'USER', parts: [{ type: 'toolResult', callId: 'toolu_01A', name: 'get_weather', content: '20°C', isError: false }] },
    ];
    await collect(chat('mistral'), chatRequest('mistral', 'mistral-large-latest', history));
    const messages = server.takeRequest().json().messages;
    expect(messages[2].tool_calls).toHaveLength(1);
    const call = messages[2].tool_calls[0];
    expect(call.id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(messages[3].tool_call_id).toBe(call.id);
    expect(call.function.arguments).toBe('{}');
  });

  it('leaves requests without tools unchanged', async () => {
    server.enqueue(sse('chat_tool_step2.txt'));
    const history: ChatMessage[] = [user('A'), { role: 'ASSISTANT', parts: [{ type: 'text', text: 'B' }] }, user('C'), user('D')];
    await collect(chat('groq'), chatRequest('groq', 'llama-3.3-70b', history, []));
    const body = server.takeRequest().json();
    expect(body.tools).toBeUndefined();
    expect(body.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(body.messages[3].content).toBe('C\n\nD');
  });

  it('never sends tools to Perplexity or for utility requests', async () => {
    server.enqueue(sse('chat_perplexity.txt'));
    await collect(chat('perplexity'), chatRequest('perplexity', 'sonar-pro', [user('Hi')]));
    expect(server.takeRequest().json().tools).toBeUndefined();

    server.enqueue(sse('chat_tool_step2.txt'));
    await collect(chat('groq'), { ...chatRequest('groq', 'llama-3.3-70b', [user('Title?')]), utility: true });
    expect(server.takeRequest().json().tools).toBeUndefined();
  });

  it('accumulates parallel calls streamed by index', async () => {
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    server.enqueue({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: chunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }] }) +
        chunk({ tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'get_weather', arguments: '' } }] }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"X"}' } }, { index: 1, function: { arguments: '{"city":"Y"}' } }] }) +
        chunk({}, 'tool_calls') + 'data: [DONE]\n\n',
    });
    const events = await collect(chat('custom'), chatRequest('custom', 'm', [user('Both?')]));
    expect(ofType(events, 'toolCallStarted').map((e) => e.id)).toEqual(['a', 'b']);
    expect(ofType(events, 'toolCallReady')).toEqual([
      { type: 'toolCallReady', id: 'a', name: 'get_weather', argumentsJson: '{"city":"X"}' },
      { type: 'toolCallReady', id: 'b', name: 'get_weather', argumentsJson: '{"city":"Y"}' },
    ]);
    expect(completed(events).stopReason).toBe('TOOL_USE');
  });
});

describe('catalog tool support', () => {
  it('knows which models can call tools', () => {
    expect(claudeCaps('claude-opus-5-5').tools).toBe(true);
    expect(openAiCaps('gpt-5.5').tools).toBe(true);
    expect(openAiCaps('o1-mini').tools).toBe(false);
    expect(openAiCaps('chatgpt-4o-latest').tools).toBe(false);
    expect(compatCaps(providerKind('perplexity'), 'sonar').tools).toBe(false);
    expect(compatCaps(providerKind('google'), 'gemma-3-27b-it').tools).toBe(false);
    expect(compatCaps(providerKind('ollama'), 'llama3.2').tools).toBe(true);
    expect(perplexityModels().every((m) => !m.caps.tools)).toBe(true);
  });
});
