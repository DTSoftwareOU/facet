/** Choosing media models (explicit or "Automatic"), running them and storing the results. */
import { beforeEach, describe, expect, it } from 'vitest';
import { b64 } from '../../src/core/bytes';
import type { AttachmentEntity, ProviderEntity } from '../../src/data/entities';
import { defaultMedia, defaultSynced, type MediaPrefs, type SyncedPrefs } from '../../src/data/prefs';
import { mediaFileName, MediaService, type MediaProviderEntry } from '../../src/domain/media/service';
import { ProviderKinds, type ProviderKind } from '../../src/llm/providers';
import { LlmException, type ModelInfo, type ModelOutput } from '../../src/llm/types';
import { FakeServer, model, mp3, mp4, png, useFakePlatform } from './fakes';

/** The tool registry's view of the service (written elsewhere); MediaService must satisfy it. */
interface MediaToolService {
  resolve(output: ModelOutput): Promise<{ model: { displayName: string } } | null>;
  create(output: ModelOutput, prompt: string, conversationId: string, aspect: 'SQUARE' | 'LANDSCAPE' | 'PORTRAIT' | null, seconds: number | null, onProgress: (label: string) => void): Promise<{ attachment: AttachmentEntity; model: { displayName: string } }>;
}

function provider(id: string, kind: ProviderKind, over: Partial<ProviderEntity> = {}): ProviderEntity {
  return {
    id, kind: kind.id, label: kind.displayName, baseUrl: 'https://api.test/v1', apiKeySealed: '', headersJson: '{}', enabled: true,
    modelsJson: '[]', modelsFetchedAt: 0, favoritesJson: '[]', customModelsJson: '[]', capsOverridesJson: '{}', modelPrefsJson: '{}',
    sort: 0, createdAt: 0, updatedAt: 0, deleted: 0, dirty: 0, ...over,
  };
}

function entry(p: ProviderEntity, kind: ProviderKind, models: ModelInfo[], baseUrl = 'https://api.test/v1'): MediaProviderEntry {
  return { provider: p, config: { id: p.id, kind, label: p.label, baseUrl, apiKey: `key-${p.id}`, headers: {} }, models };
}

const openai = () => entry(provider('oa', ProviderKinds.OPENAI), ProviderKinds.OPENAI, [
  model('gpt-5.5', 'TEXT'),
  model('dall-e-2', 'IMAGE', 'DALL·E 2'),
  model('gpt-image-1', 'IMAGE', 'GPT Image 1'),
  model('sora-2', 'VIDEO'),
  model('tts-1', 'SPEECH', 'TTS 1'),
  model('whisper-1', 'TRANSCRIPTION', 'Whisper'),
]);
const google = () => entry(provider('g', ProviderKinds.GOOGLE), ProviderKinds.GOOGLE, [model('gemini-omni-1.1-flash', 'VIDEO', 'Gemini Omni 1.1 Flash')], 'https://api.test/v1beta/openai');
const bfl = () => entry(provider('bfl', ProviderKinds.BFL), ProviderKinds.BFL, [model('flux-2-pro', 'IMAGE', 'FLUX.2 [pro]')]);
const stability = () => entry(provider('st', ProviderKinds.STABILITY), ProviderKinds.STABILITY, [model('stable-image-ultra', 'IMAGE', 'Stable Image Ultra')]);
const eleven = () => entry(provider('el', ProviderKinds.ELEVENLABS), ProviderKinds.ELEVENLABS, [model('music_v1', 'MUSIC', 'Eleven Music')]);
const groq = () => entry(provider('gq', ProviderKinds.GROQ), ProviderKinds.GROQ, [model('whisper-large-v3-turbo', 'TRANSCRIPTION')]);

let server: FakeServer;
let stored: Array<{ bytes: Uint8Array; mime: string; name: string; conversationId: string }>;

function service(entries: MediaProviderEntry[], media: Partial<MediaPrefs> = {}) {
  const synced: SyncedPrefs = { ...defaultSynced(), media: defaultMedia(media) };
  return new MediaService({
    providers: { list: async () => entries },
    settings: { synced },
    attachments: {
      storeGenerated: async (bytes, mime, name, conversationId) => {
        stored.push({ bytes, mime, name, conversationId });
        const now = Date.now();
        return {
          id: `att${stored.length}`, conversationId, kind: mime.split('/')[0], mimeType: mime, name, sizeBytes: bytes.length,
          hasFile: 1, uploaded: false, localOnly: false, createdAt: now, updatedAt: now, deleted: 0, dirty: 1,
        };
      },
    },
    fetch: server.fetch,
  });
}

beforeEach(() => {
  server = new FakeServer();
  stored = [];
  useFakePlatform(false);
});

