/**
 * Converts local entities to end-to-end encrypted records and back (port of RecordCodec.kt;
 * docs/SECURITY.md). Payload field names and shapes match the Android app exactly, so every
 * device reads every other device's records.
 *
 * Metadata hardening: on the wire every record has the type "e" and an opaque id
 * HMAC-SHA256(recordIdKey, "rec:" + type + ":" + id); the real type and id travel inside the
 * ciphertext, the plaintext is padded to size buckets, and deletions are encrypted too.
 */
import { b64, fromUtf8, unb64, utf8 } from '../core/bytes';
import { DecryptionError, decryptRecord, encryptRecord, type Vault } from '../core/crypto';
import { toJson } from '../core/json';
import type {
  AssistantEntity,
  AttachmentEntity,
  ConversationEntity,
  FolderEntity,
  McpServerEntity,
  MessageEntity,
  PromptEntity,
  ProviderEntity,
  SkillEntity,
} from '../data/entities';
import { normalizeSynced, type SyncedPrefs } from '../data/prefs';
import type { SecretBox } from '../platform';
import type { RecordDto } from './api';

/** Logical record types. They never appear on the wire. */
export const RecordType = {
  CONVERSATION: 'conv',
  MESSAGE: 'msg',
  ATTACHMENT: 'att',
  ASSISTANT: 'asst',
  FOLDER: 'folder',
  PROMPT: 'prompt',
  PROVIDER: 'provider',
  MCP: 'mcp',
  SKILL: 'skill',
  SETTINGS: 'settings',
  SETTINGS_ID: 'user',
} as const;

/** Every record has this type on the wire. */
export const WIRE_TYPE = 'e';

/** A record after decryption: its real type, id and payload (null for deletions). */
export interface OpenedRecord {
  type: string;
  id: string;
  updatedAt: number;
  deleted: boolean;
  payload: any;
}

const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const ns = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const n = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const nn = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const b = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d);

export class RecordCodec {
  constructor(
    private readonly vault: Vault,
    private readonly secrets: SecretBox,
  ) {}

  wireId(type: string, id: string): Promise<string> {
    return this.vault.opaqueId(`rec:${type}:${id}`);
  }

  /** Opaque server-side id for an attachment's encrypted file. */
  blobId(attachmentId: string): Promise<string> {
    return this.vault.opaqueId(`blob:${attachmentId}`);
  }

  private async seal(type: string, id: string, updatedAt: number, deleted: boolean, payload: unknown | null): Promise<RecordDto> {
    const wid = await this.wireId(type, id);
    const inner = payload == null ? { t: type, i: id } : { t: type, i: id, d: payload };
    const ct = await encryptRecord(this.vault.aes, WIRE_TYPE, wid, toJson(inner), { pad: true });
    return { id: wid, type: WIRE_TYPE, updatedAt, deleted, ct: b64(ct) };
  }

  /** Decrypts a pulled record. Returns null for records without ciphertext. Throws DecryptionError on tampering. */
  async open(r: RecordDto): Promise<OpenedRecord | null> {
    if (!r.ct) return null;
    const json = await decryptRecord(this.vault.aes, r.type, r.id, unb64(r.ct));
    const obj = JSON.parse(json);
    const type = obj?.t;
    const id = obj?.i;
    if (typeof type !== 'string' || typeof id !== 'string') return null;
    // The id is bound to its content: a server can't move a record to another id.
    if ((await this.wireId(type, id)) !== r.id) throw new DecryptionError('Record id mismatch');
    return { type, id, updatedAt: r.updatedAt, deleted: r.deleted, payload: obj.d ?? null };
  }

  private entity(type: string, e: { id: string; updatedAt: number; deleted: number }, payload: () => unknown | Promise<unknown>): Promise<RecordDto> {
    return (async () => this.seal(type, e.id, e.updatedAt, !!e.deleted, e.deleted ? null : await payload()))();
  }

  // ---- encode (local entity → record) ----

