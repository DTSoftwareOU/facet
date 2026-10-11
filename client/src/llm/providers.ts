/**
 * Provider presets (port of ProviderKind.kt). `id` is persisted in synced records; never rename it.
 * Any OpenAI-compatible service works through CUSTOM.
 */
import { msg, tm, type Msg } from '../i18n';
import type { ApiStyle } from './types';

export interface ProviderKind {
  id: string;
  displayName: string;
  style: ApiStyle;
  defaultBaseUrl: string;
  /** Where users create a key. */
  keyUrl: string | null;
  /** What a key looks like ('sk-…'), or 'Not needed' / 'Optional'; show it with keyHintText(). */
  keyHint: string;
  requiresKey: boolean;
  /** Short description shown in the provider picker (show it with tm()). */
  blurb: Msg;
  /**
   * Whether the provider's API accepts requests from web pages (CORS). False: the website can't
   * use it, but the Windows and Android apps can. Checked against each API's preflight response.
   */
  browserOk: boolean;
}

function kind(
  id: string,
  displayName: string,
  style: ApiStyle,
  defaultBaseUrl: string,
  keyUrl: string | null,
  keyHint: string,
  blurb: Msg,
  options: { requiresKey?: boolean; browserOk?: boolean } = {},
): ProviderKind {
  return {
    id, displayName, style, defaultBaseUrl, keyUrl, keyHint, blurb,
    requiresKey: options.requiresKey ?? true,
    browserOk: options.browserOk ?? true,
  };
}

