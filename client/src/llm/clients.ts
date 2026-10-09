/** Entry point for provider adapters: picks one by the provider's wire protocol (port of LlmClients.kt). */
import { AnthropicClient } from './anthropic';
import { createMediaProviderClient } from './media/client';
import { OpenAiChatClient } from './openaiChat';
import { OpenAiResponsesClient } from './openaiResponses';
import type { PriceSource } from '../data/providers';
import type { LlmClient, ProviderConfig, QuirkStore } from './types';

export interface ClientOptions {
  quirks: QuirkStore;
  pricing?: PriceSource;
  fetch?: typeof fetch;
}

export function createLlmClient(config: ProviderConfig, options: ClientOptions): LlmClient {
  const opts = { quirks: options.quirks, pricing: options.pricing, fetch: options.fetch };
  switch (config.kind.style) {
    case 'ANTHROPIC':
      return new AnthropicClient(config, opts);
    case 'OPENAI_RESPONSES':
      return new OpenAiResponsesClient(config, opts);
    case 'OPENAI_CHAT':
      return new OpenAiChatClient(config, opts);
    case 'MEDIA':
      return createMediaProviderClient(config, { fetch: options.fetch });
  }
}