  encodeConversation(e: ConversationEntity): Promise<RecordDto> {
    return this.entity(RecordType.CONVERSATION, e, () => ({
      title: e.title, titleSet: e.titleSet, assistantId: e.assistantId ?? null, folderId: e.folderId ?? null,
      providerId: e.providerId ?? null, modelId: e.modelId ?? null, paramsJson: e.paramsJson, systemPrompt: e.systemPrompt ?? null,
      currentLeafId: e.currentLeafId ?? null, pinned: e.pinned, archived: !!e.archived, createdAt: e.createdAt, lastActivityAt: e.lastActivityAt,
    }));
  }

  encodeMessage(e: MessageEntity): Promise<RecordDto> {
    return this.entity(RecordType.MESSAGE, e, () => ({
      conversationId: e.conversationId, parentId: e.parentId ?? null, role: e.role, content: e.content, thinking: e.thinking ?? null,
      thinkingMs: e.thinkingMs ?? null, blocksJson: e.blocksJson ?? null, attachmentsJson: e.attachmentsJson ?? null,
      citationsJson: e.citationsJson ?? null, providerId: e.providerId ?? null, modelId: e.modelId ?? null, modelName: e.modelName ?? null,
      status: e.status, errorJson: e.errorJson ?? null, usageJson: e.usageJson ?? null, costUsd: e.costUsd ?? null, createdAt: e.createdAt,
      stepsJson: e.stepsJson ?? null,
    }));
  }

  encodeAttachment(e: AttachmentEntity): Promise<RecordDto> {
    return this.entity(RecordType.ATTACHMENT, e, () => ({
      conversationId: e.conversationId ?? null, kind: e.kind, mimeType: e.mimeType, name: e.name, sizeBytes: e.sizeBytes,
      width: e.width ?? null, height: e.height ?? null, uploaded: e.uploaded, createdAt: e.createdAt,
    }));
  }

  encodeAssistant(e: AssistantEntity): Promise<RecordDto> {
    return this.entity(RecordType.ASSISTANT, e, () => ({
      name: e.name, emoji: e.emoji, colorIndex: e.colorIndex, instructions: e.instructions, providerId: e.providerId ?? null,
      modelId: e.modelId ?? null, paramsJson: e.paramsJson ?? null, startersJson: e.startersJson, sort: e.sort, createdAt: e.createdAt,
    }));
  }

  encodeFolder(e: FolderEntity): Promise<RecordDto> {
    return this.entity(RecordType.FOLDER, e, () => ({ name: e.name, colorIndex: e.colorIndex, sort: e.sort, createdAt: e.createdAt }));
  }

  encodePrompt(e: PromptEntity): Promise<RecordDto> {
    return this.entity(RecordType.PROMPT, e, () => ({ title: e.title, body: e.body, createdAt: e.createdAt }));
  }

  encodeProvider(e: ProviderEntity): Promise<RecordDto> {
    return this.entity(RecordType.PROVIDER, e, async () => ({
      kind: e.kind, label: e.label, baseUrl: e.baseUrl, apiKey: await this.openString(e.apiKeySealed), headersJson: e.headersJson,
      enabled: e.enabled, favoritesJson: e.favoritesJson, customModelsJson: e.customModelsJson, capsOverridesJson: e.capsOverridesJson,
      sort: e.sort, createdAt: e.createdAt, modelPrefsJson: e.modelPrefsJson,
    }));
  }

  encodeMcp(e: McpServerEntity): Promise<RecordDto> {
    return this.entity(RecordType.MCP, e, async () => {
      let headers: Record<string, string> = {};
      let oauth: unknown = null;
      try {
        headers = e.headersSealed ? JSON.parse(await this.openString(e.headersSealed)) : {};
      } catch {
        headers = {};
      }
      try {
        oauth = e.oauthSealed ? JSON.parse(await this.openString(e.oauthSealed)) : null;
      } catch {
        oauth = null;
      }
      return {
        name: e.name, url: e.url, authMode: e.authMode, headers, oauth, enabled: e.enabled, approval: e.approval,
        disabledToolsJson: e.disabledToolsJson, autoApprovedJson: e.autoApprovedJson, sort: e.sort, createdAt: e.createdAt,
      };
    });
  }

