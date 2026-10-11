package io.dtsoftware.facet.remote

import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.db.ConversationEntity
import io.dtsoftware.facet.data.db.MessageEntity
import io.dtsoftware.facet.data.db.MessageStatus
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.llm.GenParams

/** The coding agents whose sessions a chat can continue (docs/REMOTE.md, "Continuing a Claude Code or Codex session"). */
enum class CodingAgent(val id: String, val displayName: String, val feature: String) {
    CLAUDE("claude", "Claude Code", RemoteFeature.CLAUDE),
    CODEX("codex", "Codex", RemoteFeature.CODEX),
}

/** Turns a session read from a PC (`agents.read`) into a new chat with the imported messages. */
object AgentImport {
    fun instructions(agent: CodingAgent, folder: String): String =
        "This chat continues a ${agent.displayName} session from $folder. The messages so far were imported from it; " +
            "tool calls appear as lines starting with ›. Pick up where it left off."

    /** A title for the session: its own, else its first prompt's first line. */
    fun title(session: AgentSession, agent: CodingAgent): String =
        session.title.trim().ifBlank {
            session.messages.firstOrNull { it.role == "user" && it.text.isNotBlank() }?.text?.trim()?.lineSequence()?.firstOrNull()?.take(60)
        }?.takeIf { it.isNotBlank() } ?: Strings.get(R.string.remote_import_title, agent.displayName)

    /**
     * The new chat (same PC and folder, the composer's model) and its messages as one branch: every message DONE,
     * assistant messages from [CodingAgent.displayName] with no provider or model id. Throws when nothing is left to import.
     */
    fun build(
        session: AgentSession,
        agent: CodingAgent,
        hostId: String,
        folder: String,
        model: ModelRef?,
        params: GenParams,
        now: Long,
    ): Pair<ConversationEntity, List<MessageEntity>> {
        val source = session.messages.filter { it.text.isNotBlank() && (it.role == "user" || it.role == "assistant") }
        if (source.isEmpty()) throw IllegalArgumentException(Strings.get(R.string.remote_import_empty))
        val convId = Ids.new()
        // Keep the session's times when it has them, strictly increasing and never in the future.
        var t = (source.first().at ?: (session.updatedAt.takeIf { it > 0 } ?: now) - source.size).coerceAtMost(now - source.size)
        var parent: String? = null
        val messages = source.mapIndexed { i, m ->
            if (i > 0) t = maxOf((m.at ?: 0).coerceAtMost(now), t + 1)
            val msg = MessageEntity(
                id = Ids.new(),
                conversationId = convId,
                parentId = parent,
                role = m.role,
                content = m.text.trim(),
                modelName = if (m.role == "assistant") agent.displayName else null,
                status = MessageStatus.DONE.name,
                createdAt = t,
                updatedAt = now,
            )
            parent = msg.id
            msg
        }
        val conversation = ConversationEntity(
            id = convId,
            title = title(session, agent),
            titleSet = true,
            providerId = model?.providerId,
            modelId = model?.modelId,
            paramsJson = AppJson.encodeToString(params),
            systemPrompt = instructions(agent, folder),
            currentLeafId = messages.last().id,
            createdAt = now,
            lastActivityAt = now,
            updatedAt = now,
            computerHost = hostId,
            computerFolder = folder,
        )
        return conversation to messages
    }
}
