/**
 * Picks the user's media models (or the best available ones) and runs them (port of
 * MediaService.kt): images, video, speech and music become synced attachments; speech also
 * powers Read aloud and transcription powers dictation. On the website, providers that refuse
 * browser requests are skipped by "Automatic", and choosing one explicitly fails with a clear message.
 */
import type { AttachmentStore } from '../../data/attachments';
import type { AttachmentEntity, ProviderEntity } from '../../data/entities';
import { mediaRef, type Aspect, type ModelRef, type SettingsStore } from '../../data/prefs';
import { canRun, preferredMedia } from '../../llm/media/catalog';
import { mediaExtension, type MediaFile } from '../../llm/media/files';
import {
  defaultVoice,
  generateMedia,
  listVoices,
  transcribeAudio,
  voiceName as friendlyVoiceName,
  type MediaJob,
  type Voice,
} from '../../llm/media/gen';
import { browserBlocked } from '../../llm/media/http';
import { LlmException, MODEL_OUTPUT_INFO, type ModelInfo, type ModelOutput, type ProviderConfig } from '../../llm/types';
import { platform } from '../../platform';

/** The kinds of media, in the order Settings → Media models lists them. */
export const MEDIA_OUTPUTS: readonly ModelOutput[] = ['IMAGE', 'VIDEO', 'SPEECH', 'MUSIC', 'TRANSCRIPTION'];

/** One provider as MediaService needs it. */
export interface MediaProviderEntry {
  provider: ProviderEntity;
  /** With the API key decrypted. */
  config: ProviderConfig;
  /** The provider's models (chat and media alike) with the user's edits applied, hidden ones left out. */
  models: ModelInfo[];
}

/** What MediaService needs from the provider repository. */
export interface MediaProviders {
  /** Enabled model providers (not deleted, not search providers). */
  list(): Promise<MediaProviderEntry[]>;
}

/** A media model ready to run. */
export interface MediaChoice {
  provider: ProviderEntity;
  config: ProviderConfig;
  model: ModelInfo;
  /** Chosen in Settings (rather than picked automatically). */
  explicit: boolean;
  ref: ModelRef;
  /** "GPT Image 1 · OpenAI". */
  label: string;
  /** On the website: the provider doesn't accept browser requests, so this model can't run here. */
  browserBlocked: boolean;
}

export interface MediaServiceDeps {
  providers: MediaProviders;
  settings: Pick<SettingsStore, 'synced'>;
  attachments: Pick<AttachmentStore, 'storeGenerated'>;
  /** Defaults to platform().fetch. */
  fetch?: typeof fetch;
}

export interface CreatedMedia {
  attachment: AttachmentEntity;
  model: ModelInfo;
  choice: MediaChoice;
}

const MAX_SPEECH_CACHE = 40 * 1024 * 1024;
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'with']);

/** "A fox in the snow, watercolor" → "fox-in-snow-watercolor.png". */
export function mediaFileName(prompt: string, output: ModelOutput, ext: string): string {
  const words = prompt.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !STOP_WORDS.has(w));
  const slug = words.join('-').slice(0, 40).replace(/-+$/, '') || MODEL_OUTPUT_INFO[output].noun;
  return `${slug}.${ext}`;
}

function isSearchKind(kindId: string): boolean {
  return kindId.startsWith('search.');
}

export class MediaService {
  /** Read-aloud audio by provider/model/voice/text, oldest first (Map keeps insertion order). */
  private speechCache = new Map<string, MediaFile>();
  private speechCacheBytes = 0;

  constructor(private readonly deps: MediaServiceDeps) {}

  private get fetch(): typeof fetch | undefined {
    return this.deps.fetch;
  }

  private get media() {
    return this.deps.settings.synced.media;
  }

  /** Every enabled, visible model that makes [output] (on the website, blocked ones are flagged, not removed). */
  async available(output: ModelOutput): Promise<MediaChoice[]> {
    const corsLimited = platform().corsLimited;
    const entries = await this.deps.providers.list();
    return entries
      .filter((e) => e.provider.enabled && !e.provider.deleted && !isSearchKind(e.provider.kind))
      .flatMap((e) =>
        e.models
          .filter((m) => m.output === output && canRun(e.config.kind, output))
          .map((model): MediaChoice => ({
            provider: e.provider,
            config: e.config,
            model,
            explicit: false,
            ref: { providerId: e.provider.id, modelId: model.id },
            label: `${model.displayName} · ${e.provider.label}`,
            browserBlocked: corsLimited && !e.config.kind.browserOk,
          })),
      );
  }

  /**
   * The model chosen in Settings, else the best available one (unless [explicitOnly]). "Automatic"
   * never picks a model this platform can't call; an explicit choice is returned as it is, and
   * running it explains why it can't run here.
   */
  async resolve(output: ModelOutput, explicitOnly = false): Promise<MediaChoice | null> {
    const all = await this.available(output);
    const ref = mediaRef(this.media, output);
    const chosen = ref && all.find((c) => c.provider.id === ref.providerId && c.model.id === ref.modelId);
    if (chosen) return { ...chosen, explicit: true };
    if (explicitOnly) return null;
    const usable = all.filter((c) => !c.browserBlocked);
    const best = preferredMedia(output, usable.map((c) => c.model));
    return best ? usable.find((c) => c.model === best) ?? null : null;
  }

