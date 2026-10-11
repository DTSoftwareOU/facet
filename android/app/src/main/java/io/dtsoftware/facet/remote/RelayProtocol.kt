package io.dtsoftware.facet.remote

import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.AppJson
import java.time.Instant
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/*
 * Messages between this device (a controller) and a PC running Facet for Windows (a host),
 * docs/REMOTE.md. Every message is a JSON object with v, id, ts and type; it travels sealed in a
 * relay envelope (core/crypto/Relay.kt).
 */

object RemoteMethod {
    const val COMPUTER_INFO = "computer.info"
    const val COMPUTER_TOOLS = "computer.tools"
    const val COMPUTER_CALL = "computer.call"
    const val COMPUTER_CANCEL = "computer.cancel"
    const val FILES_LIST = "files.list"
    const val AGENTS_LIST = "agents.list"
    const val AGENTS_READ = "agents.read"

    /** How long a controller waits for each method's result. */
    fun timeoutMs(method: String): Long = when (method) {
        AGENTS_READ -> 60_000L
        COMPUTER_CALL -> 15 * 60_000L
        else -> 20_000L
    }
}

/** A PC that answered `hello` (or announced itself), keyed by [hostId]. */
data class RemoteHost(
    /** Identifies this Windows install across sign-ins. */
    val hostId: String,
    /** The relay session that currently speaks for this host (the newest one wins). */
    val sessionId: String,
    val name: String,
    val os: String = "",
    val version: String = "",
    /** False until the owner turns on "Let your other devices use this PC". */
    val remote: Boolean = false,
    val home: String? = null,
    val defaultFolder: String? = null,
    val recentFolders: List<String> = emptyList(),
    val features: List<String> = emptyList(),
    val seenAt: Long = 0,
) {
    fun has(feature: String) = feature in features

    companion object {
        /** Parses a `host` message from [sessionId]; null when it isn't one. */
        fun parse(msg: JsonObject, sessionId: String, now: Long): RemoteHost? {
            if (msg.str("type") != "host") return null
            val hostId = msg.str("hostId")?.takeIf { it.isNotBlank() } ?: return null
            return RemoteHost(
                hostId = hostId,
                sessionId = sessionId,
                name = msg.str("name")?.takeIf { it.isNotBlank() } ?: Strings.get(R.string.remote_your_pc),
                os = msg.str("os").orEmpty(),
                version = msg.str("version").orEmpty(),
                remote = (msg["remote"] as? JsonPrimitive)?.booleanOrNull == true,
                home = msg.str("home")?.takeIf { it.isNotBlank() },
                defaultFolder = msg.str("defaultFolder")?.takeIf { it.isNotBlank() },
                recentFolders = msg.strings("recentFolders"),
                features = msg.strings("features"),
                seenAt = now,
            )
        }
    }
}

object RemoteFeature {
    const val COMPUTER = "computer"
    const val FILES = "files"
    const val CLAUDE = "claude"
    const val CODEX = "codex"
}

/** A remote call failed. [code] is the host's error code, or one of the local ones below. */
class RemoteException(val code: String, message: String) : Exception(message) {
    companion object {
        const val OFFLINE = "offline"
        const val TIMEOUT = "timeout"
        const val NOT_CONNECTED = "not_connected"
        const val REMOTE_DISABLED = "remote_disabled"
        const val NOT_FOUND = "not_found"
    }
}

/** Builds and reads relay messages. */
object RelayMessages {
    const val VERSION = 1

    fun hello(id: String, ts: Long): JsonObject = base(id, ts, "hello") {}

    fun call(id: String, ts: Long, method: String, params: JsonObject): JsonObject = base(id, ts, "call") {
        put("method", method)
        put("params", params)
    }

    fun cancel(id: String, ts: Long, re: String): JsonObject = base(id, ts, "cancel") { put("re", re) }

    private inline fun base(id: String, ts: Long, type: String, crossinline extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) =
        buildJsonObject {
            put("v", VERSION)
            put("id", id)
            put("ts", ts)
            put("type", type)
            extra()
        }