describe('choosing models', () => {
  it('lists only runnable models of a kind', async () => {
    const svc = service([openai(), google()]);
    expect((await svc.available('IMAGE')).map((c) => c.model.id)).toEqual(['dall-e-2', 'gpt-image-1']);
    // OpenAI's Sora isn't something Facet can run; Gemini video is.
    expect((await svc.available('VIDEO')).map((c) => c.ref)).toEqual([{ providerId: 'g', modelId: 'gemini-omni-1.1-flash' }]);
    expect(await svc.available('MUSIC')).toEqual([]);
  });

  it('skips disabled, deleted and search providers', async () => {
    const off = entry(provider('off', ProviderKinds.OPENAI, { enabled: false }), ProviderKinds.OPENAI, [model('gpt-image-1', 'IMAGE')]);
    const gone = entry(provider('gone', ProviderKinds.OPENAI, { deleted: 1 }), ProviderKinds.OPENAI, [model('gpt-image-1', 'IMAGE')]);
    const search = entry(provider('s', ProviderKinds.CUSTOM, { kind: 'search.brave' }), ProviderKinds.CUSTOM, [model('image-x', 'IMAGE')]);
    expect(await service([off, gone, search]).available('IMAGE')).toEqual([]);
  });

  it('Automatic picks the best model the user has', async () => {
    const svc = service([openai(), google()]);
    const image = await svc.resolve('IMAGE');
    expect(image?.model.id).toBe('gpt-image-1');
    expect(image?.explicit).toBe(false);
    expect(image?.label).toBe('GPT Image 1 · OpenAI');
    expect(await svc.resolve('MUSIC')).toBeNull();
    expect(await svc.resolve('IMAGE', true)).toBeNull();
  });

  it('an explicit choice wins', async () => {
    const svc = service([openai()], { image: { providerId: 'oa', modelId: 'dall-e-2' } });
    const image = await svc.resolve('IMAGE');
    expect(image?.model.id).toBe('dall-e-2');
    expect(image?.explicit).toBe(true);
    // A choice that no longer exists falls back to Automatic.
    const stale = service([openai()], { image: { providerId: 'gone', modelId: 'x' } });
    expect((await stale.resolve('IMAGE'))?.model.id).toBe('gpt-image-1');
  });

  it('the Windows app can use every provider', async () => {
    useFakePlatform(false);
    const choice = await service([stability(), bfl()]).resolve('IMAGE');
    expect(choice?.model.id).toBe('flux-2-pro');
    expect(choice?.browserBlocked).toBe(false);
  });

  it('on the website, Automatic skips providers that refuse browser requests', async () => {
    useFakePlatform(true);
    const svc = service([stability(), bfl()]);
    expect((await svc.resolve('IMAGE'))?.model.id).toBe('stable-image-ultra');
    const listed = await svc.available('IMAGE');
    expect(listed.find((c) => c.provider.id === 'bfl')?.browserBlocked).toBe(true);
    expect(await service([bfl()]).resolve('IMAGE')).toBeNull();
  });

  it('on the website, an explicit browser-blocked choice fails clearly', async () => {
    useFakePlatform(true);
    const svc = service([stability(), bfl()], { image: { providerId: 'bfl', modelId: 'flux-2-pro' } });
    const choice = await svc.resolve('IMAGE');
    expect(choice?.explicit).toBe(true);
    expect(choice?.browserBlocked).toBe(true);
    const e = await svc.create('IMAGE', 'a fox', 'c1').catch((x) => x);
    expect(e).toBeInstanceOf(LlmException);
    expect(e.error.kind).toBe('BROWSER_BLOCKED');
    expect(e.message).toBe("Black Forest Labs doesn't accept requests from web browsers. Use it in the Facet app for Windows or Android.");
    expect(server.requests).toHaveLength(0);
  });
});

