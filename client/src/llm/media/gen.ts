/**
 * Runs media models over each provider's own API (port of MediaGen.kt): images, video, speech,
 * music and transcription. Long jobs (Veo video, FLUX) are polled; everything returns plain bytes
 * ready to store as an attachment. Audio stays in the format the provider sends (raw PCM becomes
 * WAV); the sync layer compresses WAV itself, so there's no re-encoding here.
 */
import { isObject } from '../../core/json';
import { msg, sentences, t, type Msg } from '../../i18n';
import type { Aspect } from '../../data/prefs';
import { HttpStatusError } from '../errors';
import { ProviderKinds, type ProviderKind } from '../providers';
import { LlmException, type ModelInfo, type ModelOutput, type ProviderConfig } from '../types';
import { chunks, concatParts, fileFromBase64, fileFromDataUrl, normalizeAudio, type MediaFile } from './files';
import {
  delay,
  download,
  failure,
  guard,
  requestBytes,
  requestJson,
  requestJsonValue,
  resolveFetch,
  SHORT_TIMEOUT_MS,
  trimBaseUrl,
  type Http,
  type Json,
} from './http';

export type { Aspect } from '../../data/prefs';
export type { MediaFile } from './files';
export { chunks, mediaExtension, sniff, wav } from './files';
export { mediaHeaders } from './http';

/** Shapes of a picture or video, in the order the settings screen shows them. */
export const ASPECTS: readonly Aspect[] = ['SQUARE', 'PORTRAIT', 'LANDSCAPE'];
/** `label` is shown with tm(). */
export const ASPECT_INFO: Record<Aspect, { label: Msg; ratio: string }> = {
  SQUARE: { label: msg('Square'), ratio: '1:1' },
  PORTRAIT: { label: msg('Portrait'), ratio: '9:16' },
  LANDSCAPE: { label: msg('Landscape'), ratio: '16:9' },
};

/** What to make. [seconds] applies to video and music; [voice] to speech. */
export interface MediaJob {
  output: ModelOutput;
  prompt: string;
  aspect?: Aspect | null;
  seconds?: number | null;
  voice?: string | null;
}

export interface Voice {
  id: string;
  name: string;
}

export interface MediaCallOptions {
  /** Defaults to platform().fetch (subject to CORS on the website). */
  fetch?: typeof fetch;
  /** Stops the request (and any polling); the promise then rejects with an AbortError. */
  signal?: AbortSignal;
  /** Progress for long jobs, e.g. "Creating video · 1:20". */
  onProgress?: (label: string) => void;
}

/** Polled jobs give up after this long. */
export const MAX_POLL_MS = 15 * 60_000;
const FLUX_POLL_MS = 1_500;
const VEO_POLL_MS = 8_000;

