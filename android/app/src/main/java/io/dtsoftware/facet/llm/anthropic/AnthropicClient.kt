package io.dtsoftware.facet.llm.anthropic

import io.dtsoftware.facet.core.net.HttpStatusException
import io.dtsoftware.facet.core.net.fetchString
import io.dtsoftware.facet.core.net.sseFlow
import io.dtsoftware.facet.core.net.toJsonBody
import io.dtsoftware.facet.llm.ApiStyle
import io.dtsoftware.facet.llm.ChatMessage
import io.dtsoftware.facet.llm.ChatRequest
import io.dtsoftware.facet.llm.Effort
import io.dtsoftware.facet.llm.ErrorKind
import io.dtsoftware.facet.llm.HealAction
import io.dtsoftware.facet.llm.LlmClient
import io.dtsoftware.facet.llm.LlmError
import io.dtsoftware.facet.llm.LlmErrors
import io.dtsoftware.facet.llm.LlmException
import io.dtsoftware.facet.llm.ModelCatalog
import io.dtsoftware.facet.llm.ModelCatalog.ThinkingOff
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ParamHealer
import io.dtsoftware.facet.llm.ParamSpec
import io.dtsoftware.facet.llm.Part
import io.dtsoftware.facet.llm.PricingCatalog
import io.dtsoftware.facet.llm.ProviderBlocks
import io.dtsoftware.facet.llm.ProviderConfig
import io.dtsoftware.facet.llm.QuirkStore
import io.dtsoftware.facet.llm.ReasoningKind
import io.dtsoftware.facet.llm.Role
import io.dtsoftware.facet.llm.StopReason
import io.dtsoftware.facet.llm.StreamEvent
import io.dtsoftware.facet.llm.Usage
import io.dtsoftware.facet.llm.internal.CitationCollector
import io.dtsoftware.facet.llm.internal.ToolWire
import io.dtsoftware.facet.llm.internal.arr
import io.dtsoftware.facet.llm.internal.base64
import io.dtsoftware.facet.llm.internal.bool
import io.dtsoftware.facet.llm.internal.long
import io.dtsoftware.facet.llm.internal.obj
import io.dtsoftware.facet.llm.internal.parseJsonOrNull
import io.dtsoftware.facet.llm.internal.parseObjectOrNull
import io.dtsoftware.facet.llm.internal.plus
import io.dtsoftware.facet.llm.internal.str
import io.dtsoftware.facet.llm.internal.supported
import io.dtsoftware.facet.llm.internal.trimBaseUrl
import io.dtsoftware.facet.llm.maxTokensCap
import io.dtsoftware.facet.llm.record
import io.dtsoftware.facet.llm.resolveEffort
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

