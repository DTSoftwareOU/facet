/**
 * Continues a Claude Code or Codex session in Facet (docs/REMOTE.md): the session's messages become
 * a new chat in the same PC folder, and the chosen model picks up from there.
 */
import { newId } from '../core/ids';
import type { ConversationRepository } from '../data/conversations';
import { db } from '../data/db';
import type { ComputerBinding, MessageEntity } from '../data/entities';
import type { GenParams } from '../llm/types';
import { plain, t } from '../i18n';
import type { AgentKind, ImportedSession } from '../platform/platform';

export const AGENT_NAMES: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };

export interface ResumeTarget {
  computer: ComputerBinding | null;
  assistantId: string | null;
  providerId: string | null;
  modelId: string | null;
  params: GenParams;
}

export function resumeInstructions(agent: AgentKind, folder: string): string {
  return (
    `This chat continues a ${AGENT_NAMES[agent]} session from ${folder}. The messages so far were imported from it; ` +
    'tool calls appear as lines starting with ›. Pick up where it left off.'
  );
}

/** Creates the chat and its messages; returns the new conversation's id. */
export async function importAgentSession(conversations: ConversationRepository, agent: AgentKind, session: ImportedSession, target: ResumeTarget): Promise<string> {
  const conv = await conversations.create(target.assistantId, target.providerId, target.modelId, target.params, null, target.computer);
  const now = Date.now();
  const messages: MessageEntity[] = [];
  let parentId: string | null = null;
  let last = 0;
  const kept = session.messages.filter((m) => m.text.trim());
  kept.forEach((m, i) => {
    // Keep the original times when they're sane, but always in order (the thread sorts by time).
    const original = typeof m.at === 'number' && Number.isFinite(m.at) && m.at > 0 && m.at <= now ? m.at : now - (kept.length - i) * 1000;
    const createdAt = Math.max(last + 1, original);
    last = createdAt;
    const id = newId(createdAt);
    messages.push({
      id, conversationId: conv.id, parentId, role: m.role, content: m.text,
      modelName: m.role === 'assistant' ? AGENT_NAMES[agent] : null,
      status: 'DONE', createdAt, updatedAt: now, deleted: 0, dirty: 1,
    });
    parentId = id;
  });
  await db().messages.bulkPut(messages);
  const title = session.title.trim().slice(0, 80) || plain(t('{agent} session', { agent: AGENT_NAMES[agent] }));
  await conversations.update(
    conv.id,
    (c) => ({
      ...c,
      title,
      titleSet: true,
      systemPrompt:
        resumeInstructions(agent, session.cwd || target.computer?.folder || '') +
        (session.truncated ? ' The oldest part of the session was left out because it was very long.' : ''),
      currentLeafId: parentId,
    }),
    true,
  );
  return conv.id;
}
