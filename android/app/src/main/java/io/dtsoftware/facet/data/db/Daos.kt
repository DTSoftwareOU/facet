package io.dtsoftware.facet.data.db

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

data class SearchHit(
    val messageId: String,
    val conversationId: String,
    val title: String,
    val snippet: String,
    val role: String,
    val createdAt: Long,
)

data class ConversationCost(val conversationId: String, val total: Double?)

@Dao
interface ConversationDao {
    @Query("SELECT id FROM conversations WHERE dirty = 0")
    suspend fun cleanIds(): List<String>

    @Query("SELECT * FROM conversations WHERE deleted = 0 AND archived = :archived ORDER BY pinned DESC, lastActivityAt DESC")
    fun observeList(archived: Boolean = false): Flow<List<ConversationEntity>>

    @Query("SELECT * FROM conversations WHERE id = :id")
    fun observe(id: String): Flow<ConversationEntity?>

    @Query("SELECT * FROM conversations WHERE id = :id")
    suspend fun get(id: String): ConversationEntity?

    @Query("SELECT * FROM conversations WHERE deleted = 0 AND title LIKE '%' || :q || '%' ORDER BY lastActivityAt DESC LIMIT 40")
    suspend fun searchTitles(q: String): List<ConversationEntity>

    @Upsert suspend fun upsert(entity: ConversationEntity)
    @Upsert suspend fun upsertAll(entities: List<ConversationEntity>)

    @Query("SELECT * FROM conversations WHERE dirty = 1 LIMIT :limit")
    suspend fun dirty(limit: Int): List<ConversationEntity>

    @Query("UPDATE conversations SET dirty = 0 WHERE id = :id AND updatedAt = :updatedAt")
    suspend fun markClean(id: String, updatedAt: Long)

    @Query("DELETE FROM conversations WHERE deleted = 1 AND dirty = 0")
    suspend fun purgeTombstones()

    @Query("DELETE FROM conversations WHERE id = :id")
    suspend fun hardDelete(id: String)

    @Query("UPDATE conversations SET dirty = 1")
    suspend fun markAllDirty()

    @Query("SELECT COUNT(*) FROM conversations WHERE deleted = 0")
    suspend fun count(): Int

    @Query("SELECT * FROM conversations WHERE deleted = 0 ORDER BY lastActivityAt DESC")
    suspend fun all(): List<ConversationEntity>

    @Query("DELETE FROM conversations")
    suspend fun clear()
}

@Dao
interface MessageDao {
    @Query("SELECT id FROM messages WHERE dirty = 0")
    suspend fun cleanIds(): List<String>

    @Query("SELECT * FROM messages WHERE conversationId = :conversationId AND deleted = 0 ORDER BY createdAt, id")
    fun observeForConversation(conversationId: String): Flow<List<MessageEntity>>

    @Query("SELECT * FROM messages WHERE conversationId = :conversationId AND deleted = 0 ORDER BY createdAt, id")
    suspend fun forConversation(conversationId: String): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE id = :id")
    suspend fun get(id: String): MessageEntity?

    @Upsert suspend fun upsert(entity: MessageEntity)
    @Upsert suspend fun upsertAll(entities: List<MessageEntity>)

    @Query("UPDATE messages SET content = :content, thinking = :thinking, updatedAt = :updatedAt WHERE id = :id")
    suspend fun updateStreaming(id: String, content: String, thinking: String?, updatedAt: Long)

    @Query("SELECT * FROM messages WHERE dirty = 1 AND status != 'STREAMING' LIMIT :limit")
    suspend fun dirty(limit: Int): List<MessageEntity>

    @Query("UPDATE messages SET dirty = 0 WHERE id = :id AND updatedAt = :updatedAt")
    suspend fun markClean(id: String, updatedAt: Long)

