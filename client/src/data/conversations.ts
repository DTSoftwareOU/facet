/** Conversations and messages (port of ConversationRepository.kt and MessageTree in Models.kt). */
import { newId } from '../core/ids';
import { parseJson, toJson } from '../core/json';
import { t } from '../i18n';
import type { Citation, GenParams, Usage } from '../llm/types';
import { db } from './db';
import type { AttachmentRef, ComputerBinding, ConversationEntity, MessageEntity, MessageError } from './entities';

export function messageAttachments(m: MessageEntity): AttachmentRef[] {
  return parseJson<AttachmentRef[]>(m.attachmentsJson, []);
}

export function messageCitations(m: MessageEntity): Citation[] {
  return parseJson<Citation[]>(m.citationsJson, []);
}

export function messageUsage(m: MessageEntity): Usage | null {
  const u = parseJson<Partial<Usage> | null>(m.usageJson, null);
  return u ? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, ...u } : null;
}

export function messageError(m: MessageEntity): MessageError | null {
  return parseJson<MessageError | null>(m.errorJson, null);
}

/**
 * The message tree of one conversation. Editing or regenerating creates siblings;
 * the visible thread is the path from the root to the selected leaf.
 */
export class MessageTree {
  readonly byId: Map<string, MessageEntity>;
  private readonly children: Map<string | null, MessageEntity[]>;

  constructor(messages: MessageEntity[]) {
    this.byId = new Map(messages.map((m) => [m.id, m]));
    this.children = new Map();
    for (const m of messages) {
      const parent = m.parentId && this.byId.has(m.parentId) ? m.parentId : null;
      const list = this.children.get(parent);
      if (list) list.push(m);
      else this.children.set(parent, [m]);
    }
    for (const list of this.children.values()) list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  childrenOf(id: string | null): MessageEntity[] {
    return this.children.get(id) ?? [];
  }

  siblings(m: MessageEntity): MessageEntity[] {
    return this.childrenOf(m.parentId && this.byId.has(m.parentId) ? m.parentId : null);
  }

  /** Follows the most recent child from [id] down to a leaf. */
  latestLeaf(id: string): string {
    let current = id;
    for (;;) {
      const kids = this.childrenOf(current);
      if (kids.length === 0) return current;
      current = kids[kids.length - 1].id;
    }
  }

  pathTo(leafId: string): MessageEntity[] {
    const out: MessageEntity[] = [];
    const seen = new Set<string>();
    let cur = this.byId.get(leafId);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur);
      cur = cur.parentId ? this.byId.get(cur.parentId) : undefined;
    }
    return out.reverse();
  }

  /** The visible thread for [currentLeafId], falling back to the newest branch. */
  activePath(currentLeafId: string | null | undefined): MessageEntity[] {
    if (this.byId.size === 0) return [];
    let leaf: string | null = null;
    if (currentLeafId && this.byId.has(currentLeafId)) leaf = this.latestLeaf(currentLeafId);
    else {
      const roots = this.childrenOf(null);
      if (roots.length === 0) return [];
      leaf = this.latestLeaf(roots[roots.length - 1].id);
    }
    return this.pathTo(leaf);
  }
}

export interface SearchHit {
  messageId: string;
  conversationId: string;
  title: string;
  snippet: string;
  role: string;
  createdAt: number;
}

export class ConversationRepository {
  constructor(private readonly onLocalChange: () => void = () => {}) {}

  get(id: string): Promise<ConversationEntity | undefined> {
    return db().conversations.get(id);
  }

