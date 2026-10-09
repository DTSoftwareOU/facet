/** Configured providers, their keys and models (port of ProviderRepository.kt). */
import { fromUtf8, utf8 } from '../core/bytes';
import { newId } from '../core/ids';
import { parseJson } from '../core/json';
import { createLlmClient } from '../llm/clients';
import { normalizeBaseUrl, providerKind, type ProviderKind } from '../llm/providers';
import {
  normalizeCaps,
  normalizeModel,
  type LlmClient,
  type ModelCaps,
  type ModelInfo,
  type ModelOutput,
  type ModelPricing,
  type ProviderConfig,
  type QuirkStore,
} from '../llm/types';
import { platform } from '../platform';
import { isSearchKind, searchKind } from '../tools/types';
import { db } from './db';
import type { ProviderEntity } from './entities';

/** The user's edits to one model, synced end-to-end encrypted with its provider. Null keeps the provider's value. */
export interface ModelPrefs {
  name?: string | null;
  hidden?: boolean;
  caps?: ModelCaps | null;
  contextWindow?: number | null;
  maxOutput?: number | null;
  pricing?: ModelPricing | null;
  /** Corrects what the model makes when the automatic sorting got it wrong. */
  output?: ModelOutput | null;
}

export function isEmptyPrefs(p: ModelPrefs): boolean {
  return !p.name && !p.hidden && !p.caps && p.contextWindow == null && p.maxOutput == null && !p.pricing && !p.output;
}

/** True when anything other than visibility is changed. */
export function isCustomized(p: ModelPrefs): boolean {
  return isEmptyPrefs({ ...p, hidden: false }) === false;
}

export function applyPrefs(m: ModelInfo, p: ModelPrefs): ModelInfo {
  return {
    ...m,
    displayName: p.name?.trim() ? p.name : m.displayName,
    caps: p.caps ? normalizeCaps(p.caps) : m.caps,
    contextWindow: p.contextWindow ?? m.contextWindow,
    maxOutput: p.maxOutput ?? m.maxOutput,
    pricing: p.pricing ?? m.pricing,
    output: p.output ?? m.output,
  };
}

/** Price lookups for models the provider lists without prices. */
export interface PriceSource {
  priceFor(kind: ProviderKind, modelId: string): ModelPricing | null | undefined;
}

/** A configured provider with its parsed model list, for pickers. */
export interface ProviderModels {
  provider: ProviderEntity;
  kind: ProviderKind;
  /** Chat models. */
  models: ModelInfo[];
  favorites: Set<string>;
  /** Models the user hid from pickers (still usable by chats that already use them). */
  hidden: Set<string>;
  /** Image, video, speech, music and transcription models. */
  media: ModelInfo[];
}

export class ProviderRepository {
  private keyCache = new Map<string, Promise<string>>();
  private clientCache = new Map<string, { stamp: string; client: LlmClient }>();
  private modelCache = new Map<string, { key: string; models: ModelInfo[] }>();

  constructor(
    private readonly quirks: QuirkStore,
    private readonly pricing: PriceSource,
    private readonly onLocalChange: () => void = () => {},
  ) {}

  get(id: string): Promise<ProviderEntity | undefined> {
    return db().providers.get(id);
  }

  async all(): Promise<ProviderEntity[]> {
    const list = await db().providers.filter((p) => p.deleted === 0).toArray();
    return list.sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
  }

  /** Chat pickers: providers with chat models (media-only and search services are excluded). */
  catalog(list: ProviderEntity[]): ProviderModels[] {
    return list
      .filter((p) => p.enabled && p.deleted === 0 && !isSearchKind(p.kind) && providerKind(p.kind).style !== 'MEDIA')
      .map((p) => {
        const all = this.models(p);
        return {
          provider: p, kind: providerKind(p.kind), models: all.filter((m) => m.output === 'TEXT'),
          favorites: this.favorites(p), hidden: this.hiddenModels(p), media: all.filter((m) => m.output !== 'TEXT'),
        };
      });
  }

  async add(kind: ProviderKind, label: string, baseUrl: string, apiKey: string, headers: Record<string, string>): Promise<ProviderEntity> {
    const now = Date.now();
    const p: ProviderEntity = {
      id: newId(now), kind: kind.id, label: label.trim() || kind.displayName,
      baseUrl: normalizeBaseUrl(baseUrl.trim() || kind.defaultBaseUrl),
      apiKeySealed: apiKey.trim() ? await platform().secrets.seal(utf8(apiKey.trim())) : '',
      headersJson: JSON.stringify(headers), enabled: true, modelsJson: '[]', modelsFetchedAt: 0, favoritesJson: '[]',
      customModelsJson: '[]', capsOverridesJson: '{}', modelPrefsJson: '{}', sort: await db().providers.count(),
      createdAt: now, updatedAt: now, deleted: 0, dirty: 1,
    };
    await db().providers.put(p);
    this.onLocalChange();
    return p;
  }