    @Query(
        "UPDATE messages SET deleted = 1, dirty = 1, updatedAt = :now, content = '', thinking = NULL, blocksJson = NULL " +
            "WHERE conversationId = :conversationId AND deleted = 0",
    )
    suspend fun tombstoneConversation(conversationId: String, now: Long)

    @Query("DELETE FROM messages WHERE deleted = 1 AND dirty = 0")
    suspend fun purgeTombstones()

    @Query("DELETE FROM messages WHERE conversationId = :conversationId")
    suspend fun hardDeleteConversation(conversationId: String)

    @Query("DELETE FROM messages WHERE id = :id")
    suspend fun hardDelete(id: String)

    @Query("UPDATE messages SET status = 'STOPPED', dirty = 1 WHERE status = 'STREAMING'")
    suspend fun recoverInterrupted()

    @Query("UPDATE messages SET dirty = 1")
    suspend fun markAllDirty()

    @Query("SELECT conversationId, SUM(costUsd) AS total FROM messages WHERE conversationId = :conversationId AND deleted = 0")
    fun observeCost(conversationId: String): Flow<ConversationCost?>

    @Query(
        """
        SELECT m.id AS messageId, m.conversationId AS conversationId, c.title AS title,
               snippet(messages_fts, '[[', ']]', '…', -1, 14) AS snippet, m.role AS role, m.createdAt AS createdAt
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        JOIN conversations c ON c.id = m.conversationId
        WHERE messages_fts MATCH :query AND m.deleted = 0 AND c.deleted = 0
        ORDER BY m.createdAt DESC
        LIMIT 80
        """,
    )
    suspend fun search(query: String): List<SearchHit>

    @Query("DELETE FROM messages")
    suspend fun clear()
}

@Dao
interface AttachmentDao {
    @Query("SELECT id FROM attachments WHERE dirty = 0")
    suspend fun cleanIds(): List<String>

    @Query("SELECT * FROM attachments WHERE id = :id")
    suspend fun get(id: String): AttachmentEntity?

    @Query("SELECT * FROM attachments WHERE id IN (:ids)")
    suspend fun getAll(ids: List<String>): List<AttachmentEntity>

    @Query("SELECT * FROM attachments WHERE id IN (:ids)")
    fun observeAll(ids: List<String>): Flow<List<AttachmentEntity>>

    @Upsert suspend fun upsert(entity: AttachmentEntity)

    @Query("SELECT * FROM attachments WHERE dirty = 1 LIMIT :limit")
    suspend fun dirty(limit: Int): List<AttachmentEntity>

    @Query("SELECT * FROM attachments WHERE deleted = 0 AND uploaded = 0 AND localFile IS NOT NULL LIMIT :limit")
    suspend fun pendingUpload(limit: Int): List<AttachmentEntity>

    @Query("SELECT * FROM attachments WHERE deleted = 0 AND localFile IS NULL AND uploaded = 1 AND kind = 'image' AND sizeBytes < :maxBytes LIMIT :limit")
    suspend fun pendingDownload(maxBytes: Long, limit: Int): List<AttachmentEntity>

    @Query("UPDATE attachments SET dirty = 0 WHERE id = :id AND updatedAt = :updatedAt")
    suspend fun markClean(id: String, updatedAt: Long)

    @Query("UPDATE attachments SET uploaded = 1 WHERE id = :id")
    suspend fun markUploaded(id: String)

    @Query("UPDATE attachments SET localFile = :file WHERE id = :id")
    suspend fun setLocalFile(id: String, file: String)

    @Query("UPDATE attachments SET deleted = 1, dirty = 1, updatedAt = :now WHERE conversationId = :conversationId AND deleted = 0")
    suspend fun tombstoneConversation(conversationId: String, now: Long)

    @Query("SELECT * FROM attachments WHERE deleted = 1 AND dirty = 0")
    suspend fun purgeable(): List<AttachmentEntity>

    @Query("DELETE FROM attachments WHERE id = :id")
    suspend fun hardDelete(id: String)

