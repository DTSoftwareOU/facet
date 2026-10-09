package io.dtsoftware.facet.sync

import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.data.db.AssistantEntity
import io.dtsoftware.facet.data.db.AttachmentEntity
import io.dtsoftware.facet.data.db.ConversationEntity
import io.dtsoftware.facet.data.db.FolderEntity
import io.dtsoftware.facet.data.db.MessageEntity
import io.dtsoftware.facet.data.db.PromptEntity
import io.dtsoftware.facet.data.db.ProviderEntity
import io.dtsoftware.facet.data.prefs.SyncedPrefs
import kotlinx.serialization.Serializable

/** Record type names on the wire. */
object RecordType {
    const val CONVERSATION = "conv"
    const val MESSAGE = "msg"
    const val ATTACHMENT = "att"
    const val ASSISTANT = "asst"
    const val FOLDER = "folder"
    const val PROMPT = "prompt"
    const val PROVIDER = "provider"
    const val SETTINGS = "settings"
    const val SETTINGS_ID = "user"
}

@Serializable data class ConvPayload(
    val title: String, val titleSet: Boolean, val assistantId: String?, val folderId: String?,
    val providerId: String?, val modelId: String?, val paramsJson: String, val systemPrompt: String?,
    val currentLeafId: String?, val pinned: Boolean, val archived: Boolean, val createdAt: Long, val lastActivityAt: Long,
)

@Serializable data class MsgPayload(
    val conversationId: String, val parentId: String?, val role: String, val content: String, val thinking: String?,
    val thinkingMs: Long?, val blocksJson: String?, val attachmentsJson: String?, val citationsJson: String?,
    val providerId: String?, val modelId: String?, val modelName: String?, val status: String, val errorJson: String?,
    val usageJson: String?, val costUsd: Double?, val createdAt: Long,
)

@Serializable data class AttPayload(
    val conversationId: String?, val kind: String, val mimeType: String, val name: String, val sizeBytes: Long,
    val width: Int?, val height: Int?, val uploaded: Boolean, val createdAt: Long,
)

@Serializable data class AsstPayload(
    val name: String, val emoji: String, val colorIndex: Int, val instructions: String, val providerId: String?,
    val modelId: String?, val paramsJson: String?, val startersJson: String, val sort: Int, val createdAt: Long,
)

@Serializable data class FolderPayload(val name: String, val colorIndex: Int, val sort: Int, val createdAt: Long)

@Serializable data class PromptPayload(val title: String, val body: String, val createdAt: Long)

@Serializable data class ProviderPayload(
    val kind: String, val label: String, val baseUrl: String, val apiKey: String, val headersJson: String,
    val enabled: Boolean, val favoritesJson: String, val customModelsJson: String, val capsOverridesJson: String,
    val sort: Int, val createdAt: Long,
)

/** Converts local entities to encrypted records and back. Payloads are end-to-end encrypted. */
class RecordCodec(private val vaultKey: ByteArray, private val secrets: SecretBox) {

    private fun seal(type: String, id: String, json: String) = FacetCrypto.b64(FacetCrypto.encryptRecord(vaultKey, type, id, json))
    fun open(r: RecordDto): String = FacetCrypto.decryptRecord(vaultKey, r.type, r.id, FacetCrypto.unb64(r.ct!!))

    private fun tombstone(type: String, id: String, updatedAt: Long) = RecordDto(id, type, updatedAt, deleted = true, ct = null)

    fun encode(e: ConversationEntity): RecordDto = if (e.deleted) tombstone(RecordType.CONVERSATION, e.id, e.updatedAt) else
        RecordDto(
            e.id, RecordType.CONVERSATION, e.updatedAt, false,
            seal(
                RecordType.CONVERSATION, e.id,
                AppJson.encodeToString(
                    ConvPayload(
                        e.title, e.titleSet, e.assistantId, e.folderId, e.providerId, e.modelId, e.paramsJson, e.systemPrompt,
                        e.currentLeafId, e.pinned, e.archived, e.createdAt, e.lastActivityAt,
                    ),
                ),
            ),
        )

    fun encode(e: MessageEntity): RecordDto = if (e.deleted) tombstone(RecordType.MESSAGE, e.id, e.updatedAt) else
        RecordDto(
            e.id, RecordType.MESSAGE, e.updatedAt, false,
            seal(
                RecordType.MESSAGE, e.id,
                AppJson.encodeToString(
                    MsgPayload(
                        e.conversationId, e.parentId, e.role, e.content, e.thinking, e.thinkingMs, e.blocksJson, e.attachmentsJson,
                        e.citationsJson, e.providerId, e.modelId, e.modelName, e.status, e.errorJson, e.usageJson, e.costUsd, e.createdAt,
                    ),
                ),
            ),
        )

    fun encode(e: AttachmentEntity): RecordDto = if (e.deleted) tombstone(RecordType.ATTACHMENT, e.id, e.updatedAt) else
        RecordDto(
            e.id, RecordType.ATTACHMENT, e.updatedAt, false,
            seal(
                RecordType.ATTACHMENT, e.id,
                AppJson.encodeToString(AttPayload(e.conversationId, e.kind, e.mimeType, e.name, e.sizeBytes, e.width, e.height, e.uploaded, e.createdAt)),
            ),
        )

