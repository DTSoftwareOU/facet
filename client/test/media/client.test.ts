/** The LlmClient for media-only providers: model lists, key checks and no chat. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createMediaProviderClient } from '../../src/llm/media/client';
import { ProviderKinds } from '../../src/llm/providers';
import { defaultParams, defaultCaps, LlmException, type StreamEvent } from '../../src/llm/types';
import { config, FakeServer, useFakePlatform } from './fakes';

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  useFakePlatform(false);
});

describe('media provider client', () => {
  it('ElevenLabs: live voice models plus the built-in music, sound and transcription ones', async () => {
    server.json([
      { model_id: 'eleven_v3', name: 'Eleven v3 (alpha)', can_do_text_to_speech: true },
      { model_id: 'eleven_english_sts_v2', name: 'Speech to speech', can_do_text_to_speech: false },
    ]);
    const client = createMediaProviderClient(config(ProviderKinds.ELEVENLABS, 'https://api.test/'), { fetch: server.fetch });
    const models = await client.listModels();
    expect(models.map((m) => `${m.id}:${m.output}`)).toEqual([
      'eleven_v3:SPEECH', 'music_v2_5:MUSIC', 'music_v1:MUSIC', 'sound_effects:MUSIC', 'scribe_v2:TRANSCRIPTION',
    ]);
    expect(models[0].displayName).toBe('Eleven v3 (alpha)');
    const req = server.take();
    expect(req.url.href).toBe('https://api.test/v1/models');
    expect(req.headers.get('xi-api-key')).toBe('key-123');
  });

  it('ElevenLabs: falls back to the built-in list', async () => {
    server.json({ detail: { message: 'invalid key' } }, 401);
    const models = await createMediaProviderClient(config(ProviderKinds.ELEVENLABS, 'https://api.test'), { fetch: server.fetch }).listModels();
    expect(models.filter((m) => m.output === 'SPEECH').map((m) => m.id)).toEqual(['eleven_v3', 'eleven_multilingual_v2', 'eleven_flash_v2_5']);
  });

  it('other media providers list built-in models without a request', async () => {
    const models = await createMediaProviderClient(config(ProviderKinds.STABILITY, 'https://api.test'), { fetch: server.fetch }).listModels();
    expect(models.map((m) => m.id)).toContain('stable-image-ultra');
    expect(server.requests).toHaveLength(0);
  });

  it('verifies keys against each provider', async () => {
    server.json({ projects: [] });
    await createMediaProviderClient(config(ProviderKinds.DEEPGRAM, 'https://api.test'), { fetch: server.fetch }).verify();
    const req = server.take();
    expect(req.url.pathname).toBe('/v1/projects');
    expect(req.headers.get('Authorization')).toBe('Token key-123');

    server.json({ credits: 3 });
    await createMediaProviderClient(config(ProviderKinds.BFL, 'https://api.test'), { fetch: server.fetch }).verify();
    expect(server.take().url.pathname).toBe('/v1/credits');

    server.json({ name: 'unauthorized', message: 'bad key' }, 401);
    const e = await createMediaProviderClient(config(ProviderKinds.STABILITY, 'https://api.test'), { fetch: server.fetch }).verify().catch((x) => x);
    expect(e).toBeInstanceOf(LlmException);
    expect(e.error.kind).toBe('AUTH');
    expect(server.take().url.pathname).toBe('/v1/user/account');
  });

  it('has no chat', async () => {
    const client = createMediaProviderClient(config(ProviderKinds.ELEVENLABS), { fetch: server.fetch });
    const events: StreamEvent[] = [];
    for await (const e of client.stream({ model: 'eleven_v3', messages: [], params: defaultParams(), caps: defaultCaps(), tools: [] })) events.push(e);
    expect(events).toEqual([{ type: 'failed', error: { kind: 'BAD_REQUEST', message: 'ElevenLabs makes media only. Pick a chat model for conversations.' } }]);
  });
});
