/** Request shapes and response parsing for each media backend, against a scripted fetch (port of MediaGenTest.kt). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { b64, fromUtf8 } from '../../src/core/bytes';
import { chunks, sniff, wav } from '../../src/llm/media/files';
import { defaultVoice, generateMedia, listVoices, staticVoices, transcribeAudio, voiceName } from '../../src/llm/media/gen';
import { ProviderKinds } from '../../src/llm/providers';
import { LlmException } from '../../src/llm/types';
import { config, FakeServer, model, mp3, mp4, png, settle, useFakePlatform } from './fakes';

let server: FakeServer;
const audio = new Uint8Array(2000);

beforeEach(() => {
  server = new FakeServer();
  useFakePlatform(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('images', () => {
  it('OpenAI: sizes by aspect, and no response_format for GPT Image', async () => {
    server.json({ data: [{ b64_json: b64(png) }] });
    const f = await generateMedia(config(ProviderKinds.OPENAI), model('gpt-image-1', 'IMAGE'), { output: 'IMAGE', prompt: 'a fox', aspect: 'PORTRAIT' }, { fetch: server.fetch });
    expect(f.mimeType).toBe('image/png');
    expect(f.bytes).toEqual(png);
    const req = server.take();
    expect(req.url.pathname).toBe('/v1/images/generations');
    expect(req.headers.get('Authorization')).toBe('Bearer key-123');
    expect(req.json().size).toBe('1024x1536');
    expect(req.json()).not.toHaveProperty('response_format');

    server.json({ data: [{ b64_json: b64(png) }] });
    await generateMedia(config(ProviderKinds.OPENAI), model('dall-e-3', 'IMAGE'), { output: 'IMAGE', prompt: 'x', aspect: 'LANDSCAPE' }, { fetch: server.fetch });
    const dalle = server.take().json();
    expect(dalle.response_format).toBe('b64_json');
    expect(dalle.size).toBe('1792x1024');
  });

  it('OpenAI-compatible: downloads a returned URL without the API key', async () => {
    server.json({ data: [{ url: 'https://cdn.test/fox.png' }] });
    server.bytes(png, 'application/octet-stream');
    const f = await generateMedia(config(ProviderKinds.TOGETHER), model('black-forest-labs/FLUX.1-schnell', 'IMAGE'), { output: 'IMAGE', prompt: 'x', aspect: 'LANDSCAPE' }, { fetch: server.fetch });
    expect(f.mimeType).toBe('image/png');
    const body = server.take().json();
    expect([body.width, body.height, body.response_format]).toEqual([1344, 768, 'base64']);
    const dl = server.take();
    expect(dl.url.href).toBe('https://cdn.test/fox.png');
    expect(dl.headers.get('Authorization')).toBeNull();
  });

  it('Gemini: Interactions API, retried without options after a 400', async () => {
    server.json({ error: { message: 'aspect_ratio not supported' } }, 400);
    server.json({
      id: 'i1', status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Here' }, { type: 'image', mime_type: 'image/png', data: b64(png) }] }],
    });
    const f = await generateMedia(config(ProviderKinds.GOOGLE, 'https://api.test/v1beta/openai'), model('gemini-nano-banana-2.1', 'IMAGE'), { output: 'IMAGE', prompt: 'a fox', aspect: 'LANDSCAPE' }, { fetch: server.fetch });
    expect(f.mimeType).toBe('image/png');
    const first = server.take();
    expect(first.url.pathname).toBe('/v1beta/interactions');
    expect(first.headers.get('x-goog-api-key')).toBe('key-123');
    expect(first.json().response_format).toEqual({ type: 'image', aspect_ratio: '16:9' });
    expect(first.json().store).toBe(false);
    expect(server.take().json().response_format).toEqual({ type: 'image' });
  });

  it('OpenRouter: image from a data URL', async () => {
    server.json({ choices: [{ message: { content: '', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64(png)}` } }] } }] });
    const f = await generateMedia(config(ProviderKinds.OPENROUTER), model('google/gemini-2.5-flash-image', 'IMAGE'), { output: 'IMAGE', prompt: 'x' }, { fetch: server.fetch });
    expect(f.bytes).toEqual(png);
    const req = server.take();
    expect(req.json().modalities).toContain('image');
    expect(req.json().image_config).toEqual({ aspect_ratio: '1:1' });
    expect(req.headers.get('X-Title')).toBe('Facet AI');
  });

  it('OpenRouter: says what the model wrote when it returns no image', async () => {
    server.json({ choices: [{ message: { content: 'I cannot draw that.' } }] });
    const e = await generateMedia(config(ProviderKinds.OPENROUTER), model('x/image', 'IMAGE'), { output: 'IMAGE', prompt: 'x' }, { fetch: server.fetch }).catch((x) => x);
    expect(e).toBeInstanceOf(LlmException);
    expect(e.message).toBe("OpenRouter didn't return an image: I cannot draw that..");
  });

  it('Black Forest Labs: FLUX is polled', async () => {
    vi.useFakeTimers();
    server.json({ id: 't1', polling_url: 'https://api.test/v1/get_result?id=t1' });
    server.json({ status: 'Pending' });
    server.json({ status: 'Ready', result: { sample: 'https://delivery.test/sample.png' } });
    server.bytes(png, 'image/png');
    const f = await settle(generateMedia(config(ProviderKinds.BFL, 'https://api.test/'), model('flux-2-pro', 'IMAGE'), { output: 'IMAGE', prompt: 'x', aspect: 'SQUARE' }, { fetch: server.fetch }));
    expect(f.mimeType).toBe('image/png');
    const start = server.take();
    expect(start.url.pathname).toBe('/v1/flux-2-pro');
    expect(start.headers.get('x-key')).toBe('key-123');
    expect(start.json()).toEqual({ prompt: 'x', width: 1024, height: 1024 });
    expect(server.take().headers.get('x-key')).toBe('key-123');
    server.take();
    expect(server.take().headers.get('x-key')).toBeNull();
  });

  it('Black Forest Labs: a failed task stops polling', async () => {
    vi.useFakeTimers();
    server.json({ id: 't1' });
    server.json({ status: 'Content Moderated' });
    const e = await settle(generateMedia(config(ProviderKinds.BFL, 'https://api.test'), model('flux-kontext-pro', 'IMAGE'), { output: 'IMAGE', prompt: 'x', aspect: 'PORTRAIT' }, { fetch: server.fetch })).catch((x) => x);
    expect(e.message).toBe("Black Forest Labs couldn't make that image (Content Moderated).");
    expect(server.take().json()).toEqual({ prompt: 'x', aspect_ratio: '9:16' });
    expect(server.take().url.href).toBe('https://api.test/v1/get_result?id=t1');
  });

  it('Stability: multipart with Accept image/*', async () => {
    server.bytes(png, 'image/png');
    await generateMedia(config(ProviderKinds.STABILITY, 'https://api.test/'), model('sd3.5-large', 'IMAGE'), { output: 'IMAGE', prompt: 'x', aspect: 'LANDSCAPE' }, { fetch: server.fetch });
    const req = server.take();
    expect(req.url.pathname).toBe('/v2beta/stable-image/generate/sd3');
    expect(req.headers.get('Accept')).toBe('image/*');
    expect(req.form().get('model')).toBe('sd3.5-large');
    expect(req.form().get('aspect_ratio')).toBe('16:9');

    server.bytes(png, 'image/png');
    await generateMedia(config(ProviderKinds.STABILITY, 'https://api.test'), model('stable-image-ultra', 'IMAGE'), { output: 'IMAGE', prompt: 'x' }, { fetch: server.fetch });
    const ultra = server.take();
    expect(ultra.url.pathname).toBe('/v2beta/stable-image/generate/ultra');
    expect(ultra.form().get('model')).toBeNull();
  });
});

describe('video', () => {
  it('Veo is polled with progress and downloaded with the key', async () => {
    vi.useFakeTimers();
    server.json({ name: 'models/veo-3.1-generate-preview/operations/op1' });
    server.json({ name: 'models/veo-3.1-generate-preview/operations/op1', done: false });
    server.json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://api.test/v1beta/files/v1:download?alt=media' } }] } } });
    server.bytes(mp4, 'video/mp4');
    const progress: string[] = [];
    const f = await settle(generateMedia(
      config(ProviderKinds.GOOGLE, 'https://api.test/v1beta/openai'),
      model('veo-3.1-generate-preview', 'VIDEO'),
      { output: 'VIDEO', prompt: 'waves', aspect: 'PORTRAIT' },
      { fetch: server.fetch, onProgress: (p) => progress.push(p) },
    ));
    expect(f.mimeType).toBe('video/mp4');
    const start = server.take();
    expect(start.url.pathname).toBe('/v1beta/models/veo-3.1-generate-preview:predictLongRunning');
    expect(start.json()).toEqual({ instances: [{ prompt: 'waves' }], parameters: { aspectRatio: '9:16' } });
    expect(server.take().url.pathname).toBe('/v1beta/models/veo-3.1-generate-preview/operations/op1');
    server.take();
    expect(server.take().headers.get('x-goog-api-key')).toBe('key-123');
    expect(progress).toHaveLength(2);
    expect(progress[0]).toBe('Creating video · 0:08');
    expect(progress.every((p) => /^Creating video · \d+:\d\d$/.test(p))).toBe(true);
  });

  it('stops polling when aborted', async () => {
    vi.useFakeTimers();
    server.json({ name: 'operations/op1' });
    const stop = new AbortController();
    const job = generateMedia(config(ProviderKinds.GOOGLE, 'https://api.test/v1beta/openai'), model('veo-3.1-fast', 'VIDEO'), { output: 'VIDEO', prompt: 'x' }, { fetch: server.fetch, signal: stop.signal });
    const outcome = job.catch((e) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    stop.abort();
    const e = await outcome;
    expect(e.name).toBe('AbortError');
    expect(server.requests).toHaveLength(1);
  });

  it('reports a failed operation', async () => {
    vi.useFakeTimers();
    server.json({ name: 'operations/op1' });
    server.json({ done: true, error: { message: 'The prompt was blocked.' } });
    const e = await settle(generateMedia(config(ProviderKinds.GOOGLE, 'https://api.test/v1beta/openai'), model('veo-3', 'VIDEO'), { output: 'VIDEO', prompt: 'x' }, { fetch: server.fetch })).catch((x) => x);
    expect(e.message).toBe("Google Gemini couldn't make that video: The prompt was blocked.");
  });

  it('other Gemini video models go through Interactions', async () => {
    server.json({ steps: [{ content: [{ type: 'video', mime_type: 'video/mp4', data: b64(mp4) }] }] });
    const progress: string[] = [];
    const f = await generateMedia(config(ProviderKinds.GOOGLE, 'https://api.test/v1beta/openai'), model('gemini-omni-1.1-flash', 'VIDEO'), { output: 'VIDEO', prompt: 'x', aspect: 'SQUARE' }, { fetch: server.fetch, onProgress: (p) => progress.push(p) });
    expect(f.mimeType).toBe('video/mp4');
    expect(progress).toEqual(['Creating video']);
    expect(server.take().json().response_format).toEqual({ type: 'video', aspect_ratio: '16:9' });
  });

  it('is Gemini only', async () => {
    const e = await generateMedia(config(ProviderKinds.OPENAI), model('sora-2', 'VIDEO'), { output: 'VIDEO', prompt: 'x' }, { fetch: server.fetch }).catch((x) => x);
    expect(e.error.kind).toBe('BAD_REQUEST');
    expect(e.message).toBe("Facet can't make video with OpenAI yet.");
  });
});

describe('speech, music and transcription', () => {
  it('Gemini speech: raw PCM becomes WAV', async () => {
    const pcm = Uint8Array.from({ length: 480 }, (_, i) => i % 7);
    server.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/l16;rate=24000', data: b64(pcm) }] }] });
    const f = await generateMedia(config(ProviderKinds.GOOGLE, 'https://api.test/v1beta/openai'), model('gemini-3.8-flash-tts', 'SPEECH'), { output: 'SPEECH', prompt: 'Hello', voice: 'Puck' }, { fetch: server.fetch });
    expect(f.mimeType).toBe('audio/wav');
    expect(fromUtf8(f.bytes.subarray(0, 4))).toBe('RIFF');
    expect(f.bytes.length).toBe(44 + pcm.length);
    expect(new DataView(f.bytes.buffer).getUint32(24, true)).toBe(24000);
    expect(server.take().json().generation_config).toEqual({ speech_config: [{ voice: 'Puck' }] });
  });

  it('ElevenLabs: speech, music and transcription', async () => {
    const cfg = config(ProviderKinds.ELEVENLABS, 'https://api.test/');
    server.bytes(mp3, 'audio/mpeg');
    const speech = await generateMedia(cfg, model('eleven_multilingual_v2', 'SPEECH'), { output: 'SPEECH', prompt: 'Hi there', voice: 'voice42' }, { fetch: server.fetch });
    expect(speech.mimeType).toBe('audio/mpeg');
    const tts = server.take();
    expect(tts.url.pathname).toBe('/v1/text-to-speech/voice42');
    expect(tts.url.searchParams.get('output_format')).toBe('mp3_44100_128');
    expect(tts.headers.get('xi-api-key')).toBe('key-123');
    expect(tts.json().model_id).toBe('eleven_multilingual_v2');

    server.bytes(mp3, 'audio/mpeg');
    await generateMedia(cfg, model('music_v1', 'MUSIC'), { output: 'MUSIC', prompt: 'lofi', seconds: 45 }, { fetch: server.fetch });
    const music = server.take();
    expect(music.url.pathname).toBe('/v1/music');
    expect(music.json().music_length_ms).toBe(45000);

    server.bytes(mp3, 'audio/mpeg');
    await generateMedia(cfg, model('sound_effects', 'MUSIC'), { output: 'MUSIC', prompt: 'door creak', seconds: 120 }, { fetch: server.fetch });
    const sfx = server.take();
    expect(sfx.url.pathname).toBe('/v1/sound-generation');
    expect(sfx.json()).toEqual({ text: 'door creak', duration_seconds: 30 });

    server.json({ text: ' hello world ' });
    const text = await transcribeAudio(cfg, model('scribe_v2', 'TRANSCRIPTION'), audio, 'audio/mp4', 'd.m4a', { fetch: server.fetch });
    expect(text).toBe('hello world');
    const stt = server.take();
    expect(stt.url.pathname).toBe('/v1/speech-to-text');
    expect(stt.form().get('model_id')).toBe('scribe_v2');
    expect((stt.form().get('file') as File).name).toBe('d.m4a');
  });

  it('Deepgram and OpenAI-compatible transcription', async () => {
    server.json({ results: { channels: [{ alternatives: [{ transcript: 'buenos dias' }] }] } });
    const dg = await transcribeAudio(config(ProviderKinds.DEEPGRAM, 'https://api.test/'), model('nova-3', 'TRANSCRIPTION'), audio, 'audio/webm;codecs=opus', 'd.webm', { fetch: server.fetch });
    expect(dg).toBe('buenos dias');
    const req = server.take();
    expect(req.headers.get('Authorization')).toBe('Token key-123');
    expect(req.headers.get('Content-Type')).toBe('audio/webm;codecs=opus');
    expect(req.url.searchParams.get('model')).toBe('nova-3');
    expect(req.url.searchParams.get('smart_format')).toBe('true');

    server.json({ text: 'hi' });
    expect(await transcribeAudio(config(ProviderKinds.GROQ), model('whisper-large-v3-turbo', 'TRANSCRIPTION'), new Blob([audio]), 'audio/mp4', 'd.m4a', { fetch: server.fetch })).toBe('hi');
    const groq = server.take();
    expect(groq.url.pathname).toBe('/v1/audio/transcriptions');
    expect(groq.form().get('model')).toBe('whisper-large-v3-turbo');
  });

  it('Mistral: speech with and without a voice, and transcription', async () => {
    server.json({ audio_data: b64(mp3) });
    const f = await generateMedia(config(ProviderKinds.MISTRAL), model('voxtral-mini-tts-2603', 'SPEECH'), { output: 'SPEECH', prompt: 'Bonjour', voice: 'v-123' }, { fetch: server.fetch });
    expect(f.mimeType).toBe('audio/mpeg');
    const tts = server.take();
    expect(tts.url.pathname).toBe('/v1/audio/speech');
    expect(tts.json().voice_id).toBe('v-123');
    expect(tts.json().response_format).toBe('mp3');

    // No saved voice: let Mistral choose.
    server.json({ audio_data: b64(mp3) });
    await generateMedia(config(ProviderKinds.MISTRAL), model('voxtral-mini-tts-2603', 'SPEECH'), { output: 'SPEECH', prompt: 'Hola', voice: '' }, { fetch: server.fetch });
    expect(server.take().json()).not.toHaveProperty('voice_id');

    server.json({ text: 'salut' });
    expect(await transcribeAudio(config(ProviderKinds.MISTRAL), model('voxtral-mini-latest', 'TRANSCRIPTION'), audio, 'audio/mp4', 'd.m4a', { fetch: server.fetch })).toBe('salut');
    expect(server.take().url.pathname).toBe('/v1/audio/transcriptions');
  });

  it('long text is spoken in chunks and joined', async () => {
    for (let i = 0; i < 3; i++) server.bytes(mp3, 'audio/mpeg');
    const text = 'One. '.repeat(1800);
    const f = await generateMedia(config(ProviderKinds.OPENAI), model('gpt-4o-mini-tts', 'SPEECH'), { output: 'SPEECH', prompt: text }, { fetch: server.fetch });
    expect(server.requests).toHaveLength(3);
    expect(f.bytes.length).toBe(3 * mp3.length);
    const first = server.take().json();
    expect(first).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'alloy', response_format: 'mp3' });
    expect(first.input.length).toBeLessThanOrEqual(4000);
  });

  it('Deepgram speech names the voice in the model', async () => {
    server.bytes(mp3, 'audio/mpeg');
    await generateMedia(config(ProviderKinds.DEEPGRAM, 'https://api.test'), model('aura-2', 'SPEECH'), { output: 'SPEECH', prompt: 'Hi' }, { fetch: server.fetch });
    const req = server.take();
    expect(req.url.pathname).toBe('/v1/speak');
    expect(req.url.searchParams.get('model')).toBe('aura-2-thalia-en');
    expect(req.json()).toEqual({ text: 'Hi' });
  });

  it('Stability and Gemini music', async () => {
    server.bytes(mp3, 'audio/mpeg');
    await generateMedia(config(ProviderKinds.STABILITY, 'https://api.test'), model('stable-audio-2.5', 'MUSIC'), { output: 'MUSIC', prompt: 'drums', seconds: 300 }, { fetch: server.fetch });
    const st = server.take();
    expect(st.url.pathname).toBe('/v2beta/audio/stable-audio-2/text-to-audio');
    expect(st.headers.get('Accept')).toBe('audio/*');
    expect(st.form().get('duration')).toBe('190');

    server.json({ steps: [{ content: [{ type: 'audio', mime_type: 'audio/mpeg', data: b64(mp3) }] }] });
    await generateMedia(config(ProviderKinds.GOOGLE, 'https://api.test/v1beta/openai'), model('lyria-3.5', 'MUSIC'), { output: 'MUSIC', prompt: 'jazz', seconds: 60 }, { fetch: server.fetch });
    const body = server.take().json();
    expect(body.input).toBe('jazz\n\nLength: about 60 seconds.');
    expect(body.response_format).toEqual({ type: 'audio' });
  });
});

describe('voices', () => {
  it('ElevenLabs lists account voices, else George', async () => {
    const cfg = config(ProviderKinds.ELEVENLABS, 'https://api.test');
    server.json({ voices: [{ voice_id: 'v1', name: 'Rachel' }, { voice_id: 'v2' }, { name: 'no id' }] });
    expect(await listVoices(cfg, 'eleven_v3', { fetch: server.fetch })).toEqual([{ id: 'v1', name: 'Rachel' }, { id: 'v2', name: 'v2' }]);
    expect(server.take().url.pathname).toBe('/v1/voices');

    server.json({ detail: 'nope' }, 401);
    expect(await listVoices(cfg, 'eleven_v3', { fetch: server.fetch })).toEqual([{ id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' }]);
  });

  it('Mistral offers the default voice plus saved ones', async () => {
    server.json({ items: [{ id: 'v-1', name: 'Narrator' }] });
    expect(await listVoices(config(ProviderKinds.MISTRAL), 'voxtral-mini-tts-2603', { fetch: server.fetch })).toEqual([
      { id: '', name: 'Default voice' },
      { id: 'v-1', name: 'Narrator' },
    ]);
    expect(server.take().url.pathname).toBe('/v1/audio/voices');
  });

  it('built-in lists and defaults', async () => {
    expect(staticVoices(ProviderKinds.GOOGLE, 'gemini-3.8-flash-tts')[0]).toEqual({ id: 'Kore', name: 'Kore' });
    expect(staticVoices(ProviderKinds.OPENAI, 'tts-1').map((v) => v.id)).not.toContain('marin');
    expect(staticVoices(ProviderKinds.OPENAI, 'gpt-4o-mini-tts').map((v) => v.id)).toContain('marin');
    expect(staticVoices(ProviderKinds.DEEPGRAM, 'aura-2')[0]).toEqual({ id: 'thalia', name: 'Thalia' });
    expect(await listVoices(config(ProviderKinds.OPENAI), 'tts-1', { fetch: server.fetch })).toHaveLength(9);
    expect(server.requests).toHaveLength(0);
    expect(defaultVoice(ProviderKinds.GOOGLE, 'x')).toBe('Kore');
    expect(defaultVoice(ProviderKinds.MISTRAL, 'x')).toBe('');
    expect(defaultVoice(ProviderKinds.OPENAI, 'x')).toBe('alloy');
    expect(voiceName(ProviderKinds.ELEVENLABS, 'JBFqnCBsd6RMkjVDRZzb')).toBe('George');
    expect(voiceName(ProviderKinds.MISTRAL, '')).toBe('Default voice');
    expect(voiceName(ProviderKinds.OPENAI, 'nova')).toBe('Nova');
  });
});

describe('errors', () => {
  it('are friendly', async () => {
    server.json({ error: { message: 'Incorrect API key provided: sk-proj-abcdefghijkl' } }, 401);
    const e = await generateMedia(config(ProviderKinds.OPENAI), model('gpt-image-1', 'IMAGE'), { output: 'IMAGE', prompt: 'x' }, { fetch: server.fetch }).catch((x) => x);
    expect(e).toBeInstanceOf(LlmException);
    expect(e.error.kind).toBe('AUTH');
    expect(e.error.detail).not.toContain('abcdefghijkl');
  });

  it('a refused request on the website is explained as browser-blocked', async () => {
    useFakePlatform(true);
    const refuse: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const e = await generateMedia(config(ProviderKinds.BFL, 'https://api.test'), model('flux-2-pro', 'IMAGE'), { output: 'IMAGE', prompt: 'x' }, { fetch: refuse }).catch((x) => x);
    expect(e.error.kind).toBe('BROWSER_BLOCKED');
  });

  it('network failures and unreadable responses', async () => {
    const offline: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const e = await transcribeAudio(config(ProviderKinds.GROQ), model('whisper-large-v3', 'TRANSCRIPTION'), audio, 'audio/mp4', 'd.m4a', { fetch: offline }).catch((x) => x);
    expect(e.error.kind).toBe('NETWORK');

    server.enqueue(new Response('<html>oops</html>', { status: 200 }));
    const bad = await generateMedia(config(ProviderKinds.OPENAI), model('gpt-image-1', 'IMAGE'), { output: 'IMAGE', prompt: 'x' }, { fetch: server.fetch }).catch((x) => x);
    expect(bad).toBeInstanceOf(LlmException);
    expect(bad.error.kind).toBe('UNKNOWN');
  });

  it('unsupported outputs', async () => {
    const e = await generateMedia(config(ProviderKinds.OPENAI), model('whisper-1', 'TRANSCRIPTION'), { output: 'TRANSCRIPTION', prompt: 'x' }, { fetch: server.fetch }).catch((x) => x);
    expect(e.message).toBe("Facet can't make transcripts with OpenAI yet.");
  });
});

describe('helpers', () => {
  it('sniff, chunks and wav', () => {
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe('image/jpeg');
    expect(sniff(mp3)).toBe('audio/mpeg');
    expect(sniff(mp4)).toBe('video/mp4');
    expect(sniff(png)).toBe('image/png');
    expect(sniff(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]))).toBe('video/webm');
    expect(sniff(new Uint8Array([1, 2, 3]))).toBeNull();
    const parts = chunks('One. '.repeat(500), 1000);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join(' ').replace(/ /g, '')).toBe('One. '.repeat(500).trim().replace(/ /g, ''));
    expect(chunks('  short  ', 1000)).toEqual(['short']);
    const w = wav(new Uint8Array(10), 24000);
    expect(w.length).toBe(54);
    expect(sniff(w)).toBe('audio/wav');
  });
});