  async messages(conversationId: string): Promise<MessageEntity[]> {
    const list = await db().messages.where('conversationId').equals(conversationId).filter((m) => m.deleted === 0).toArray();
    return list.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  message(id: string): Promise<MessageEntity | undefined> {
    return db().messages.get(id);
  }

  async create(assistantId: string | null, providerId: string | null, modelId: string | null, params: GenParams, folderId: string | null = null, computer: ComputerBinding | null = null): Promise<ConversationEntity> {
    const now = Date.now();
    const c: ConversationEntity = {
      id: newId(now), title: t('New chat'), titleSet: false, assistantId, folderId, providerId, modelId,
      paramsJson: toJson(params), systemPrompt: null, currentLeafId: null, pinned: false, archived: 0,
      createdAt: now, lastActivityAt: now, updatedAt: now, deleted: 0, dirty: 1,
      computerHost: computer?.host ?? null, computerFolder: computer?.folder ?? null,
    };
    await db().conversations.put(c);
    return c;
  }

  /** Applies [transform] and marks the conversation for sync. */
  async update(id: string, transform: (c: ConversationEntity) => ConversationEntity, touchActivity = false): Promise<void> {
    await db().transaction('rw', db().conversations, async () => {
      const current = await db().conversations.get(id);
      if (!current) return;
      const now = Date.now();
      await db().conversations.put({ ...transform(current), updatedAt: now, lastActivityAt: touchActivity ? now : current.lastActivityAt, dirty: 1 });
    });
    this.onLocalChange();
  }

  rename(id: string, title: string) {
    return this.update(id, (c) => ({ ...c, title: title.trim() || 'Untitled', titleSet: true }));
  }
  setPinned(id: string, pinned: boolean) {
    return this.update(id, (c) => ({ ...c, pinned }));
  }
  setArchived(id: string, archived: boolean) {
    return this.update(id, (c) => ({ ...c, archived: archived ? 1 : 0 }));
  }
  moveToFolder(id: string, folderId: string | null) {
    return this.update(id, (c) => ({ ...c, folderId }));
  }
  setModel(id: string, providerId: string, modelId: string) {
    return this.update(id, (c) => ({ ...c, providerId, modelId }));
  }
  setParams(id: string, params: GenParams) {
    return this.update(id, (c) => ({ ...c, paramsJson: toJson(params) }));
  }
  setSystemPrompt(id: string, prompt: string | null) {
    return this.update(id, (c) => ({ ...c, systemPrompt: prompt?.trim() ? prompt : null }));
  }
  setCurrentLeaf(id: string, leafId: string | null) {
    return this.update(id, (c) => ({ ...c, currentLeafId: leafId }));
  }

  /** The PC and folder the chat's computer tools work in (synced), or none. */
  setComputer(id: string, computer: ComputerBinding | null) {
    return this.update(id, (c) => ({ ...c, computerHost: computer?.host ?? null, computerFolder: computer?.folder ?? null, workspace: null }));
  }

  /** Soft-deletes a conversation with its messages and attachments (tombstones sync to other devices). */
  async delete(id: string): Promise<void> {
    const now = Date.now();
    const d = db();
    await d.transaction('rw', d.conversations, d.messages, d.attachments, async () => {
      const c = await d.conversations.get(id);
      if (!c) return;
      await d.conversations.put({ ...c, deleted: 1, dirty: 1, updatedAt: now, title: '', systemPrompt: null });
      await d.messages.where('conversationId').equals(id).filter((m) => m.deleted === 0)
        .modify({ deleted: 1, dirty: 1, updatedAt: now, content: '', thinking: null, blocksJson: null });
      await d.attachments.where('conversationId').equals(id).filter((a) => a.deleted === 0).modify({ deleted: 1, dirty: 1, updatedAt: now });
    });
    this.onLocalChange();
  }

  async insertMessage(m: MessageEntity): Promise<void> {
    await db().messages.put(m);
  }

  async updateMessage(m: MessageEntity, markDirty = true): Promise<void> {
    await db().messages.put({ ...m, updatedAt: Date.now(), dirty: markDirty || m.dirty ? 1 : 0 });
    if (markDirty) this.onLocalChange();
  }

  async updateStreaming(id: string, content: string, thinking: string | null): Promise<void> {
    await db().messages.update(id, { content, thinking, updatedAt: Date.now() });
  }

  async deleteMessage(m: MessageEntity): Promise<void> {
    await db().messages.put({ ...m, deleted: 1, dirty: 1, content: '', thinking: null, blocksJson: null, updatedAt: Date.now() });
    this.onLocalChange();
  }

  /** Replies left "streaming" by a closed window become "stopped" (unless another tab is still writing them). */
  async recoverInterrupted(activeConversationIds: Set<string>): Promise<void> {
    await db().messages.where('status').equals('STREAMING').filter((m) => !activeConversationIds.has(m.conversationId))
      .modify({ status: 'STOPPED', dirty: 1 });
  }

  /** Search over message text plus title matches (a scan; IndexedDB has no full-text index). */
  async search(raw: string): Promise<{ titles: ConversationEntity[]; hits: SearchHit[] }> {
    const q = raw.trim().toLowerCase();
    if (!q) return { titles: [], hits: [] };
    const terms = q.split(/\s+/).filter(Boolean);
    const convs = await db().conversations.filter((c) => c.deleted === 0).toArray();
    const byId = new Map(convs.map((c) => [c.id, c]));
    const titles = convs.filter((c) => c.title.toLowerCase().includes(q)).sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 40);
    const hits: SearchHit[] = [];
    await db().messages.filter((m) => m.deleted === 0).each((m) => {
      const c = byId.get(m.conversationId);
      if (!c || hits.length >= 400) return;
      const text = m.content.toLowerCase();
      if (!terms.every((term) => text.includes(term))) return;
      hits.push({ messageId: m.id, conversationId: m.conversationId, title: c.title, snippet: snippet(m.content, terms[0]), role: m.role, createdAt: m.createdAt });
    });
    hits.sort((a, b) => b.createdAt - a.createdAt);
    return { titles, hits: hits.slice(0, 80) };
  }
}

/** A short excerpt around the first match, with [[ ]] around matches (as the Android FTS snippet). */
function snippet(text: string, term: string): string {
  const lower = text.toLowerCase();
  const i = lower.indexOf(term);
  const start = Math.max(0, i - 60);
  const end = Math.min(text.length, i + term.length + 90);
  let out = (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  out = out.replace(re, (m) => `[[${m}]]`);
  return out;
}
