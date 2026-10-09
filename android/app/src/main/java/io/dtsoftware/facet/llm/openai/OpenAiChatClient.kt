package io.dtsoftware.facet.llm.openai

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
import io.dtsoftware.facet.llm.ModelCaps
import io.dtsoftware.facet.llm.ModelCatalog
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ModelOutput
import io.dtsoftware.facet.llm.ParamHealer
import io.dtsoftware.facet.llm.ParamSpec
import io.dtsoftware.facet.llm.Part
import io.dtsoftware.facet.llm.PricingCatalog
import io.dtsoftware.facet.llm.ProviderBlocks
import io.dtsoftware.facet.llm.ProviderConfig
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.llm.QuirkStore
import io.dtsoftware.facet.llm.ReasoningKind
import io.dtsoftware.facet.llm.ReasoningSupport
import io.dtsoftware.facet.llm.Role
import io.dtsoftware.facet.llm.StopReason
import io.dtsoftware.facet.llm.StreamEvent
import io.dtsoftware.facet.llm.Usage
import io.dtsoftware.facet.llm.internal.CitationCollector
import io.dtsoftware.facet.llm.internal.ToolWire
import io.dtsoftware.facet.llm.internal.ThinkTagSplitter
import io.dtsoftware.facet.llm.internal.arr
import io.dtsoftware.facet.llm.internal.dataUrl
import io.dtsoftware.facet.llm.internal.long
import io.dtsoftware.facet.llm.internal.obj
import io.dtsoftware.facet.llm.internal.parseJsonOrNull
import io.dtsoftware.facet.llm.internal.parseObjectOrNull
import io.dtsoftware.facet.llm.internal.str
import io.dtsoftware.facet.llm.internal.stringOrNull
import io.dtsoftware.facet.llm.internal.trimBaseUrl
import io.dtsoftware.facet.llm.maxTokensCap
import io.dtsoftware.facet.llm.record
import io.dtsoftware.facet.llm.resolveEffort
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
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
import okhttp3.OkHttpClient
import okhttp3.Request

