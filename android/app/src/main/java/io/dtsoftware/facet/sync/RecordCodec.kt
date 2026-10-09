package io.dtsoftware.facet.sync

import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.data.db.AssistantEntity
import io.dtsoftware.facet.data.db.AttachmentEntity
import io.dtsoftware.facet.data.db.ConversationEntity
import io.dtsoftware.facet.data.db.FolderEntity
import io.dtsoftware.facet.data.db.McpServerEntity
import io.dtsoftware.facet.data.db.MessageEntity
import io.dtsoftware.facet.data.db.PromptEntity
import io.dtsoftware.facet.data.db.ProviderEntity
import io.dtsoftware.facet.data.db.SkillEntity
import io.dtsoftware.facet.data.prefs.SyncedPrefs
import io.dtsoftware.facet.mcp.McpOAuthState
import java.nio.charset.StandardCharsets.UTF_8
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Logical record types. They never appear on the wire (see [RecordCodec]). */
object RecordType {
    const val CONVERSATION = "conv"
    const val MESSAGE = "msg"
    const val ATTACHMENT = "att"
    const val ASSISTANT = "asst"
    const val FOLDER = "folder"
    const val PROMPT = "prompt"
    const val PROVIDER = "provider"
    const val MCP = "mcp"
    const val SKILL = "skill"
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
    val usageJson: String?, val costUsd: Double?, val createdAt: Long, val stepsJson: String? = null,
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

@Serializable data class McpPayload(
    val name: String, val url: String, val authMode: String, val headers: Map<String, String>, val oauth: McpOAuthState?,
    val enabled: Boolean, val approval: String, val disabledToolsJson: String, val autoApprovedJson: String,
    val sort: Int, val createdAt: Long,
)

@Serializable data class SkillPayload(
    val name: String, val description: String, val instructions: String, val resourcesJson: String,
    val enabled: Boolean, val alwaysOn: Boolean, val sourceUrl: String?, val createdAt: Long,
)

/** A record after decryption: its real type, id and payload JSON (null for deletions). */
data class OpenedRecord(val type: String, val id: String, val updatedAt: Long, val deleted: Boolean, val payload: String?)

/**
 * Converts local entities to end-to-end encrypted records and back (docs/SECURITY.md).
 *
 * Metadata hardening: on the wire every record has the type [WIRE_TYPE] and an opaque id
 * `HMAC-SHA256(recordIdKey, type:id)`; the real type and id travel inside the ciphertext, the
 * plaintext is padded to size buckets, and deletions are encrypted too. The server learns only
 * how many records exist, their padded sizes and when they changed.
 */
class RecordCodec(private val vaultKey: ByteArray, private val secrets: SecretBox) {
    private val idKey = FacetCrypto.hkdf(vaultKey, "facet:record-id:v1")

    private fun hmacId(input: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(idKey, "HmacSHA256"))
        val digest = mac.doFinal(input.toByteArray(UTF_8)).copyOf(24)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
    }

    fun wireId(type: String, id: String): String = hmacId("rec:$type:$id")

    /** Opaque server-side id for an attachment's encrypted file. */
    fun blobId(attachmentId: String): String = hmacId("blob:$attachmentId")

    private fun seal(type: String, id: String, updatedAt: Long, deleted: Boolean, payloadJson: String?): RecordDto {
        val wid = wireId(type, id)
        val inner = buildJsonObject {
            put("t", type)
            put("i", id)
            if (payloadJson != null) put("d", AppJson.parseToJsonElement(payloadJson))
        }
        val ct = FacetCrypto.encryptRecord(vaultKey, WIRE_TYPE, wid, AppJson.encodeToString(JsonObject.serializer(), inner), pad = true)
        return RecordDto(wid, WIRE_TYPE, updatedAt, deleted, FacetCrypto.b64(ct))
    }