    fun encode(msg: JsonObject): String = AppJson.encodeToString(JsonObject.serializer(), msg)

    fun parse(json: String): JsonObject? = runCatching { AppJson.parseToJsonElement(json) as? JsonObject }.getOrNull()

    /**
     * The value of a `result` message, or throws [RemoteException] with the host's error
     * (`remote_disabled`, `bad_request`, `not_found`, `unknown_method`, `too_large`, `failed`).
     */
    fun resultValue(msg: JsonObject): JsonElement {
        val ok = (msg["ok"] as? JsonPrimitive)?.booleanOrNull == true
        if (ok) return msg["value"] ?: JsonNull
        val err = msg["error"] as? JsonObject
        throw RemoteException(err?.str("code") ?: "failed", err?.str("message")?.takeIf { it.isNotBlank() } ?: Strings.get(R.string.remote_error_pc_failed))
    }
}

internal fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

internal fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull

private fun JsonObject.strings(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()

// ---- Method results ----

/** `computer.tools`: one tool the PC offers to models. */
@Serializable
data class ComputerToolInfo(
    val name: String,
    val description: String = "",
    /** JSON Schema of the arguments, as a JSON string. */
    val inputSchemaJson: String = "",
    /** Reads only: runs without asking unless the user chose "Always ask". */
    val readOnly: Boolean = false,
)

/** `computer.info`. */
@Serializable
data class ComputerInfo(
    val os: String = "",
    val shell: String = "",
    val home: String = "",
    val user: String = "",
    val hostname: String = "",
)

/** `computer.call`: the tool result as the model sees it, and a short line for the tool card. */
@Serializable
data class ComputerCallResult(val content: String = "", val isError: Boolean = false, val label: String? = null)

@Serializable
data class FolderRef(val name: String, val path: String)

/** `files.list`: folders only. With `path: null`, [places] (home, Desktop, drives, recent folders) and no [folders]. */
@Serializable
data class FolderListing(
    val path: String? = null,
    val parent: String? = null,
    val folders: List<FolderRef> = emptyList(),
    val places: List<FolderRef> = emptyList(),
)

/** One Claude Code or Codex session in `agents.list` (newest first). */
@Serializable
data class AgentSessionInfo(
    val id: String,
    val title: String = "",
    @Serializable(with = EpochMillisSerializer::class) val updatedAt: Long = 0,
    val messageCount: Int = 0,
)

@Serializable
data class AgentSessionList(val sessions: List<AgentSessionInfo> = emptyList())

@Serializable
data class AgentMessage(
    /** "user" or "assistant". */
    val role: String,
    val text: String = "",
    @Serializable(with = EpochMillisSerializer::class) val at: Long? = null,
)

/** `agents.read`: a session converted to plain messages; [truncated] when older ones were dropped. */
@Serializable
data class AgentSession(
    val id: String,
    val title: String = "",
    val cwd: String = "",
    @Serializable(with = EpochMillisSerializer::class) val updatedAt: Long = 0,
    val messages: List<AgentMessage> = emptyList(),
    val truncated: Boolean = false,
)

/** Times as epoch milliseconds; also accepts ISO-8601 strings, so a host's choice of format doesn't break the list. */
internal object EpochMillisSerializer : KSerializer<Long> {
    override val descriptor = PrimitiveSerialDescriptor("EpochMillis", PrimitiveKind.LONG)

    override fun serialize(encoder: Encoder, value: Long) = encoder.encodeLong(value)

    override fun deserialize(decoder: Decoder): Long {
        val el = (decoder as? JsonDecoder)?.decodeJsonElement() ?: return decoder.decodeLong()
        val p = el as? JsonPrimitive ?: return 0
        if (!p.isString) return p.longOrNull ?: p.contentOrNull?.toDoubleOrNull()?.toLong() ?: 0
        return p.content.toLongOrNull() ?: runCatching { Instant.parse(p.content).toEpochMilli() }.getOrDefault(0)
    }
}
