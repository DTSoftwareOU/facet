package io.dtsoftware.facet.llm

import io.dtsoftware.facet.core.net.HttpStatusException
import io.dtsoftware.facet.llm.internal.obj
import io.dtsoftware.facet.llm.internal.parseObjectOrNull
import io.dtsoftware.facet.llm.internal.str
import io.dtsoftware.facet.llm.internal.stringOrNull
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/** Maps transport and provider failures to user-facing [LlmError]s. Never leaks API keys. */
object LlmErrors {
    private val keyLike = Regex("""\b(sk-ant-|sk-or-|sk-proj-|sk-|xai-|gsk_|pplx-|csk-|fw_|AIza)[A-Za-z0-9_\-*.]{6,}""")
    private const val MAX_DETAIL = 600

    fun providerName(config: ProviderConfig): String =
        if (config.kind == ProviderKind.CUSTOM) config.label.ifBlank { "The endpoint" } else config.kind.displayName

    /** Removes anything that looks like a credential, including the configured key itself. */
    fun redact(text: String, apiKey: String?): String {
        var out = text
        if (!apiKey.isNullOrBlank() && apiKey.length >= 6) out = out.replace(apiKey, "[redacted]")
        return keyLike.replace(out) { "[redacted]" }
    }

    /** Best-effort extraction of the human message from a provider error body. */
    fun extractMessage(body: String): String {
        val json = parseObjectOrNull(body) ?: return body.trim().take(MAX_DETAIL)
        val err = json["error"]
        val msg = when {
            err is kotlinx.serialization.json.JsonObject -> err.str("message") ?: err.str("type")
            err != null -> err.stringOrNull()
            else -> null
        } ?: json.str("message") ?: json.str("detail") ?: json.obj("detail")?.str("message")
        return (msg ?: body).trim().take(MAX_DETAIL)
    }

    private fun errorCode(body: String): String? {
        val json = parseObjectOrNull(body) ?: return null
        val err = json.obj("error")
        return err?.str("code") ?: err?.str("type") ?: json.str("code")
    }

    fun fromHttp(config: ProviderConfig, model: String?, e: HttpStatusException): LlmError {
        val provider = providerName(config)
        val raw = redact(extractMessage(e.body), config.apiKey)
        val m = raw.lowercase()
        val code = errorCode(e.body)?.lowercase().orEmpty()
        val modelName = model?.let { "“$it”" } ?: "this model"
        fun err(kind: ErrorKind, message: String) =
            LlmError(kind, message, e.code, e.retryAfterSeconds, raw.ifBlank { null })

        val creditProblem = "credit balance" in m || "insufficient_quota" in code || "insufficient credits" in m ||
            "billing" in m || "exceeded your current quota" in m || "payment required" in m || "out of credits" in m
        return when {
            e.code == 401 -> err(ErrorKind.AUTH, "$provider rejected this API key. Check it in Providers.")
            e.code == 402 || creditProblem ->
                err(ErrorKind.QUOTA, "$provider says this account is out of credits or over its spending limit. Add credits with $provider, then retry.")
            e.code == 403 && ("verif" in m) ->
                err(ErrorKind.PERMISSION, "$provider requires organization verification for $modelName. Verify your organization in the $provider dashboard, or pick another model.")
            e.code == 403 ->
                err(ErrorKind.PERMISSION, "$provider denied access to $modelName with this key. Check the key's permissions or pick another model.")
            e.code == 404 ->
                err(ErrorKind.NOT_FOUND, "$provider couldn't find $modelName. It may be retired, or this key can't use it.")
            e.code == 413 || ParamHealer.isContextLength(raw) ->
                err(ErrorKind.CONTEXT_LENGTH, "This conversation is too long for $modelName. Start a new chat, remove attachments, or pick a model with a larger context window.")
            e.code == 429 -> {
                val wait = e.retryAfterSeconds?.let { if (it <= 90) " Try again in ${it}s." else " Try again in ${(it + 59) / 60} min." }
                    ?: " Try again in a moment."
                err(ErrorKind.RATE_LIMIT, "$provider is rate-limiting this key.$wait")
            }
            e.code == 408 -> err(ErrorKind.TIMEOUT, "$provider took too long to respond. Try again.")
            e.code == 529 || ((e.code == 503 || e.code == 502) && "overload" in m) || "overloaded" in code ->
                err(ErrorKind.OVERLOADED, "$provider is overloaded right now. Try again shortly, or switch models.")
            e.code in 500..599 ->
                err(ErrorKind.SERVER, "$provider had a server error (HTTP ${e.code}). Try again.")
            e.code == 400 || e.code == 422 -> {
                val shown = raw.take(220).ifBlank { "invalid request" }
                err(ErrorKind.BAD_REQUEST, "$provider rejected the request: $shown")
            }
            else -> err(ErrorKind.UNKNOWN, "$provider returned HTTP ${e.code}${if (raw.isNotBlank()) ": ${raw.take(200)}" else "."}")
        }
    }

