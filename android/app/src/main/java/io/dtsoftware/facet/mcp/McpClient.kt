package io.dtsoftware.facet.mcp

import io.dtsoftware.facet.core.net.SseReader
import io.dtsoftware.facet.core.net.await
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Client for one remote MCP server. Speaks Streamable HTTP (2025-03-26 and later) and falls back to
 * the legacy HTTP+SSE transport (2024-11-05) automatically. Sessions are re-established when the
 * server expires them, and OAuth tokens are refreshed when they lapse, so a long-lived instance keeps
 * working across app sessions as long as the token store does.
 *
 * Safe for concurrent use: initialization and token refresh are serialized; requests run in parallel.
 */
class McpClient(val config: McpServerConfig, http: OkHttpClient, private val tokens: McpTokenStore) {

    companion object {
        /** tools/call deadline. */
        const val CALL_TIMEOUT_MS = 120_000L
        /** initialize / tools/list deadline. */
        const val REQUEST_TIMEOUT_MS = 30_000L
        private const val MAX_PAGES = 50
        private val JSON = "application/json".toMediaType()
    }

    private enum class Mode { STREAMABLE, LEGACY }

    private class SessionExpiredException : Exception()
    private class UnauthorizedException(val wwwAuthenticate: String?, val tokenUsed: String?) : Exception()
    private class NotStreamableException(val status: Int) : Exception()
    private class RpcErrorException(val error: JsonObject) : Exception(rpcErrorText(error))

    private val http: OkHttpClient = http.newBuilder()
        .readTimeout(CALL_TIMEOUT_MS + 15_000, TimeUnit.MILLISECONDS)
        .build()
    private val streamHttp: OkHttpClient = this.http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val initMutex = Mutex()
    private val authMutex = Mutex()
    private val ids = AtomicLong(1)

    @Volatile private var mode: Mode? = null
    @Volatile private var sessionId: String? = null
    @Volatile private var negotiated: String? = null
    @Volatile private var info: McpServerInfo? = null
    @Volatile private var generation = 0
    @Volatile private var legacy: LegacyChannel? = null
    @Volatile private var closed = false

    /** Connects (initialize + initialized) if needed and returns the server's identity. */
    suspend fun connect(): McpServerInfo = ensureSession().first

    /** Lists every tool, following pagination. */
    suspend fun listTools(): List<McpTool> {
        val out = ArrayList<McpTool>()
        var cursor: String? = null
        var pages = 0
        do {
            val params = cursor?.let { c -> buildJsonObject { put("cursor", c) } }
            val result = request("tools/list", params, REQUEST_TIMEOUT_MS)
            result.arr("tools")?.forEach { el -> (el as? JsonObject)?.let(::parseTool)?.let(out::add) }
            cursor = result.str("nextCursor")?.takeIf { it.isNotEmpty() }
        } while (cursor != null && ++pages < MAX_PAGES)
        return out
    }

    /** Calls a tool. [argumentsJson] must be a JSON object (or blank for no arguments). */
    suspend fun callTool(name: String, argumentsJson: String): McpCallResult {
        val args: JsonObject = if (argumentsJson.isBlank()) {
            JsonObject(emptyMap())
        } else {
            try {
                Mcp.json.parseToJsonElement(argumentsJson) as? JsonObject
            } catch (e: SerializationException) {
                null
            } ?: throw McpException("The arguments for \"$name\" aren't a valid JSON object.")
        }
        val params = buildJsonObject {
            put("name", name)
            put("arguments", args)
        }
        return flattenCallResult(request("tools/call", params, CALL_TIMEOUT_MS))
    }

