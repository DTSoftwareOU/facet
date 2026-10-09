package io.dtsoftware.facet.llm.internal

import java.security.MessageDigest
import java.util.UUID
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Shared helpers for client tool calling across adapters. */
internal object ToolWire {
    private val EMPTY_OBJECT = JsonObject(emptyMap())
    private val DEFAULT_SCHEMA = JsonObject(mapOf("type" to JsonPrimitive("object"), "properties" to EMPTY_OBJECT))

    /** Parses a tool's JSON Schema; falls back to an empty object schema and always sets `type: object`. */
    fun schema(json: String): JsonObject {
        val parsed = parseJsonOrNull(json) as? JsonObject ?: return DEFAULT_SCHEMA
        return if (parsed.str("type") == null) JsonObject(mapOf("type" to JsonPrimitive("object")) + parsed) else parsed
    }

    /** Arguments as an object for providers that need one (Anthropic `input`); invalid JSON becomes `{}`. */
    fun argsObject(argumentsJson: String): JsonObject = parseJsonOrNull(argumentsJson) as? JsonObject ?: EMPTY_OBJECT

    /**
     * Normalizes streamed arguments for [io.dtsoftware.facet.llm.StreamEvent.ToolCallReady]:
     * blank → `{}`, a valid object → compact JSON, anything else (truncated/invalid) → the raw text.
     */
    fun normalizeArgs(raw: String): String {
        if (raw.isBlank()) return "{}"
        val parsed = parseJsonOrNull(raw) as? JsonObject ?: return raw
        return parsed.toString()
    }

    /** Arguments string to replay when the stored text isn't a JSON object (keeps requests valid). */
    fun replayArgs(argumentsJson: String): String =
        (parseJsonOrNull(argumentsJson) as? JsonObject)?.toString() ?: "{}"

    /** True when an error message says the model can't use tools/function calling at all. */
    fun toolsUnsupported(message: String): Boolean {
        val m = message.lowercase()
        if ("function calling" in m || "function-calling" in m) {
            return "not support" in m || "unsupported" in m || "not available" in m || "not enabled" in m || "disabled" in m
        }
        val mentionsTools = "tool use" in m || "tool_use" in m || "tools" in m || "tool calling" in m || "tool calls" in m
        if (!mentionsTools) return false
        return "does not support" in m || "doesn't support" in m || "not supported" in m || "unsupported" in m ||
            "not available" in m || "not enabled" in m || "is not allowed" in m
    }

    /** Anthropic / Responses-safe id: ^[a-zA-Z0-9_-]+$. */
    fun safeId(id: String): String = id.replace(Regex("[^a-zA-Z0-9_-]"), "_").ifEmpty { "call" }

    /** Mistral requires 9-character alphanumeric tool call ids; map any id to one deterministically. */
    fun mistralId(id: String): String {
        if (id.length == 9 && id.all { it.isLetterOrDigit() && it.code < 128 }) return id
        val digest = MessageDigest.getInstance("SHA-256").digest(id.toByteArray())
        val alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        return buildString { for (i in 0 until 9) append(alphabet[(digest[i].toInt() and 0xFF) % alphabet.length]) }
    }

    /** A fresh id for providers that omit them (Gemini compat). */
    fun newId(index: Int): String = "call_" + UUID.randomUUID().toString().replace("-", "").take(12) + "_" + index
}
