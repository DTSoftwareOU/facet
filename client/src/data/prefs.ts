/**
 * Preferences (port of Settings.kt). LocalPrefs stay on this device; SyncedPrefs follow the account
 * as the end-to-end encrypted "settings" record. Both notify other open tabs of changes.
 */
import { defaultParams, type GenParams, type ModelOutput } from '../llm/types';
import { db } from './db';

export type ThemeMode = 'SYSTEM' | 'LIGHT' | 'DARK' | 'BLACK';
export type Aspect = 'SQUARE' | 'LANDSCAPE' | 'PORTRAIT';
export type ToolApprovalName = 'ALWAYS' | 'WRITES' | 'NEVER';

/** Device-local preferences (not synced). */
export interface LocalPrefs {
  theme: ThemeMode;
  chatTextScale: number;
  reducedMotion: boolean;
  sendOnEnter: boolean;
  showUsage: boolean;
  showCost: boolean;
  expandThinking: boolean;
  notifyOnComplete: boolean;
  pricingFeed: boolean;
  onboardingDone: boolean;
  /** Model used for the next new chat when no assistant default applies. */
  lastProviderId: string | null;
  lastModelId: string | null;
  sidebarOpen: boolean;
  /** Windows app: let models use this computer (commands and files). */
  computerTools: boolean;
  /** Windows app: when computer tools ask first. WRITES = commands and file changes. */
  computerApproval: ToolApprovalName;
  /** Windows app: the folder new chats work in (empty = the default). */
  defaultWorkspace: string;
}

export const DEFAULT_LOCAL: LocalPrefs = {
  theme: 'SYSTEM',
  chatTextScale: 1,
  reducedMotion: false,
  sendOnEnter: true,
  showUsage: true,
  showCost: true,
  expandThinking: false,
  notifyOnComplete: true,
  pricingFeed: true,
  onboardingDone: false,
  lastProviderId: null,
  lastModelId: null,
  sidebarOpen: true,
  computerTools: true,
  computerApproval: 'WRITES',
  defaultWorkspace: '',
};

/** A model reference: a configured provider plus a model id. */
export interface ModelRef {
  providerId: string;
  modelId: string;
}

/** Preferred media models and their options. A null model means "pick the best available". */
export interface MediaPrefs {
  image?: ModelRef | null;
  video?: ModelRef | null;
  speech?: ModelRef | null;
  music?: ModelRef | null;
  transcription?: ModelRef | null;
  /** Voice for speech; voiceFor is the "providerId/modelId" it belongs to, so a stale voice isn't sent elsewhere. */
  voice?: string | null;
  voiceFor?: string | null;
  imageAspect: Aspect;
  videoAspect: Aspect;
  musicSeconds: number;
  /** Chat models may call the generate_* tools. */
  chatTools: boolean;
  /** Read aloud uses the chosen speech model instead of the system voice. */
  aiReadAloud: boolean;
  /** Dictation uses the chosen transcription model. */
  aiDictation: boolean;
}

export function defaultMedia(over: Partial<MediaPrefs> = {}): MediaPrefs {
  return { imageAspect: 'SQUARE', videoAspect: 'LANDSCAPE', musicSeconds: 30, chatTools: true, aiReadAloud: true, aiDictation: true, ...over };
}

export function mediaRef(m: MediaPrefs, output: ModelOutput): ModelRef | null {
  switch (output) {
    case 'IMAGE': return m.image ?? null;
    case 'VIDEO': return m.video ?? null;
    case 'SPEECH': return m.speech ?? null;
    case 'MUSIC': return m.music ?? null;
    case 'TRANSCRIPTION': return m.transcription ?? null;
    default: return null;
  }
}

export function withMediaRef(m: MediaPrefs, output: ModelOutput, ref: ModelRef | null): MediaPrefs {
  switch (output) {
    case 'IMAGE': return { ...m, image: ref };
    case 'VIDEO': return { ...m, video: ref };
    case 'SPEECH': return { ...m, speech: ref };
    case 'MUSIC': return { ...m, music: ref };
    case 'TRANSCRIPTION': return { ...m, transcription: ref };
    default: return m;
  }
}

/** Preferences that follow the account across devices (synced as the "settings" record). */
export interface SyncedPrefs {
  /** Display name. Kept here (end-to-end encrypted) instead of on the sync server. */
  profileName: string;
  aboutMe: string;
  responseStyle: string;
  customInstructionsEnabled: boolean;
  defaultModel?: ModelRef | null;
  defaultParams: GenParams;
  titleModel?: ModelRef | null;
  autoTitle: boolean;
  /** Use the model's own web search when it has one; otherwise Facet's search tool. */
  preferNativeSearch: boolean;
  /** YOLO mode: run every tool call without asking, and let the model take more tool rounds. */
  yoloMode: boolean;
  media: MediaPrefs;
  /** When sync storage is full, remove the cloud copies of the oldest files; devices that have them keep them. */
  autoFreeSpace: boolean;
  updatedAt: number;
  /** Fields written by newer app versions are kept as they are. */
  [extra: string]: unknown;
}