    /** Decrypts a pulled record. Returns null for legacy/unknown records without ciphertext. */
    fun open(r: RecordDto): OpenedRecord? {
        val ct = r.ct ?: return null
        val json = FacetCrypto.decryptRecord(vaultKey, r.type, r.id, FacetCrypto.unb64(ct))
        val obj = AppJson.parseToJsonElement(json).jsonObject
        val type = obj["t"]?.jsonPrimitive?.content ?: return null
        val id = obj["i"]?.jsonPrimitive?.content ?: return null
        // The id is bound to its content: a server can't move a record to another id.
        if (wireId(type, id) != r.id) throw io.dtsoftware.facet.core.crypto.DecryptionException("Record id mismatch")
        val payload = obj["d"]?.let { AppJson.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), it) }
        return OpenedRecord(type, id, r.updatedAt, r.deleted, payload)
    }

    private inline fun <reified T> encodeEntity(type: String, id: String, updatedAt: Long, deleted: Boolean, payload: () -> T): RecordDto =
        if (deleted) seal(type, id, updatedAt, true, null) else seal(type, id, updatedAt, false, AppJson.encodeToString(payload()))

    fun encode(e: ConversationEntity) = encodeEntity(RecordType.CONVERSATION, e.id, e.updatedAt, e.deleted) {
        ConvPayload(
            e.title, e.titleSet, e.assistantId, e.folderId, e.providerId, e.modelId, e.paramsJson, e.systemPrompt,
            e.currentLeafId, e.pinned, e.archived, e.createdAt, e.lastActivityAt,
        )
    }

    fun encode(e: MessageEntity) = encodeEntity(RecordType.MESSAGE, e.id, e.updatedAt, e.deleted) {
        MsgPayload(
            e.conversationId, e.parentId, e.role, e.content, e.thinking, e.thinkingMs, e.blocksJson, e.attachmentsJson,
            e.citationsJson, e.providerId, e.modelId, e.modelName, e.status, e.errorJson, e.usageJson, e.costUsd, e.createdAt,
            e.stepsJson,
        )
    }

    fun encode(e: AttachmentEntity) = encodeEntity(RecordType.ATTACHMENT, e.id, e.updatedAt, e.deleted) {
        AttPayload(e.conversationId, e.kind, e.mimeType, e.name, e.sizeBytes, e.width, e.height, e.uploaded, e.createdAt)
    }

    fun encode(e: AssistantEntity) = encodeEntity(RecordType.ASSISTANT, e.id, e.updatedAt, e.deleted) {
        AsstPayload(e.name, e.emoji, e.colorIndex, e.instructions, e.providerId, e.modelId, e.paramsJson, e.startersJson, e.sort, e.createdAt)
    }

    fun encode(e: FolderEntity) = encodeEntity(RecordType.FOLDER, e.id, e.updatedAt, e.deleted) {
        FolderPayload(e.name, e.colorIndex, e.sort, e.createdAt)
    }

    fun encode(e: PromptEntity) = encodeEntity(RecordType.PROMPT, e.id, e.updatedAt, e.deleted) {
        PromptPayload(e.title, e.body, e.createdAt)
    }

    fun encode(e: ProviderEntity) = encodeEntity(RecordType.PROVIDER, e.id, e.updatedAt, e.deleted) {
        val key = if (e.apiKeySealed.isBlank()) "" else runCatching { secrets.openString(e.apiKeySealed) }.getOrDefault("")
        ProviderPayload(
            e.kind, e.label, e.baseUrl, key, e.headersJson, e.enabled, e.favoritesJson, e.customModelsJson, e.capsOverridesJson, e.sort, e.createdAt,
        )
    }

    fun encode(e: McpServerEntity) = encodeEntity(RecordType.MCP, e.id, e.updatedAt, e.deleted) {
        val headers = if (e.headersSealed.isBlank()) emptyMap() else runCatching {
            AppJson.decodeFromString<Map<String, String>>(secrets.openString(e.headersSealed))
        }.getOrDefault(emptyMap())
        val oauth = if (e.oauthSealed.isBlank()) null else runCatching {
            AppJson.decodeFromString<McpOAuthState>(secrets.openString(e.oauthSealed))
        }.getOrNull()
        McpPayload(e.name, e.url, e.authMode, headers, oauth, e.enabled, e.approval, e.disabledToolsJson, e.autoApprovedJson, e.sort, e.createdAt)
    }

    fun encode(e: SkillEntity) = encodeEntity(RecordType.SKILL, e.id, e.updatedAt, e.deleted) {
        SkillPayload(e.name, e.description, e.instructions, e.resourcesJson, e.enabled, e.alwaysOn, e.sourceUrl, e.createdAt)
    }

    fun encode(s: SyncedPrefs): RecordDto = seal(RecordType.SETTINGS, RecordType.SETTINGS_ID, s.updatedAt, false, AppJson.encodeToString(s))

    // ---- decode (opened record → local entity, clean) ----

    fun conversation(r: OpenedRecord): ConversationEntity {
        val p = AppJson.decodeFromString<ConvPayload>(r.payload!!)
        return ConversationEntity(
            r.id, p.title, p.titleSet, p.assistantId, p.folderId, p.providerId, p.modelId, p.paramsJson, p.systemPrompt,
            p.currentLeafId, p.pinned, p.archived, p.createdAt, p.lastActivityAt, r.updatedAt, deleted = false, dirty = false,
        )
    }

    fun message(r: OpenedRecord): MessageEntity {
        val p = AppJson.decodeFromString<MsgPayload>(r.payload!!)
        return MessageEntity(
            r.id, p.conversationId, p.parentId, p.role, p.content, p.thinking, p.thinkingMs, p.blocksJson, p.attachmentsJson,
            p.citationsJson, p.providerId, p.modelId, p.modelName, p.status, p.errorJson, p.usageJson, p.costUsd, p.createdAt,
            r.updatedAt, deleted = false, dirty = false, stepsJson = p.stepsJson,
        )
    }

    fun attachment(r: OpenedRecord, existing: AttachmentEntity?): AttachmentEntity {
        val p = AppJson.decodeFromString<AttPayload>(r.payload!!)
        return AttachmentEntity(
            r.id, p.conversationId, p.kind, p.mimeType, p.name, p.sizeBytes, p.width, p.height,
            localFile = existing?.localFile, uploaded = p.uploaded, createdAt = p.createdAt, updatedAt = r.updatedAt,
            deleted = false, dirty = false,
        )
    }

    fun assistant(r: OpenedRecord): AssistantEntity {
        val p = AppJson.decodeFromString<AsstPayload>(r.payload!!)
        return AssistantEntity(
            r.id, p.name, p.emoji, p.colorIndex, p.instructions, p.providerId, p.modelId, p.paramsJson, p.startersJson, p.sort,
            p.createdAt, r.updatedAt, deleted = false, dirty = false,
        )
    }

    fun folder(r: OpenedRecord): FolderEntity {
        val p = AppJson.decodeFromString<FolderPayload>(r.payload!!)
        return FolderEntity(r.id, p.name, p.colorIndex, p.sort, p.createdAt, r.updatedAt, deleted = false, dirty = false)
    }

    fun prompt(r: OpenedRecord): PromptEntity {
        val p = AppJson.decodeFromString<PromptPayload>(r.payload!!)
        return PromptEntity(r.id, p.title, p.body, p.createdAt, r.updatedAt, deleted = false, dirty = false)
    }

    fun provider(r: OpenedRecord, existing: ProviderEntity?): ProviderEntity {
        val p = AppJson.decodeFromString<ProviderPayload>(r.payload!!)
        return ProviderEntity(
            id = r.id, kind = p.kind, label = p.label, baseUrl = p.baseUrl,
            apiKeySealed = if (p.apiKey.isBlank()) "" else secrets.sealString(p.apiKey),
            headersJson = p.headersJson, enabled = p.enabled,
            modelsJson = existing?.modelsJson ?: "[]", modelsFetchedAt = existing?.modelsFetchedAt ?: 0,
            favoritesJson = p.favoritesJson, customModelsJson = p.customModelsJson, capsOverridesJson = p.capsOverridesJson,
            sort = p.sort, createdAt = p.createdAt, updatedAt = r.updatedAt, deleted = false, dirty = false,
        )
    }

    fun mcpServer(r: OpenedRecord, existing: McpServerEntity?): McpServerEntity {
        val p = AppJson.decodeFromString<McpPayload>(r.payload!!)
        return McpServerEntity(
            id = r.id, name = p.name, url = p.url, authMode = p.authMode,
            headersSealed = if (p.headers.isEmpty()) "" else secrets.sealString(AppJson.encodeToString(p.headers)),
            oauthSealed = p.oauth?.let { secrets.sealString(AppJson.encodeToString(it)) } ?: "",
            enabled = p.enabled, approval = p.approval,
            toolsJson = existing?.toolsJson ?: "[]", toolsFetchedAt = existing?.toolsFetchedAt ?: 0,
            instructions = existing?.instructions, status = existing?.status,
            disabledToolsJson = p.disabledToolsJson, autoApprovedJson = p.autoApprovedJson,
            sort = p.sort, createdAt = p.createdAt, updatedAt = r.updatedAt, deleted = false, dirty = false,
        )
    }

    fun skill(r: OpenedRecord): SkillEntity {
        val p = AppJson.decodeFromString<SkillPayload>(r.payload!!)
        return SkillEntity(
            r.id, p.name, p.description, p.instructions, p.resourcesJson, p.enabled, p.alwaysOn, p.sourceUrl,
            p.createdAt, r.updatedAt, deleted = false, dirty = false,
        )
    }

    fun settings(r: OpenedRecord): SyncedPrefs = AppJson.decodeFromString<SyncedPrefs>(r.payload!!).copy(updatedAt = r.updatedAt)

    companion object {
        /** Every record has this type on the wire. */
        const val WIRE_TYPE = "e"
    }
}
