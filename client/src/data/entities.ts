/**
 * Local entities (port of Entities.kt). Every synced entity has: updatedAt (last-writer-wins key),
 * deleted (tombstone) and dirty (needs push). Flags used in IndexedDB indexes are 0/1 numbers,
 * because IndexedDB can't index booleans. Tombstoned rows are kept until pushed, then purged.
 */

export type Flag = 0 | 1;

export interface SyncFields {
  createdAt: number;
  updatedAt: number;
  deleted: Flag;
  dirty: Flag;
}

export interface ConversationEntity extends SyncFields {
  id: string;
  title: string;
  /** True once a title was generated or set by the user (stops auto-titling). */
  titleSet: boolean;
  assistantId?: string | null;
  folderId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  /** GenParams JSON. */
  paramsJson: string;
  /** Per-chat instructions added on top of the assistant and custom instructions. */
  systemPrompt?: string | null;
  /** Leaf of the selected branch. */
  currentLeafId?: string | null;
  pinned: boolean;
  archived: Flag;
  lastActivityAt: number;
  /** Desktop only, never synced: the folder computer tools work in for this chat. */
  workspace?: string | null;
}

export type MessageStatus = 'DONE' | 'STREAMING' | 'STOPPED' | 'ERROR' | 'REFUSED' | 'TRUNCATED';

export interface MessageEntity extends SyncFields {
  id: string;
  conversationId: string;
  parentId?: string | null;
  /** "user" or "assistant". */
  role: 'user' | 'assistant';
  content: string;
  thinking?: string | null;
  thinkingMs?: number | null;
  /** ProviderBlocks JSON for lossless replay. */
  blocksJson?: string | null;
  /** AttachmentRef[] JSON. */
  attachmentsJson?: string | null;
  /** Citation[] JSON. */
  citationsJson?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  modelName?: string | null;
  status: MessageStatus;
  /** MessageError JSON. */
  errorJson?: string | null;
  /** Usage JSON. */
  usageJson?: string | null;
  costUsd?: number | null;
  /** ToolTrace JSON: the tool steps of an assistant reply (calls, results, per-step provider blocks). */
  stepsJson?: string | null;
}

export interface AttachmentRef {
  id: string;
  kind: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
}

export interface MessageError {
  kind: string;
  message: string;
  detail?: string | null;
}

export interface AttachmentEntity extends SyncFields {
  id: string;
  conversationId?: string | null;
  /** "image", "pdf", "text", "video", "audio", "file". */
  kind: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  /** 1 when this device has the file's bytes (in the `files` table). */
  hasFile: Flag;
  /** True once the encrypted blob is on the sync server. */
  uploaded: boolean;
  /** Kept on this device only: not uploaded (sync storage full, or the user chose to free cloud space). */
  localOnly: boolean;
}

export interface FileEntity {
  /** The attachment id. */
  id: string;
  data: Blob;
}

export interface AssistantEntity extends SyncFields {
  id: string;
  name: string;
  emoji: string;
  colorIndex: number;
  instructions: string;
  providerId?: string | null;
  modelId?: string | null;
  paramsJson?: string | null;
  /** string[] JSON. */
  startersJson: string;
  sort: number;
}

export interface FolderEntity extends SyncFields {
  id: string;
  name: string;
  colorIndex: number;
  sort: number;
}

export interface PromptEntity extends SyncFields {
  id: string;
  title: string;
  body: string;
}

export interface ProviderEntity extends SyncFields {
  id: string;
  /** ProviderKind.id, or a search kind id ("search.brave"). */
  kind: string;
  label: string;
  baseUrl: string;
  /** API key sealed with the local SecretBox ("" when none). */
  apiKeySealed: string;
  /** Record<string,string> JSON of extra headers. */
  headersJson: string;
  enabled: boolean;
  /** Cached ModelInfo[] JSON (local only, refreshed from the provider). */
  modelsJson: string;
  modelsFetchedAt: number;
  /** string[] JSON of favorite model ids. */
  favoritesJson: string;
  /** ModelInfo[] JSON of manually added models. */
  customModelsJson: string;
  /** Record<modelId, ModelCaps> JSON of user overrides (legacy; superseded by modelPrefsJson). */
  capsOverridesJson: string;
  /** Record<modelId, ModelPrefs> JSON: the user's name, visibility, capability, limit and price edits. */
  modelPrefsJson: string;
  sort: number;
}

/** McpAuthMode name. */
export type McpAuthMode = 'NONE' | 'HEADERS' | 'OAUTH';

/** A local command that speaks MCP over stdin/stdout (Windows app only; never synced). */
export interface StdioSpec {
  command: string;
  args: string[];
  cwd?: string | null;
}

export interface McpServerEntity extends SyncFields {
  id: string;
  name: string;
  url: string;
  authMode: McpAuthMode;
  /** Record<string,string> JSON sealed with the local SecretBox ("" when none). For stdio servers: environment variables. */
  headersSealed: string;
  /** McpOAuthState JSON sealed with the local SecretBox ("" when none). */
  oauthSealed: string;
  enabled: boolean;
  /** ToolApproval name: ALWAYS, WRITES, NEVER. */
  approval: string;
  /** Cached McpTool[] JSON (local only). */
  toolsJson: string;
  toolsFetchedAt: number;
  /** Server instructions from initialize (local only). */
  instructions?: string | null;
  /** Last connection problem shown to the user (local only). */
  status?: string | null;
  /** string[] JSON of tool names the user turned off. */
  disabledToolsJson: string;
  /** string[] JSON of tool names that never ask for approval. */
  autoApprovedJson: string;
  sort: number;
  /** Windows app only: a local stdio server. These rows stay on this computer (never synced). */
  stdio?: StdioSpec | null;
}

export interface SkillEntity extends SyncFields {
  id: string;
  /** Short identifier used by the model, e.g. "meeting-notes". */
  name: string;
  /** When to use the skill; shown to the model in the skill index. */
  description: string;
  /** The full instructions (SKILL.md body). */
  instructions: string;
  /** SkillResource[] JSON: extra reference files bundled with the skill. */
  resourcesJson: string;
  enabled: boolean;
  /** Always include the full instructions instead of loading on demand. */
  alwaysOn: boolean;
  sourceUrl?: string | null;
}

export interface KvEntry {
  key: string;
  value: unknown;
}

export function attachmentRef(a: AttachmentEntity): AttachmentRef {
  return { id: a.id, kind: a.kind, mimeType: a.mimeType, name: a.name, sizeBytes: a.sizeBytes, width: a.width ?? null, height: a.height ?? null };
}
