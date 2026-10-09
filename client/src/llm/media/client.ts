/**
 * Client for providers that only make media: ElevenLabs, Stability AI, Black Forest Labs and
 * Deepgram (port of MediaProviderClient.kt). It lists their models and checks keys; generation
 * goes through gen.ts. It has no chat.
 */
import { ProviderKinds } from '../providers';
import { normalizeModel, type LlmClient, type ModelInfo, type ProviderConfig, type StreamEvent } from '../types';
import { mediaProviderModels } from './catalog';
import { guard, requestJsonValue, resolveFetch, send, SHORT_TIMEOUT_MS, trimBaseUrl, type Http } from './http';

const VERIFY_PATHS: Record<string, string> = {
  [ProviderKinds.ELEVENLABS.id]: '/v1/models',
  [ProviderKinds.STABILITY.id]: '/v1/user/account',
  [ProviderKinds.BFL.id]: '/v1/credits',
  [ProviderKinds.DEEPGRAM.id]: '/v1/projects',
};

export function createMediaProviderClient(config: ProviderConfig, options: { fetch?: typeof fetch } = {}): LlmClient {
  const base = trimBaseUrl(config.baseUrl);
  const http: Http = { config, fetch: resolveFetch(options.fetch), timeoutMs: SHORT_TIMEOUT_MS };

  return {
    config,

    async listModels(): Promise<ModelInfo[]> {
      const builtIn = mediaProviderModels(config.kind);
      if (config.kind.id !== ProviderKinds.ELEVENLABS.id) return builtIn;
      // ElevenLabs lists its voice models; keep the built-in music, sound and transcription entries.
      let live: ModelInfo[] = [];
      try {
        const list = await requestJsonValue(http, `${base}/v1/models`);
        live = (Array.isArray(list) ? list : []).flatMap((m) => {
          if (!m || typeof m !== 'object' || m.can_do_text_to_speech !== true || typeof m.model_id !== 'string') return [];
          return [normalizeModel({ id: m.model_id, displayName: typeof m.name === 'string' ? m.name : m.model_id, output: 'SPEECH' })];
        });
      } catch {
        // Offline or a restricted key: the built-in list still works.
      }
      return live.length === 0 ? builtIn : [...live, ...builtIn.filter((m) => m.output !== 'SPEECH')];
    },

    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: 'failed', error: { kind: 'BAD_REQUEST', message: `${config.label} makes media only. Pick a chat model for conversations.` } };
    },

    async verify(): Promise<void> {
      // Any 2xx proves the key; the body doesn't matter.
      const res = await guard(config, null, () => send(http, base + (VERIFY_PATHS[config.kind.id] ?? '/')));
      await res.body?.cancel().catch(() => {});
    },
  };
}