  /** Adds a non-LLM service row (web search backends) that shares key sealing and sync with providers. */
  async addService(kindId: string, label: string, baseUrl: string, apiKey: string): Promise<ProviderEntity> {
    const now = Date.now();
    const p: ProviderEntity = {
      id: newId(now), kind: kindId, label, baseUrl: normalizeBaseUrl(baseUrl),
      apiKeySealed: apiKey.trim() ? await platform().secrets.seal(utf8(apiKey.trim())) : '',
      headersJson: '{}', enabled: true, modelsJson: '[]', modelsFetchedAt: 0, favoritesJson: '[]',
      customModelsJson: '[]', capsOverridesJson: '{}', modelPrefsJson: '{}', sort: 1000,
      createdAt: now, updatedAt: now, deleted: 0, dirty: 1,
    };
    await db().providers.put(p);
    this.onLocalChange();
    return p;
  }

  /** [apiKey]: undefined keeps the current key, "" removes it. */
  async update(id: string, changes: { label: string; baseUrl: string; apiKey?: string; headers: Record<string, string>; enabled: boolean }): Promise<void> {
    const p = await db().providers.get(id);
    if (!p) return;
    let apiKeySealed = p.apiKeySealed;
    if (changes.apiKey !== undefined) apiKeySealed = changes.apiKey.trim() ? await platform().secrets.seal(utf8(changes.apiKey.trim())) : '';
    await db().providers.put({
      ...p,
      label: changes.label.trim() || (searchKind(p.kind)?.displayName ?? providerKind(p.kind).displayName),
      baseUrl: normalizeBaseUrl(changes.baseUrl),
      apiKeySealed,
      headersJson: JSON.stringify(changes.headers),
      enabled: changes.enabled,
      updatedAt: Date.now(),
      dirty: 1,
    });
    this.keyCache.delete(id);
    this.clientCache.delete(id);
    this.onLocalChange();
  }

  async delete(id: string): Promise<void> {
    const p = await db().providers.get(id);
    if (!p) return;
    await db().providers.put({ ...p, deleted: 1, dirty: 1, apiKeySealed: '', updatedAt: Date.now() });
    this.keyCache.delete(id);
    this.clientCache.delete(id);
    this.onLocalChange();
  }

  /** The decrypted API key ("" when none). Cached per sealed value. */
  apiKey(p: ProviderEntity): Promise<string> {
    if (!p.apiKeySealed) return Promise.resolve('');
    const cacheKey = p.id + ':' + p.apiKeySealed;
    let v = this.keyCache.get(cacheKey);
    if (!v) {
      v = platform().secrets.open(p.apiKeySealed).then(fromUtf8, () => '');
      this.keyCache.set(cacheKey, v);
    }
    return v;
  }

  headers(p: ProviderEntity): Record<string, string> {
    return parseJson<Record<string, string>>(p.headersJson, {});
  }

  async config(p: ProviderEntity): Promise<ProviderConfig> {
    return { id: p.id, kind: providerKind(p.kind), label: p.label, baseUrl: p.baseUrl, apiKey: await this.apiKey(p), headers: this.headers(p) };
  }

  async client(p: ProviderEntity): Promise<LlmClient> {
    const stamp = `${p.updatedAt}|${p.apiKeySealed}|${p.baseUrl}`;
    const cached = this.clientCache.get(p.id);
    if (cached && cached.stamp === stamp) return cached.client;
    const client = createLlmClient(await this.config(p), { quirks: this.quirks, pricing: this.pricing });
    this.clientCache.set(p.id, { stamp, client });
    return client;
  }

  /** Validates a key before saving. Throws LlmException with a user-facing message. */
  async verify(kind: ProviderKind, baseUrl: string, apiKey: string, headers: Record<string, string>): Promise<void> {
    const cfg: ProviderConfig = { id: 'verify', kind, label: kind.displayName, baseUrl: normalizeBaseUrl(baseUrl), apiKey: apiKey.trim(), headers };
    await createLlmClient(cfg, { quirks: this.quirks, pricing: this.pricing }).verify();
  }