  encodeSkill(e: SkillEntity): Promise<RecordDto> {
    return this.entity(RecordType.SKILL, e, () => ({
      name: e.name, description: e.description, instructions: e.instructions, resourcesJson: e.resourcesJson,
      enabled: e.enabled, alwaysOn: e.alwaysOn, sourceUrl: e.sourceUrl ?? null, createdAt: e.createdAt,
    }));
  }

  encodeSettings(p: SyncedPrefs): Promise<RecordDto> {
    return this.seal(RecordType.SETTINGS, RecordType.SETTINGS_ID, p.updatedAt, false, p);
  }

  // ---- decode (opened record → local entity, clean) ----

  conversation(r: OpenedRecord, existing?: ConversationEntity): ConversationEntity {
    const p = r.payload ?? {};
    return {
      id: r.id, title: s(p.title), titleSet: b(p.titleSet), assistantId: ns(p.assistantId), folderId: ns(p.folderId),
      providerId: ns(p.providerId), modelId: ns(p.modelId), paramsJson: s(p.paramsJson, '{}'), systemPrompt: ns(p.systemPrompt),
      currentLeafId: ns(p.currentLeafId), pinned: b(p.pinned), archived: b(p.archived) ? 1 : 0, createdAt: n(p.createdAt),
      lastActivityAt: n(p.lastActivityAt), updatedAt: r.updatedAt, deleted: 0, dirty: 0,
      workspace: existing?.workspace ?? null,
    };
  }

  message(r: OpenedRecord): MessageEntity {
    const p = r.payload ?? {};
    return {
      id: r.id, conversationId: s(p.conversationId), parentId: ns(p.parentId), role: p.role === 'user' ? 'user' : 'assistant',
      content: s(p.content), thinking: ns(p.thinking), thinkingMs: nn(p.thinkingMs), blocksJson: ns(p.blocksJson),
      attachmentsJson: ns(p.attachmentsJson), citationsJson: ns(p.citationsJson), providerId: ns(p.providerId), modelId: ns(p.modelId),
      modelName: ns(p.modelName), status: (s(p.status, 'DONE') as MessageEntity['status']), errorJson: ns(p.errorJson),
      usageJson: ns(p.usageJson), costUsd: nn(p.costUsd), createdAt: n(p.createdAt), updatedAt: r.updatedAt, deleted: 0, dirty: 0,
      stepsJson: ns(p.stepsJson),
    };
  }

  attachment(r: OpenedRecord, existing?: AttachmentEntity): AttachmentEntity {
    const p = r.payload ?? {};
    const uploaded = b(p.uploaded);
    const hasFile = existing?.hasFile ?? 0;
    return {
      id: r.id, conversationId: ns(p.conversationId), kind: s(p.kind, 'file'), mimeType: s(p.mimeType, 'application/octet-stream'),
      name: s(p.name, 'file'), sizeBytes: n(p.sizeBytes), width: nn(p.width), height: nn(p.height), hasFile, uploaded,
      // "Kept on this device" is local state; it ends once some device has uploaded the file.
      // A copy this device downloaded becomes device-only when another device frees the cloud copy.
      localOnly: !uploaded && (existing?.localOnly === true || (existing?.uploaded === true && hasFile === 1)),
      createdAt: n(p.createdAt), updatedAt: r.updatedAt, deleted: 0, dirty: 0,
    };
  }

  assistant(r: OpenedRecord): AssistantEntity {
    const p = r.payload ?? {};
    return {
      id: r.id, name: s(p.name, 'Assistant'), emoji: s(p.emoji, '✨'), colorIndex: n(p.colorIndex), instructions: s(p.instructions),
      providerId: ns(p.providerId), modelId: ns(p.modelId), paramsJson: ns(p.paramsJson), startersJson: s(p.startersJson, '[]'),
      sort: n(p.sort), createdAt: n(p.createdAt), updatedAt: r.updatedAt, deleted: 0, dirty: 0,
    };
  }

  folder(r: OpenedRecord): FolderEntity {
    const p = r.payload ?? {};
    return { id: r.id, name: s(p.name, 'Folder'), colorIndex: n(p.colorIndex), sort: n(p.sort), createdAt: n(p.createdAt), updatedAt: r.updatedAt, deleted: 0, dirty: 0 };
  }