const ELEVEN_DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const GEMINI_VOICES = [
  'Kore', 'Puck', 'Zephyr', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus',
  'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam',
  'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

interface Ctx extends Http {
  base: string;
  onProgress: (label: string) => void;
}

function context(config: ProviderConfig, options: MediaCallOptions): Ctx {
  return {
    config,
    fetch: resolveFetch(options.fetch),
    signal: options.signal,
    base: trimBaseUrl(config.baseUrl),
    onProgress: options.onProgress ?? (() => {}),
  };
}

const is = (config: ProviderConfig, kind: ProviderKind) => config.kind.id === kind.id;
const s = (x: unknown, k: string): string | null => (isObject(x) && typeof x[k] === 'string' ? (x[k] as string) : null);
const o = (x: unknown, k: string): Json | null => (isObject(x) && isObject(x[k]) ? (x[k] as Json) : null);
const a = (x: unknown, k: string): unknown[] => (isObject(x) && Array.isArray(x[k]) ? (x[k] as unknown[]) : []);
const titlecase = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

function unsupportedMessage(provider: string, output: ModelOutput): string {
  switch (output) {
    case 'TEXT': return t('Facet can\'t chat with {provider} yet.', { provider });
    case 'IMAGE': return t('Facet can\'t make images with {provider} yet.', { provider });
    case 'VIDEO': return t('Facet can\'t make video with {provider} yet.', { provider });
    case 'SPEECH': return t('Facet can\'t make speech with {provider} yet.', { provider });
    case 'MUSIC': return t('Facet can\'t make music with {provider} yet.', { provider });
    case 'TRANSCRIPTION': return t('Facet can\'t make transcripts with {provider} yet.', { provider });
  }
}

function unsupported(config: ProviderConfig, output: ModelOutput): never {
  throw new LlmException({ kind: 'BAD_REQUEST', message: unsupportedMessage(config.label, output) });
}

/** The provider answered without the image, video or audio it was asked for. */
function noResult(config: ProviderConfig, type: string, status?: string | null): LlmException {
  const provider = config.label;
  const none = type === 'image' ? t('{provider} returned no image.', { provider })
    : type === 'video' ? t('{provider} returned no video.', { provider })
      : t('{provider} returned no audio.', { provider });
  return failure(status ? sentences(none, t('Status: {status}.', { status })) : none);
}

// ------------------------------------------------------------------ public API

/** Makes an image, video, voice clip or song. Failures throw LlmException (aborts throw AbortError). */
export function generateMedia(
  config: ProviderConfig,
  model: Pick<ModelInfo, 'id'>,
  job: MediaJob,
  options: MediaCallOptions = {},
): Promise<MediaFile> {
  const ctx = context(config, options);
  return guard(config, model.id, async () => {
    switch (job.output) {
      case 'IMAGE': return image(ctx, model.id, job);
      case 'VIDEO': return video(ctx, model.id, job);
      case 'SPEECH': return speech(ctx, model.id, job.prompt, job.voice ?? defaultVoice(config.kind, model.id));
      case 'MUSIC': return music(ctx, model.id, job);
      default: return unsupported(config, job.output);
    }
  });
}

/** Speech to text. [audio] is the recording; [fileName]'s extension tells some APIs its format. */
export function transcribeAudio(
  config: ProviderConfig,
  model: Pick<ModelInfo, 'id'>,
  audio: Uint8Array | Blob,
  mimeType: string,
  fileName: string,
  options: Pick<MediaCallOptions, 'fetch' | 'signal'> = {},
): Promise<string> {
  const ctx = context(config, options);
  const blob = audio instanceof Blob ? audio : new Blob([audio.slice()], { type: mimeType });
  return guard(config, model.id, async () => {
    let text: string;
    if (is(config, ProviderKinds.ELEVENLABS)) {
      const form = new FormData();
      form.append('model_id', model.id);
      form.append('file', blob, fileName);
      text = s(await requestJson(ctx, `${ctx.base}/v1/speech-to-text`, { body: form }), 'text') ?? '';
    } else if (is(config, ProviderKinds.DEEPGRAM)) {
      const url = new URL(`${ctx.base}/v1/listen`);
      url.searchParams.set('model', model.id);
      url.searchParams.set('smart_format', 'true');
      const res = await requestJson(ctx, url.toString(), { body: blob, headers: { 'Content-Type': mimeType } });
      const channel = a(o(res, 'results'), 'channels')[0];
      text = s(a(channel, 'alternatives')[0], 'transcript') ?? '';
    } else {
      const form = new FormData();
      form.append('model', model.id);
      form.append('file', blob, fileName);
      text = s(await requestJson(ctx, `${ctx.base}/audio/transcriptions`, { body: form }), 'text') ?? '';
    }
    return text.trim();
  });
}

/** Voices a speech model can use; the first is the default. Never throws: falls back to built-in lists. */
export async function listVoices(config: ProviderConfig, modelId: string, options: Pick<MediaCallOptions, 'fetch' | 'signal'> = {}): Promise<Voice[]> {
  const ctx = { ...context(config, options), timeoutMs: SHORT_TIMEOUT_MS };
  if (is(config, ProviderKinds.ELEVENLABS)) {
    let voices: Voice[] = [];
    try {
      const res = await requestJson(ctx, `${ctx.base}/v1/voices`);
      voices = a(res, 'voices').flatMap((v) => {
        const id = s(v, 'voice_id');
        return id ? [{ id, name: s(v, 'name') ?? id }] : [];
      });
    } catch {
      // Offline or a key without voice access: the default voice still works.
    }
    return voices.length > 0 ? voices : staticVoices(config.kind, modelId);
  }
  if (is(config, ProviderKinds.MISTRAL)) {
    // Mistral voices are the ones saved (or cloned) in your Mistral account; "" lets Mistral pick.
    let saved: Voice[] = [];
    try {
      const res = await requestJsonValue(ctx, `${ctx.base}/audio/voices`);
      const items = Array.isArray(res) ? res : [a(res, 'data'), a(res, 'voices'), a(res, 'items')].find((l) => l.length > 0) ?? [];
      saved = items.flatMap((v) => {
        const id = s(v, 'id') ?? s(v, 'voice_id');
        return id ? [{ id, name: s(v, 'name') ?? id }] : [];
      });
    } catch {
      // Only the default voice then.
    }
    return [{ id: '', name: t('Default voice') }, ...saved];
  }
  return staticVoices(config.kind, modelId);
}

export function staticVoices(kind: ProviderKind, modelId: string): Voice[] {
  switch (kind.id) {
    case ProviderKinds.GOOGLE.id:
      return GEMINI_VOICES.map((v) => ({ id: v, name: v }));
    case ProviderKinds.DEEPGRAM.id:
      return ['thalia', 'andromeda', 'helena', 'apollo', 'arcas', 'aries'].map((v) => ({ id: v, name: titlecase(v) }));
    case ProviderKinds.ELEVENLABS.id:
      return [{ id: ELEVEN_DEFAULT_VOICE, name: 'George' }];
    default: {
      const extra = modelId.startsWith('gpt-') ? ['ballad', 'verse', 'marin', 'cedar'] : [];
      return ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', ...extra].map((v) => ({ id: v, name: titlecase(v) }));
    }
  }
}

export function defaultVoice(kind: ProviderKind, _modelId: string): string {
  switch (kind.id) {
    case ProviderKinds.GOOGLE.id: return 'Kore';
    case ProviderKinds.ELEVENLABS.id: return ELEVEN_DEFAULT_VOICE;
    case ProviderKinds.DEEPGRAM.id: return 'thalia';
    case ProviderKinds.MISTRAL.id: return '';
    default: return 'alloy';
  }
}

/** Voice ids are opaque for some providers (ElevenLabs); a friendly name when we know one. */
export function voiceName(kind: ProviderKind, voice: string): string {
  if (!voice.trim()) return t('Default voice');
  if (kind.id === ProviderKinds.ELEVENLABS.id && voice === ELEVEN_DEFAULT_VOICE) return 'George';
  return titlecase(voice);
}

// ------------------------------------------------------------------ images

function aspectOf(job: MediaJob): Aspect {
  return job.aspect ?? 'SQUARE';
}

async function image(ctx: Ctx, id: string, job: MediaJob): Promise<MediaFile> {
  const { config } = ctx;
  const aspect = aspectOf(job);
  if (is(config, ProviderKinds.GOOGLE)) return interaction(ctx, id, job.prompt, 'image', { aspect_ratio: ASPECT_INFO[aspect].ratio });
  if (is(config, ProviderKinds.OPENROUTER)) return openRouterImage(ctx, id, job);
  if (is(config, ProviderKinds.STABILITY)) return stabilityImage(ctx, id, job);
  if (is(config, ProviderKinds.BFL)) return fluxImage(ctx, id, job);
  const body: Json = { model: id, prompt: job.prompt, n: 1 };
  if (is(config, ProviderKinds.XAI)) {
    body.response_format = 'b64_json';
  } else if (is(config, ProviderKinds.TOGETHER)) {
    const [w, h] = aspect === 'SQUARE' ? [1024, 1024] : aspect === 'PORTRAIT' ? [768, 1344] : [1344, 768];
    Object.assign(body, { width: w, height: h, response_format: 'base64' });
  } else {
    body.size = openAiSize(id, aspect);
    // GPT Image models always return base64 and reject response_format.
    if (!id.startsWith('gpt-image') && !id.startsWith('chatgpt-image')) body.response_format = 'b64_json';
  }
  const res = await requestJson(ctx, `${ctx.base}/images/generations`, { json: body });
  const first = a(res, 'data')[0];
  if (!isObject(first)) throw noResult(config, 'image');
  const b64 = s(first, 'b64_json');
  if (b64) return fileFromBase64(b64, null);
  const url = s(first, 'url');
  if (url) return download(ctx, url, null, false);
  throw noResult(config, 'image');
}

function openAiSize(id: string, aspect: Aspect): string {
  if (id.startsWith('dall-e-2')) return '1024x1024';
  if (id.startsWith('dall-e-3')) return aspect === 'SQUARE' ? '1024x1024' : aspect === 'PORTRAIT' ? '1024x1792' : '1792x1024';
  return aspect === 'SQUARE' ? '1024x1024' : aspect === 'PORTRAIT' ? '1024x1536' : '1536x1024';
}

async function openRouterImage(ctx: Ctx, id: string, job: MediaJob): Promise<MediaFile> {
  const body = {
    model: id,
    messages: [{ role: 'user', content: job.prompt }],
    modalities: ['image', 'text'],
    image_config: { aspect_ratio: ASPECT_INFO[aspectOf(job)].ratio },
  };
  const res = await requestJson(ctx, `${ctx.base}/chat/completions`, { json: body });
  const message = o(a(res, 'choices')[0], 'message');
  const url = s(o(a(message, 'images')[0], 'image_url'), 'url');
  if (!url) {
    const said = s(message, 'content')?.trim() ? s(message, 'content')!.slice(0, 200) : '';
    const provider = ctx.config.label;
    throw failure(said
      ? t('{provider} didn\'t return an image: {reason}.', { provider, reason: said })
      : t('{provider} didn\'t return an image.', { provider }));
  }
  return url.startsWith('data:') ? fileFromDataUrl(url) : download(ctx, url, null, false);
}

async function stabilityImage(ctx: Ctx, id: string, job: MediaJob): Promise<MediaFile> {
  const endpoint = id === 'stable-image-ultra' ? 'ultra' : id === 'stable-image-core' ? 'core' : 'sd3';
  const form = new FormData();
  form.append('prompt', job.prompt);
  form.append('output_format', 'png');
  form.append('aspect_ratio', ASPECT_INFO[aspectOf(job)].ratio);
  if (endpoint === 'sd3') form.append('model', id);
  return requestBytes(ctx, `${ctx.base}/v2beta/stable-image/generate/${endpoint}`, { body: form, headers: { Accept: 'image/*' } });
}

async function fluxImage(ctx: Ctx, id: string, job: MediaJob): Promise<MediaFile> {
  const { config } = ctx;
  const aspect = aspectOf(job);
  const body: Json = { prompt: job.prompt };
  if (id.startsWith('flux-2')) {
    const [w, h] = aspect === 'SQUARE' ? [1024, 1024] : aspect === 'PORTRAIT' ? [768, 1360] : [1360, 768];
    Object.assign(body, { width: w, height: h });
  } else {
    body.aspect_ratio = ASPECT_INFO[aspect].ratio;
  }
  const start = await requestJson(ctx, `${ctx.base}/v1/${id}`, { json: body });
  const taskId = s(start, 'id');
  const pollUrl = s(start, 'polling_url') ?? (taskId ? `${ctx.base}/v1/get_result?id=${encodeURIComponent(taskId)}` : null);
  if (!pollUrl) throw failure(t('{provider} didn\'t start the image.', { provider: config.label }));
  const began = Date.now();
  while (Date.now() - began < MAX_POLL_MS) {
    await delay(FLUX_POLL_MS, ctx.signal);
    const res = await requestJson(ctx, pollUrl);
    const status = s(res, 'status');
    if (status === 'Ready') {
      const sample = s(o(res, 'result'), 'sample');
      if (!sample) throw noResult(config, 'image');
      // The sample is a pre-signed URL: sending the key along would leak it to the CDN.
      return download(ctx, sample, null, false);
    }
    if (status !== null && status !== 'Pending' && status !== 'Queued' && status !== 'Processing') {
      throw failure(t('{provider} couldn\'t make that image ({status}).', { provider: config.label, status }));
    }
  }
  throw failure(t('{provider} took too long to make the image.', { provider: config.label }));
}

// ------------------------------------------------------------------ video

async function video(ctx: Ctx, id: string, job: MediaJob): Promise<MediaFile> {
  const { config } = ctx;
  if (!is(config, ProviderKinds.GOOGLE)) unsupported(config, 'VIDEO');
  const aspect = job.aspect === 'PORTRAIT' ? '9:16' : '16:9';
  if (!id.startsWith('veo')) {
    ctx.onProgress(t('Creating video'));
    return interaction(ctx, id, job.prompt, 'video', { aspect_ratio: aspect });
  }
  // Veo: a long-running operation, polled until done.
  const native = geminiNative(ctx);
  const body = { instances: [{ prompt: job.prompt }], parameters: { aspectRatio: aspect } };
  const op = await requestJson(ctx, `${native}/models/${id}:predictLongRunning`, { json: body });
  const name = s(op, 'name');
  if (!name) throw failure(t('{provider} didn\'t start the video.', { provider: config.label }));
  const began = Date.now();
  while (Date.now() - began < MAX_POLL_MS) {
    await delay(VEO_POLL_MS, ctx.signal);
    const elapsed = Math.floor((Date.now() - began) / 1000);
    ctx.onProgress(t('Creating video · {time}', { time: `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` }));
    const res = await requestJson(ctx, `${native}/${name}`);
    const error = o(res, 'error');
    if (error) {
      const reason = s(error, 'message');
      throw failure(reason
        ? t('{provider} couldn\'t make that video: {reason}', { provider: config.label, reason })
        : t('{provider} couldn\'t make that video.', { provider: config.label }));
    }
    if (res.done === true || res.done === 'true') {
      const sample = a(o(o(res, 'response'), 'generateVideoResponse'), 'generatedSamples')[0];
      const uri = s(o(sample, 'video'), 'uri');
      if (!uri) throw failure(t('{provider} finished without a video (it may have been filtered).', { provider: config.label }));
      return download(ctx, uri, 'video/mp4', true);
    }
  }
  throw failure(t('{provider} took too long to make the video.', { provider: config.label }));
}

// ------------------------------------------------------------------ speech

async function speech(ctx: Ctx, id: string, text: string, voice: string): Promise<MediaFile> {
  const { config, base } = ctx;
  if (is(config, ProviderKinds.GOOGLE)) {
    const body = {
      model: id,
      input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
      store: false,
    };
    return interactionResult(ctx, body, 'audio');
  }
  if (is(config, ProviderKinds.ELEVENLABS)) {
    const url = `${base}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`;
    return concatParts(chunks(text, 4_500), (part) => requestBytes(ctx, url, { json: { text: part, model_id: id } }));
  }
  if (is(config, ProviderKinds.MISTRAL)) {
    return concatParts(chunks(text, 4_000), async (part) => {
      const body: Json = { model: id, input: part, response_format: 'mp3' };
      if (voice.trim()) body.voice_id = voice;
      const res = await requestJson(ctx, `${base}/audio/speech`, { json: body });
      const data = s(res, 'audio_data');
      if (!data) throw noResult(config, 'audio');
      return fileFromBase64(data, 'audio/mpeg');
    });
  }
  if (is(config, ProviderKinds.DEEPGRAM)) {
    const url = new URL(`${base}/v1/speak`);
    url.searchParams.set('model', `${id}-${voice}-en`);
    url.searchParams.set('encoding', 'mp3');
    return concatParts(chunks(text, 1_900), (part) => requestBytes(ctx, url.toString(), { json: { text: part } }));
  }
  return concatParts(chunks(text, 4_000), (part) =>
    requestBytes(ctx, `${base}/audio/speech`, { json: { model: id, input: part, voice, response_format: 'mp3' } }),
  );
}

// ------------------------------------------------------------------ music

async function music(ctx: Ctx, id: string, job: MediaJob): Promise<MediaFile> {
  const { config, base } = ctx;
  const seconds = Math.min(600, Math.max(3, Math.round(job.seconds ?? 30)));
  if (is(config, ProviderKinds.ELEVENLABS)) {
    if (id === 'sound_effects') {
      return requestBytes(ctx, `${base}/v1/sound-generation`, { json: { text: job.prompt, duration_seconds: Math.min(seconds, 30) } });
    }
    const body = { prompt: job.prompt, music_length_ms: seconds * 1000, model_id: id };
    return requestBytes(ctx, `${base}/v1/music?output_format=mp3_44100_128`, { json: body });
  }
  if (is(config, ProviderKinds.STABILITY)) {
    const form = new FormData();
    form.append('prompt', job.prompt);
    form.append('duration', String(Math.min(seconds, 190)));
    form.append('model', id);
    form.append('output_format', 'mp3');
    return requestBytes(ctx, `${base}/v2beta/audio/stable-audio-2/text-to-audio`, { body: form, headers: { Accept: 'audio/*' } });
  }
  if (is(config, ProviderKinds.GOOGLE)) {
    const prompt = job.seconds != null ? `${job.prompt}\n\nLength: about ${seconds} seconds.` : job.prompt;
    return interaction(ctx, id, prompt, 'audio', {});
  }
  return unsupported(config, 'MUSIC');
}

// ------------------------------------------------------------------ Gemini Interactions API

function geminiNative(ctx: Ctx): string {
  return ctx.base.replace(/\/openai$/, '');
}

async function interaction(ctx: Ctx, model: string, prompt: string, type: string, format: Json): Promise<MediaFile> {
  try {
    return await interactionResult(ctx, { model, input: prompt, response_format: { type, ...format }, store: false }, type);
  } catch (e) {
    // Some models reject an option (e.g. an aspect ratio); retry once with the plain request.
    if (!(e instanceof HttpStatusError) || e.status !== 400) throw e;
    return interactionResult(ctx, { model, input: prompt, response_format: { type }, store: false }, type);
  }
}

async function interactionResult(ctx: Ctx, body: Json, type: string): Promise<MediaFile> {
  const { config } = ctx;
  const native = geminiNative(ctx);
  const res = await requestJson(ctx, `${native}/interactions`, { json: body });
  const error = a(res, 'errors')[0];
  if (isObject(error)) {
    const reason = s(error, 'message');
    throw failure(reason
      ? t('{provider} couldn\'t make that: {reason}', { provider: config.label, reason })
      : t('{provider} couldn\'t make that.', { provider: config.label }));
  }
  const blocks = a(res, 'steps').flatMap((step) => a(step, 'content')).filter((b) => s(b, 'type') === type);
  const block = blocks[blocks.length - 1];
  if (!block) {
    const status = s(res, 'status');
    throw noResult(config, type, status);
  }
  const mime = s(block, 'mime_type');
  const data = s(block, 'data');
  if (data) return normalizeAudio(fileFromBase64(data, mime));
  const uri = s(block, 'uri');
  if (!uri) throw noResult(config, type);
  const url = uri.startsWith('http') ? uri : `${native}/${uri}:download?alt=media`;
  return normalizeAudio(await download(ctx, url, mime, true));
}
