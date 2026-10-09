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
import io.dtsoftware.facet.llm.ModelCatalog
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
import io.dtsoftware.facet.llm.internal.arr
import io.dtsoftware.facet.llm.internal.dataUrl
import io.dtsoftware.facet.llm.internal.long
import io.dtsoftware.facet.llm.internal.obj
import io.dtsoftware.facet.llm.internal.parseJsonOrNull
import io.dtsoftware.facet.llm.internal.parseObjectOrNull
import io.dtsoftware.facet.llm.internal.str
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request

/** OpenAI Responses API adapter (`/v1/responses`, stateless `store:false`). */
internal class OpenAiResponsesClient(
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
    private val base = config.baseUrl.trimBaseUrl().ifBlank { "https://api.openai.com/v1" }
    private val provider get() = LlmErrors.providerName(config)

    private fun requestBuilder(path: String) = Request.Builder()
        .url("$base/$path")
        .apply {
            if (config.apiKey.isNotBlank()) header("Authorization", "Bearer ${config.apiKey}")
            config.headers.forEach { (k, v) -> header(k, v) }
        }

    // ------------------------------------------------------------------ models

    override suspend fun listModels(): List<ModelInfo> {
        val body = fetch(requestBuilder("models").get().build())
        val data = parseObjectOrNull(body)?.arr("data") ?: return emptyList()
        val entries = data.mapNotNull { it as? JsonObject }.mapNotNull { m -> m.str("id")?.let { it to m.long("created") } }
            .filter { ModelCatalog.isOpenAiChatModel(it.first) }
        val visible = ModelCatalog.hideDatedDuplicates(entries.map { it.first })
        return entries.filter { it.first in visible }
            .sortedByDescending { it.second ?: 0L }
            .map { (id, created) ->
                ModelInfo(
                    id = id,
                    displayName = ModelCatalog.displayName(config.kind, id),
                    caps = ModelCatalog.openAiCaps(id),
                    pricing = pricing?.priceFor(config.kind, id),
                    createdAt = created?.times(1000),
                )
            }
    }

    override suspend fun verify(): Result<Unit> = try {
        fetch(requestBuilder("models").get().build())
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
        var noReplay = false
        while (true) {
            val built = buildBody(request, dropped, noReplay)
            val httpRequest = requestBuilder("responses")
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
                val lower = msg.lowercase()
                if (e.code == 400 && built.replayed && !noReplay &&
                    ("item" in lower || "encrypted" in lower || "rs_" in lower || "msg_" in lower || "ws_" in lower)
                ) {
                    noReplay = true
                    continue
                }
                if ((e.code == 400 || e.code == 403 || e.code == 422) && heals < MAX_HEALS) {
                    val action = if ("verif" in lower && "summar" in lower && built.sent.any { it.key == "summary" }) {
                        HealAction.Drop("summary")
                    } else if (e.code != 403) {
                        ParamHealer.diagnose(msg, built.sent, built.effort, request.caps.reasoning.efforts)
                    } else null
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
        var usage = Usage()
        var refusal = false
        var thinkingOpen = false
        val citations = CitationCollector()
        val outputItems = ArrayList<JsonObject>()
        val searchQueries = HashMap<String, String?>()
    }

    private suspend fun FlowCollector<StreamEvent>.consume(httpRequest: Request, s: StreamState) {
        streamHttp.sseFlow(httpRequest).collect { ev ->
            if (s.finished) return@collect
            val json = parseObjectOrNull(ev.data) ?: return@collect
            val type = json.str("type") ?: ev.event ?: return@collect
            when (type) {
                "response.created", "response.in_progress" -> {
                    if (!s.started) {
                        s.started = true
                        json.obj("response")?.str("model")?.let { s.model = it }
                        emit(StreamEvent.Started(s.model))
                    }
                }
                "response.output_item.added" -> {
                    val item = json.obj("item") ?: return@collect
                    when (item.str("type")) {
                        "reasoning" -> if (!s.thinkingOpen) {
                            s.thinkingOpen = true
                            emit(StreamEvent.ThinkingStarted)
                        }
                        "web_search_call" -> emit(StreamEvent.WebSearch(item.obj("action")?.str("query"), done = false))
                    }
                }
                "response.reasoning_summary_part.added" -> {
                    if ((json.long("summary_index") ?: 0) > 0) emit(StreamEvent.ThinkingDelta("\n\n"))
                }
                "response.reasoning_summary_text.delta", "response.reasoning_text.delta" -> {
                    json.str("delta")?.takeIf { it.isNotEmpty() }?.let {
                        if (!s.thinkingOpen) {
                            s.thinkingOpen = true
                            emit(StreamEvent.ThinkingStarted)
                        }
                        emit(StreamEvent.ThinkingDelta(it))
                    }
                }
                "response.output_item.done" -> {
                    val item = json.obj("item") ?: return@collect
                    s.outputItems += item
                    when (item.str("type")) {
                        "reasoning" -> if (s.thinkingOpen) {
                            s.thinkingOpen = false
                            emit(StreamEvent.ThinkingEnded)
                        }
                        "web_search_call" -> {
                            val action = item.obj("action")
                            emit(StreamEvent.WebSearch(action?.str("query"), done = true))
                            var changed = false
                            action?.arr("sources")?.forEach { src ->
                                (src as? JsonObject)?.let { changed = s.citations.add(it.str("url"), it.str("title")) or changed }
                            }
                            if (changed) emit(StreamEvent.Citations(s.citations.snapshot()))
                        }
                        "message" -> {
                            var changed = false
                            item.arr("content")?.forEach { part ->
                                (part as? JsonObject)?.arr("annotations")?.forEach { a ->
                                    val o = a as? JsonObject
                                    if (o?.str("type") == "url_citation") changed = s.citations.add(o.str("url"), o.str("title")) or changed
                                }
                            }
                            if (changed) emit(StreamEvent.Citations(s.citations.snapshot()))
                        }
                    }
                }
                "response.output_text.delta" -> {
                    if (s.thinkingOpen) {
                        s.thinkingOpen = false
                        emit(StreamEvent.ThinkingEnded)
                    }
                    json.str("delta")?.takeIf { it.isNotEmpty() }?.let { emit(StreamEvent.TextDelta(it)) }
                }
                "response.refusal.delta" -> {
                    s.refusal = true
                    json.str("delta")?.takeIf { it.isNotEmpty() }?.let { emit(StreamEvent.TextDelta(it)) }
                }
                "response.output_text.annotation.added" -> {
                    val a = json.obj("annotation") ?: return@collect
                    if (a.str("type") == "url_citation" && s.citations.add(a.str("url"), a.str("title"))) {
                        emit(StreamEvent.Citations(s.citations.snapshot()))
                    }
                }
                "response.completed", "response.incomplete" -> {
                    val response = json.obj("response")
                    response?.obj("usage")?.let { s.usage = parseUsage(it); emit(StreamEvent.UsageUpdate(s.usage)) }
                    if (s.thinkingOpen) {
                        s.thinkingOpen = false
                        emit(StreamEvent.ThinkingEnded)
                    }
                    val reason = response?.obj("incomplete_details")?.str("reason")
                    val stop = when {
                        type == "response.incomplete" && reason == "content_filter" -> StopReason.REFUSAL
                        type == "response.incomplete" -> StopReason.MAX_TOKENS
                        s.refusal -> StopReason.REFUSAL
                        else -> StopReason.END
                    }
                    if (stop == StopReason.REFUSAL) emit(StreamEvent.Notice("${s.model} declined to answer this request."))
                    val items = response?.arr("output")?.takeIf { it.isNotEmpty() } ?: JsonArray(s.outputItems)
                    s.finished = true
                    emit(StreamEvent.Completed(stop, ProviderBlocks(ApiStyle.OPENAI_RESPONSES, response?.str("model") ?: s.model, items.toString())))
                }
                "response.failed" -> {
                    val err = json.obj("response")?.obj("error")
                    s.finished = true
                    emit(StreamEvent.Failed(LlmErrors.fromStream(config, s.request.model, err?.str("code"), err?.str("message"))))
                }
                "error" -> {
                    val err = json.obj("error") ?: json
                    s.finished = true
                    emit(StreamEvent.Failed(LlmErrors.fromStream(config, s.request.model, err.str("code") ?: err.str("type"), err.str("message"))))
                }
                else -> Unit
            }
        }
        if (!s.finished) emit(StreamEvent.Failed(LlmErrors.truncatedStream(config)))
    }

    private fun parseUsage(u: JsonObject) = Usage(
        inputTokens = u.long("input_tokens") ?: 0,
        outputTokens = u.long("output_tokens") ?: 0,
        cacheReadTokens = u.obj("input_tokens_details")?.long("cached_tokens") ?: 0,
        reasoningTokens = u.obj("output_tokens_details")?.long("reasoning_tokens") ?: 0,
    )

    // ------------------------------------------------------------------ request body

    private class Built(val body: JsonObject, val sent: List<ParamSpec>, val effort: Effort?, val replayed: Boolean)

    private fun buildBody(req: ChatRequest, dropped: Set<String>, noReplay: Boolean): Built {
        val caps = req.caps
        val sent = ArrayList<ParamSpec>()
        val reasoningModel = caps.reasoning.kind == ReasoningKind.EFFORT
        val utility = req.utility
        var replayed = false

        val input = buildJsonArray {
            for (m in req.messages) {
                when (m.role) {
                    Role.USER -> addJsonObject {
                        put("role", "user")
                        put("content", userContent(m.parts))
                    }
                    Role.ASSISTANT -> {
                        val items = if (!noReplay) replayItems(m, req.model) else null
                        if (items != null) {
                            replayed = true
                            items.forEach { add(it) }
                        } else {
                            val text = m.parts.filterIsInstance<Part.Text>().joinToString("\n\n") { it.text }
                            addJsonObject {
                                put("role", "assistant")
                                putJsonArray("content") {
                                    addJsonObject { put("type", "output_text"); put("text", text.ifBlank { "(no response)" }) }
                                }
                            }
                        }
                    }
                }
            }
        }

        var effort: Effort? = null
        val body = buildJsonObject {
            put("model", req.model)
            put("stream", true)
            put("store", false)
            req.system?.takeIf { it.isNotBlank() }?.let { put("instructions", it) }
            put("input", input)

            if (reasoningModel && "reasoning" !in dropped) {
                val supported = caps.reasoning.efforts
                val requested = when {
                    utility -> supported.minByOrNull { it.ordinal } ?: Effort.LOW
                    else -> req.params.effort
                }
                effort = if (requested == Effort.NONE) {
                    if (Effort.NONE in supported && "effort:none" !in dropped && "effort" !in dropped) Effort.NONE
                    else resolveEffort(Effort.MINIMAL, supported, dropped)
                } else resolveEffort(requested, supported, dropped)
                val summary = req.params.showThinking && !utility && caps.reasoning.summaries &&
                    "summary" !in dropped && effort != Effort.NONE
                val pro = req.params.proMode && caps.proMode && !utility && "mode" !in dropped
                if (effort != null || summary || pro) {
                    putJsonObject("reasoning") {
                        effort?.let { put("effort", it.wire) }
                        if (summary) put("summary", "auto")
                        if (pro) put("mode", "pro")
                    }
                    if (effort != null) sent += ParamSpec("effort", listOf("reasoning.effort", "reasoning_effort", "effort"))
                    if (summary) sent += ParamSpec("summary", listOf("reasoning.summary", "summary"))
                    if (pro) sent += ParamSpec("mode", listOf("reasoning.mode", "mode"))
                    sent += ParamSpec("reasoning", listOf("reasoning"))
                }
                if ("include" !in dropped) {
                    putJsonArray("include") { add("reasoning.encrypted_content") }
                    sent += ParamSpec("include", listOf("include", "encrypted_content"))
                }
            }
            if (caps.verbosity && !utility && "verbosity" !in dropped) {
                req.params.verbosity?.let {
                    putJsonObject("text") { put("verbosity", it.wire) }
                    sent += ParamSpec("verbosity", listOf("text.verbosity", "verbosity"))
                }
            }
            if (req.params.webSearch && caps.webSearch && !utility && "web_search" !in dropped) {
                putJsonArray("tools") { addJsonObject { put("type", "web_search") } }
                sent += ParamSpec("web_search", listOf("web_search", "tools"))
            }
            val cap = maxTokensCap(dropped)
            val max = req.params.maxOutputTokens ?: if (utility) (if (reasoningModel) 2_048 else 256) else null
            val finalMax = when {
                max != null && cap != null -> minOf(max, cap)
                else -> max ?: cap
            }
            if (finalMax != null && "max_output_tokens" !in dropped) {
                put("max_output_tokens", finalMax.coerceAtLeast(16))
                sent += ParamSpec("max_output_tokens", listOf("max_output_tokens"))
            }
            if (caps.sampling && !reasoningModel) {
                req.params.temperature?.takeIf { "temperature" !in dropped }?.let {
                    put("temperature", it)
                    sent += ParamSpec("temperature", listOf("temperature"))
                }
                req.params.topP?.takeIf { "top_p" !in dropped }?.let {
                    put("top_p", it)
                    sent += ParamSpec("top_p", listOf("top_p"))
                }
            }
        }
        val order = listOf("summary", "mode", "effort", "verbosity", "include", "web_search", "temperature", "top_p", "max_output_tokens", "reasoning")
        return Built(body, sent.sortedBy { order.indexOf(it.key) }, effort, replayed)
    }

    private fun replayItems(m: ChatMessage, model: String): List<JsonObject>? {
        val b = m.blocks ?: return null
        if (b.style != ApiStyle.OPENAI_RESPONSES || b.model != model) return null
        val arr = parseJsonOrNull(b.json) as? JsonArray ?: return null
        val items = arr.mapNotNull { it as? JsonObject }
        return items.takeIf { list -> list.any { it.str("type") == "message" } }
    }

    private fun userContent(parts: List<Part>): JsonArray = buildJsonArray {
        for (p in parts) when (p) {
            is Part.Text -> if (p.text.isNotBlank()) addJsonObject { put("type", "input_text"); put("text", p.text) }
            is Part.Image -> addJsonObject {
                put("type", "input_image")
                put("image_url", dataUrl(p.mimeType, p.bytes))
            }
            is Part.Document -> if (p.mimeType == "application/pdf") {
                addJsonObject {
                    put("type", "input_file")
                    put("filename", p.name.ifBlank { "document.pdf" })
                    put("file_data", dataUrl(p.mimeType, p.bytes))
                }
            } else {
                addJsonObject {
                    put("type", "input_text")
                    put("text", "File: ${p.name}\n```\n${p.bytes.toString(Charsets.UTF_8)}\n```")
                }
            }
        }
    }.let { if (it.isEmpty()) buildJsonArray { addJsonObject { put("type", "input_text"); put("text", "(empty message)") } } else it }

    private companion object {
        const val MAX_HEALS = 3
    }
}
