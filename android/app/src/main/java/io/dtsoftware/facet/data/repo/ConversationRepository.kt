package io.dtsoftware.facet.data.repo

import androidx.room.withTransaction
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.db.ConversationEntity
import io.dtsoftware.facet.data.db.FacetDatabase
import io.dtsoftware.facet.data.db.MessageEntity
import io.dtsoftware.facet.data.db.SearchHit
import io.dtsoftware.facet.llm.GenParams
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

class ConversationRepository(
    private val db: FacetDatabase,
    private val onLocalChange: () -> Unit,
) {
    private val conversations = db.conversations()
    private val messages = db.messages()

    fun observeConversations(archived: Boolean = false): Flow<List<ConversationEntity>> = conversations.observeList(archived)
    fun observeConversation(id: String): Flow<ConversationEntity?> = conversations.observe(id)
    fun observeMessages(conversationId: String): Flow<List<MessageEntity>> = messages.observeForConversation(conversationId)
    fun observeCost(conversationId: String): Flow<Double> = messages.observeCost(conversationId).map { it?.total ?: 0.0 }

    suspend fun get(id: String): ConversationEntity? = conversations.get(id)
    suspend fun messages(conversationId: String): List<MessageEntity> = messages.forConversation(conversationId)
    suspend fun message(id: String): MessageEntity? = messages.get(id)

    suspend fun create(
        assistantId: String?,
        providerId: String?,
        modelId: String?,
        params: GenParams,
        folderId: String? = null,
        computerHost: String? = null,
        computerFolder: String? = null,
    ): ConversationEntity {
        val now = Clock.now()
        val c = ConversationEntity(
            id = Ids.new(),
            title = "New chat",
            assistantId = assistantId,
            folderId = folderId,
            providerId = providerId,
            modelId = modelId,
            paramsJson = AppJson.encodeToString(params),
            createdAt = now,
            lastActivityAt = now,
            updatedAt = now,
            computerHost = computerHost,
            computerFolder = computerFolder?.takeIf { computerHost != null },
        )
        conversations.upsert(c)
        return c
    }

    /** Stores a chat created whole, e.g. one continued from a Claude Code session, with its messages. */
    suspend fun insertWithMessages(conversation: ConversationEntity, messages: List<MessageEntity>) {
        db.withTransaction {
            conversations.upsert(conversation)
            this.messages.upsertAll(messages)
        }
        onLocalChange()
    }

    /** Applies [transform] and marks the conversation for sync. */
    suspend fun update(id: String, touchActivity: Boolean = false, transform: (ConversationEntity) -> ConversationEntity) {
        val current = conversations.get(id) ?: return
        val now = Clock.now()
        val next = transform(current).copy(
            updatedAt = now,
            lastActivityAt = if (touchActivity) now else current.lastActivityAt,
            dirty = true,
        )
        conversations.upsert(next)
        onLocalChange()
    }

    suspend fun rename(id: String, title: String) = update(id) { it.copy(title = title.trim().ifEmpty { "Untitled" }, titleSet = true) }
    suspend fun setPinned(id: String, pinned: Boolean) = update(id) { it.copy(pinned = pinned) }
    suspend fun setArchived(id: String, archived: Boolean) = update(id) { it.copy(archived = archived) }
    suspend fun moveToFolder(id: String, folderId: String?) = update(id) { it.copy(folderId = folderId) }
    suspend fun setModel(id: String, providerId: String, modelId: String) = update(id) { it.copy(providerId = providerId, modelId = modelId) }
    suspend fun setParams(id: String, params: GenParams) = update(id) { it.copy(paramsJson = AppJson.encodeToString(params)) }
    suspend fun setSystemPrompt(id: String, prompt: String?) = update(id) { it.copy(systemPrompt = prompt?.takeIf { p -> p.isNotBlank() }) }
    suspend fun setCurrentLeaf(id: String, leafId: String?) = update(id) { it.copy(currentLeafId = leafId) }

    /** Binds the chat to a PC and a folder on it, or to none (both null). */
    suspend fun setComputer(id: String, hostId: String?, folder: String?) =
        update(id) { it.copy(computerHost = hostId, computerFolder = folder?.takeIf { hostId != null }) }

    /** Soft-deletes a conversation with its messages and attachments (tombstones sync to other devices). */
    suspend fun delete(id: String) {
        val now = Clock.now()
        db.withTransaction {
            val c = conversations.get(id) ?: return@withTransaction
            conversations.upsert(c.copy(deleted = true, dirty = true, updatedAt = now, title = "", systemPrompt = null, computerFolder = null))
            messages.tombstoneConversation(id, now)
            db.attachments().tombstoneConversation(id, now)
        }
        onLocalChange()
    }

    suspend fun insertMessage(message: MessageEntity) {
        messages.upsert(message)
    }

    suspend fun updateMessage(message: MessageEntity, markDirty: Boolean = true) {
        messages.upsert(message.copy(updatedAt = Clock.now(), dirty = markDirty || message.dirty))
        if (markDirty) onLocalChange()
    }

    suspend fun updateStreaming(id: String, content: String, thinking: String?) =
        messages.updateStreaming(id, content, thinking, Clock.now())

    suspend fun deleteMessage(message: MessageEntity) {
        messages.upsert(message.copy(deleted = true, dirty = true, content = "", thinking = null, blocksJson = null, updatedAt = Clock.now()))
        onLocalChange()
    }

    suspend fun recoverInterrupted() = messages.recoverInterrupted()

    /** Full-text search over message bodies plus title matches. */
    suspend fun search(raw: String): Pair<List<ConversationEntity>, List<SearchHit>> {
        val q = raw.trim()
        if (q.isEmpty()) return emptyList<ConversationEntity>() to emptyList()
        val titleHits = conversations.searchTitles(q)
        val fts = q.split(Regex("\\s+"))
            .map { it.replace("\"", "").replace("*", "") }
            .filter { it.isNotBlank() }
            .joinToString(" ") { "\"$it\"*" }
        val hits = if (fts.isBlank()) emptyList() else runCatching { messages.search(fts) }.getOrDefault(emptyList())
        return titleHits to hits
    }
}