  prompt(r: OpenedRecord): PromptEntity {
    const p = r.payload ?? {};
    return { id: r.id, title: s(p.title), body: s(p.body), createdAt: n(p.createdAt), updatedAt: r.updatedAt, deleted: 0, dirty: 0 };
  }

  /** Seals a pulled provider's API key for local storage (async, so it runs before the database transaction). */
  async providerSecrets(r: OpenedRecord): Promise<{ apiKeySealed: string }> {
    const apiKey = s(r.payload?.apiKey).trim();
    return { apiKeySealed: apiKey ? await this.secrets.seal(utf8(apiKey)) : '' };
  }

  provider(r: OpenedRecord, existing: ProviderEntity | undefined, sealed: { apiKeySealed: string }): ProviderEntity {
    const p = r.payload ?? {};
    return {
      id: r.id, kind: s(p.kind, 'custom'), label: s(p.label), baseUrl: s(p.baseUrl), apiKeySealed: sealed.apiKeySealed,
      headersJson: s(p.headersJson, '{}'), enabled: b(p.enabled, true),
      modelsJson: existing?.modelsJson ?? '[]', modelsFetchedAt: existing?.modelsFetchedAt ?? 0,
      favoritesJson: s(p.favoritesJson, '[]'), customModelsJson: s(p.customModelsJson, '[]'), capsOverridesJson: s(p.capsOverridesJson, '{}'),
      modelPrefsJson: s(p.modelPrefsJson, '{}'), sort: n(p.sort), createdAt: n(p.createdAt), updatedAt: r.updatedAt, deleted: 0, dirty: 0,
    };
  }

  /** Seals a pulled MCP server's headers and sign-in state for local storage. */
  async mcpSecrets(r: OpenedRecord): Promise<{ headersSealed: string; oauthSealed: string }> {
    const p = r.payload ?? {};
    const headers = p.headers && typeof p.headers === 'object' ? p.headers : {};
    return {
      headersSealed: Object.keys(headers).length ? await this.secrets.seal(utf8(JSON.stringify(headers))) : '',
      oauthSealed: p.oauth ? await this.secrets.seal(utf8(JSON.stringify(p.oauth))) : '',
    };
  }

  mcpServer(r: OpenedRecord, existing: McpServerEntity | undefined, sealed: { headersSealed: string; oauthSealed: string }): McpServerEntity {
    const p = r.payload ?? {};
    return {
      id: r.id, name: s(p.name), url: s(p.url), authMode: (s(p.authMode, 'NONE') as McpServerEntity['authMode']),
      headersSealed: sealed.headersSealed, oauthSealed: sealed.oauthSealed,
      enabled: b(p.enabled, true), approval: s(p.approval, 'WRITES'),
      toolsJson: existing?.toolsJson ?? '[]', toolsFetchedAt: existing?.toolsFetchedAt ?? 0,
      instructions: existing?.instructions ?? null, status: existing?.status ?? null,
      disabledToolsJson: s(p.disabledToolsJson, '[]'), autoApprovedJson: s(p.autoApprovedJson, '[]'),
      sort: n(p.sort), createdAt: n(p.createdAt), updatedAt: r.updatedAt, deleted: 0, dirty: 0,
    };
  }

  skill(r: OpenedRecord): SkillEntity {
    const p = r.payload ?? {};
    return {
      id: r.id, name: s(p.name), description: s(p.description), instructions: s(p.instructions), resourcesJson: s(p.resourcesJson, '[]'),
      enabled: b(p.enabled, true), alwaysOn: b(p.alwaysOn), sourceUrl: ns(p.sourceUrl), createdAt: n(p.createdAt),
      updatedAt: r.updatedAt, deleted: 0, dirty: 0,
    };
  }

  settings(r: OpenedRecord): SyncedPrefs {
    return { ...normalizeSynced(r.payload), updatedAt: r.updatedAt };
  }

  private async openString(sealed: string): Promise<string> {
    if (!sealed) return '';
    try {
      return fromUtf8(await this.secrets.open(sealed));
    } catch {
      return '';
    }
  }
}