/** OpenAI-compatible Chat Completions adapter for every non-first-party preset and custom endpoints. */
internal class OpenAiChatClient(
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
    private val kind = config.kind
    private val base = config.baseUrl.trimBaseUrl().ifBlank { kind.defaultBaseUrl.trimBaseUrl() }
    private val provider get() = LlmErrors.providerName(config)

    private fun requestBuilder(path: String) = Request.Builder()
        .url("$base/$path")
        .apply {
            if (config.apiKey.isNotBlank()) header("Authorization", "Bearer ${config.apiKey}")
            if (kind == ProviderKind.OPENROUTER) {
                header("HTTP-Referer", "https://facet.dtsoftware.io")
                header("X-Title", "Facet")
            }
            config.headers.forEach { (k, v) -> header(k, v) }
        }

    // ------------------------------------------------------------------ models

    override suspend fun listModels(): List<ModelInfo> {
        if (kind == ProviderKind.PERPLEXITY) {
            return ModelCatalog.perplexityModels().map { it.copy(pricing = pricing?.priceFor(kind, it.id)) }
        }
        val body = fetch(requestBuilder("models").get().build())
        val json = parseObjectOrNull(body)
        val data = json?.arr("data") ?: json?.arr("models") ?: return emptyList()
        val models = data.mapNotNull { it as? JsonObject }
        return if (kind == ProviderKind.OPENROUTER) {
            models.mapNotNull { openRouterModel(it) }
        } else {
            val listed = models.mapNotNull { m ->
                val rawId = m.str("id") ?: m.str("name") ?: return@mapNotNull null
                val id = rawId.removePrefix("models/")
                val output = outputOf(id, m.str("type")) ?: return@mapNotNull null
                ModelInfo(
                    id = id,
                    displayName = m.str("display_name")?.takeIf { kind == ProviderKind.GOOGLE }
                        ?: ModelCatalog.displayName(kind, id),
                    contextWindow = (m.long("context_length") ?: m.long("context_window") ?: m.long("max_context_length"))?.toInt(),
                    caps = if (output == ModelOutput.TEXT) ModelCatalog.compatCaps(kind, id) else ModelCaps(tools = false),
                    pricing = pricing?.priceFor(kind, id),
                    createdAt = m.long("created")?.times(1000),
                    output = output,
                )
            }
            if (kind == ProviderKind.GOOGLE) {
                // Gemini's OpenAI-compatible list may leave out media models; add the current ones it lacks.
                listed + ModelCatalog.geminiMediaDefaults.filter { d -> listed.none { it.output == d.output } }
            } else listed
        }
    }

    /** Chat, a runnable media kind, or null to leave the model out (embeddings, rerankers, unsupported media). */
    private fun outputOf(id: String, type: String?): ModelOutput? {
        // Together labels every model with a type.
        val typed = when (type?.lowercase()) {
            "chat", "language", "code" -> ModelOutput.TEXT
            "image" -> ModelOutput.IMAGE
            "audio" -> ModelOutput.SPEECH
            "transcribe" -> ModelOutput.TRANSCRIPTION
            "video" -> ModelOutput.VIDEO
            "embedding", "rerank", "moderation" -> return null
            else -> null
        }
        val output = typed ?: ModelCatalog.mediaOutput(kind, id) ?: if (ModelCatalog.isCompatChatModel(id)) ModelOutput.TEXT else return null
        return output.takeIf { ModelCatalog.canRun(kind, it) }
    }

    private fun openRouterModel(m: JsonObject): ModelInfo? {
        val id = m.str("id") ?: return null
        val arch = m.obj("architecture")
        val outputs = arch?.arr("output_modalities")?.mapNotNull { it.stringOrNull() }.orEmpty()
        // Models that draw (e.g. Gemini image models) go to the image list; they answer through chat completions.
        if ("image" in outputs) {
            return ModelInfo(
                id = id,
                displayName = m.str("name") ?: ModelCatalog.displayName(kind, id),
                caps = ModelCaps(tools = false),
                pricing = PricingCatalog.openRouterPricing(m.obj("pricing")),
                createdAt = m.long("created")?.times(1000),
                output = ModelOutput.IMAGE,
            )
        }
        if (outputs.isNotEmpty() && "text" !in outputs) return null
        val inputs = arch?.arr("input_modalities")?.mapNotNull { it.stringOrNull() }.orEmpty()
        val params = m.arr("supported_parameters")?.mapNotNull { it.stringOrNull() }?.toSet()
        val reasons = params != null && ("reasoning" in params || "include_reasoning" in params)
        val caps = ModelCaps(
            vision = if (inputs.isNotEmpty()) "image" in inputs else ModelCatalog.looksVision(id),
            pdf = "file" in inputs,
            reasoning = if (reasons) {
                ReasoningSupport(ReasoningKind.EFFORT, listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH), null, summaries = true)
            } else ReasoningSupport(),
            webSearch = true,
            sampling = params?.contains("temperature") ?: true,
            tools = params?.contains("tools") ?: true,
        )
        return ModelInfo(
            id = id,
            displayName = m.str("name") ?: ModelCatalog.displayName(kind, id),
            contextWindow = m.long("context_length")?.toInt(),
            maxOutput = m.obj("top_provider")?.long("max_completion_tokens")?.toInt(),
            caps = caps,
            pricing = PricingCatalog.openRouterPricing(m.obj("pricing")),
            createdAt = m.long("created")?.times(1000),
        )
    }

    override suspend fun verify(): Result<Unit> = try {
        if (kind == ProviderKind.PERPLEXITY) {
            val body = buildJsonObject {
                put("model", "sonar")
                put("max_tokens", 1)
                putJsonArray("messages") { addJsonObject { put("role", "user"); put("content", "ping") } }
            }
            fetch(requestBuilder("chat/completions").post(body.toString().toJsonBody()).build())
        } else {
            fetch(requestBuilder("models").get().build())
        }
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
        var heals = 0
        var includeReasoning = false
        while (true) {
            val built = buildBody(request, dropped, includeReasoning)
            val httpRequest = requestBuilder("chat/completions")
                .header("Accept", "text/event-stream")
                .post(built.body.toString().toJsonBody())
                .build()
            val state = StreamState(request)
            try {
                consume(httpRequest, state)
                return@flow
            } catch (e: HttpStatusException) {
                if (state.started) {
                    emit(StreamEvent.Failed(LlmErrors.fromHttp(config, request.model, e)))
                    return@flow
                }
                val msg = LlmErrors.extractMessage(e.body)
                // DeepSeek-style thinking + tools: the tool loop must echo reasoning_content back.
                if (e.code == 400 && !includeReasoning && built.hasToolHistory && "reasoning_content" in msg.lowercase()) {
                    includeReasoning = true
                    continue
                }
                if ((e.code == 400 || e.code == 422) && heals < MAX_HEALS) {
                    val action = if (built.clientTools && ToolWire.toolsUnsupported(msg)) HealAction.Drop("tools")
                    else ParamHealer.diagnose(msg, built.sent, built.effort, request.caps.reasoning.efforts)
                    if (action != null) {
                        heals++
                        quirks.record(config.id, request.model, action)
                        when (action) {
                            is HealAction.Drop -> dropped += action.key
                            is HealAction.EffortValue -> {
                                dropped += "effort:${action.unsupported.wire}"
                                if (action.replacement == null) dropped += "effort"
                            }
                            is HealAction.CapMaxTokens -> dropped += "max_tokens:${action.max}"
                        }
                        continue
                    }
                }
                emit(StreamEvent.Failed(LlmErrors.fromHttp(config, request.model, e)))
                return@flow
            } catch (e: IOException) {
                emit(StreamEvent.Failed(LlmErrors.fromIo(config, e)))
                return@flow
            }
        }
    }.catch { e ->
        if (e is CancellationException) throw e
        if (e is IOException) emit(StreamEvent.Failed(LlmErrors.fromIo(config, e)))
        else emit(StreamEvent.Failed(LlmError(ErrorKind.UNKNOWN, "Something went wrong reading the response from $provider.", detail = e.message)))
    }.flowOn(Dispatchers.Default)

    private class StreamState(val request: ChatRequest) {
        var started = false
        var finished = false
        var model: String = request.model
        var usage: Usage? = null
        var finishReason: String? = null
        var thinkingOpen = false
        val splitter = ThinkTagSplitter()
        val citations = CitationCollector()
        var perplexityCitationsSeen = 0
        val text = StringBuilder()
        val reasoning = StringBuilder()
        val tools = java.util.TreeMap<Int, ToolAcc>()
    }

    private class ToolAcc(var id: String = "", var name: String = "", val args: StringBuilder = StringBuilder(), var started: Boolean = false)

    private suspend fun FlowCollector<StreamEvent>.consume(httpRequest: Request, s: StreamState) {
        streamHttp.sseFlow(httpRequest).collect { ev ->
            if (s.finished) return@collect
            val data = ev.data.trim()
            if (data == "[DONE]") {
                finish(s)
                return@collect
            }
            val json = parseObjectOrNull(data) ?: return@collect
            json["error"]?.let { err ->
                val o = err as? JsonObject
                s.finished = true
                closeThinking(s)
                emit(StreamEvent.Failed(LlmErrors.fromStream(config, s.request.model, o?.str("type") ?: o?.long("code")?.toString() ?: o?.str("code"), o?.str("message") ?: err.stringOrNull())))
                return@collect
            }
            if (!s.started) {
                s.started = true
                json.str("model")?.let { s.model = it }
                emit(StreamEvent.Started(s.model))
            }
            handleCitations(json, s)
            val choice = json.arr("choices")?.firstOrNull() as? JsonObject
            if (choice != null) {
                val delta = choice.obj("delta") ?: choice.obj("message")
                if (delta != null) handleDelta(delta, s)
                choice.str("finish_reason")?.let { s.finishReason = it }
            }
            (json.obj("usage") ?: json.obj("x_groq")?.obj("usage"))?.let { u ->
                val usage = parseUsage(u)
                if (usage != s.usage) {
                    s.usage = usage
                    emit(StreamEvent.UsageUpdate(usage))
                }
            }
        }
        if (!s.finished) {
            if (s.started && s.finishReason != null) finish(s)
            else emit(StreamEvent.Failed(LlmErrors.truncatedStream(config)))
        }
    }

    private suspend fun FlowCollector<StreamEvent>.handleDelta(delta: JsonObject, s: StreamState) {
        // Reasoning fields used by various providers (DeepSeek, OpenRouter, Groq, xAI, vLLM…).
        val reasoning = delta.str("reasoning_content") ?: delta.str("reasoning")
            ?: delta.arr("reasoning_details")?.joinToString("") { d ->
                (d as? JsonObject)?.let { it.str("text") ?: it.str("summary") }.orEmpty()
            }?.takeIf { it.isNotEmpty() }
        if (!reasoning.isNullOrEmpty()) emitThinking(reasoning, s)

        when (val content = delta["content"]) {
            is JsonPrimitive -> content.stringOrNull()?.let { emitContent(it, s) }
            is JsonArray -> for (part in content) {
                val o = part as? JsonObject ?: continue
                when (o.str("type")) {
                    "text" -> o.str("text")?.let { emitContent(it, s) }
                    "thinking" -> {
                        val t = when (val th = o["thinking"]) {
                            is JsonArray -> th.joinToString("") { (it as? JsonObject)?.str("text").orEmpty() }
                            else -> th.stringOrNull().orEmpty()
                        }
                        if (t.isNotEmpty()) emitThinking(t, s)
                    }
                }
            }
            else -> Unit
        }
        delta.arr("annotations")?.let { anns ->
            var changed = false
            for (a in anns) {
                val o = a as? JsonObject ?: continue
                val c = o.obj("url_citation") ?: o
                changed = s.citations.add(c.str("url"), c.str("title"), c.str("content")) or changed
            }
            if (changed) emit(StreamEvent.Citations(s.citations.snapshot()))
        }
        delta.arr("tool_calls")?.forEach { el -> handleToolFragment(el as? JsonObject ?: return@forEach, s) }
    }

    /**
     * Accumulates a streamed tool-call fragment. Ids and names may arrive only on the first fragment;
     * some providers (Gemini compat) omit `index` and ids, so a fragment with a name starts a new call.
     */
    private suspend fun FlowCollector<StreamEvent>.handleToolFragment(o: JsonObject, s: StreamState) {
        val fn = o.obj("function")
        val name = fn?.str("name")?.takeIf { it.isNotEmpty() }
        val index = o.long("index")?.toInt()
            ?: if (name != null || s.tools.isEmpty()) s.tools.size else s.tools.lastKey()
        val acc = s.tools.getOrPut(index) { ToolAcc() }
        o.str("id")?.takeIf { it.isNotBlank() && acc.id.isEmpty() }?.let { acc.id = it }
        if (name != null && acc.name.isEmpty()) acc.name = name
        when (val args = fn?.get("arguments")) {
            is JsonPrimitive -> args.stringOrNull()?.let { acc.args.append(it) }
            is JsonObject -> acc.args.append(args.toString())
            else -> Unit
        }
        if (!acc.started && acc.name.isNotEmpty()) {
            if (acc.id.isEmpty()) acc.id = ToolWire.newId(index)
            acc.started = true
            closeThinking(s)
            emit(StreamEvent.ToolCallStarted(acc.id, acc.name))
        }
    }

    private suspend fun FlowCollector<StreamEvent>.emitThinking(text: String, s: StreamState) {
        if (!s.thinkingOpen) {
            s.thinkingOpen = true
            emit(StreamEvent.ThinkingStarted)
        }
        s.reasoning.append(text)
        emit(StreamEvent.ThinkingDelta(text))
    }

    private suspend fun FlowCollector<StreamEvent>.emitContent(text: String, s: StreamState) {
        if (text.isEmpty()) return
        for (seg in s.splitter.feed(text)) emitSegment(seg, s)
    }

    private suspend fun FlowCollector<StreamEvent>.emitSegment(seg: ThinkTagSplitter.Segment, s: StreamState) {
        if (seg.thinking) {
            emitThinking(seg.text, s)
        } else {
            closeThinking(s)
            s.text.append(seg.text)
            emit(StreamEvent.TextDelta(seg.text))
        }
    }

    private suspend fun FlowCollector<StreamEvent>.closeThinking(s: StreamState) {
        if (s.thinkingOpen) {
            s.thinkingOpen = false
            emit(StreamEvent.ThinkingEnded)
        }
    }

    private suspend fun FlowCollector<StreamEvent>.handleCitations(json: JsonObject, s: StreamState) {
        var changed = false
        json.arr("search_results")?.forEach { r ->
            (r as? JsonObject)?.let { changed = s.citations.add(it.str("url"), it.str("title"), it.str("snippet")) or changed }
        }
        json.arr("citations")?.let { arr ->
            if (arr.size != s.perplexityCitationsSeen) {
                s.perplexityCitationsSeen = arr.size
                for (c in arr) {
                    when (c) {
                        is JsonPrimitive -> changed = s.citations.add(c.stringOrNull(), null) or changed
                        is JsonObject -> changed = s.citations.add(c.str("url"), c.str("title")) or changed
                        else -> Unit
                    }
                }
            }
        }
        if (changed) emit(StreamEvent.Citations(s.citations.snapshot()))
    }

    private suspend fun FlowCollector<StreamEvent>.finish(s: StreamState) {
        if (s.finished) return
        s.finished = true
        for (seg in s.splitter.flush()) emitSegment(seg, s)
        closeThinking(s)
        val calls = s.tools.values.filter { it.name.isNotEmpty() }
        for (c in calls) {
            if (!c.started) {
                c.started = true
                emit(StreamEvent.ToolCallStarted(c.id, c.name))
            }
            emit(StreamEvent.ToolCallReady(c.id, c.name, ToolWire.normalizeArgs(c.args.toString())))
        }
        val stop = when {
            s.finishReason == "length" -> StopReason.MAX_TOKENS
            s.finishReason == "content_filter" -> StopReason.REFUSAL
            calls.isNotEmpty() -> StopReason.TOOL_USE
            else -> StopReason.END
        }
        if (stop == StopReason.REFUSAL) emit(StreamEvent.Notice("${s.model} stopped because of a content filter."))
        val blocks = if (calls.isEmpty()) null else {
            val message = buildJsonObject {
                put("role", "assistant")
                put("content", s.text.toString())
                putJsonArray("tool_calls") {
                    for (c in calls) addJsonObject {
                        put("id", c.id)
                        put("type", "function")
                        putJsonObject("function") {
                            put("name", c.name)
                            put("arguments", ToolWire.normalizeArgs(c.args.toString()))
                        }
                    }
                }
                if (s.reasoning.isNotEmpty()) put("reasoning_content", s.reasoning.toString())
            }
            ProviderBlocks(ApiStyle.OPENAI_CHAT, s.model, JsonArray(listOf(message)).toString())
        }
        emit(StreamEvent.Completed(stop, blocks))
    }

    private fun parseUsage(u: JsonObject) = Usage(
        inputTokens = u.long("prompt_tokens") ?: u.long("input_tokens") ?: 0,
        outputTokens = u.long("completion_tokens") ?: u.long("output_tokens") ?: 0,
        cacheReadTokens = u.obj("prompt_tokens_details")?.long("cached_tokens") ?: u.long("prompt_cache_hit_tokens") ?: 0,
        reasoningTokens = u.obj("completion_tokens_details")?.long("reasoning_tokens") ?: 0,
    )

    // ------------------------------------------------------------------ request body

    private class Built(
        val body: JsonObject,
        val sent: List<ParamSpec>,
        val effort: Effort?,
        val clientTools: Boolean,
        val hasToolHistory: Boolean,
    )

    private fun buildBody(req: ChatRequest, dropped: Set<String>, includeReasoning: Boolean = false): Built {
        val caps = req.caps
        val sent = ArrayList<ParamSpec>()
        val utility = req.utility
        val clientTools = if (!utility && caps.tools && "tools" !in dropped && kind != ProviderKind.PERPLEXITY) req.tools else emptyList()
        val hasToolHistory = req.messages.any { m -> m.parts.any { it is Part.ToolCall || it is Part.ToolResult } }
        val messages = buildMessages(req, caps, includeReasoning)

        var effort: Effort? = null
        val body = buildJsonObject {
            put("model", req.model)
            put("stream", true)
            put("messages", messages)
            if ("stream_options" !in dropped && kind != ProviderKind.PERPLEXITY) {
                putJsonObject("stream_options") { put("include_usage", true) }
                sent += ParamSpec("stream_options", listOf("stream_options", "include_usage"))
            }

            // Output limit
            val cap = maxTokensCap(dropped)
            val max = req.params.maxOutputTokens ?: if (utility) 1_024 else null
            val finalMax = if (max != null && cap != null) minOf(max, cap) else max ?: cap
            if (finalMax != null) {
                val field = if ("max_tokens" in dropped) "max_completion_tokens" else "max_tokens"
                if (!(field == "max_completion_tokens" && "max_completion_tokens" in dropped)) {
                    put(field, finalMax.coerceAtLeast(16))
                    sent += ParamSpec("max_tokens", listOf(field))
                }
            }

            // Reasoning
            val r = caps.reasoning
            if (r.kind == ReasoningKind.EFFORT) {
                val requested = if (utility) r.efforts.minByOrNull { it.ordinal } else req.params.effort
                effort = when {
                    requested == null -> null
                    requested == Effort.NONE && Effort.NONE in r.efforts && "effort:none" !in dropped && "effort" !in dropped -> Effort.NONE
                    requested == Effort.NONE -> resolveEffort(Effort.MINIMAL, r.efforts, dropped)
                    else -> resolveEffort(requested, r.efforts, dropped)
                }
            }
            if (kind == ProviderKind.OPENROUTER) {
                val hide = !req.params.showThinking || utility
                if ((effort != null || hide) && r.kind == ReasoningKind.EFFORT && "reasoning" !in dropped) {
                    putJsonObject("reasoning") {
                        effort?.let { if (it == Effort.NONE) put("enabled", false) else put("effort", it.wire) }
                        if (hide) put("exclude", true)
                    }
                    sent += ParamSpec("reasoning", listOf("reasoning"))
                }
                if (effort != null) sent += ParamSpec("effort", listOf("effort"))
            } else if (effort != null && "reasoning_effort" !in dropped) {
                put("reasoning_effort", effort.wire)
                sent += ParamSpec("effort", listOf("reasoning_effort", "reasoning effort", "effort"))
            }
            if (kind == ProviderKind.GOOGLE && r.summaries && req.params.showThinking && !utility &&
                effort != Effort.NONE && "extra_body" !in dropped
            ) {
                putJsonObject("extra_body") {
                    putJsonObject("google") { putJsonObject("thinking_config") { put("include_thoughts", true) } }
                }
                sent += ParamSpec("extra_body", listOf("extra_body", "include_thoughts", "thinking_config"))
            }

            // Web search (OpenRouter web plugin)
            if (kind == ProviderKind.OPENROUTER && req.params.webSearch && caps.webSearch && !utility && "web_search" !in dropped) {
                putJsonArray("plugins") { addJsonObject { put("id", "web") } }
                sent += ParamSpec("web_search", listOf("plugins", "web"))
            }

            // Sampling
            if (caps.sampling) {
                req.params.temperature?.takeIf { "temperature" !in dropped }?.let {
                    put("temperature", it)
                    sent += ParamSpec("temperature", listOf("temperature"))
                }
                req.params.topP?.takeIf { "top_p" !in dropped }?.let {
                    put("top_p", it)
                    sent += ParamSpec("top_p", listOf("top_p"))
                }
            }

            // Client tools (function calling); tool_choice stays at the default "auto".
            if (clientTools.isNotEmpty()) {
                putJsonArray("tools") {
                    for (t in clientTools) addJsonObject {
                        put("type", "function")
                        putJsonObject("function") {
                            put("name", t.name)
                            put("description", t.description)
                            put("parameters", ToolWire.schema(t.inputSchemaJson))
                        }
                    }
                }
            }
        }
        val order = listOf("extra_body", "effort", "reasoning", "stream_options", "web_search", "temperature", "top_p", "max_tokens")
        return Built(body, sent.sortedBy { order.indexOf(it.key) }, effort, clientTools.isNotEmpty(), hasToolHistory)
    }

    /** Tool call ids as this provider accepts them (Mistral: 9 alphanumeric characters). */
    private fun wireId(id: String): String {
        val raw = id.ifBlank { "call_0" }
        return if (kind == ProviderKind.MISTRAL) ToolWire.mistralId(raw) else raw
    }

    private fun buildMessages(req: ChatRequest, caps: ModelCaps, includeReasoning: Boolean): JsonArray {
        val out = ArrayList<JsonObject>()

        /** Appends a plain message, merging into the previous one of the same role (strict-alternation providers). */
        fun addPlain(role: String, content: JsonElement) {
            val last = out.lastOrNull()
            val lastContent = last?.get("content")
            if (last != null && last.str("role") == role && role != "system" && role != "tool" &&
                "tool_calls" !in last && lastContent != null && lastContent !is kotlinx.serialization.json.JsonNull
            ) {
                out[out.lastIndex] = buildJsonObject { put("role", role); put("content", mergeContent(lastContent, content)) }
            } else {
                out += buildJsonObject { put("role", role); put("content", content) }
            }
        }

        req.system?.takeIf { it.isNotBlank() }?.let { out += buildJsonObject { put("role", "system"); put("content", it) } }
        for (m in req.messages) {
            when (m.role) {
                Role.USER -> {
                    val results = m.parts.filterIsInstance<Part.ToolResult>()
                    for (r in results) out += buildJsonObject {
                        put("role", "tool")
                        put("tool_call_id", wireId(r.callId))
                        put("content", (if (r.isError) "Error: " else "") + r.content.ifBlank { "(no output)" })
                    }
                    val rest = m.parts.filter { it !is Part.ToolResult && it !is Part.ToolCall }
                    if (rest.isNotEmpty() || results.isEmpty()) addPlain("user", userContent(rest, caps))
                }
                Role.ASSISTANT -> {
                    val text = m.parts.filterIsInstance<Part.Text>().joinToString("\n\n") { it.text }
                    val calls = m.parts.filterIsInstance<Part.ToolCall>()
                    if (calls.isEmpty()) {
                        addPlain("assistant", JsonPrimitive(text.ifBlank { "(no response)" }))
                    } else {
                        out += buildJsonObject {
                            put("role", "assistant")
                            put("content", text)
                            putJsonArray("tool_calls") {
                                for (c in calls) addJsonObject {
                                    put("id", wireId(c.id))
                                    put("type", "function")
                                    putJsonObject("function") {
                                        put("name", c.name)
                                        put("arguments", ToolWire.replayArgs(c.argumentsJson))
                                    }
                                }
                            }
                            if (includeReasoning) storedReasoning(m)?.let { put("reasoning_content", it) }
                        }
                    }
                }
            }
        }
        return JsonArray(out)
    }

    /** reasoning_content saved with an OPENAI_CHAT tool step (echoed only when the provider asks for it). */
    private fun storedReasoning(m: ChatMessage): String? {
        val b = m.blocks?.takeIf { it.style == ApiStyle.OPENAI_CHAT } ?: return null
        val arr = parseJsonOrNull(b.json) as? JsonArray ?: return null
        return arr.firstNotNullOfOrNull { (it as? JsonObject)?.str("reasoning_content") } ?: ""
    }

    private fun userContent(parts: List<Part>, caps: ModelCaps): JsonElement {
        val hasMedia = parts.any { it !is Part.Text }
        if (!hasMedia) {
            return JsonPrimitive(parts.filterIsInstance<Part.Text>().joinToString("\n\n") { it.text }.ifBlank { "(empty message)" })
        }
        return buildJsonArray {
            for (p in parts) when (p) {
                is Part.ToolCall, is Part.ToolResult -> Unit
                is Part.Text -> if (p.text.isNotBlank()) addJsonObject { put("type", "text"); put("text", p.text) }
                is Part.Image -> addJsonObject {
                    put("type", "image_url")
                    putJsonObject("image_url") { put("url", dataUrl(p.mimeType, p.bytes)) }
                }
                is Part.Document -> when {
                    p.mimeType == "application/pdf" && (caps.pdf || kind == ProviderKind.OPENROUTER) -> addJsonObject {
                        put("type", "file")
                        putJsonObject("file") {
                            put("filename", p.name.ifBlank { "document.pdf" })
                            put("file_data", dataUrl(p.mimeType, p.bytes))
                        }
                    }
                    p.mimeType == "application/pdf" -> addJsonObject {
                        put("type", "text")
                        put("text", "[Attached PDF “${p.name}” can't be read by this model.]")
                    }
                    else -> addJsonObject {
                        put("type", "text")
                        put("text", "File: ${p.name}\n```\n${p.bytes.toString(Charsets.UTF_8)}\n```")
                    }
                }
            }
        }
    }

    private fun mergeContent(a: JsonElement, b: JsonElement): JsonElement {
        if (a is JsonPrimitive && b is JsonPrimitive) return JsonPrimitive("${a.content}\n\n${b.content}")
        fun parts(e: JsonElement): List<JsonElement> = when (e) {
            is JsonArray -> e.toList()
            is JsonPrimitive -> listOf(buildJsonObject { put("type", "text"); put("text", e.content) })
            else -> emptyList()
        }
        return JsonArray(parts(a) + parts(b))
    }

    private companion object {
        const val MAX_HEALS = 3
    }
}
