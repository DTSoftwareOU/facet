package io.dtsoftware.facet.llm.internal

import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

internal val LlmJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    isLenient = true
}

internal fun parseJsonOrNull(text: String): JsonElement? =
    runCatching { LlmJson.parseToJsonElement(text) }.getOrNull()

internal fun parseObjectOrNull(text: String): JsonObject? = parseJsonOrNull(text) as? JsonObject

internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
internal fun JsonObject.arr(key: String): JsonArray? = this[key] as? JsonArray

internal fun JsonObject.str(key: String): String? {
    val p = this[key] as? JsonPrimitive ?: return null
    if (p is JsonNull || !p.isString) return null
    return p.content
}

internal fun JsonObject.long(key: String): Long? {
    val p = this[key] as? JsonPrimitive ?: return null
    if (p is JsonNull) return null
    return p.longOrNull ?: p.doubleOrNull?.toLong() ?: p.content.toLongOrNull()
}

internal fun JsonObject.double(key: String): Double? {
    val p = this[key] as? JsonPrimitive ?: return null
    if (p is JsonNull) return null
    return p.doubleOrNull ?: p.content.toDoubleOrNull()
}

internal fun JsonObject.bool(key: String): Boolean? {
    val p = this[key] as? JsonPrimitive ?: return null
    if (p is JsonNull) return null
    return p.booleanOrNull
}

/** `obj.a.b.supported` style lookup. */
internal fun JsonObject.path(vararg keys: String): JsonElement? {
    var cur: JsonElement = this
    for (k in keys) cur = (cur as? JsonObject)?.get(k) ?: return null
    return cur
}

internal fun JsonObject.supported(vararg keys: String): Boolean? =
    (path(*keys, "supported") as? JsonPrimitive)?.booleanOrNull

internal fun JsonElement?.stringOrNull(): String? =
    (this as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content

internal fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

internal fun dataUrl(mimeType: String, bytes: ByteArray): String = "data:$mimeType;base64,${base64(bytes)}"

internal fun String.trimBaseUrl(): String = trim().trimEnd('/')