    @Query("SELECT * FROM attachments WHERE deleted = 0 AND conversationId IS NOT NULL ORDER BY sizeBytes DESC LIMIT :limit")
    fun observeLargest(limit: Int): Flow<List<AttachmentEntity>>

    @Query("SELECT COUNT(*) FROM attachments WHERE deleted = 0 AND localOnly = 1")
    fun observeLocalOnlyCount(): Flow<Int>

    /** Files in sync storage that this device also holds, oldest first: what automatic clean-up may remove from the cloud. */
    @Query("SELECT * FROM attachments WHERE deleted = 0 AND uploaded = 1 AND localOnly = 0 AND localFile IS NOT NULL AND conversationId IS NOT NULL AND createdAt < :before ORDER BY createdAt, id")
    suspend fun inCloudOldestFirst(before: Long): List<AttachmentEntity>

    /** Files that couldn't upload because sync storage was full (their records synced), oldest first. */
    @Query("SELECT * FROM attachments WHERE deleted = 0 AND uploaded = 0 AND localOnly = 0 AND dirty = 0 AND localFile IS NOT NULL AND conversationId IS NOT NULL AND sizeBytes <= :maxBytes ORDER BY createdAt, id")
    suspend fun waitingForSpace(maxBytes: Long): List<AttachmentEntity>

    /** Queues a file to upload again; a newer updatedAt so its record wins over the synced "not uploaded" one. */
    @Query("UPDATE attachments SET dirty = 1, updatedAt = :now WHERE id = :id")
    suspend fun requeue(id: String, now: Long)

    /** Keeps a synced file on this device only: the record syncs again with uploaded = false. */
    @Query("UPDATE attachments SET localOnly = 1, uploaded = 0, dirty = 1, updatedAt = :now WHERE id = :id")
    suspend fun unsync(id: String, now: Long)

    /** Uploads files kept on this device again (after space was freed). */
    @Query("UPDATE attachments SET localOnly = 0, dirty = 1, updatedAt = :now WHERE localOnly = 1 AND deleted = 0")
    suspend fun retryLocalOnly(now: Long)

    @Query("SELECT * FROM attachments WHERE deleted = 0 AND uploaded = 1 AND localOnly = 0 AND localFile IS NOT NULL")
    suspend fun downloadedCopies(): List<AttachmentEntity>

    @Query("UPDATE attachments SET localFile = NULL WHERE id = :id")
    suspend fun clearLocalFile(id: String)

    @Query("UPDATE attachments SET dirty = 1, uploaded = 0")
    suspend fun markAllDirty()

    @Query("SELECT * FROM attachments WHERE deleted = 0")
    suspend fun all(): List<AttachmentEntity>

    @Query("DELETE FROM attachments")
    suspend fun clear()
}

@Dao
interface AssistantDao {
    @Query("SELECT id FROM assistants WHERE dirty = 0")
    suspend fun cleanIds(): List<String>

    @Query("SELECT * FROM assistants WHERE deleted = 0 ORDER BY sort, createdAt")
    fun observeAll(): Flow<List<AssistantEntity>>

    @Query("SELECT * FROM assistants WHERE id = :id")
    suspend fun get(id: String): AssistantEntity?

    @Upsert suspend fun upsert(entity: AssistantEntity)

    @Query("SELECT * FROM assistants WHERE dirty = 1 LIMIT :limit")
    suspend fun dirty(limit: Int): List<AssistantEntity>

    @Query("UPDATE assistants SET dirty = 0 WHERE id = :id AND updatedAt = :updatedAt")
    suspend fun markClean(id: String, updatedAt: Long)

    @Query("DELETE FROM assistants WHERE deleted = 1 AND dirty = 0")
    suspend fun purgeTombstones()

    @Query("DELETE FROM assistants WHERE id = :id")
    suspend fun hardDelete(id: String)