    fun fromIo(config: ProviderConfig, e: IOException): LlmError {
        if (e is HttpStatusException) return fromHttp(config, null, e)
        val provider = providerName(config)
        val local = config.kind == ProviderKind.OLLAMA || config.kind == ProviderKind.LMSTUDIO
        val detail = redact(e.message ?: e.javaClass.simpleName, config.apiKey)
        return when (e) {
            is SocketTimeoutException -> LlmError(ErrorKind.TIMEOUT, "$provider took too long to respond. Try again.", detail = detail)
            is UnknownHostException, is ConnectException, is NoRouteToHostException -> LlmError(
                ErrorKind.NETWORK,
                if (local) "Can't reach $provider at ${config.baseUrl}. Make sure it's running and reachable from this phone."
                else "Can't reach $provider. Check your connection.",
                detail = detail,
            )
            is SSLException -> LlmError(ErrorKind.NETWORK, "The secure connection to $provider failed. Check the address and your network.", detail = detail)
            is InterruptedIOException -> LlmError(ErrorKind.TIMEOUT, "$provider took too long to respond. Try again.", detail = detail)
            else -> LlmError(ErrorKind.NETWORK, "Lost the connection to $provider before the response finished. Try again.", detail = detail)
        }
    }

    /** Errors reported inside a stream (`event: error`, `response.failed`, `{"error":…}` chunks). */
    fun fromStream(config: ProviderConfig, model: String?, type: String?, message: String?): LlmError {
        val provider = providerName(config)
        val raw = redact(message.orEmpty(), config.apiKey).take(MAX_DETAIL)
        val t = type?.lowercase().orEmpty()
        val m = raw.lowercase()
        return when {
            "overloaded" in t || "overloaded" in m ->
                LlmError(ErrorKind.OVERLOADED, "$provider is overloaded right now. Try again shortly, or switch models.", detail = raw)
            "rate_limit" in t || "rate limit" in m ->
                LlmError(ErrorKind.RATE_LIMIT, "$provider is rate-limiting this key. Try again in a moment.", detail = raw)
            "quota" in t || "insufficient" in t || "credit" in m ->
                LlmError(ErrorKind.QUOTA, "$provider says this account is out of credits or over its spending limit. Add credits with $provider, then retry.", detail = raw)
            "authentication" in t || "invalid_api_key" in t ->
                LlmError(ErrorKind.AUTH, "$provider rejected this API key. Check it in Providers.", detail = raw)
            ParamHealer.isContextLength(raw) ->
                LlmError(ErrorKind.CONTEXT_LENGTH, "This conversation is too long for ${model?.let { "“$it”" } ?: "this model"}. Start a new chat or remove attachments.", detail = raw)
            "server" in t || "api_error" in t ->
                LlmError(ErrorKind.SERVER, "$provider had a server error mid-response. Try again.", detail = raw)
            else -> LlmError(
                ErrorKind.UNKNOWN,
                "$provider stopped with an error${if (raw.isNotBlank()) ": ${raw.take(200)}" else "."}",
                detail = raw.ifBlank { null },
            )
        }
    }

    fun truncatedStream(config: ProviderConfig): LlmError = LlmError(
        ErrorKind.NETWORK,
        "The connection to ${providerName(config)} closed before the response finished. Try again.",
    )
}