    /** Ends the session (best effort) and stops background readers. Safe to call more than once. */
    fun close() {
        if (closed) return
        closed = true
        legacy?.close()
        legacy = null
        val sid = sessionId
        if (mode == Mode.STREAMABLE && sid != null) {
            val req = Request.Builder().url(config.url).delete()
                .header(Mcp.HEADER_SESSION, sid)
                .apply { negotiated?.takeIf { it in Mcp.VERSIONS_WITH_HEADER }?.let { header(Mcp.HEADER_VERSION, it) } }
                .apply { staticAuth(this) }
                .build()
            http.newCall(req).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) = Unit
                override fun onResponse(call: Call, response: Response) = response.close()
            })
        }
        scope.cancel()
    }

    // ---------------------------------------------------------------- request pipeline

    private suspend fun request(method: String, params: JsonObject?, timeoutMs: Long): JsonObject {
        var reinitialized = false
        var refreshed = false
        while (true) {
            val (_, gen) = ensureSession()
            val id = ids.getAndIncrement()
            try {
                val result = withTimeoutOrNull(timeoutMs) {
                    when (mode) {
                        Mode.LEGACY -> legacyRequest(id, method, params)
                        else -> streamableRequest(id, method, params)
                    }
                }
                if (result == null) {
                    notifyCancelled(id)
                    throw McpException("${config.name} didn't answer within ${timeoutMs / 1000} seconds.")
                }
                return result
            } catch (e: SessionExpiredException) {
                if (reinitialized) throw McpException("${config.name} keeps ending the session. Try again in a moment.")
                reinitialized = true
                invalidate(gen)
            } catch (e: UnauthorizedException) {
                if (refreshed || !refreshTokens(e.tokenUsed)) throw McpAuthRequiredException(config.id, e.wwwAuthenticate)
                refreshed = true
            } catch (e: RpcErrorException) {
                throw McpException("${config.name}: ${e.message}")
            } catch (e: McpException) {
                throw e
            } catch (e: McpAuthRequiredException) {
                throw e
            } catch (e: CancellationException) {
                throw e
            } catch (e: IOException) {
                if (closed) throw McpException("This connection to ${config.name} was closed.")
                throw McpException("Couldn't reach ${config.name}. Check the address and your connection.", cause = e)
            }
        }
    }

    private suspend fun ensureSession(): Pair<McpServerInfo, Int> {
        if (closed) throw McpException("This connection to ${config.name} was closed.")
        info?.let { return it to generation }
        return initMutex.withLock {
            info?.let { return@withLock it to generation }
            var refreshed = false
            while (true) {
                try {
                    val result = initializeLocked()
                    return@withLock result to generation
                } catch (e: UnauthorizedException) {
                    if (refreshed || !refreshTokens(e.tokenUsed)) throw McpAuthRequiredException(config.id, e.wwwAuthenticate)
                    refreshed = true
                } catch (e: RpcErrorException) {
                    throw McpException("${config.name} refused to start a session: ${e.message}")
                } catch (e: SessionExpiredException) {
                    throw McpException("Couldn't start a session with ${config.name}.")
                } catch (e: IOException) {
                    throw McpException("Couldn't reach ${config.name}. Check the address and your connection.", cause = e)
                }
            }
            @Suppress("UNREACHABLE_CODE")
            error("unreachable")
        }
    }

    private suspend fun invalidate(gen: Int) = initMutex.withLock {
        if (generation == gen) {
            info = null
            sessionId = null
            legacy?.close()
            legacy = null
        }
    }

    private suspend fun initializeLocked(): McpServerInfo {
        val result = when (mode) {
            Mode.STREAMABLE -> initStreamable(allowFallback = false)
            Mode.LEGACY -> initLegacy()
            null -> try {
                initStreamable(allowFallback = true)
            } catch (e: NotStreamableException) {
                try {
                    initLegacy()
                } catch (legacyError: McpException) {
                    throw McpException("No MCP server answered at this address (HTTP ${e.status}).")
                }
            }
        }
        generation++
        return result
    }

    private fun initParams() = buildJsonObject {
        put("protocolVersion", Mcp.LATEST_VERSION)
        putJsonObject("capabilities") {}
        putJsonObject("clientInfo") {
            put("name", Mcp.CLIENT_NAME)
            put("title", Mcp.CLIENT_NAME)
            put("version", Mcp.CLIENT_VERSION)
        }
    }

    private fun serverInfo(result: JsonObject): McpServerInfo {
        val version = result.str("protocolVersion")
            ?: throw McpException("${config.name} didn't say which MCP version it speaks.")
        if (version !in Mcp.SUPPORTED_VERSIONS) {
            throw McpException("${config.name} uses MCP version $version, which Facet doesn't support yet.")
        }
        val si = result.obj("serverInfo")
        negotiated = version
        val built = McpServerInfo(
            name = si?.str("title") ?: si?.str("name") ?: config.name,
            version = si?.str("version"),
            protocolVersion = version,
            instructions = result.str("instructions")?.takeIf { it.isNotBlank() },
        )
        info = built
        return built
    }

    // ---------------------------------------------------------------- Streamable HTTP

    private suspend fun initStreamable(allowFallback: Boolean): McpServerInfo {
        val id = ids.getAndIncrement()
        sessionId = null
        negotiated = null
        val sent = post(config.url, rpc(id, "initialize", initParams()), includeSession = false)
        if (allowFallback && sent.response.code in setOf(400, 404, 405)) {
            sent.response.close()
            throw NotStreamableException(sent.response.code)
        }
        checkStatus(sent.response, initializing = true, tokenUsed = sent.token)
        val newSession = sent.response.header(Mcp.HEADER_SESSION)
        val result = readResponse(sent.call, sent.response, id)
        sessionId = newSession
        mode = Mode.STREAMABLE
        val built = serverInfo(result)
        // notifications/initialized: no id; servers answer 202.
        val ack = post(config.url, rpc(null, "notifications/initialized", null), includeSession = true)
        ack.response.use { if (it.code == 401) throw UnauthorizedException(it.header("WWW-Authenticate"), ack.token) }
        return built
    }

    private suspend fun streamableRequest(id: Long, method: String, params: JsonObject?): JsonObject {
        val sent = post(config.url, rpc(id, method, params), includeSession = true)
        checkStatus(sent.response, initializing = false, tokenUsed = sent.token)
        return readResponse(sent.call, sent.response, id)
    }

    private class Sent(val call: Call, val response: Response, val token: String?)

    /** Builds and sends a POST, returning the live response (caller closes) and the token it carried. */
    private suspend fun post(url: String, body: String, includeSession: Boolean): Sent {
        val token = currentAccessToken()
        val builder = Request.Builder().url(url)
            .header("Accept", Mcp.ACCEPT_STREAMABLE)
            .post(body.toRequestBody(JSON))
        applyAuth(builder, token)
        if (includeSession) {
            sessionId?.let { builder.header(Mcp.HEADER_SESSION, it) }
            negotiated?.takeIf { it in Mcp.VERSIONS_WITH_HEADER }?.let { builder.header(Mcp.HEADER_VERSION, it) }
        }
        val call = http.newCall(builder.build())
        return Sent(call, call.await(), token)
    }

    /** Maps auth, session and generic HTTP failures. Leaves a successful response open. */
    private fun checkStatus(response: Response, initializing: Boolean, tokenUsed: String?) {
        if (response.isSuccessful) return
        val code = response.code
        val challenge = response.header("WWW-Authenticate")
        response.close()
        when {
            code == 401 -> throw UnauthorizedException(challenge, tokenUsed)
            code == 403 && parseBearerChallenge(challenge)["error"] == "insufficient_scope" ->
                throw McpAuthRequiredException(config.id, challenge)
            code == 403 -> throw McpException("${config.name} refused access (HTTP 403).", 403)
            code == 404 && !initializing && sessionId != null -> throw SessionExpiredException()
            code == 404 -> throw McpException("No MCP server was found at this address (HTTP 404).", 404)
            code == 429 -> throw McpException("${config.name} is rate limiting requests. Try again shortly.", 429)
            code >= 500 -> throw McpException("${config.name} had a server error (HTTP $code).", code)
            else -> throw McpException("${config.name} rejected the request (HTTP $code).", code)
        }
    }

    /** Reads a JSON or SSE response until the JSON-RPC response for [id] arrives. */
    private suspend fun readResponse(call: Call, response: Response, id: Long): JsonObject = cancellableWith(call) {
        response.use { res ->
            val type = res.header("Content-Type").orEmpty().lowercase()
            withContext(Dispatchers.IO) {
                if (type.contains("text/event-stream")) {
                    val reader = SseReader(res.body.source())
                    while (true) {
                        val ev = reader.next() ?: throw McpException("${config.name} closed the stream before answering.")
                        if (ev.event != null && ev.event != "message") continue
                        val msg = runCatching { Mcp.json.parseToJsonElement(ev.data) }.getOrNull() ?: continue
                        handleIncoming(msg, id)?.let { return@withContext it }
                    }
                    @Suppress("UNREACHABLE_CODE")
                    error("unreachable")
                } else {
                    val text = res.body.string()
                    if (res.code == 202 || text.isBlank()) throw McpException("${config.name} accepted the request but sent no answer.")
                    val notMcp = "The address answered, but not as an MCP server."
                    val msg = try {
                        Mcp.json.parseToJsonElement(text)
                    } catch (e: SerializationException) {
                        throw McpException(notMcp)
                    }
                    if (msg !is JsonObject && msg !is JsonArray) throw McpException(notMcp)
                    handleIncoming(msg, id) ?: throw McpException("${config.name} answered a different request.")
                }
            }
        }
    }

    /**
     * Dispatches one incoming JSON-RPC message (or batch). Returns the result object when [msg] is
     * the response to [id]; answers server requests; ignores notifications.
     */
    private fun handleIncoming(msg: JsonElement, id: Long): JsonObject? {
        if (msg is JsonArray) {
            var found: JsonObject? = null
            msg.forEach { el -> handleIncoming(el, id)?.let { found = it } }
            return found
        }
        val o = msg as? JsonObject ?: return null
        val msgId = (o["id"] as? JsonPrimitive)?.contentOrNull
        val method = o.str("method")
        if (method != null) {
            if (msgId != null) answerServerRequest(o)
            return null
        }
        if (msgId != id.toString()) return null
        o.obj("error")?.let { throw RpcErrorException(it) }
        return o.obj("result") ?: JsonObject(emptyMap())
    }

    /** We declare no client capabilities: answer ping, refuse everything else. */
    private fun answerServerRequest(request: JsonObject) {
        val reply = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", request["id"]!!)
            if (request.str("method") == "ping") {
                putJsonObject("result") {}
            } else {
                putJsonObject("error") {
                    put("code", -32601)
                    put("message", "Method not found")
                }
            }
        }
        sendAsync(Mcp.json.encodeToString(JsonObject.serializer(), reply))
    }

    private fun notifyCancelled(id: Long) {
        val note = buildJsonObject {
            put("jsonrpc", "2.0")
            put("method", "notifications/cancelled")
            putJsonObject("params") {
                put("requestId", id)
                put("reason", "Timed out")
            }
        }
        sendAsync(Mcp.json.encodeToString(JsonObject.serializer(), note))
    }

    /** Fire-and-forget POST (responses to server requests, notifications) on the active transport. */
    private fun sendAsync(body: String) {
        if (closed) return
        val target = when (mode) {
            Mode.LEGACY -> legacy?.endpointUrl?.toString() ?: return
            else -> config.url
        }
        scope.launch {
            runCatching {
                post(target, body, includeSession = mode == Mode.STREAMABLE).response.close()
            }
        }
    }

    private fun rpc(id: Long?, method: String, params: JsonObject?): String =
        Mcp.json.encodeToString(
            JsonObject.serializer(),
            buildJsonObject {
                put("jsonrpc", "2.0")
                if (id != null) put("id", id)
                put("method", method)
                if (params != null) put("params", params)
            },
        )

    // ---------------------------------------------------------------- legacy HTTP+SSE

    /** The long-lived GET stream of a legacy server, demultiplexing responses by id. */
    private inner class LegacyChannel(private val call: Call, response: Response) {
        val endpoint = CompletableDeferred<HttpUrl>()
        @Volatile var endpointUrl: HttpUrl? = null
        @Volatile var dead = false
        private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonObject>>()

        // Dispatched (not undispatched): the reader blocks, so it must never run on the caller's thread.
        private val job = scope.launch {
            try {
                response.use { res ->
                    val reader = SseReader(res.body.source())
                    while (true) {
                        val ev = reader.next() ?: break
                        when (ev.event) {
                            "endpoint" -> {
                                val url = resolveEndpoint(ev.data)
                                if (url != null) {
                                    endpointUrl = url
                                    endpoint.complete(url)
                                }
                            }
                            null, "message" -> dispatch(ev.data)
                            else -> Unit
                        }
                    }
                }
            } catch (_: Exception) {
                // Stream dropped or was cancelled: fail pending requests below.
            } finally {
                dead = true
                endpoint.completeExceptionally(McpException("${config.name} closed the connection."))
                pending.values.forEach { it.completeExceptionally(SessionExpiredException()) }
                pending.clear()
            }
        }

        private fun resolveEndpoint(data: String): HttpUrl? {
            val base = config.url.toHttpUrlOrNull() ?: return null
            return base.resolve(data.trim())
        }

        private fun dispatch(data: String) {
            val msg = runCatching { Mcp.json.parseToJsonElement(data) }.getOrNull() ?: return
            val list = if (msg is JsonArray) msg.mapNotNull { it as? JsonObject } else listOfNotNull(msg as? JsonObject)
            for (o in list) {
                val msgId = (o["id"] as? JsonPrimitive)?.contentOrNull
                if (o.str("method") != null) {
                    if (msgId != null) answerServerRequest(o)
                    continue
                }
                if (msgId != null) pending.remove(msgId)?.complete(o)
            }
        }

        fun register(id: Long): CompletableDeferred<JsonObject> {
            if (dead) throw SessionExpiredException()
            return CompletableDeferred<JsonObject>().also { pending[id.toString()] = it }
        }

        fun forget(id: Long) {
            pending.remove(id.toString())
        }

        fun close() {
            call.cancel()
            job.cancel()
        }
    }

    private suspend fun initLegacy(): McpServerInfo {
        val token = currentAccessToken()
        val builder = Request.Builder().url(config.url).get().header("Accept", "text/event-stream")
        applyAuth(builder, token)
        val call = streamHttp.newCall(builder.build())
        val response = call.await()
        if (response.code == 401) {
            val challenge = response.header("WWW-Authenticate")
            response.close()
            throw UnauthorizedException(challenge, token)
        }
        if (!response.isSuccessful || !response.header("Content-Type").orEmpty().contains("text/event-stream", ignoreCase = true)) {
            response.close()
            throw McpException("No MCP server answered at this address.")
        }
        val channel = LegacyChannel(call, response)
        try {
            withTimeout(REQUEST_TIMEOUT_MS) { channel.endpoint.await() }
        } catch (e: Exception) {
            channel.close()
            if (e is CancellationException && e !is kotlinx.coroutines.TimeoutCancellationException) throw e
            throw McpException("${config.name} didn't send its message endpoint.")
        }
        legacy?.close()
        legacy = channel
        mode = Mode.LEGACY
        sessionId = null
        negotiated = null
        val id = ids.getAndIncrement()
        val result = withTimeoutOrNull(REQUEST_TIMEOUT_MS) { legacyRequest(id, "initialize", initParams()) }
            ?: throw McpException("${config.name} didn't answer the initialize request.")
        val built = serverInfo(result)
        legacyPost(channel, rpc(null, "notifications/initialized", null)).response.close()
        return built
    }

    private suspend fun legacyRequest(id: Long, method: String, params: JsonObject?): JsonObject {
        val channel = legacy ?: throw SessionExpiredException()
        val deferred = channel.register(id)
        try {
            val sent = legacyPost(channel, rpc(id, method, params))
            sent.response.use {
                when {
                    it.code == 401 -> throw UnauthorizedException(it.header("WWW-Authenticate"), sent.token)
                    it.code == 404 -> throw SessionExpiredException()
                    !it.isSuccessful -> throw McpException("${config.name} rejected the request (HTTP ${it.code}).", it.code)
                }
            }
            val msg = deferred.await()
            msg.obj("error")?.let { throw RpcErrorException(it) }
            return msg.obj("result") ?: JsonObject(emptyMap())
        } finally {
            channel.forget(id)
        }
    }

    private suspend fun legacyPost(channel: LegacyChannel, body: String): Sent {
        val url = channel.endpointUrl ?: throw SessionExpiredException()
        val token = currentAccessToken()
        val builder = Request.Builder().url(url).post(body.toRequestBody(JSON))
        applyAuth(builder, token)
        val call = http.newCall(builder.build())
        return Sent(call, call.await(), token)
    }

    // ---------------------------------------------------------------- auth

    private fun staticAuth(builder: Request.Builder) {
        if (config.authMode == McpAuthMode.HEADERS) config.headers.forEach { (k, v) -> builder.header(k, v) }
    }

    private fun applyAuth(builder: Request.Builder, token: String?) {
        builder.header("User-Agent", "Facet/${Mcp.CLIENT_VERSION}")
        staticAuth(builder)
        if (config.authMode == McpAuthMode.OAUTH && token != null) builder.header("Authorization", "Bearer $token")
    }

    /** The OAuth access token to send, refreshed proactively when it expires within a minute. */
    private suspend fun currentAccessToken(): String? {
        if (config.authMode != McpAuthMode.OAUTH) return null
        val state = tokens.load(config.id) ?: return null
        val expiresAt = state.expiresAt
        if (expiresAt != null && expiresAt - System.currentTimeMillis() < 60_000 && state.refreshToken != null) {
            refreshTokens(state.accessToken)
            return tokens.load(config.id)?.accessToken
        }
        return state.accessToken
    }

    /**
     * Refreshes the access token once per expiry. Returns true when a usable token now exists
     * (refreshed here or by a concurrent caller). Clears dead tokens when the grant is rejected.
     */
    private suspend fun refreshTokens(tokenUsed: String?): Boolean = authMutex.withLock {
        if (config.authMode != McpAuthMode.OAUTH) return@withLock false
        val state = tokens.load(config.id) ?: return@withLock false
        if (state.accessToken != null && state.accessToken != tokenUsed) return@withLock true
        if (state.refreshToken == null) return@withLock false
        try {
            tokens.save(config.id, McpOAuth.refresh(state, http))
            true
        } catch (e: OAuthErrorException) {
            tokens.save(config.id, state.copy(accessToken = null, refreshToken = null, expiresAt = null))
            false
        }
    }

    // ---------------------------------------------------------------- utilities

    /** Runs [block] so that cancelling the coroutine also cancels [call], unblocking any reader. */
    private suspend fun <T> cancellableWith(call: Call, block: suspend () -> T): T = coroutineScope {
        val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                awaitCancellation()
            } finally {
                call.cancel()
            }
        }
        try {
            block()
        } finally {
            watcher.cancel()
        }
    }
}
