package io.dtsoftware.facet.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Fts4
import androidx.room.Index
import androidx.room.PrimaryKey

/*
 * Every synced entity has: updatedAt (last-writer-wins key), deleted (tombstone), dirty (needs push).
 * Tombstoned rows are kept until pushed, then purged.
 */

@Entity(
    tableName = "conversations",
    indices = [Index("lastActivityAt"), Index("folderId"), Index("dirty")],
)
data class ConversationEntity(
    @PrimaryKey val id: String,
    val title: String,
    /** True once a title was generated or set by the user (stops auto-titling). */
    val titleSet: Boolean = false,
    val assistantId: String? = null,
    val folderId: String? = null,
    val providerId: String? = null,
    val modelId: String? = null,
    /** GenParams JSON. */
    val paramsJson: String = "{}",
    /** Per-chat instructions added on top of the assistant and custom instructions. */
    val systemPrompt: String? = null,
    /** Leaf of the selected branch. */
    val currentLeafId: String? = null,
    val pinned: Boolean = false,
    val archived: Boolean = false,
    val createdAt: Long,
    val lastActivityAt: Long,
    val updatedAt: Long,
    val deleted: Boolean = false,
    val dirty: Boolean = true,
)

@Entity(
    tableName = "messages",
    indices = [Index("conversationId"), Index("parentId"), Index("dirty")],
)
data class MessageEntity(
    @PrimaryKey val id: String,
    val conversationId: String,
    val parentId: String? = null,
    /** "user" or "assistant". */
    val role: String,
    val content: String = "",
    val thinking: String? = null,
    val thinkingMs: Long? = null,
    /** ProviderBlocks JSON for lossless replay. */
    val blocksJson: String? = null,
    /** List<AttachmentRef> JSON. */
    val attachmentsJson: String? = null,
    /** List<Citation> JSON. */
    val citationsJson: String? = null,
    val providerId: String? = null,
    val modelId: String? = null,
    val modelName: String? = null,
    /** MessageStatus name. */
    val status: String = MessageStatus.DONE.name,
    /** MessageError JSON. */
    val errorJson: String? = null,
    /** Usage JSON. */
    val usageJson: String? = null,
    val costUsd: Double? = null,
    val createdAt: Long,
    val updatedAt: Long,
    val deleted: Boolean = false,
    val dirty: Boolean = true,
)

enum class MessageStatus { DONE, STREAMING, STOPPED, ERROR, REFUSED, TRUNCATED }

@Fts4(contentEntity = MessageEntity::class)
@Entity(tableName = "messages_fts")
data class MessageFts(
    @ColumnInfo(name = "content") val content: String,
)

@Entity(tableName = "attachments", indices = [Index("conversationId"), Index("dirty")])
data class AttachmentEntity(
    @PrimaryKey val id: String,
    val conversationId: String? = null,
    /** "image", "pdf", "text", "file". */
    val kind: String,
    val mimeType: String,
    val name: String,
    val sizeBytes: Long,
    val width: Int? = null,
    val height: Int? = null,
    /** File name inside filesDir/attachments, null until downloaded. */
    val localFile: String? = null,
    /** True once the encrypted blob is on the sync server. */
    val uploaded: Boolean = false,
    val createdAt: Long,
    val updatedAt: Long,
    val deleted: Boolean = false,
    val dirty: Boolean = true,
)

@Entity(tableName = "assistants", indices = [Index("dirty")])
data class AssistantEntity(
    @PrimaryKey val id: String,
    val name: String,
    val emoji: String,
    val colorIndex: Int = 0,
    val instructions: String,
    val providerId: String? = null,
    val modelId: String? = null,
    val paramsJson: String? = null,
    /** List<String> JSON. */
    val startersJson: String = "[]",
    val sort: Int = 0,
    val createdAt: Long,
    val updatedAt: Long,
    val deleted: Boolean = false,
    val dirty: Boolean = true,
)

@Entity(tableName = "folders", indices = [Index("dirty")])
data class FolderEntity(
    @PrimaryKey val id: String,
    val name: String,
    val colorIndex: Int = 0,
    val sort: Int = 0,
    val createdAt: Long,
    val updatedAt: Long,
    val deleted: Boolean = false,
    val dirty: Boolean = true,
)

@Entity(tableName = "prompts", indices = [Index("dirty")])
data class PromptEntity(
    @PrimaryKey val id: String,
    val title: String,
    val body: String,
    val createdAt: Long,
    val updatedAt: Long,
    val deleted: Boolean = false,
    val dirty: Boolean = true,
)

@Entity(tableName = "providers", indices = [Index("dirty")])
data class ProviderEntity(
    @PrimaryKey val id: String,
    /** ProviderKind.id */
    val kind: String,
    val label: String,
    val baseUrl: String,
    /** API key sealed with the local SecretBox ("" when none). */
    val apiKeySealed: String = "",
    /** Map<String,String> JSON of extra headers. */
    val headersJson: String = "{}",
    val enabled: Boolean = true,
    /** Cached List<ModelInfo> JSON (local only, refreshed from the provider). */
    val modelsJson: String = "[]",
    val modelsFetchedAt: Long = 0,
    /** List<String> JSON of favorite model ids. */
    val favoritesJson: String = "[]",
    /** List<ModelInfo> JSON of manually added models. */
    val customModelsJson: String = "[]",
    /** Map<modelId, ModelCaps> JSON of user overrides. */
    val capsOverridesJson: String = "{}",
    val sort: Int = 0,
    val createdAt: Long,
    val updatedAt: Long,
    val deleted: Boolean = false,
    val dirty: Boolean = true,
)
