/**
 * Media-model knowledge (the media part of ModelCatalog.kt): what a model id makes, which
 * provider/output pairs Facet can run, built-in lists for media-only providers and the ranking
 * behind "Automatic". It lives here so MediaGen and MediaService don't depend on the chat catalog;
 * the chat catalog can import mediaOutput/canRun/GEMINI_MEDIA_DEFAULTS from this module.
 */
import { ProviderKinds, type ProviderKind } from '../providers';
import { normalizeModel, type ModelInfo, type ModelOutput } from '../types';

const NOT_MEDIA = ['embed', 'rerank', 'moderation', 'guard', 'realtime', 'native-audio', '-live', 'live-', 'search'];

/** What a non-chat model produces, judged from its id; null when it isn't a media model Facet can run. */
export function mediaOutput(kind: ProviderKind, id: string): ModelOutput | null {
  const s = id.toLowerCase().replace(/^models\//, '');
  if (NOT_MEDIA.some((x) => s.includes(x))) return null;
  // Mistral: Voxtral Mini is the transcription model; Voxtral Small is chat with audio input.
  if (kind.id === ProviderKinds.MISTRAL.id && s.startsWith('voxtral-mini') && !s.includes('tts')) return 'TRANSCRIPTION';
  if (s.includes('transcribe') || s.includes('whisper') || s.startsWith('scribe') || s.startsWith('nova-')) return 'TRANSCRIPTION';
  if (s.includes('tts') || s.startsWith('aura') || s.startsWith('eleven_')) return 'SPEECH';
  if (s.includes('lyria') || s.startsWith('music_') || s.includes('stable-audio') || s === 'sound_effects') return 'MUSIC';
  if (s.includes('veo-') || (kind.id === ProviderKinds.GOOGLE.id && s.includes('omni')) || s.includes('-video') || s.includes('video-')) return 'VIDEO';
  if (
    s.includes('image') || s.includes('dall-e') || s.includes('imagen') || s.includes('nano-banana') || s.includes('flux') ||
    s.includes('stable-diffusion') || s.includes('sdxl') || s.startsWith('sd3') || s.includes('seedream') || s.includes('ideogram') ||
    s.includes('recraft') || s.includes('hidream')
  ) return 'IMAGE';
  return null;
}

const K = ProviderKinds;
const RUNS: Record<Exclude<ModelOutput, 'TEXT'>, Set<string>> = {
  IMAGE: new Set([K.OPENAI, K.GOOGLE, K.OPENROUTER, K.XAI, K.TOGETHER, K.DEEPINFRA, K.NEBIUS, K.STABILITY, K.BFL, K.CUSTOM].map((k) => k.id)),
  VIDEO: new Set([K.GOOGLE.id]),
  SPEECH: new Set([K.OPENAI, K.GOOGLE, K.MISTRAL, K.ELEVENLABS, K.DEEPGRAM, K.CUSTOM].map((k) => k.id)),
  MUSIC: new Set([K.GOOGLE, K.ELEVENLABS, K.STABILITY].map((k) => k.id)),
  TRANSCRIPTION: new Set([K.OPENAI, K.MISTRAL, K.GROQ, K.TOGETHER, K.DEEPINFRA, K.ELEVENLABS, K.DEEPGRAM, K.CUSTOM].map((k) => k.id)),
};

/** Whether Facet can run [output] models from [kind] (see gen.ts for the API behind each pair). */
export function canRun(kind: ProviderKind, output: ModelOutput): boolean {
  if (output === 'TEXT') return kind.style !== 'MEDIA';
  return RUNS[output].has(kind.id);
}

function m(id: string, displayName: string, output: ModelOutput): ModelInfo {
  return normalizeModel({ id, displayName, output });
}

/** Built-in lists for providers that make only media (their APIs don't list models, or list only some). */
export function mediaProviderModels(kind: ProviderKind): ModelInfo[] {
  switch (kind.id) {
    case K.ELEVENLABS.id:
      return [
        m('eleven_v3', 'Eleven v3', 'SPEECH'),
        m('eleven_multilingual_v2', 'Eleven Multilingual v2', 'SPEECH'),
        m('eleven_flash_v2_5', 'Eleven Flash v2.5', 'SPEECH'),
        m('music_v2_5', 'Eleven Music v2.5', 'MUSIC'),
        m('music_v1', 'Eleven Music', 'MUSIC'),
        m('sound_effects', 'Sound effects', 'MUSIC'),
        m('scribe_v2', 'Scribe v2', 'TRANSCRIPTION'),
      ];
    case K.STABILITY.id:
      return [
        m('stable-image-ultra', 'Stable Image Ultra', 'IMAGE'),
        m('stable-image-core', 'Stable Image Core', 'IMAGE'),
        m('sd3.5-large', 'Stable Diffusion 3.5 Large', 'IMAGE'),
        m('sd3.5-large-turbo', 'Stable Diffusion 3.5 Large Turbo', 'IMAGE'),
        m('sd3.5-medium', 'Stable Diffusion 3.5 Medium', 'IMAGE'),
        m('stable-audio-2.5', 'Stable Audio 2.5', 'MUSIC'),
      ];
    case K.BFL.id:
      return [
        m('flux-2-max', 'FLUX.2 [max]', 'IMAGE'),
        m('flux-2-pro', 'FLUX.2 [pro]', 'IMAGE'),
        m('flux-2-flex', 'FLUX.2 [flex]', 'IMAGE'),
        m('flux-kontext-max', 'FLUX.1 Kontext [max]', 'IMAGE'),
        m('flux-kontext-pro', 'FLUX.1 Kontext [pro]', 'IMAGE'),
        m('flux-pro-1.1-ultra', 'FLUX1.1 [pro] Ultra', 'IMAGE'),
      ];
    case K.DEEPGRAM.id:
      return [
        m('nova-3', 'Nova-3', 'TRANSCRIPTION'),
        m('nova-2', 'Nova-2', 'TRANSCRIPTION'),
        m('aura-2', 'Aura-2', 'SPEECH'),
      ];
    default:
      return [];
  }
}

/** Current Gemini media models, used when the model list doesn't include any of a kind. */
export const GEMINI_MEDIA_DEFAULTS: readonly ModelInfo[] = [
  m('gemini-nano-banana-2.1', 'Nano Banana 2.1', 'IMAGE'),
  m('gemini-omni-1.1-flash', 'Gemini Omni 1.1 Flash', 'VIDEO'),
  m('gemini-3.8-flash-tts', 'Gemini 3.8 Flash TTS', 'SPEECH'),
  m('lyria-3.5', 'Lyria 3.5', 'MUSIC'),
];

/** Friendly names for OpenAI media ids (their API lists ids only). */
export const MEDIA_NAMES: Readonly<Record<string, string>> = {
  'gpt-image-1': 'GPT Image 1', 'gpt-image-1-mini': 'GPT Image 1 mini', 'dall-e-3': 'DALL·E 3', 'dall-e-2': 'DALL·E 2',
  'tts-1': 'TTS 1', 'tts-1-hd': 'TTS 1 HD', 'gpt-4o-mini-tts': 'GPT-4o mini TTS', 'whisper-1': 'Whisper',
  'gpt-4o-transcribe': 'GPT-4o Transcribe', 'gpt-4o-mini-transcribe': 'GPT-4o mini Transcribe',
};

const RANKING: Record<ModelOutput, string[]> = {
  IMAGE: ['nano-banana', 'gpt-image', 'flux-2-pro', 'stable-image-ultra', 'grok', 'flux', 'image'],
  VIDEO: ['omni', 'veo-3.1-generate', 'veo'],
  SPEECH: ['gpt-4o-mini-tts', 'eleven_multilingual', 'eleven', 'flash-tts', 'tts', 'aura'],
  MUSIC: ['music_v2', 'music', 'lyria', 'stable-audio', 'sound'],
  TRANSCRIPTION: ['gpt-4o-transcribe', 'scribe', 'nova-3', 'voxtral', 'whisper-large-v3-turbo', 'transcribe', 'whisper'],
  TEXT: [],
};

/** Picks the most capable media model of [output] from [models] when the user hasn't chosen one. */
export function preferredMedia<T extends Pick<ModelInfo, 'id' | 'output'>>(output: ModelOutput, models: readonly T[]): T | null {
  const ofKind = models.filter((x) => x.output === output);
  for (const key of RANKING[output]) {
    const hit = ofKind.find((x) => x.id.toLowerCase().includes(key));
    if (hit) return hit;
  }
  return ofKind[0] ?? null;
}
