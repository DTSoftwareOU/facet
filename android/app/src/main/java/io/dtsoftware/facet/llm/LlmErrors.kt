package io.dtsoftware.facet.llm

import androidx.annotation.StringRes
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
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
        if (config.kind == ProviderKind.CUSTOM) config.label.ifBlank { Strings.get(R.string.llm_the_endpoint) } else config.kind.displayName

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
        fun err(kind: ErrorKind, message: String) =
            LlmError(kind, message, e.code, e.retryAfterSeconds, raw.ifBlank { null })
        /** [named] when the model is known (its name is the second argument), else [unnamed]. */
        fun aboutModel(@StringRes named: Int, @StringRes unnamed: Int): String =
            if (model != null) Strings.get(named, provider, model) else Strings.get(unnamed, provider)

        val creditProblem = "credit balance" in m || "insufficient_quota" in code || "insufficient credits" in m ||
            "billing" in m || "exceeded your current quota" in m || "payment required" in m || "out of credits" in m
        return when {
            e.code == 401 -> err(ErrorKind.AUTH, Strings.get(R.string.llm_auth, provider))
            e.code == 402 || creditProblem ->
                err(ErrorKind.QUOTA, Strings.get(R.string.llm_quota, provider))
            e.code == 403 && ("verif" in m) ->
                err(ErrorKind.PERMISSION, aboutModel(R.string.llm_verify_model, R.string.llm_verify_this_model))
            e.code == 403 ->
                err(ErrorKind.PERMISSION, aboutModel(R.string.llm_denied_model, R.string.llm_denied_this_model))
            e.code == 404 ->
                err(ErrorKind.NOT_FOUND, aboutModel(R.string.llm_not_found_model, R.string.llm_not_found_this_model))
            e.code == 413 || ParamHealer.isContextLength(raw) ->
                err(
                    ErrorKind.CONTEXT_LENGTH,
                    if (model != null) Strings.get(R.string.llm_too_long_model, model) else Strings.get(R.string.llm_too_long_this_model),
                )
            e.code == 429 -> {
                val wait = e.retryAfterSeconds
                err(
                    ErrorKind.RATE_LIMIT,
                    when {
                        wait == null -> Strings.get(R.string.llm_rate_limit_moment, provider)
                        wait <= 90 -> Strings.get(R.string.llm_rate_limit_seconds, provider, wait.toInt())
                        else -> Strings.get(R.string.llm_rate_limit_minutes, provider, ((wait + 59) / 60).toInt())
                    },
                )
            }
            e.code == 408 -> err(ErrorKind.TIMEOUT, Strings.get(R.string.llm_timeout, provider))
            e.code == 529 || ((e.code == 503 || e.code == 502) && "overload" in m) || "overloaded" in code ->
                err(ErrorKind.OVERLOADED, Strings.get(R.string.llm_overloaded, provider))
            e.code in 500..599 ->
                err(ErrorKind.SERVER, Strings.get(R.string.llm_server_error, provider, e.code))
            e.code == 400 || e.code == 422 -> err(
                ErrorKind.BAD_REQUEST,
                if (raw.isBlank()) Strings.get(R.string.llm_bad_request_invalid, provider)
                else Strings.get(R.string.llm_bad_request, provider, raw.take(220)),
            )
            else -> err(
                ErrorKind.UNKNOWN,
                if (raw.isNotBlank()) Strings.get(R.string.llm_http_reason, provider, e.code, raw.take(200))
                else Strings.get(R.string.llm_http, provider, e.code),
            )
        }
    }

    fun fromIo(config: ProviderConfig, e: IOException): LlmError {
        if (e is HttpStatusException) return fromHttp(config, null, e)
        val provider = providerName(config)
        val local = config.kind == ProviderKind.OLLAMA || config.kind == ProviderKind.LMSTUDIO
        val detail = redact(e.message ?: e.javaClass.simpleName, config.apiKey)
        return when (e) {
            is SocketTimeoutException -> LlmError(ErrorKind.TIMEOUT, Strings.get(R.string.llm_timeout, provider), detail = detail)
            is UnknownHostException, is ConnectException, is NoRouteToHostException -> LlmError(
                ErrorKind.NETWORK,
                if (local) Strings.get(R.string.llm_unreachable_local, provider, config.baseUrl)
                else Strings.get(R.string.llm_unreachable, provider),
                detail = detail,
            )
            is SSLException -> LlmError(ErrorKind.NETWORK, Strings.get(R.string.llm_ssl, provider), detail = detail)
            is InterruptedIOException -> LlmError(ErrorKind.TIMEOUT, Strings.get(R.string.llm_timeout, provider), detail = detail)
            else -> LlmError(ErrorKind.NETWORK, Strings.get(R.string.llm_connection_lost, provider), detail = detail)
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
                LlmError(ErrorKind.OVERLOADED, Strings.get(R.string.llm_overloaded, provider), detail = raw)
            "rate_limit" in t || "rate limit" in m ->
                LlmError(ErrorKind.RATE_LIMIT, Strings.get(R.string.llm_rate_limit_moment, provider), detail = raw)
            "quota" in t || "insufficient" in t || "credit" in m ->
                LlmError(ErrorKind.QUOTA, Strings.get(R.string.llm_quota, provider), detail = raw)
            "authentication" in t || "invalid_api_key" in t ->
                LlmError(ErrorKind.AUTH, Strings.get(R.string.llm_auth, provider), detail = raw)
            ParamHealer.isContextLength(raw) -> LlmError(
                ErrorKind.CONTEXT_LENGTH,
                if (model != null) Strings.get(R.string.llm_too_long_short_model, model) else Strings.get(R.string.llm_too_long_short_this_model),
                detail = raw,
            )
            "server" in t || "api_error" in t ->
                LlmError(ErrorKind.SERVER, Strings.get(R.string.llm_server_error_stream, provider), detail = raw)
            else -> LlmError(
                ErrorKind.UNKNOWN,
                if (raw.isNotBlank()) Strings.get(R.string.llm_stream_error_reason, provider, raw.take(200))
                else Strings.get(R.string.llm_stream_error, provider),
                detail = raw.ifBlank { null },
            )
        }
    }

    fun truncatedStream(config: ProviderConfig): LlmError = LlmError(
        ErrorKind.NETWORK,
        Strings.get(R.string.llm_truncated, providerName(config)),
    )

    /** An unexpected failure while reading a provider's response. */
    fun readFailed(config: ProviderConfig, detail: String?): LlmError =
        LlmError(ErrorKind.UNKNOWN, Strings.get(R.string.llm_read_failed, providerName(config)), detail = detail)
}