    fun encode(e: AssistantEntity): RecordDto = if (e.deleted) tombstone(RecordType.ASSISTANT, e.id, e.updatedAt) else
        RecordDto(
            e.id, RecordType.ASSISTANT, e.updatedAt, false,
            seal(
                RecordType.ASSISTANT, e.id,
                AppJson.encodeToString(
                    AsstPayload(e.name, e.emoji, e.colorIndex, e.instructions, e.providerId, e.modelId, e.paramsJson, e.startersJson, e.sort, e.createdAt),
                ),
            ),
        )

    fun encode(e: FolderEntity): RecordDto = if (e.deleted) tombstone(RecordType.FOLDER, e.id, e.updatedAt) else
        RecordDto(e.id, RecordType.FOLDER, e.updatedAt, false, seal(RecordType.FOLDER, e.id, AppJson.encodeToString(FolderPayload(e.name, e.colorIndex, e.sort, e.createdAt))))

    fun encode(e: PromptEntity): RecordDto = if (e.deleted) tombstone(RecordType.PROMPT, e.id, e.updatedAt) else
        RecordDto(e.id, RecordType.PROMPT, e.updatedAt, false, seal(RecordType.PROMPT, e.id, AppJson.encodeToString(PromptPayload(e.title, e.body, e.createdAt))))

    fun encode(e: ProviderEntity): RecordDto {
        if (e.deleted) return tombstone(RecordType.PROVIDER, e.id, e.updatedAt)
        val key = if (e.apiKeySealed.isBlank()) "" else runCatching { secrets.openString(e.apiKeySealed) }.getOrDefault("")
        val payload = ProviderPayload(
            e.kind, e.label, e.baseUrl, key, e.headersJson, e.enabled, e.favoritesJson, e.customModelsJson, e.capsOverridesJson, e.sort, e.createdAt,
        )
        return RecordDto(e.id, RecordType.PROVIDER, e.updatedAt, false, seal(RecordType.PROVIDER, e.id, AppJson.encodeToString(payload)))
    }

    fun encode(s: SyncedPrefs): RecordDto =
        RecordDto(RecordType.SETTINGS_ID, RecordType.SETTINGS, s.updatedAt, false, seal(RecordType.SETTINGS, RecordType.SETTINGS_ID, AppJson.encodeToString(s)))

    // ---- decode (remote → local entity, clean) ----

    fun conversation(r: RecordDto): ConversationEntity {
        val p = AppJson.decodeFromString<ConvPayload>(open(r))
        return ConversationEntity(
            r.id, p.title, p.titleSet, p.assistantId, p.folderId, p.providerId, p.modelId, p.paramsJson, p.systemPrompt,
            p.currentLeafId, p.pinned, p.archived, p.createdAt, p.lastActivityAt, r.updatedAt, deleted = false, dirty = false,
        )
    }

    fun message(r: RecordDto): MessageEntity {
        val p = AppJson.decodeFromString<MsgPayload>(open(r))
        return MessageEntity(
            r.id, p.conversationId, p.parentId, p.role, p.content, p.thinking, p.thinkingMs, p.blocksJson, p.attachmentsJson,
            p.citationsJson, p.providerId, p.modelId, p.modelName, p.status, p.errorJson, p.usageJson, p.costUsd, p.createdAt,
            r.updatedAt, deleted = false, dirty = false,
        )
    }

    fun attachment(r: RecordDto, existing: AttachmentEntity?): AttachmentEntity {
        val p = AppJson.decodeFromString<AttPayload>(open(r))
        return AttachmentEntity(
            r.id, p.conversationId, p.kind, p.mimeType, p.name, p.sizeBytes, p.width, p.height,
            localFile = existing?.localFile, uploaded = p.uploaded, createdAt = p.createdAt, updatedAt = r.updatedAt,
            deleted = false, dirty = false,
        )
    }

    fun assistant(r: RecordDto): AssistantEntity {
        val p = AppJson.decodeFromString<AsstPayload>(open(r))
        return AssistantEntity(
            r.id, p.name, p.emoji, p.colorIndex, p.instructions, p.providerId, p.modelId, p.paramsJson, p.startersJson, p.sort,
            p.createdAt, r.updatedAt, deleted = false, dirty = false,
        )
    }

    fun folder(r: RecordDto): FolderEntity {
        val p = AppJson.decodeFromString<FolderPayload>(open(r))
        return FolderEntity(r.id, p.name, p.colorIndex, p.sort, p.createdAt, r.updatedAt, deleted = false, dirty = false)
    }

    fun prompt(r: RecordDto): PromptEntity {
        val p = AppJson.decodeFromString<PromptPayload>(open(r))
        return PromptEntity(r.id, p.title, p.body, p.createdAt, r.updatedAt, deleted = false, dirty = false)
    }

    fun provider(r: RecordDto, existing: ProviderEntity?): ProviderEntity {
        val p = AppJson.decodeFromString<ProviderPayload>(open(r))
        return ProviderEntity(
            id = r.id, kind = p.kind, label = p.label, baseUrl = p.baseUrl,
            apiKeySealed = if (p.apiKey.isBlank()) "" else secrets.sealString(p.apiKey),
            headersJson = p.headersJson, enabled = p.enabled,
            modelsJson = existing?.modelsJson ?: "[]", modelsFetchedAt = existing?.modelsFetchedAt ?: 0,
            favoritesJson = p.favoritesJson, customModelsJson = p.customModelsJson, capsOverridesJson = p.capsOverridesJson,
            sort = p.sort, createdAt = p.createdAt, updatedAt = r.updatedAt, deleted = false, dirty = false,
        )
    }

    fun settings(r: RecordDto): SyncedPrefs = AppJson.decodeFromString<SyncedPrefs>(open(r)).copy(updatedAt = r.updatedAt)
}