export const ProviderKinds = {
  OPENAI: kind('openai', 'OpenAI', 'OPENAI_RESPONSES', 'https://api.openai.com/v1', 'https://platform.openai.com/api-keys', 'sk-…', msg('GPT and o-series models')),
  ANTHROPIC: kind('anthropic', 'Anthropic', 'ANTHROPIC', 'https://api.anthropic.com', 'https://console.anthropic.com/settings/keys', 'sk-ant-…', msg('Claude models')),
  GOOGLE: kind('google', 'Google Gemini', 'OPENAI_CHAT', 'https://generativelanguage.googleapis.com/v1beta/openai', 'https://aistudio.google.com/apikey', 'AIza…', msg('Gemini models')),
  OPENROUTER: kind('openrouter', 'OpenRouter', 'OPENAI_CHAT', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/keys', 'sk-or-…', msg('Hundreds of models with one key')),
  XAI: kind('xai', 'xAI', 'OPENAI_CHAT', 'https://api.x.ai/v1', 'https://console.x.ai', 'xai-…', msg('Grok models')),
  DEEPSEEK: kind('deepseek', 'DeepSeek', 'OPENAI_CHAT', 'https://api.deepseek.com/v1', 'https://platform.deepseek.com/api_keys', 'sk-…', msg('DeepSeek chat and reasoner')),
  MISTRAL: kind('mistral', 'Mistral', 'OPENAI_CHAT', 'https://api.mistral.ai/v1', 'https://console.mistral.ai/api-keys', '…', msg('Mistral and Magistral models')),
  GROQ: kind('groq', 'Groq', 'OPENAI_CHAT', 'https://api.groq.com/openai/v1', 'https://console.groq.com/keys', 'gsk_…', msg('Very fast open models')),
  CEREBRAS: kind('cerebras', 'Cerebras', 'OPENAI_CHAT', 'https://api.cerebras.ai/v1', 'https://cloud.cerebras.ai', 'csk-…', msg('Very fast open models')),
  TOGETHER: kind('together', 'Together AI', 'OPENAI_CHAT', 'https://api.together.xyz/v1', 'https://api.together.ai/settings/api-keys', '…', msg('Open models at scale')),
  FIREWORKS: kind('fireworks', 'Fireworks', 'OPENAI_CHAT', 'https://api.fireworks.ai/inference/v1', 'https://fireworks.ai/account/api-keys', 'fw_…', msg('Open models at scale'), { browserOk: false }),
  PERPLEXITY: kind('perplexity', 'Perplexity', 'OPENAI_CHAT', 'https://api.perplexity.ai', 'https://www.perplexity.ai/settings/api', 'pplx-…', msg('Search-grounded Sonar models')),
  HUGGINGFACE: kind('huggingface', 'Hugging Face', 'OPENAI_CHAT', 'https://router.huggingface.co/v1', 'https://huggingface.co/settings/tokens', 'hf_…', msg('Open models from many inference providers')),
  MOONSHOT: kind('moonshot', 'Moonshot AI', 'OPENAI_CHAT', 'https://api.moonshot.ai/v1', 'https://platform.moonshot.ai/console/api-keys', 'sk-…', msg('Kimi models')),
  ZAI: kind('zai', 'Z.ai', 'OPENAI_CHAT', 'https://api.z.ai/api/paas/v4', 'https://z.ai/manage-apikey/apikey-list', '…', msg('GLM models')),
  QWEN: kind('qwen', 'Alibaba Qwen', 'OPENAI_CHAT', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'https://modelstudio.console.alibabacloud.com/', 'sk-…', msg('Qwen models from Alibaba Cloud')),
  MINIMAX: kind('minimax', 'MiniMax', 'OPENAI_CHAT', 'https://api.minimax.io/v1', 'https://www.minimax.io/platform/user-center/basic-information/interface-key', '…', msg('MiniMax models')),
  COHERE: kind('cohere', 'Cohere', 'OPENAI_CHAT', 'https://api.cohere.ai/compatibility/v1', 'https://dashboard.cohere.com/api-keys', '…', msg('Command models')),
  NVIDIA: kind('nvidia', 'NVIDIA NIM', 'OPENAI_CHAT', 'https://integrate.api.nvidia.com/v1', 'https://build.nvidia.com/settings/api-keys', 'nvapi-…', msg('Open models on NVIDIA GPUs'), { browserOk: false }),
  DEEPINFRA: kind('deepinfra', 'DeepInfra', 'OPENAI_CHAT', 'https://api.deepinfra.com/v1/openai', 'https://deepinfra.com/dash/api_keys', '…', msg('Low-cost open models')),
  NEBIUS: kind('nebius', 'Nebius AI Studio', 'OPENAI_CHAT', 'https://api.studio.nebius.com/v1', 'https://studio.nebius.com/settings/api-keys', '…', msg('Open models in the EU')),
  SAMBANOVA: kind('sambanova', 'SambaNova', 'OPENAI_CHAT', 'https://api.sambanova.ai/v1', 'https://cloud.sambanova.ai/apis', '…', msg('Very fast open models'), { browserOk: false }),
  HYPERBOLIC: kind('hyperbolic', 'Hyperbolic', 'OPENAI_CHAT', 'https://api.hyperbolic.xyz/v1', 'https://app.hyperbolic.xyz/settings', '…', msg('Open models at low cost')),
  NOVITA: kind('novita', 'Novita AI', 'OPENAI_CHAT', 'https://api.novita.ai/v3/openai', 'https://novita.ai/settings/key-management', 'sk_…', msg('Open models at low cost')),
  VENICE: kind('venice', 'Venice', 'OPENAI_CHAT', 'https://api.venice.ai/api/v1', 'https://venice.ai/settings/api', '…', msg('Private, uncensored open models')),
  VERCEL: kind('vercel', 'Vercel AI Gateway', 'OPENAI_CHAT', 'https://ai-gateway.vercel.sh/v1', 'https://vercel.com/dashboard', '…', msg('Many providers through one key')),
  INCEPTION: kind('inception', 'Inception', 'OPENAI_CHAT', 'https://api.inceptionlabs.ai/v1', 'https://platform.inceptionlabs.ai', '…', msg('Mercury diffusion models')),
  ELEVENLABS: kind('elevenlabs', 'ElevenLabs', 'MEDIA', 'https://api.elevenlabs.io', 'https://elevenlabs.io/app/settings/api-keys', 'sk_…', msg('Voices, music, sound effects and transcription')),
  STABILITY: kind('stability', 'Stability AI', 'MEDIA', 'https://api.stability.ai', 'https://platform.stability.ai/account/keys', 'sk-…', msg('Stable Image and Stable Audio')),
  BFL: kind('bfl', 'Black Forest Labs', 'MEDIA', 'https://api.bfl.ai', 'https://dashboard.bfl.ai', '…', msg('FLUX image models'), { browserOk: false }),
  DEEPGRAM: kind('deepgram', 'Deepgram', 'MEDIA', 'https://api.deepgram.com', 'https://console.deepgram.com', '…', msg('Transcription and Aura voices')),
  OLLAMA: kind('ollama', 'Ollama', 'OPENAI_CHAT', 'http://localhost:11434/v1', 'https://ollama.com', 'Not needed', msg('Models on your own computer'), { requiresKey: false }),
  LMSTUDIO: kind('lmstudio', 'LM Studio', 'OPENAI_CHAT', 'http://localhost:1234/v1', 'https://lmstudio.ai', 'Not needed', msg('Models on your own computer'), { requiresKey: false }),
  CUSTOM: kind('custom', 'Custom endpoint', 'OPENAI_CHAT', 'https://', null, 'Optional', msg('Any OpenAI-compatible API'), { requiresKey: false }),
} as const;

export const ALL_PROVIDER_KINDS: readonly ProviderKind[] = Object.values(ProviderKinds);

const WORD_HINTS: Record<string, Msg> = { 'Not needed': msg('Not needed'), Optional: msg('Optional') };

/** The API key field's placeholder: an example of the key's format, or a translated 'Not needed' / 'Optional'. */
export function keyHintText(kind: ProviderKind): string {
  const word = WORD_HINTS[kind.keyHint];
  return word ? tm(word) : kind.keyHint;
}

const CUSTOM_NAME = msg('Custom endpoint');

/** The name to show for a provider kind: the brand, or a translated 'Custom endpoint' (displayName stays English). */
export function providerDisplayName(kind: ProviderKind): string {
  return kind.id === ProviderKinds.CUSTOM.id ? tm(CUSTOM_NAME) : kind.displayName;
}

export function providerKind(id: string): ProviderKind {
  return ALL_PROVIDER_KINDS.find((k) => k.id === id) ?? ProviderKinds.CUSTOM;
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}
