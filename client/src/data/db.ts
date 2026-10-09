/**
 * The local database (IndexedDB via Dexie), the counterpart of the Android Room database.
 * Everything here is this device's copy; the sync engine pushes dirty rows end-to-end encrypted.
 * Dexie's live queries also update other open tabs, so every window shows the same data.
 */
import Dexie, { type EntityTable } from 'dexie';
import type {
  AssistantEntity,
  AttachmentEntity,
  ConversationEntity,
  FileEntity,
  FolderEntity,
  KvEntry,
  McpServerEntity,
  MessageEntity,
  PromptEntity,
  ProviderEntity,
  SkillEntity,
} from './entities';

export class FacetDb extends Dexie {
  conversations!: EntityTable<ConversationEntity, 'id'>;
  messages!: EntityTable<MessageEntity, 'id'>;
  attachments!: EntityTable<AttachmentEntity, 'id'>;
  files!: EntityTable<FileEntity, 'id'>;
  assistants!: EntityTable<AssistantEntity, 'id'>;
  folders!: EntityTable<FolderEntity, 'id'>;
  prompts!: EntityTable<PromptEntity, 'id'>;
  providers!: EntityTable<ProviderEntity, 'id'>;
  mcpServers!: EntityTable<McpServerEntity, 'id'>;
  skills!: EntityTable<SkillEntity, 'id'>;
  kv!: EntityTable<KvEntry, 'key'>;

  constructor(name = 'facet') {
    super(name);
    this.version(1).stores({
      conversations: 'id, dirty, lastActivityAt, folderId, [deleted+archived]',
      messages: 'id, dirty, conversationId, parentId, status',
      attachments: 'id, dirty, conversationId, createdAt, hasFile',
      files: 'id',
      assistants: 'id, dirty',
      folders: 'id, dirty',
      prompts: 'id, dirty',
      providers: 'id, dirty',
      mcpServers: 'id, dirty',
      skills: 'id, dirty',
      kv: 'key',
    });
  }

  /** The synced tables, in push order (settings first, then what other rows refer to). */
  get syncedTables() {
    return [this.providers, this.folders, this.prompts, this.assistants, this.conversations, this.attachments, this.mcpServers, this.skills, this.messages];
  }

  async getKv<T>(key: string, fallback: T): Promise<T> {
    const row = await this.kv.get(key);
    return row === undefined ? fallback : (row.value as T);
  }

  async setKv(key: string, value: unknown): Promise<void> {
    await this.kv.put({ key, value });
  }
}

let instance: FacetDb | null = null;

/** The app's database. Tests may replace it with [setDb]. */
export function db(): FacetDb {
  if (!instance) instance = new FacetDb();
  return instance;
}

export function setDb(next: FacetDb): void {
  instance = next;
}