/** Anthropic Messages API adapter (raw HTTP, streaming). */
internal class AnthropicClient(
    override val config: ProviderConfig,
    http: OkHttpClient,
    private val quirks: QuirkStore,
    private val pricing: PricingCatalog?,
) : LlmClient {

    private val http = http
    private val streamHttp = http.newBuilder()
        .readTimeout(15, TimeUnit.MINUTES)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val base = config.baseUrl.trimBaseUrl().removeSuffix("/v1").ifBlank { "https://api.anthropic.com" }
    private val provider get() = LlmErrors.providerName(config)

    private fun requestBuilder(path: String) = Request.Builder()
        .url("$base/v1/$path")
        .header("x-api-key", config.apiKey)
        .header("anthropic-version", API_VERSION)
        .apply { config.headers.forEach { (k, v) -> header(k, v) } }

    // ------------------------------------------------------------------ models

    override suspend fun listModels(): List<ModelInfo> {
        val out = ArrayList<ModelInfo>()
        var after: String? = null
        repeat(MAX_MODEL_PAGES) {
            val url = "$base/v1/models".toHttpUrl().newBuilder()
                .addQueryParameter("limit", "1000")
                .apply { after?.let { addQueryParameter("after_id", it) } }
                .build()
            val body = fetch(requestBuilder("models").url(url).get().build())
            val json = parseObjectOrNull(body) ?: return out
            json.arr("data")?.forEach { el -> (el as? JsonObject)?.let { out += toModelInfo(it) } }
            if (json.bool("has_more") != true) return out
            after = json.str("last_id") ?: return out
        }
        return out
    }

    private fun toModelInfo(m: JsonObject): ModelInfo {
        val id = m.str("id").orEmpty()
        val caps = m.obj("capabilities")
        val effortLevels = caps?.let { c ->
            if (c.supported("effort") == false) emptyList()
            else listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.XHIGH, Effort.MAX)
                .filter { c.supported("effort", it.wire) == true }
                .takeIf { it.isNotEmpty() }
        }
        val modelCaps = if (caps == null) ModelCatalog.claudeCaps(id) else ModelCatalog.claudeCapsFromApi(
            id = id,
            imageInput = caps.supported("image_input"),
            adaptive = caps.supported("thinking", "types", "adaptive")
                ?: if (caps.supported("thinking") == false) false else null,
            enabled = caps.supported("thinking", "types", "enabled")
                ?: if (caps.supported("thinking") == false) false else null,
            effortLevels = effortLevels,
        )
        return ModelInfo(
            id = id,
            displayName = m.str("display_name") ?: ModelCatalog.displayName(config.kind, id),
            contextWindow = m.long("max_input_tokens")?.toInt(),
            maxOutput = m.long("max_tokens")?.toInt() ?: ModelCatalog.parseClaude(id)?.defaultMaxOutput,
            caps = modelCaps,
            pricing = pricing?.priceFor(config.kind, id),
            createdAt = m.str("created_at")?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() },
        )
    }

    override suspend fun verify(): Result<Unit> = try {
        fetch(requestBuilder("models?limit=1").get().build())
        Result.success(Unit)
    } catch (e: LlmException) {
        Result.failure(e)
    }

    private suspend fun fetch(request: Request): String = try {
        http.fetchString(request)
    } catch (e: HttpStatusException) {
        throw LlmException(LlmErrors.fromHttp(config, null, e))
    } catch (e: IOException) {
        throw LlmException(LlmErrors.fromIo(config, e))
    }

    // ------------------------------------------------------------------ streaming

    override fun stream(request: ChatRequest): Flow<StreamEvent> = flow {
        val dropped = quirks.dropped(config.id, request.model).toMutableSet()
        var stripThinking = false
        var heals = 0
        val turn = TurnState(request)

        while (true) {
            val built = buildBody(request, dropped, stripThinking, turn.pausedContent())
            val httpRequest = requestBuilder("messages")
                .header("accept", "text/event-stream")
                .apply { if (built.betas.isNotEmpty()) header("anthropic-beta", built.betas.joinToString(",")) }
                .post(built.body.toString().toJsonBody())
                .build()
            val outcome = try {
                runRound(httpRequest, turn)
            } catch (e: HttpStatusException) {
                if (turn.emittedAnything) {
                    emit(StreamEvent.Failed(LlmErrors.fromHttp(config, request.model, e)))
                    return@flow
                }
                val msg = LlmErrors.extractMessage(e.body)
                val lower = msg.lowercase()
                if (e.code == 400 && !stripThinking && built.replaysThinking && isSignatureProblem(lower)) {
                    stripThinking = true
                    continue
                }
                if ((e.code == 400 || e.code == 422) && heals < MAX_HEALS) {
                    val action = if (built.clientTools && ToolWire.toolsUnsupported(msg)) HealAction.Drop("tools")
                    else ParamHealer.diagnose(msg, built.sent, built.effort, request.caps.reasoning.efforts)
                    if (action != null) {
                        heals++
                        quirks.record(config.id, request.model, action)
                        applyHeal(action, dropped)
                        continue
                    }
                }
                emit(StreamEvent.Failed(LlmErrors.fromHttp(config, request.model, e)))
                return@flow
            } catch (e: IOException) {
                emit(StreamEvent.Failed(LlmErrors.fromIo(config, e)))
                return@flow
            }
            when (outcome) {
                RoundOutcome.CONTINUE -> {
                    if (turn.rounds >= MAX_PAUSE_ROUNDS) {
                        turn.stopReason = StopReason.END
                        finish(turn)
                        return@flow
                    }
                    continue
                }
                RoundOutcome.DONE -> {
                    finish(turn)
                    return@flow
                }
                RoundOutcome.FAILED -> return@flow
            }
        }
    }.catch { e ->
        if (e is kotlinx.coroutines.CancellationException) throw e
        if (e is IOException) emit(StreamEvent.Failed(LlmErrors.fromIo(config, e)))
        else emit(StreamEvent.Failed(LlmError(ErrorKind.UNKNOWN, "Something went wrong reading the response from $provider.", detail = e.message)))
    }.flowOn(Dispatchers.Default)

    private fun applyHeal(action: HealAction, dropped: MutableSet<String>) {
        when (action) {
            is HealAction.Drop -> dropped += action.key
            is HealAction.EffortValue -> {
                dropped += "effort:${action.unsupported.wire}"
                if (action.replacement == null) dropped += "effort"
            }
            is HealAction.CapMaxTokens -> dropped += "max_tokens:${action.max}"
        }
    }

    private fun isSignatureProblem(lower: String) =
        "signature" in lower || "bound to a different conversation" in lower ||
            ("thinking" in lower && "messages." in lower)

    private enum class RoundOutcome { DONE, CONTINUE, FAILED }

    /** State that spans pause_turn continuation rounds. */
    private inner class TurnState(val request: ChatRequest) {
        val blocks = ArrayList<JsonObject>()
        var usageDone = Usage()
        var usageRound = Usage()
        var servedModel: String = request.model
        var started = false
        var emittedAnything = false
        var stopReason: StopReason = StopReason.END
        var rounds = 0
        val citations = CitationCollector()
        var lastQuery: String? = null

        fun pausedContent(): JsonArray? = if (blocks.isEmpty()) null else JsonArray(blocks.toList())
        val usage get() = usageDone + usageRound
    }

    private class BlockBuilder(val start: JsonObject) {
        val type: String = start.str("type").orEmpty()
        val text = StringBuilder()
        val thinking = StringBuilder()
        var signature: String? = null
        val partialJson = StringBuilder()
        val citations = ArrayList<JsonElement>()

        fun build(): JsonObject = when (type) {
            "text" -> JsonObject(start + buildMap {
                put("text", JsonPrimitive(text.toString()))
                val existing = start.arr("citations").orEmpty()
                if (existing.isNotEmpty() || citations.isNotEmpty()) put("citations", JsonArray(existing + citations))
                else if ("citations" in start) put("citations", JsonArray(emptyList()))
            })
            "thinking" -> JsonObject(start + buildMap {
                put("thinking", JsonPrimitive(thinking.toString()))
                signature?.let { put("signature", JsonPrimitive(it)) }
            })
            "tool_use", "server_tool_use", "mcp_tool_use" -> {
                val input = if (partialJson.isNotBlank()) parseJsonOrNull(partialJson.toString()) else null
                if (input != null) JsonObject(start + ("input" to input)) else start
            }
            else -> start
        }
    }

    private suspend fun FlowCollector<StreamEvent>.runRound(httpRequest: Request, turn: TurnState): RoundOutcome {
        turn.rounds++
        turn.usageRound = Usage()
        val open = HashMap<Int, BlockBuilder>()
        val finished = java.util.TreeMap<Int, JsonObject>()
        var roundStop: String? = null
        var sawStop = false
        var failed = false

        streamHttp.sseFlow(httpRequest).collect { ev ->
            if (failed) return@collect
            val json = parseObjectOrNull(ev.data) ?: return@collect
            when (json.str("type") ?: ev.event) {
                "message_start" -> {
                    val msg = json.obj("message")
                    val model = msg?.str("model")
                    if (model != null) turn.servedModel = model
                    if (!turn.started) {
                        turn.started = true
                        turn.emittedAnything = true
                        emit(StreamEvent.Started(turn.servedModel))
                        if (model != null && !sameModel(model, turn.request.model)) {
                            emit(StreamEvent.Notice("Answered by $model instead of ${turn.request.model} (automatic fallback)."))
                        }
                    }
                    msg?.obj("usage")?.let { turn.usageRound = parseUsage(it, turn.usageRound); emit(StreamEvent.UsageUpdate(turn.usage)) }
                }
                "content_block_start" -> {
                    val index = json.long("index")?.toInt() ?: return@collect
                    val block = json.obj("content_block") ?: return@collect
                    val b = BlockBuilder(block)
                    open[index] = b
                    when (b.type) {
                        "thinking", "redacted_thinking" -> emit(StreamEvent.ThinkingStarted)
                        "tool_use" -> {
                            val id = block.str("id").orEmpty()
                            val name = block.str("name").orEmpty()
                            turn.emittedAnything = true
                            emit(StreamEvent.ToolCallStarted(id, name))
                        }
                        "web_search_tool_result" -> {
                            val content = block["content"]
                            if (content is JsonArray) {
                                var changed = false
                                for (r in content) {
                                    val o = r as? JsonObject ?: continue
                                    if (o.str("type") == "web_search_result") changed = turn.citations.add(o.str("url"), o.str("title")) or changed
                                }
                                emit(StreamEvent.WebSearch(turn.lastQuery, done = true))
                                if (changed) emit(StreamEvent.Citations(turn.citations.snapshot()))
                            } else {
                                emit(StreamEvent.WebSearch(turn.lastQuery, done = true))
                            }
                        }
                        "fallback" -> {
                            val from = block.obj("from")?.str("model")
                            val to = block.obj("to")?.str("model")
                            if (to != null) turn.servedModel = to
                            emit(StreamEvent.Notice(
                                if (from != null && to != null) "$from declined this request; $to answered instead."
                                else "Another model answered after the requested model declined.",
                            ))
                        }
                    }
                }
                "content_block_delta" -> {
                    val index = json.long("index")?.toInt() ?: return@collect
                    val b = open[index] ?: return@collect
                    val delta = json.obj("delta") ?: return@collect
                    when (delta.str("type")) {
                        "text_delta" -> delta.str("text")?.takeIf { it.isNotEmpty() }?.let {
                            b.text.append(it); emit(StreamEvent.TextDelta(it))
                        }
                        "thinking_delta" -> delta.str("thinking")?.takeIf { it.isNotEmpty() }?.let {
                            b.thinking.append(it); emit(StreamEvent.ThinkingDelta(it))
                        }
                        "signature_delta" -> b.signature = delta.str("signature")
                        "input_json_delta" -> delta.str("partial_json")?.let { b.partialJson.append(it) }
                        "citations_delta" -> delta.obj("citation")?.let { c ->
                            b.citations += c
                            if (turn.citations.add(c.str("url"), c.str("title"), c.str("cited_text"))) {
                                emit(StreamEvent.Citations(turn.citations.snapshot()))
                            }
                        }
                    }
                }
                "content_block_stop" -> {
                    val index = json.long("index")?.toInt() ?: return@collect
                    val b = open.remove(index) ?: return@collect
                    val built = b.build()
                    finished[index] = built
                    when (b.type) {
                        "thinking", "redacted_thinking" -> emit(StreamEvent.ThinkingEnded)
                        "tool_use" -> {
                            // Eager input streaming: arguments may be truncated or invalid; the engine validates.
                            val raw = b.partialJson.toString()
                            val args = if (raw.isBlank()) (b.start.obj("input") ?: JsonObject(emptyMap())).toString()
                            else ToolWire.normalizeArgs(raw)
                            emit(StreamEvent.ToolCallReady(b.start.str("id").orEmpty(), b.start.str("name").orEmpty(), args))
                        }
                        "server_tool_use" -> if (built.str("name") == "web_search") {
                            turn.lastQuery = built.obj("input")?.str("query")
                            emit(StreamEvent.WebSearch(turn.lastQuery, done = false))
                        }
                    }
                }
                "message_delta" -> {
                    json.obj("delta")?.let { d ->
                        d.str("stop_reason")?.let { roundStop = it }
                        if (d.str("stop_reason") == "refusal") {
                            val category = d.obj("stop_details")?.str("category")
                            emit(StreamEvent.Notice(refusalNotice(turn.servedModel, category)))
                        }
                    }
                    json.obj("usage")?.let { turn.usageRound = parseUsage(it, turn.usageRound); emit(StreamEvent.UsageUpdate(turn.usage)) }
                }
                "message_stop" -> sawStop = true
                "error" -> {
                    val err = json.obj("error")
                    failed = true
                    emit(StreamEvent.Failed(LlmErrors.fromStream(config, turn.request.model, err?.str("type"), err?.str("message"))))
                }
                else -> Unit // ping and future event types
            }
        }
        if (failed) return RoundOutcome.FAILED
        // Blocks still open when the stream ended are kept as-is.
        open.forEach { (i, b) -> finished.putIfAbsent(i, b.build()) }
        turn.blocks += finished.values
        turn.usageDone = turn.usage
        turn.usageRound = Usage()

        if (!sawStop && roundStop == null) {
            emit(StreamEvent.Failed(LlmErrors.truncatedStream(config)))
            return RoundOutcome.FAILED
        }
        return when (roundStop) {
            "pause_turn" -> RoundOutcome.CONTINUE
            "max_tokens", "model_context_window_exceeded" -> { turn.stopReason = StopReason.MAX_TOKENS; RoundOutcome.DONE }
            "refusal" -> { turn.stopReason = StopReason.REFUSAL; RoundOutcome.DONE }
            "tool_use" -> { turn.stopReason = StopReason.TOOL_USE; RoundOutcome.DONE }
            else -> { turn.stopReason = StopReason.END; RoundOutcome.DONE }
        }
    }

    private suspend fun FlowCollector<StreamEvent>.finish(turn: TurnState) {
        val blocks = cleanForReplay(turn.blocks)
        emit(StreamEvent.Completed(turn.stopReason, ProviderBlocks(ApiStyle.ANTHROPIC, turn.servedModel, JsonArray(blocks).toString())))
    }

    private fun refusalNotice(model: String, category: String?): String {
        val why = when (category) {
            null -> ""
            "cyber" -> " (cybersecurity safeguard)"
            "bio" -> " (biology safeguard)"
            else -> " ($category safeguard)"
        }
        return "$model declined to answer this request$why. Rephrase it or try another model."
    }

    private fun sameModel(a: String, b: String) = ModelCatalog.normalizeId(a) == ModelCatalog.normalizeId(b)

    private fun parseUsage(u: JsonObject, prev: Usage): Usage {
        val input = u.long("input_tokens")
        val cacheWrite = u.long("cache_creation_input_tokens")
        val cacheRead = u.long("cache_read_input_tokens")
        val output = u.long("output_tokens")
        val prevUncached = prev.inputTokens - prev.cacheReadTokens - prev.cacheWriteTokens
        val uncached = input ?: prevUncached
        val cw = cacheWrite ?: prev.cacheWriteTokens
        val cr = cacheRead ?: prev.cacheReadTokens
        return Usage(
            inputTokens = uncached + cw + cr,
            outputTokens = output ?: prev.outputTokens,
            cacheReadTokens = cr,
            cacheWriteTokens = cw,
            reasoningTokens = prev.reasoningTokens,
        )
    }

    // ------------------------------------------------------------------ request body

    private class Built(
        val body: JsonObject,
        val betas: Set<String>,
        val sent: List<ParamSpec>,
        val effort: Effort?,
        val replaysThinking: Boolean,
        val clientTools: Boolean,
    )

    private fun buildBody(req: ChatRequest, dropped: Set<String>, stripThinking: Boolean, paused: JsonArray?): Built {
        val claude = ModelCatalog.parseClaude(req.model)
        val caps = req.caps
        val betas = LinkedHashSet<String>()
        val sent = ArrayList<ParamSpec>()
        val utility = req.utility
        val webSearch = req.params.webSearch && caps.webSearch && !utility && "web_search" !in dropped
        val clientTools = if (!utility && caps.tools && "tools" !in dropped) req.tools else emptyList()

        // max_tokens
        val cap = maxTokensCap(dropped)
        var maxTokens = req.params.maxOutputTokens
            ?: if (utility) UTILITY_MAX_TOKENS
            else minOf(req.modelMaxOutput ?: claude?.defaultMaxOutput ?: FALLBACK_MAX_TOKENS, DEFAULT_MAX_TOKENS)
        if (cap != null) maxTokens = minOf(maxTokens, cap)
        maxTokens = maxTokens.coerceAtLeast(1)

        // thinking + effort
        val requested = if (utility) Effort.NONE else req.params.effort
        val display = if (req.params.showThinking && !utility) "summarized" else "omitted"
        var thinking: JsonObject? = null
        var thinkingMode: String? = null
        var effort: Effort? = null
        when (caps.reasoning.kind) {
            ReasoningKind.EFFORT -> {
                if (requested == Effort.NONE) {
                    when (claude?.thinkingOff ?: ThinkingOff.OMIT) {
                        ThinkingOff.DISABLED -> thinkingMode = "disabled"
                        ThinkingOff.BETWEEN_TOOLS -> thinkingMode = "between_tools"
                        ThinkingOff.OMIT -> Unit
                        ThinkingOff.CANNOT -> {
                            thinkingMode = "adaptive"
                            effort = resolveEffort(Effort.LOW, caps.reasoning.efforts, dropped)
                        }
                    }
                } else {
                    effort = resolveEffort(requested, caps.reasoning.efforts, dropped)
                    if (requested != null || claude?.thinkingOnByDefault == true) thinkingMode = "adaptive"
                }
            }
            ReasoningKind.BUDGET -> if (requested != null && requested != Effort.NONE) thinkingMode = "enabled"
            ReasoningKind.NONE -> Unit
        }
        if ("thinking" in dropped && thinkingMode != null) thinkingMode = null

        // messages
        var replaysThinking = false
        val messages = buildJsonArray {
            for (m in req.messages) {
                when (m.role) {
                    Role.USER -> addJsonObject {
                        put("role", "user")
                        put("content", userContent(m.parts))
                    }
                    Role.ASSISTANT -> {
                        val content = assistantContent(m, stripThinking, webSearch)
                        if (content.any { (it as? JsonObject)?.str("type") in THINKING_TYPES }) replaysThinking = true
                        addJsonObject {
                            put("role", "assistant")
                            put("content", content)
                        }
                    }
                }
            }
            if (paused != null) {
                val content = JsonArray(paused.filter { !isEmptyText(it) })
                if (content.any { (it as? JsonObject)?.str("type") in THINKING_TYPES }) replaysThinking = true
                addJsonObject {
                    put("role", "assistant")
                    put("content", content)
                }
            }
        }

        if (thinkingMode != null) {
            thinking = buildJsonObject {
                put("type", thinkingMode)
                when (thinkingMode) {
                    "adaptive" -> {
                        if ("display" !in dropped) {
                            put("display", display)
                            sent += ParamSpec("display", listOf("thinking.display", "display"))
                        }
                    }
                    "enabled" -> {
                        val budget = budgetFor(requested ?: Effort.MEDIUM)
                            .coerceAtMost(maxTokens - 1024).coerceAtLeast(1024)
                        if (maxTokens <= 1024 + 1024) maxTokens = budget + 4096
                        put("budget_tokens", budget)
                    }
                }
                val bindable = thinkingMode == "adaptive" || thinkingMode == "enabled"
                if (replaysThinking && bindable && "block_binding" !in dropped) {
                    putJsonObject("block_binding") { put("prefix_mismatch_behavior", "drop_block") }
                    betas += BETA_THINKING_BINDING
                    sent += ParamSpec("block_binding", listOf("block_binding", "prefix_mismatch", "thinking-binding"))
                }
            }
            sent += ParamSpec("thinking", listOf("thinking", "budget_tokens"))
        }

        val body = buildJsonObject {
            put("model", req.model)
            put("max_tokens", maxTokens)
            put("stream", true)
            req.system?.takeIf { it.isNotBlank() }?.let { sys ->
                putJsonArray("system") { addJsonObject { put("type", "text"); put("text", sys) } }
            }
            put("messages", messages)
            thinking?.let { put("thinking", it) }
            if (effort != null) {
                putJsonObject("output_config") { put("effort", effort.wire) }
                sent += ParamSpec("effort", listOf("output_config.effort", "effort", "output_config"))
            }
            val thinkingOn = thinkingMode == "adaptive" || thinkingMode == "enabled"
            if (caps.sampling && !thinkingOn) {
                req.params.temperature?.takeIf { "temperature" !in dropped }?.let {
                    put("temperature", it.coerceIn(0f, 1f))
                    sent += ParamSpec("temperature", listOf("temperature"))
                }
                req.params.topP?.takeIf { "top_p" !in dropped }?.let {
                    put("top_p", it)
                    sent += ParamSpec("top_p", listOf("top_p"))
                }
            }
            val eager = clientTools.isNotEmpty() && "eager_input_streaming" !in dropped
            if (webSearch || clientTools.isNotEmpty()) {
                val v2 = claude?.webSearchV2 == true && "web_search_v2" !in dropped
                putJsonArray("tools") {
                    if (webSearch) addJsonObject {
                        put("type", if (v2) "web_search_20260209" else "web_search_20250305")
                        put("name", "web_search")
                        put("max_uses", 5)
                    }
                    for (t in clientTools) addJsonObject {
                        put("name", t.name)
                        put("description", t.description)
                        put("input_schema", ToolWire.schema(t.inputSchemaJson))
                        if (eager) put("eager_input_streaming", true)
                    }
                }
                if (webSearch) {
                    if (v2) sent += ParamSpec("web_search_v2", listOf("web_search_20260209"))
                    // With client tools present, a generic "tools" error isn't evidence against web search.
                    sent += ParamSpec("web_search", if (clientTools.isEmpty()) listOf("web_search", "tools") else listOf("web_search"))
                }
                if (eager) sent += ParamSpec("eager_input_streaming", listOf("eager_input_streaming"))
            }
            if (!utility && "cache_control" !in dropped) {
                putJsonObject("cache_control") { put("type", "ephemeral") }
                sent += ParamSpec("cache_control", listOf("cache_control"))
            }
            if (!utility && caps.refusalFallback && "fallbacks" !in dropped) {
                put("fallbacks", "default")
                betas += BETA_FALLBACK
                sent += ParamSpec("fallbacks", listOf("fallbacks", "fallback", "server-side-fallback"))
            }
            if (!utility && req.params.fastMode && caps.fastMode && "speed" !in dropped) {
                put("speed", "fast")
                betas += BETA_FAST
                sent += ParamSpec("speed", listOf("speed", "fast-mode", "fast mode"))
            }
        }
        sent += ParamSpec("max_tokens", listOf("max_tokens"))
        // Specific params first so the healer blames the narrowest one.
        val ordered = sent.sortedBy { SPEC_ORDER.indexOf(it.key).let { i -> if (i < 0) SPEC_ORDER.size else i } }
        return Built(body, betas, ordered, effort, replaysThinking, clientTools.isNotEmpty())
    }

    private fun budgetFor(e: Effort): Int = when (e) {
        Effort.NONE, Effort.MINIMAL, Effort.LOW -> 2_048
        Effort.MEDIUM -> 8_192
        Effort.HIGH -> 16_384
        Effort.XHIGH -> 24_576
        Effort.MAX -> 32_000
    }

    private fun userContent(parts: List<Part>): JsonArray {
        val results = parts.filterIsInstance<Part.ToolResult>()
        val media = parts.filter { it is Part.Image || it is Part.Document }
        val texts = parts.filterIsInstance<Part.Text>().filter { it.text.isNotBlank() }
        val arr = buildJsonArray {
            // tool_result blocks must come first in the user turn that follows tool_use.
            for (r in results) addJsonObject {
                put("type", "tool_result")
                put("tool_use_id", ToolWire.safeId(r.callId))
                put("content", r.content.ifBlank { "(no output)" })
                if (r.isError) put("is_error", true)
            }
            for (p in media) when (p) {
                is Part.Image -> addJsonObject {
                    put("type", "image")
                    putJsonObject("source") {
                        put("type", "base64")
                        put("media_type", p.mimeType)
                        put("data", base64(p.bytes))
                    }
                }
                is Part.Document -> when {
                    p.mimeType == "application/pdf" -> addJsonObject {
                        put("type", "document")
                        putJsonObject("source") {
                            put("type", "base64")
                            put("media_type", "application/pdf")
                            put("data", base64(p.bytes))
                        }
                        if (p.name.isNotBlank()) put("title", p.name)
                    }
                    else -> addJsonObject {
                        put("type", "document")
                        putJsonObject("source") {
                            put("type", "text")
                            put("media_type", "text/plain")
                            put("data", p.bytes.toString(Charsets.UTF_8))
                        }
                        if (p.name.isNotBlank()) put("title", p.name)
                    }
                }
                else -> Unit
            }
            for (t in texts) addJsonObject { put("type", "text"); put("text", t.text) }
        }
        return if (arr.isEmpty()) buildJsonArray { addJsonObject { put("type", "text"); put("text", "(empty message)") } } else arr
    }

    private fun assistantContent(m: ChatMessage, stripThinking: Boolean, webSearch: Boolean): JsonArray {
        val blocks = m.blocks
        if (blocks != null && blocks.style == ApiStyle.ANTHROPIC) {
            val parsed = parseJsonOrNull(blocks.json) as? JsonArray
            if (parsed != null) {
                val kept = parsed.filter { el ->
                    val type = (el as? JsonObject)?.str("type") ?: return@filter false
                    when {
                        type == "fallback" -> false
                        stripThinking && type in THINKING_TYPES -> false
                        !webSearch && type in SERVER_TOOL_TYPES -> false
                        isEmptyText(el) -> false
                        else -> true
                    }
                }
                if (kept.any { (it as? JsonObject)?.str("type") !in THINKING_TYPES }) return JsonArray(kept)
            }
        }
        val text = m.parts.filterIsInstance<Part.Text>().joinToString("\n\n") { it.text }
        val calls = m.parts.filterIsInstance<Part.ToolCall>()
        return buildJsonArray {
            if (text.isNotBlank() || calls.isEmpty()) addJsonObject { put("type", "text"); put("text", text.ifBlank { "(no response)" }) }
            for (c in calls) addJsonObject {
                put("type", "tool_use")
                put("id", ToolWire.safeId(c.id))
                put("name", c.name)
                put("input", ToolWire.argsObject(c.argumentsJson))
            }
        }
    }

    private fun isEmptyText(el: JsonElement): Boolean {
        val o = el as? JsonObject ?: return false
        return o.str("type") == "text" && o.str("text").isNullOrBlank()
    }

    /**
     * Prepares the final content for replay: after a mid-output refusal fallback, drop the
     * declined model's thinking / tool_use / unpaired server-tool blocks before the last fallback
     * marker, then drop the markers themselves and empty text blocks.
     */
    private fun cleanForReplay(blocks: List<JsonObject>): List<JsonObject> {
        val lastFallback = blocks.indexOfLast { it.str("type") == "fallback" }
        val resultIds = blocks.mapNotNull { it.str("tool_use_id") }.toSet()
        return blocks.filterIndexed { i, b ->
            val type = b.str("type")
            when {
                type == "fallback" -> false
                isEmptyText(b) -> false
                i < lastFallback && (type in THINKING_TYPES || type == "tool_use") -> false
                i < lastFallback && type == "server_tool_use" && b.str("id") !in resultIds -> false
                else -> true
            }
        }
    }

    companion object {
        const val API_VERSION = "2023-06-01"
        const val BETA_THINKING_BINDING = "thinking-binding-controls-2026-08-01"
        const val BETA_FALLBACK = "server-side-fallback-2026-07-01"
        const val BETA_FAST = "fast-mode-2026-02-01"
        private const val MAX_HEALS = 3
        private const val MAX_PAUSE_ROUNDS = 5
        private const val MAX_MODEL_PAGES = 10
        private const val DEFAULT_MAX_TOKENS = 64_000
        private const val FALLBACK_MAX_TOKENS = 16_000
        private const val UTILITY_MAX_TOKENS = 1_024
        private val THINKING_TYPES = setOf("thinking", "redacted_thinking")
        private val SERVER_TOOL_TYPES = setOf("server_tool_use", "web_search_tool_result", "web_fetch_tool_result")
        private val SPEC_ORDER = listOf(
            "eager_input_streaming", "block_binding", "display", "effort", "fallbacks", "speed", "web_search_v2", "cache_control",
            "temperature", "top_p", "web_search", "thinking", "max_tokens",
        )
    }
}
