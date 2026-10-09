/** Automatic sorting of models by what they make (port of MediaCatalogTest.kt, media half). */
import { describe, expect, it } from 'vitest';
import { canRun, mediaOutput, mediaProviderModels, preferredMedia } from '../../src/llm/media/catalog';
import { ProviderKinds as K } from '../../src/llm/providers';
import { model } from './fakes';

describe('media catalog', () => {
  it('sorts by output', () => {
    expect(mediaOutput(K.OPENAI, 'gpt-image-1')).toBe('IMAGE');
    expect(mediaOutput(K.OPENAI, 'dall-e-3')).toBe('IMAGE');
    expect(mediaOutput(K.OPENAI, 'gpt-4o-mini-tts')).toBe('SPEECH');
    expect(mediaOutput(K.OPENAI, 'gpt-4o-transcribe')).toBe('TRANSCRIPTION');
    expect(mediaOutput(K.GROQ, 'whisper-large-v3-turbo')).toBe('TRANSCRIPTION');
    expect(mediaOutput(K.GOOGLE, 'models/gemini-nano-banana-2.1')).toBe('IMAGE');
    expect(mediaOutput(K.GOOGLE, 'gemini-3.1-flash-image')).toBe('IMAGE');
    expect(mediaOutput(K.GOOGLE, 'gemini-omni-1.1-flash')).toBe('VIDEO');
    expect(mediaOutput(K.GOOGLE, 'veo-3.1-generate-preview')).toBe('VIDEO');
    expect(mediaOutput(K.GOOGLE, 'gemini-3.8-flash-tts')).toBe('SPEECH');
    expect(mediaOutput(K.GOOGLE, 'lyria-3.5')).toBe('MUSIC');
    expect(mediaOutput(K.TOGETHER, 'black-forest-labs/FLUX.1-schnell')).toBe('IMAGE');
    expect(mediaOutput(K.XAI, 'grok-2-image-1212')).toBe('IMAGE');
    // Not media (or not runnable): embeddings, realtime and live models, chat models.
    expect(mediaOutput(K.GOOGLE, 'gemini-embedding-2')).toBeNull();
    expect(mediaOutput(K.OPENAI, 'gpt-realtime')).toBeNull();
    expect(mediaOutput(K.GOOGLE, 'lyria-realtime-exp')).toBeNull();
    expect(mediaOutput(K.GOOGLE, 'gemini-3.6-flash')).toBeNull();
    expect(mediaOutput(K.OPENAI, 'gpt-5.5')).toBeNull();
  });

  it('knows Mistral audio models', () => {
    expect(mediaOutput(K.MISTRAL, 'voxtral-mini-latest')).toBe('TRANSCRIPTION');
    expect(mediaOutput(K.MISTRAL, 'voxtral-mini-2602')).toBe('TRANSCRIPTION');
    expect(mediaOutput(K.MISTRAL, 'voxtral-mini-tts-2603')).toBe('SPEECH');
    // Voxtral Small is a chat model; live transcription is neither chat nor media.
    expect(mediaOutput(K.MISTRAL, 'voxtral-small-latest')).toBeNull();
    expect(mediaOutput(K.MISTRAL, 'voxtral-mini-transcribe-realtime-2602')).toBeNull();
    expect(canRun(K.MISTRAL, 'TRANSCRIPTION')).toBe(true);
    expect(canRun(K.MISTRAL, 'SPEECH')).toBe(true);
  });

  it('allows only runnable combinations', () => {
    expect(canRun(K.GOOGLE, 'VIDEO')).toBe(true);
    expect(canRun(K.OPENAI, 'VIDEO')).toBe(false);
    expect(canRun(K.GROQ, 'SPEECH')).toBe(false);
    expect(canRun(K.ELEVENLABS, 'TEXT')).toBe(false);
    expect(canRun(K.OPENAI, 'TEXT')).toBe(true);
    expect(canRun(K.ELEVENLABS, 'MUSIC')).toBe(true);
    expect(canRun(K.BFL, 'IMAGE')).toBe(true);
  });

  it('picks the best automatically', () => {
    const models = [
      model('dall-e-2', 'IMAGE', 'DALL·E 2'),
      model('gpt-image-1', 'IMAGE', 'GPT Image 1'),
      model('tts-1', 'SPEECH', 'TTS 1'),
    ];
    expect(preferredMedia('IMAGE', models)?.id).toBe('gpt-image-1');
    expect(preferredMedia('SPEECH', models)?.id).toBe('tts-1');
    expect(preferredMedia('VIDEO', models)).toBeNull();
    // Unranked ids still count: the first of the kind wins.
    expect(preferredMedia('IMAGE', [model('mystery-painter', 'IMAGE')])?.id).toBe('mystery-painter');
  });

  it('has built-in models for media-only providers', () => {
    for (const k of [K.ELEVENLABS, K.STABILITY, K.BFL, K.DEEPGRAM]) {
      const models = mediaProviderModels(k);
      expect(models.length, k.id).toBeGreaterThan(0);
      expect(models.every((m) => m.output !== 'TEXT' && canRun(k, m.output))).toBe(true);
      expect(models.every((m) => mediaOutput(k, m.id) === m.output), k.id).toBe(true);
    }
    expect(mediaProviderModels(K.OPENAI)).toEqual([]);
  });
});