export function defaultSynced(): SyncedPrefs {
  return {
    profileName: '',
    aboutMe: '',
    responseStyle: '',
    customInstructionsEnabled: true,
    defaultModel: null,
    defaultParams: defaultParams(),
    titleModel: null,
    autoTitle: true,
    preferNativeSearch: true,
    yoloMode: false,
    media: defaultMedia(),
    autoFreeSpace: true,
    updatedAt: 0,
  };
}

/** Fills defaults into settings decoded from any app version (unknown fields are kept). */
export function normalizeSynced(raw: unknown): SyncedPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const base = defaultSynced();
  return {
    ...base,
    ...r,
    defaultParams: defaultParams((r.defaultParams as object) ?? {}),
    media: defaultMedia((r.media as object) ?? {}),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  } as SyncedPrefs;
}

type Listener = () => void;

const LOCAL_KEY = 'facet.local.v1';
const SYNCED_KEY = 'synced_prefs';
const SYNCED_DIRTY_KEY = 'synced_dirty';

/** Holds both preference sets in memory for synchronous reads; persists and broadcasts changes. */
export class SettingsStore {
  private localValue: LocalPrefs;
  private syncedValue: SyncedPrefs = defaultSynced();
  private dirty = false;
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  /** Invoked after the user changes synced prefs, so the sync engine can push them. */
  onSyncedChanged: (() => void) | null = null;

  constructor() {
    this.localValue = readLocal();
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('facet-prefs');
      this.channel.onmessage = () => {
        this.localValue = readLocal();
        void this.load().then(() => this.emit());
      };
    }
  }

  /** Loads synced prefs from the database. Call once at startup. */
  async load(): Promise<void> {
    const raw = await db().getKv<unknown>(SYNCED_KEY, null);
    this.syncedValue = raw ? normalizeSynced(raw) : defaultSynced();
    this.dirty = await db().getKv<boolean>(SYNCED_DIRTY_KEY, false);
    this.emit();
  }

  get local(): LocalPrefs {
    return this.localValue;
  }

  get synced(): SyncedPrefs {
    return this.syncedValue;
  }

  get syncedDirty(): boolean {
    return this.dirty;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  private broadcast() {
    this.channel?.postMessage('changed');
  }

  updateLocal(transform: (p: LocalPrefs) => LocalPrefs): void {
    this.localValue = transform(this.localValue);
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(this.localValue));
    } catch {
      // Private mode or storage disabled: keep the value for this session.
    }
    this.emit();
    this.broadcast();
  }

  async updateSynced(transform: (p: SyncedPrefs) => SyncedPrefs): Promise<void> {
    this.syncedValue = { ...transform(this.syncedValue), updatedAt: Date.now() };
    this.dirty = true;
    this.emit();
    await db().transaction('rw', db().kv, async () => {
      await db().setKv(SYNCED_KEY, this.syncedValue);
      await db().setKv(SYNCED_DIRTY_KEY, true);
    });
    this.broadcast();
    this.onSyncedChanged?.();
  }

  /** Applies a remote copy (from sync). Returns false if the local copy is newer. */
  async applyRemoteSynced(remote: SyncedPrefs): Promise<boolean> {
    if (remote.updatedAt < this.syncedValue.updatedAt) return false;
    this.syncedValue = remote;
    this.dirty = false;
    await db().setKv(SYNCED_KEY, remote);
    await db().setKv(SYNCED_DIRTY_KEY, false);
    this.emit();
    this.broadcast();
    return true;
  }

  async markSyncedClean(updatedAt: number): Promise<void> {
    if (this.syncedValue.updatedAt !== updatedAt) return;
    this.dirty = false;
    await db().setKv(SYNCED_DIRTY_KEY, false);
  }

  async markSyncedDirty(): Promise<void> {
    this.dirty = true;
    await db().setKv(SYNCED_DIRTY_KEY, true);
  }

  async resetSynced(): Promise<void> {
    this.syncedValue = defaultSynced();
    this.dirty = false;
    await db().kv.bulkDelete([SYNCED_KEY, SYNCED_DIRTY_KEY]);
    this.emit();
    this.broadcast();
  }
}

function readLocal(): LocalPrefs {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return { ...DEFAULT_LOCAL, ...JSON.parse(raw) };
  } catch {
    // Unavailable or corrupt: defaults.
  }
  return { ...DEFAULT_LOCAL };
}