describe('creating media', () => {
  it('stores the result as an attachment of the chat and reports progress', async () => {
    server.json({ steps: [{ content: [{ type: 'video', mime_type: 'video/mp4', data: b64(mp4) }] }] });
    const svc = service([google()], { videoAspect: 'PORTRAIT' });
    const progress: string[] = [];
    const tools: MediaToolService = svc;
    const made = await tools.create('VIDEO', 'Waves crashing at dusk', 'c1', null, null, (p) => progress.push(p));
    expect(made.model.displayName).toBe('Gemini Omni 1.1 Flash');
    expect(made.attachment.id).toBe('att1');
    expect(progress).toEqual(['Creating video']);
    expect(stored[0]).toMatchObject({ mime: 'video/mp4', name: 'waves-crashing-at-dusk.mp4', conversationId: 'c1' });
    expect(server.take().json().response_format).toEqual({ type: 'video', aspect_ratio: '9:16' });
  });

  it('uses the saved image shape and music length unless the call gives one', async () => {
    server.json({ data: [{ b64_json: b64(png) }] });
    const svc = service([openai(), eleven()], { imageAspect: 'LANDSCAPE', musicSeconds: 60 });
    await svc.create('IMAGE', 'x', 'c1');
    expect(server.take().json().size).toBe('1536x1024');
    server.json({ data: [{ b64_json: b64(png) }] });
    await svc.create('IMAGE', 'x', 'c1', 'PORTRAIT');
    expect(server.take().json().size).toBe('1024x1536');

    server.bytes(mp3, 'audio/mpeg');
    await svc.create('MUSIC', 'lofi beat', 'c1');
    expect(server.take().json().music_length_ms).toBe(60000);
    server.bytes(mp3, 'audio/mpeg');
    await svc.create('MUSIC', 'lofi beat', 'c1', null, 15);
    expect(server.take().json().music_length_ms).toBe(15000);
    expect(stored.map((s) => s.name)).toEqual(['x.png', 'x.png', 'lofi-beat.mp3', 'lofi-beat.mp3']);
  });

  it('explains when nothing can make it', async () => {
    const e = await service([google()]).create('IMAGE', 'x', 'c1').catch((x) => x);
    expect(e.error.kind).toBe('BAD_REQUEST');
    expect(e.message).toBe('No image model is set up. Add a provider that makes images in Settings → Media models.');
  });

  it('speaks with the saved voice', async () => {
    server.bytes(mp3, 'audio/mpeg');
    const svc = service([openai()], { voice: 'nova', voiceFor: 'oa/tts-1' });
    await svc.create('SPEECH', 'Hello there', 'c1');
    expect(server.take().json()).toMatchObject({ model: 'tts-1', voice: 'nova', input: 'Hello there' });
  });

  it('names files after the prompt', () => {
    expect(mediaFileName('A fox in the snow, watercolor', 'IMAGE', 'png')).toBe('fox-in-snow-watercolor.png');
    expect(mediaFileName('!!!', 'MUSIC', 'mp3')).toBe('music.mp3');
    expect(mediaFileName('a very long prompt about many different things all at once', 'IMAGE', 'png')).toBe('very-long-prompt-about-many-different-th.png');
  });
});

describe('voices, read aloud and dictation', () => {
  it('uses a saved voice only for the model it belongs to', async () => {
    const svc = service([openai()], { voice: 'nova', voiceFor: 'other/tts-1' });
    const choice = (await svc.resolve('SPEECH'))!;
    expect(svc.voiceFor(choice)).toBe('alloy');
    expect(svc.voiceName(choice, 'alloy')).toBe('Alloy');
    expect((await svc.voices(choice)).map((v) => v.id)).toContain('shimmer');
  });

  it('reads aloud only with an explicitly chosen speech model, and caches the audio', async () => {
    expect(await service([openai()]).speak('Hi')).toBeNull();
    expect(await service([openai()], { speech: { providerId: 'oa', modelId: 'tts-1' }, aiReadAloud: false }).speak('Hi')).toBeNull();

    const svc = service([openai()], { speech: { providerId: 'oa', modelId: 'tts-1' } });
    expect(await svc.readAloudAvailable()).toBe(true);
    server.bytes(mp3, 'audio/mpeg');
    const first = await svc.speak('Hi');
    expect(first?.mimeType).toBe('audio/mpeg');
    const again = await svc.speak('Hi');
    expect(again).toBe(first);
    expect(server.requests).toHaveLength(1);
  });

  it('dictates with the chosen transcription model', async () => {
    const none = service([groq()]);
    expect(await none.dictationAvailable()).toBe(false);
    const e = await none.transcribe(new Blob([new Uint8Array(10)], { type: 'audio/webm' })).catch((x) => x);
    expect(e.message).toBe('Choose a transcription model in Settings → Media models.');

    const svc = service([groq()], { transcription: { providerId: 'gq', modelId: 'whisper-large-v3-turbo' } });
    expect(await svc.dictationAvailable()).toBe(true);
    server.json({ text: '  remind me to call mom  ' });
    expect(await svc.transcribe(new Blob([new Uint8Array(10)], { type: 'audio/webm;codecs=opus' }))).toBe('remind me to call mom');
    const req = server.take();
    expect(req.url.pathname).toBe('/v1/audio/transcriptions');
    expect(req.headers.get('Authorization')).toBe('Bearer key-gq');
    expect((req.form().get('file') as File).name).toBe('dictation.webm');
  });
});