    @Query("UPDATE assistants SET dirty = 1")
    suspend fun markAllDirty()

    @Query("DELETE FROM assistants")
    suspend fun clear()
}

@Dao
interface FolderDao {
    @Query("SELECT id FROM folders WHERE dirty = 0")
    suspend fun cleanIds(): List<String>

    @Query("SELECT * FROM folders WHERE deleted = 0 ORDER BY sort, name")
    fun observeAll(): Flow<List<FolderEntity>>

    @Query("SELECT * FROM folders WHERE id = :id")
    suspend fun get(id: String): FolderEntity?

    @Upsert suspend fun upsert(entity: FolderEntity)

    @Query("SELECT * FROM folders WHERE dirty = 1 LIMIT :limit")
    suspend fun dirty(limit: Int): List<FolderEntity>

    @Query("UPDATE folders SET dirty = 0 WHERE id = :id AND updatedAt = :updatedAt")
    suspend fun markClean(id: String, updatedAt: Long)

    @Query("DELETE FROM folders WHERE deleted = 1 AND dirty = 0")
    suspend fun purgeTombstones()

    @Query("DELETE FROM folders WHERE id = :id")
    suspend fun hardDelete(id: String)

    @Query("UPDATE folders SET dirty = 1")
    suspend fun markAllDirty()

    @Query("DELETE FROM folders")
    suspend fun clear()
}

@Dao
interface PromptDao {
    @Query("SELECT id FROM prompts WHERE dirty = 0")
    suspend fun cleanIds(): List<String>

    @Query("SELECT * FROM prompts WHERE deleted = 0 ORDER BY title COLLATE NOCASE")
    fun observeAll(): Flow<List<PromptEntity>>

    @Query("SELECT * FROM prompts WHERE id = :id")
    suspend fun get(id: String): PromptEntity?

    @Upsert suspend fun upsert(entity: PromptEntity)

    @Query("SELECT * FROM prompts WHERE dirty = 1 LIMIT :limit")
    suspend fun dirty(limit: Int): List<PromptEntity>

    @Query("UPDATE prompts SET dirty = 0 WHERE id = :id AND updatedAt = :updatedAt")
    suspend fun markClean(id: String, updatedAt: Long)

    @Query("DELETE FROM prompts WHERE deleted = 1 AND dirty = 0")
    suspend fun purgeTombstones()

    @Query("DELETE FROM prompts WHERE id = :id")
    suspend fun hardDelete(id: String)

    @Query("UPDATE prompts SET dirty = 1")
    suspend fun markAllDirty()

    @Query("DELETE FROM prompts")
    suspend fun clear()
}

@Dao
interface ProviderDao {
    @Query("SELECT id FROM providers WHERE dirty = 0")
    suspend fun cleanIds(): List<String>

    @Query("SELECT * FROM providers WHERE deleted = 0 ORDER BY sort, createdAt")
    fun observeAll(): Flow<List<ProviderEntity>>

    @Query("SELECT * FROM providers WHERE deleted = 0 ORDER BY sort, createdAt")
    suspend fun all(): List<ProviderEntity>

    @Query("SELECT * FROM providers WHERE id = :id")
    suspend fun get(id: String): ProviderEntity?

    @Query("SELECT * FROM providers WHERE id = :id")
    fun observe(id: String): Flow<ProviderEntity?>

    @Upsert suspend fun upsert(entity: ProviderEntity)

    @Query("UPDATE providers SET modelsJson = :modelsJson, modelsFetchedAt = :fetchedAt WHERE id = :id")
    suspend fun setModels(id: String, modelsJson: String, fetchedAt: Long)

    @Query("SELECT * FROM providers WHERE dirty = 1 LIMIT :limit")
    suspend fun dirty(limit: Int): List<ProviderEntity>

    @Query("UPDATE providers SET dirty = 0 WHERE id = :id AND updatedAt = :updatedAt")
    suspend fun markClean(id: String, updatedAt: Long)

