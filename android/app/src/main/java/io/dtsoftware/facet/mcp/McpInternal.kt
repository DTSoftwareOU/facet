package io.dtsoftware.facet.mcp

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Protocol constants and shared helpers for the MCP client. */
internal object Mcp {
    /** Newest first; we offer the first in `initialize` and accept any of them back. */
    val SUPPORTED_VERSIONS = listOf("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
    val LATEST_VERSION = SUPPORTED_VERSIONS.first()

    /** Versions that define the MCP-Protocol-Version request header. */
    val VERSIONS_WITH_HEADER = setOf("2025-11-25", "2025-06-18")

    const val CLIENT_NAME = "Facet AI"
    const val CLIENT_VERSION = "1.0.0"

    const val HEADER_SESSION = "Mcp-Session-Id"
    const val HEADER_VERSION = "MCP-Protocol-Version"
    const val ACCEPT_STREAMABLE = "application/json, text/event-stream"

    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        isLenient = true
    }

    val prettyJson = Json {
        prettyPrint = true
        prettyPrintIndent = "  "
    }

    private val random = SecureRandom()

    fun randomUrlSafe(bytes: Int): String {
        val b = ByteArray(bytes).also { random.nextBytes(it) }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    }

    fun s256(verifier: String): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
}

internal fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString || it.contentOrNull != null }?.contentOrNull
internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
internal fun JsonObject.arr(key: String): JsonArray? = this[key] as? JsonArray
internal fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull

/** Parses one tools/list entry. */
internal fun parseTool(o: JsonObject): McpTool? {
    val name = o.str("name") ?: return null
    val annotations = o.obj("annotations")
    val schema = o.obj("inputSchema") ?: JsonObject(mapOf("type" to JsonPrimitive("object"), "properties" to JsonObject(emptyMap())))
    return McpTool(
        name = name,
        title = o.str("title") ?: annotations?.str("title"),
        description = o.str("description"),
        inputSchemaJson = Mcp.json.encodeToString(JsonObject.serializer(), schema),
        readOnlyHint = annotations?.bool("readOnlyHint"),
        destructiveHint = annotations?.bool("destructiveHint"),
        openWorldHint = annotations?.bool("openWorldHint"),
    )
}

/** Flattens a tools/call result into text the model can read, plus any images. */
internal fun flattenCallResult(result: JsonObject): McpCallResult {
    val texts = ArrayList<String>()
    val images = ArrayList<Pair<String, ByteArray>>()
    result.arr("content")?.forEach { el ->
        val c = el as? JsonObject ?: return@forEach
        when (c.str("type")) {
            "text" -> c.str("text")?.let(texts::add)
            "image" -> {
                val data = c.str("data")
                val mime = c.str("mimeType") ?: "image/png"
                val bytes = data?.let { runCatching { Base64.getMimeDecoder().decode(it) }.getOrNull() }
                if (bytes != null) images += mime to bytes else texts += "[image omitted]"
            }
            "audio" -> texts += "[audio omitted]"
            "resource" -> {
                val r = c.obj("resource")
                val uri = r?.str("uri") ?: "unknown"
                val text = r?.str("text")
                texts += if (text != null) "[resource: $uri]\n$text" else "[resource: $uri (${r?.str("mimeType") ?: "binary"})]"
            }
            "resource_link" -> {
                val uri = c.str("uri") ?: "unknown"
                val name = c.str("name") ?: c.str("title")
                val desc = c.str("description")
                texts += buildString {
                    append("[resource link: ")
                    if (name != null) append(name).append(" (").append(uri).append(")") else append(uri)
                    if (desc != null) append(": ").append(desc)
                    append("]")
                }
            }
            else -> Unit
        }
    }
    val structured = result["structuredContent"]?.takeIf { it !is JsonNull }
    if (structured != null) {
        val duplicated = texts.any { t ->
            runCatching { Mcp.json.parseToJsonElement(t) == structured }.getOrDefault(false)
        }
        if (!duplicated) texts += Mcp.prettyJson.encodeToString(JsonElement.serializer(), structured)
    }
    val isError = result.bool("isError") == true
    val text = texts.joinToString("\n\n").ifEmpty { if (isError) "The tool reported an error without details." else "(no output)" }
    return McpCallResult(text, isError, images)
}

/** Parameters of the Bearer challenge in a WWW-Authenticate header (keys lowercased). */
internal fun parseBearerChallenge(header: String?): Map<String, String> {
    if (header.isNullOrBlank()) return emptyMap()
    val idx = header.indexOf("Bearer", ignoreCase = true)
    val part = if (idx >= 0) header.substring(idx + 6) else header
    val out = LinkedHashMap<String, String>()
    val regex = Regex("""([A-Za-z0-9_\-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))""")
    for (m in regex.findAll(part)) {
        val key = m.groupValues[1].lowercase()
        val value = m.groupValues[2].ifEmpty { m.groupValues[3] }.replace("\\\"", "\"")
        out.putIfAbsent(key, value)
    }
    return out
}

/** Canonical server URI for RFC 8707 resource indicators: lowercase scheme/host, no default port, no query/fragment, no trailing slash. */
internal fun canonicalResource(url: String): String {
    val u = url.toHttpUrlOrNull() ?: return url.trim().trimEnd('/')
    val port = if (u.port == HttpUrl.defaultPort(u.scheme)) "" else ":${u.port}"
    val path = u.encodedPath.trimEnd('/')
    return "${u.scheme}://${u.host.lowercase()}$port$path"
}

internal fun originOf(url: HttpUrl): String {
    val port = if (url.port == HttpUrl.defaultPort(url.scheme)) "" else ":${url.port}"
    return "${url.scheme}://${url.host}$port"
}

/** Builds `<origin>/.well-known/<name><path>` (RFC 8414 §3 / RFC 9728 §3 path insertion). */
internal fun wellKnown(url: HttpUrl, name: String, includePath: Boolean): String {
    val path = url.encodedPath.trimEnd('/')
    return originOf(url) + "/.well-known/" + name + if (includePath && path.isNotEmpty()) path else ""
}

/** Pulls `message (code)` out of a JSON-RPC error object. */
internal fun rpcErrorText(error: JsonObject): String {
    val message = error.str("message") ?: "Unknown error"
    val code = (error["code"] as? JsonPrimitive)?.contentOrNull
    return if (code != null) "$message ($code)" else message
}

internal fun JsonElement.asObjectOrNull(): JsonObject? = this as? JsonObject