  /** Voice for [choice]: the saved one if it belongs to this model, else the provider's default. */
  voiceFor(choice: MediaChoice): string {
    const m = this.media;
    if (m.voice != null && m.voiceFor === `${choice.provider.id}/${choice.model.id}`) return m.voice;
    return defaultVoice(choice.config.kind, choice.model.id);
  }

  /** A friendly name for [voice] of [choice] ("Default voice", "George", "Alloy"). */
  voiceName(choice: MediaChoice, voice: string): string {
    return friendlyVoiceName(choice.config.kind, voice);
  }

  voices(choice: MediaChoice, signal?: AbortSignal): Promise<Voice[]> {
    return listVoices(choice.config, choice.model.id, { fetch: this.fetch, signal });
  }

  /**
   * Makes a picture, video, voice clip or song and stores it as an attachment of [conversationId].
   * [onProgress] reports long jobs ("Creating video · 1:20"); aborting [signal] stops them.
   */
  async create(
    output: ModelOutput,
    prompt: string,
    conversationId: string,
    aspect: Aspect | null = null,
    seconds: number | null = null,
    onProgress: (label: string) => void = () => {},
    signal?: AbortSignal,
  ): Promise<CreatedMedia> {
    const info = MODEL_OUTPUT_INFO[output];
    const choice = await this.resolve(output);
    if (!choice) {
      throw new LlmException({
        kind: 'BAD_REQUEST',
        message: `No ${info.noun} model is set up. Add a provider that makes ${info.what} in Settings → Media models.`,
      });
    }
    if (choice.browserBlocked) throw browserBlocked(choice.config);
    const prefs = this.media;
    const job: MediaJob = {
      output,
      prompt,
      aspect: aspect ?? (output === 'VIDEO' ? prefs.videoAspect : prefs.imageAspect),
      seconds: seconds ?? (output === 'MUSIC' ? prefs.musicSeconds : null),
      voice: output === 'SPEECH' ? this.voiceFor(choice) : null,
    };
    const file = await generateMedia(choice.config, choice.model, job, { fetch: this.fetch, signal, onProgress });
    const name = mediaFileName(prompt, output, mediaExtension(file.mimeType));
    const attachment = await this.deps.attachments.storeGenerated(file.bytes, file.mimeType, name, conversationId);
    return { attachment, model: choice.model, choice };
  }

  /** True when Read aloud should use the speech model chosen in Settings. */
  async readAloudAvailable(): Promise<boolean> {
    return this.media.aiReadAloud && (await this.resolve('SPEECH', true)) != null;
  }

  /**
   * Speaks [text] with the speech model chosen in Settings, caching the audio per text and voice.
   * Null when no speech model is chosen or AI read-aloud is off (callers fall back to the system voice).
   */
  async speak(text: string, signal?: AbortSignal): Promise<MediaFile | null> {
    if (!this.media.aiReadAloud) return null;
    const choice = await this.resolve('SPEECH', true);
    if (!choice) return null;
    if (choice.browserBlocked) throw browserBlocked(choice.config);
    const voice = this.voiceFor(choice);
    const key = `${choice.provider.id}/${choice.model.id}/${voice}/${text}`;
    const cached = this.speechCache.get(key);
    if (cached) {
      // Refresh its place so the clips used most stay cached.
      this.speechCache.delete(key);
      this.speechCache.set(key, cached);
      return cached;
    }
    const file = await generateMedia(choice.config, choice.model, { output: 'SPEECH', prompt: text, voice }, { fetch: this.fetch, signal });
    this.remember(key, file);
    return file;
  }

  private remember(key: string, file: MediaFile) {
    this.speechCache.set(key, file);
    this.speechCacheBytes += file.bytes.length;
    for (const [k, f] of this.speechCache) {
      if (this.speechCacheBytes <= MAX_SPEECH_CACHE || k === key) break;
      this.speechCache.delete(k);
      this.speechCacheBytes -= f.bytes.length;
    }
  }

  /** True when dictation should use the transcription model chosen in Settings. */
  async dictationAvailable(): Promise<boolean> {
    return this.media.aiDictation && (await this.resolve('TRANSCRIPTION', true)) != null;
  }

  /** Writes down a recording (e.g. MediaRecorder's audio/webm) with the transcription model chosen in Settings. */
  async transcribe(audio: Blob, signal?: AbortSignal): Promise<string> {
    const choice = await this.resolve('TRANSCRIPTION', true);
    if (!choice) throw new LlmException({ kind: 'BAD_REQUEST', message: 'Choose a transcription model in Settings → Media models.' });
    if (choice.browserBlocked) throw browserBlocked(choice.config);
    const mimeType = audio.type || 'audio/webm';
    const ext = mediaExtension(mimeType);
    return transcribeAudio(choice.config, choice.model, audio, mimeType, `dictation.${ext === 'bin' ? 'webm' : ext}`, { fetch: this.fetch, signal });
  }
}