    @Query("DELETE FROM providers WHERE deleted = 1 AND dirty = 0")
    suspend fun purgeTombstones()

    @Query("DELETE FROM providers WHERE id = :id")
    suspend fun hardDelete(id: String)

    @Query("UPDATE providers SET dirty = 1")
    suspend fun markAllDirty()

    @Query("DELETE FROM providers")
    suspend fun clear()
}

@Dao
interface McpServerDao {
    @Query("SELECT id FROM mcp_servers WHERE dirty = 0")
    suspend fun cleanIds(): List<String>

    @Query("SELECT * FROM mcp_servers WHERE deleted = 0 ORDER BY sort, createdAt")
    fun observeAll(): Flow<List<McpServerEntity>>

    @Query("SELECT * FROM mcp_servers WHERE deleted = 0 ORDER BY sort, createdAt")
    suspend fun all(): List<McpServerEntity>

    @Query("SELECT * FROM mcp_servers WHERE id = :id")
    suspend fun get(id: String): McpServerEntity?

    @Query("SELECT * FROM mcp_servers WHERE id = :id")
    fun observe(id: String): Flow<McpServerEntity?>

    @Upsert suspend fun upsert(entity: McpServerEntity)

    @Query("UPDATE mcp_servers SET toolsJson = :toolsJson, toolsFetchedAt = :fetchedAt, instructions = :instructions, status = NULL WHERE id = :id")
    suspend fun setTools(id: String, toolsJson: String, fetchedAt: Long, instructions: String?)

    @Query("UPDATE mcp_servers SET status = :status WHERE id = :id")
    suspend fun setStatus(id: String, status: String?)

    @Query("SELECT * FROM mcp_servers WHERE dirty = 1 LIMIT :limit")
    suspend fun dirty(limit: Int): List<McpServerEntity>

    @Query("UPDATE mcp_servers SET dirty = 0 WHERE id = :id AND updatedAt = :updatedAt")
    suspend fun markClean(id: String, updatedAt: Long)

    @Query("DELETE FROM mcp_servers WHERE deleted = 1 AND dirty = 0")
    suspend fun purgeTombstones()

    @Query("DELETE FROM mcp_servers WHERE id = :id")
    suspend fun hardDelete(id: String)

    @Query("UPDATE mcp_servers SET dirty = 1")
    suspend fun markAllDirty()

    @Query("DELETE FROM mcp_servers")
    suspend fun clear()
}

@Dao
interface SkillDao {
    @Query("SELECT id FROM skills WHERE dirty = 0")
    suspend fun cleanIds(): List<String>

    @Query("SELECT * FROM skills WHERE deleted = 0 ORDER BY name COLLATE NOCASE")
    fun observeAll(): Flow<List<SkillEntity>>

    @Query("SELECT * FROM skills WHERE deleted = 0 ORDER BY name COLLATE NOCASE")
    suspend fun all(): List<SkillEntity>

    @Query("SELECT * FROM skills WHERE id = :id")
    suspend fun get(id: String): SkillEntity?

    @Upsert suspend fun upsert(entity: SkillEntity)

    @Query("SELECT * FROM skills WHERE dirty = 1 LIMIT :limit")
    suspend fun dirty(limit: Int): List<SkillEntity>

    @Query("UPDATE skills SET dirty = 0 WHERE id = :id AND updatedAt = :updatedAt")
    suspend fun markClean(id: String, updatedAt: Long)

    @Query("DELETE FROM skills WHERE deleted = 1 AND dirty = 0")
    suspend fun purgeTombstones()

    @Query("DELETE FROM skills WHERE id = :id")
    suspend fun hardDelete(id: String)

    @Query("UPDATE skills SET dirty = 1")
    suspend fun markAllDirty()

    @Query("DELETE FROM skills")
    suspend fun clear()
}