  async refreshModels(id: string): Promise<ModelInfo[]> {
    const p = await db().providers.get(id);
    if (!p) throw new Error('Provider not found');
    const models = (await (await this.client(p)).listModels())
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.displayName.localeCompare(b.displayName));
    // Local cache only: doesn't change updatedAt or dirty, so it never syncs or conflicts.
    await db().providers.update(id, { modelsJson: JSON.stringify(models), modelsFetchedAt: Date.now() });
    return models;
  }

  favorites(p: ProviderEntity): Set<string> {
    return new Set(parseJson<string[]>(p.favoritesJson, []));
  }

  customModels(p: ProviderEntity): ModelInfo[] {
    return parseJson<unknown[]>(p.customModelsJson, []).map(normalizeModel);
  }

  modelPrefs(p: ProviderEntity): Record<string, ModelPrefs> {
    return parseJson<Record<string, ModelPrefs>>(p.modelPrefsJson, {});
  }

  hiddenModels(p: ProviderEntity): Set<string> {
    return new Set(Object.entries(this.modelPrefs(p)).filter(([, v]) => v.hidden).map(([k]) => k));
  }

  /** Fetched + manually added models as the provider describes them, with known pricing filled in. */
  baseModels(p: ProviderEntity): ModelInfo[] {
    const kind = providerKind(p.kind);
    const fetched = parseJson<unknown[]>(p.modelsJson, []).map(normalizeModel);
    const custom = this.customModels(p);
    const ids = new Set(custom.map((m) => m.id));
    return [...custom, ...fetched.filter((f) => !ids.has(f.id))].map((m) => ({ ...m, pricing: m.pricing ?? this.pricing.priceFor(kind, m.id) ?? null }));
  }

  /** baseModels with the user's edits applied: what pickers, chats and cost estimates use. */
  models(p: ProviderEntity): ModelInfo[] {
    const key = `${p.modelsFetchedAt}|${p.customModelsJson}|${p.capsOverridesJson}|${p.modelPrefsJson}|${p.modelsJson.length}`;
    const cached = this.modelCache.get(p.id);
    if (cached && cached.key === key) return cached.models;
    const legacy = parseJson<Record<string, unknown>>(p.capsOverridesJson, {});
    const prefs = this.modelPrefs(p);
    const merged = this.baseModels(p).map((m) => {
      const withLegacy = legacy[m.id] ? { ...m, caps: normalizeCaps(legacy[m.id]) } : m;
      return prefs[m.id] ? applyPrefs(withLegacy, prefs[m.id]) : withLegacy;
    });
    this.modelCache.set(p.id, { key, models: merged });
    return merged;
  }

  modelInfo(p: ProviderEntity, modelId: string): ModelInfo {
    return this.models(p).find((m) => m.id === modelId) ?? normalizeModel({ id: modelId, displayName: modelId });
  }

  /** Enabled providers with keys and visible models, chat and media alike (for media generation). */
  async list(): Promise<Array<{ provider: ProviderEntity; config: ProviderConfig; models: ModelInfo[] }>> {
    const out = [];
    for (const p of await this.all()) {
      if (!p.enabled || isSearchKind(p.kind)) continue;
      const hidden = this.hiddenModels(p);
      out.push({ provider: p, config: await this.config(p), models: this.models(p).filter((m) => !hidden.has(m.id)) });
    }
    return out;
  }

  toggleFavorite(id: string, modelId: string) {
    return this.mutate(id, (p) => {
      const favs = this.favorites(p);
      if (favs.has(modelId)) favs.delete(modelId);
      else favs.add(modelId);
      return { ...p, favoritesJson: JSON.stringify([...favs]) };
    });
  }

  addCustomModel(id: string, model: ModelInfo) {
    return this.mutate(id, (p) => ({ ...p, customModelsJson: JSON.stringify([...this.customModels(p).filter((m) => m.id !== model.id), model]) }));
  }

  /** Removes a manually added model along with its edits and favorite. */
  removeCustomModel(id: string, modelId: string) {
    return this.mutate(id, (p) => {
      const prefs = this.modelPrefs(p);
      delete prefs[modelId];
      const favs = this.favorites(p);
      favs.delete(modelId);
      return {
        ...p,
        customModelsJson: JSON.stringify(this.customModels(p).filter((m) => m.id !== modelId)),
        modelPrefsJson: JSON.stringify(prefs),
        favoritesJson: JSON.stringify([...favs]),
      };
    });
  }

  /** Saves the user's edits to one model; empty prefs restore the provider's values. */
  setModelPrefs(id: string, modelId: string, prefs: ModelPrefs) {
    return this.mutate(id, (p) => {
      const map = this.modelPrefs(p);
      if (isEmptyPrefs(prefs)) delete map[modelId];
      else map[modelId] = prefs;
      // Edits replace the older caps-only override for this model.
      const legacy = parseJson<Record<string, unknown>>(p.capsOverridesJson, {});
      delete legacy[modelId];
      return { ...p, modelPrefsJson: JSON.stringify(map), capsOverridesJson: JSON.stringify(legacy) };
    });
  }

  /** Hides or shows models in pickers. */
  setHidden(id: string, modelIds: string[], hidden: boolean) {
    return this.mutate(id, (p) => {
      const map = this.modelPrefs(p);
      for (const mid of modelIds) {
        const next = { ...(map[mid] ?? {}), hidden };
        if (isEmptyPrefs(next)) delete map[mid];
        else map[mid] = next;
      }
      return { ...p, modelPrefsJson: JSON.stringify(map) };
    });
  }

  private async mutate(id: string, transform: (p: ProviderEntity) => ProviderEntity): Promise<void> {
    // In a transaction, so a model-list refresh can't land between the read and the write.
    let changed = false;
    await db().transaction('rw', db().providers, async () => {
      const p = await db().providers.get(id);
      if (!p) return;
      await db().providers.put({ ...transform(p), updatedAt: Date.now(), dirty: 1 });
      changed = true;
    });
    if (changed) this.onLocalChange();
  }
}
