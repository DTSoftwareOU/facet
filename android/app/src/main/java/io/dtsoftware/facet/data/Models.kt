package io.dtsoftware.facet.data

import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.data.db.MessageEntity
import io.dtsoftware.facet.llm.Citation
import io.dtsoftware.facet.llm.GenParams
import io.dtsoftware.facet.llm.Usage
import kotlinx.serialization.Serializable

@Serializable
data class AttachmentRef(
    val id: String,
    val kind: String,
    val mimeType: String,
    val name: String,
    val sizeBytes: Long,
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable
data class MessageError(val kind: String, val message: String, val detail: String? = null)

fun MessageEntity.attachments(): List<AttachmentRef> =
    attachmentsJson?.let { runCatching { AppJson.decodeFromString<List<AttachmentRef>>(it) }.getOrNull() } ?: emptyList()

fun MessageEntity.citations(): List<Citation> =
    citationsJson?.let { runCatching { AppJson.decodeFromString<List<Citation>>(it) }.getOrNull() } ?: emptyList()

fun MessageEntity.usage(): Usage? =
    usageJson?.let { runCatching { AppJson.decodeFromString<Usage>(it) }.getOrNull() }

fun MessageEntity.error(): MessageError? =
    errorJson?.let { runCatching { AppJson.decodeFromString<MessageError>(it) }.getOrNull() }

fun parseParams(json: String?): GenParams =
    json?.let { runCatching { AppJson.decodeFromString<GenParams>(it) }.getOrNull() } ?: GenParams()

/**
 * The message tree of one conversation. Editing or regenerating creates siblings;
 * the visible thread is the path from the root to the selected leaf.
 */
class MessageTree(messages: List<MessageEntity>) {
    val byId: Map<String, MessageEntity> = messages.associateBy { it.id }
    private val children: Map<String?, List<MessageEntity>> = messages
        .groupBy { it.parentId?.takeIf { p -> p in byId } }
        .mapValues { (_, v) -> v.sortedWith(compareBy({ it.createdAt }, { it.id })) }

    fun childrenOf(id: String?): List<MessageEntity> = children[id].orEmpty()

    fun siblings(message: MessageEntity): List<MessageEntity> =
        childrenOf(message.parentId?.takeIf { it in byId })

    /** Follows the most recent child from [id] down to a leaf. */
    fun latestLeaf(id: String): String {
        var current = id
        while (true) {
            current = childrenOf(current).lastOrNull()?.id ?: return current
        }
    }

    fun pathTo(leafId: String): List<MessageEntity> {
        val out = ArrayList<MessageEntity>()
        var cur = byId[leafId]
        val seen = HashSet<String>()
        while (cur != null && seen.add(cur.id)) {
            out.add(cur)
            cur = cur.parentId?.let { byId[it] }
        }
        out.reverse()
        return out
    }

    /** The visible thread for [currentLeafId], falling back to the newest branch. */
    fun activePath(currentLeafId: String?): List<MessageEntity> {
        if (byId.isEmpty()) return emptyList()
        val leaf = currentLeafId?.takeIf { it in byId }?.let { latestLeaf(it) }
            ?: latestLeaf(childrenOf(null).lastOrNull()?.id ?: return emptyList())
        return pathTo(leaf)
    }
}
