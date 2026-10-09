package io.dtsoftware.facet.llm

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AnthropicClientTest : MockServerTest() {

    private fun client() = LlmClients.create(config(ProviderKind.ANTHROPIC), http, quirks)

    private fun request(
        model: String = "claude-opus-5-5",
        params: GenParams = GenParams(effort = Effort.HIGH),
        messages: List<ChatMessage> = listOf(user("Hi")),
        caps: ModelCaps = ModelCatalog.claudeCaps(model),
    ) = ChatRequest(model = model, system = "Be brief.", messages = messages, params = params, caps = caps)

    @Test
    fun streamsTextAndSummarizedThinking() {
        server.enqueue(sse("anthropic_thinking.txt"))
        val events = collect(client(), request())

        assertEquals(StreamEvent.Started("claude-opus-5-5"), events.first())
        assertEquals("Considering the question.", events.thinking())
        assertEquals("Hello world", events.text())
        assertEquals(1, events.count { it == StreamEvent.ThinkingStarted })
        assertEquals(1, events.count { it == StreamEvent.ThinkingEnded })
        val usage = events.lastOf<StreamEvent.UsageUpdate>().usage
        assertEquals(Usage(inputTokens = 420, outputTokens = 42, cacheReadTokens = 300, cacheWriteTokens = 100), usage)

        val done = events.last() as StreamEvent.Completed
        assertEquals(StopReason.END, done.stopReason)
        val blocks = JsonArrayOf(done.blocks!!.json)
        assertEquals(ApiStyle.ANTHROPIC, done.blocks!!.style)
        assertEquals("thinking", blocks[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("sigABC", blocks[0].jsonObject["signature"]!!.jsonPrimitive.content)
        assertEquals("Hello world", blocks[1].jsonObject["text"]!!.jsonPrimitive.content)

        val recorded = server.takeRequest()
        assertEquals("/v1/messages", recorded.url.encodedPath)
        assertEquals("sk-test-key-1234567890", recorded.headers["x-api-key"])
        assertEquals("2023-06-01", recorded.headers["anthropic-version"])
        assertTrue(recorded.headers["anthropic-beta"]!!.contains("server-side-fallback-2026-07-01"))
        val body = recorded.json()
        assertEquals("adaptive", body["thinking"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("summarized", body["thinking"]!!.jsonObject["display"]!!.jsonPrimitive.content)
        assertEquals("high", body["output_config"]!!.jsonObject["effort"]!!.jsonPrimitive.content)
        assertEquals("default", body["fallbacks"]!!.jsonPrimitive.content)
        assertEquals("ephemeral", body["cache_control"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals(64_000, body["max_tokens"]!!.jsonPrimitive.content.toInt())
        assertNull(body["temperature"])
        assertEquals("Be brief.", body["system"]!!.jsonArray[0].jsonObject["text"]!!.jsonPrimitive.content)
    }

    @Test
    fun omittedThinkingStillSignalsThinkingAndMaxTokens() {
        server.enqueue(sse("anthropic_omitted.txt"))
        val events = collect(client(), request(params = GenParams(effort = Effort.LOW, showThinking = false)))
        assertTrue(events.contains(StreamEvent.ThinkingStarted))
        assertTrue(events.contains(StreamEvent.ThinkingEnded))
        assertEquals("", events.thinking())
        assertEquals(StopReason.MAX_TOKENS, (events.last() as StreamEvent.Completed).stopReason)
        val body = server.takeRequest().json()
        assertEquals("omitted", body["thinking"]!!.jsonObject["display"]!!.jsonPrimitive.content)
        assertEquals("low", body["output_config"]!!.jsonObject["effort"]!!.jsonPrimitive.content)
    }

    @Test
    fun webSearchEmitsQueriesAndCitations() {
        server.enqueue(sse("anthropic_websearch.txt"))
        val events = collect(
            client(),
            request(model = "claude-sonnet-5-5", params = GenParams(effort = Effort.MEDIUM, webSearch = true)),
        )
        val searches = events.filterIsInstance<StreamEvent.WebSearch>()
        assertEquals(listOf(StreamEvent.WebSearch("facet app", false), StreamEvent.WebSearch("facet app", true)), searches)
        val citations = events.lastOf<StreamEvent.Citations>().citations
        assertEquals(listOf("https://example.com/a", "https://example.com/b"), citations.map { it.url })
        assertEquals("Facet is an app", citations[0].snippet)
        assertEquals("Facet is an app.", events.text())

        val blocks = JsonArrayOf((events.last() as StreamEvent.Completed).blocks!!.json)
        val toolUse = blocks[0].jsonObject
        assertEquals("facet app", toolUse["input"]!!.jsonObject["query"]!!.jsonPrimitive.content)
        assertEquals("web_search_tool_result", blocks[1].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals(1, blocks[2].jsonObject["citations"]!!.jsonArray.size)

        val tools = server.takeRequest().json()["tools"]!!.jsonArray
        assertEquals("web_search_20260209", tools[0].jsonObject["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun continuesAfterPauseTurn() {
        server.enqueue(sse("anthropic_pause_1.txt"))
        server.enqueue(sse("anthropic_pause_2.txt"))
        val events = collect(client(), request(params = GenParams(effort = Effort.HIGH, webSearch = true)))
        assertEquals("Searching. Here is the result.", events.text())
        assertEquals(1, events.count { it is StreamEvent.Started })
        val done = events.last() as StreamEvent.Completed
        assertEquals(StopReason.END, done.stopReason)
        assertEquals(4, JsonArrayOf(done.blocks!!.json).size)
        assertEquals(40L + 60L, events.lastOf<StreamEvent.UsageUpdate>().usage.inputTokens)

        server.takeRequest()
        val second = server.takeRequest().json()
        val last = second["messages"]!!.jsonArray.last().jsonObject
        assertEquals("assistant", last["role"]!!.jsonPrimitive.content)
        assertEquals("server_tool_use", last["content"]!!.jsonArray.last().jsonObject["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun refusalCompletesWithNotice() {
        server.enqueue(sse("anthropic_refusal.txt"))
        val events = collect(client(), request(model = "claude-fable-5-1", params = GenParams(effort = Effort.HIGH)))
        val notice = events.only<StreamEvent.Notice>()
        assertTrue(notice.text.contains("declined"))
        assertTrue(notice.text.contains("cybersecurity"))
        assertEquals(StopReason.REFUSAL, (events.last() as StreamEvent.Completed).stopReason)
    }

    @Test
    fun fallbackBlockProducesNoticeAndIsDroppedFromReplay() {
        server.enqueue(sse("anthropic_fallback.txt"))
        val events = collect(client(), request(model = "claude-fable-5-1"))
        assertTrue(events.filterIsInstance<StreamEvent.Notice>().any { it.text.contains("claude-opus-4-8") })
        val done = events.last() as StreamEvent.Completed
        assertEquals("claude-opus-4-8", done.blocks!!.model)
        val blocks = JsonArrayOf(done.blocks!!.json)
        assertTrue(blocks.none { it.jsonObject["type"]!!.jsonPrimitive.content == "fallback" })
    }

    @Test
    fun replaysThinkingBlocksWithDropBlockBinding() {
        server.enqueue(sse("anthropic_thinking.txt"))
        val prior = """[{"type":"thinking","thinking":"earlier","signature":"sigOLD"},{"type":"text","text":"Earlier answer"}]"""
        val messages = listOf(
            user("First"),
            ChatMessage(Role.ASSISTANT, listOf(Part.Text("Earlier answer")), ProviderBlocks(ApiStyle.ANTHROPIC, "claude-opus-5-5", prior)),
            user("Second"),
        )
        collect(client(), request(messages = messages))
        val recorded = server.takeRequest()
        assertTrue(recorded.headers["anthropic-beta"]!!.contains("thinking-binding-controls-2026-08-01"))
        val body = recorded.json()
        assertEquals(
            "drop_block",
            body["thinking"]!!.jsonObject["block_binding"]!!.jsonObject["prefix_mismatch_behavior"]!!.jsonPrimitive.content,
        )
        val assistant = body["messages"]!!.jsonArray[1].jsonObject["content"]!!.jsonArray
        assertEquals("sigOLD", assistant[0].jsonObject["signature"]!!.jsonPrimitive.content)
    }

    @Test
    fun signatureErrorStripsThinkingAndRetries() {
        server.enqueue(
            json(400, """{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."}}"""),
        )
        server.enqueue(sse("anthropic_thinking.txt"))
        val prior = """[{"type":"thinking","thinking":"x","signature":"bad"},{"type":"text","text":"Prev"}]"""
        val messages = listOf(
            user("First"),
            ChatMessage(Role.ASSISTANT, listOf(Part.Text("Prev")), ProviderBlocks(ApiStyle.ANTHROPIC, "claude-opus-5-5", prior)),
            user("Again"),
        )
        val events = collect(client(), request(messages = messages))
        assertTrue(events.last() is StreamEvent.Completed)
        server.takeRequest()
        val retry = server.takeRequest().json()
        val assistant = retry["messages"]!!.jsonArray[1].jsonObject["content"]!!.jsonArray
        assertTrue(assistant.none { it.jsonObject["type"]!!.jsonPrimitive.content == "thinking" })
        assertNull(retry["thinking"]!!.jsonObject["block_binding"])
    }

    @Test
    fun mapsAuthError() {
        server.enqueue(json(401, """{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"""))
        val failed = collect(client(), request()).single() as StreamEvent.Failed
        assertEquals(ErrorKind.AUTH, failed.error.kind)
        assertEquals("Anthropic rejected this API key. Check it in Providers.", failed.error.message)
    }

    @Test
    fun mapsRateLimitWithRetryAfter() {
        server.enqueue(json(429, """{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}""", "retry-after" to "30"))
        val failed = collect(client(), request()).single() as StreamEvent.Failed
        assertEquals(ErrorKind.RATE_LIMIT, failed.error.kind)
        assertEquals(30L, failed.error.retryAfterSeconds)
        assertTrue(failed.error.message.contains("30s"))
    }

    @Test
    fun dropsRejectedTemperatureAndRemembersIt() {
        server.enqueue(json(400, """{"type":"error","error":{"type":"invalid_request_error","message":"temperature: this model does not support the temperature parameter"}}"""))
        server.enqueue(sse("anthropic_thinking.txt"))
        val model = "claude-sonnet-4-5"
        val events = collect(
            client(),
            request(model = model, params = GenParams(temperature = 0.4f), caps = ModelCatalog.claudeCaps(model).copy(sampling = true)),
        )
        assertTrue(events.last() is StreamEvent.Completed)
        assertNotNull(server.takeRequest().json()["temperature"])
        assertNull(server.takeRequest().json()["temperature"])
        assertTrue("temperature" in quirks.dropped("p1", model))

        // Next request omits it up front.
        server.enqueue(sse("anthropic_thinking.txt"))
        collect(client(), request(model = model, params = GenParams(temperature = 0.4f), caps = ModelCatalog.claudeCaps(model).copy(sampling = true)))
        assertNull(server.takeRequest().json()["temperature"])
    }

    @Test
    fun stepsDownUnsupportedEffort() {
        server.enqueue(json(400, """{"type":"error","error":{"type":"invalid_request_error","message":"output_config.effort: Input should be 'low', 'medium', 'high' or 'max'"}}"""))
        server.enqueue(sse("anthropic_thinking.txt"))
        val events = collect(client(), request(params = GenParams(effort = Effort.XHIGH)))
        assertTrue(events.last() is StreamEvent.Completed)
        assertEquals("xhigh", server.takeRequest().json()["output_config"]!!.jsonObject["effort"]!!.jsonPrimitive.content)
        assertEquals("high", server.takeRequest().json()["output_config"]!!.jsonObject["effort"]!!.jsonPrimitive.content)
        assertTrue("effort:xhigh" in quirks.dropped("p1", "claude-opus-5-5"))
    }

    @Test
    fun effortNoneMapsPerFamily() {
        // Opus 5.5 can't disable thinking: adaptive + low effort.
        server.enqueue(sse("anthropic_thinking.txt"))
        collect(client(), request(model = "claude-opus-5-5", params = GenParams(effort = Effort.NONE)))
        var body = server.takeRequest().json()
        assertEquals("adaptive", body["thinking"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("low", body["output_config"]!!.jsonObject["effort"]!!.jsonPrimitive.content)

        // Sonnet 5.5 uses between_tools, with no other thinking fields.
        server.enqueue(sse("anthropic_thinking.txt"))
        collect(client(), request(model = "claude-sonnet-5-5", params = GenParams(effort = Effort.NONE)))
        body = server.takeRequest().json()
        assertEquals(JsonObject(mapOf("type" to JsonPrimitive("between_tools"))), body["thinking"])
        assertNull(body["output_config"])

        // Opus 4.8 disables.
        server.enqueue(sse("anthropic_thinking.txt"))
        collect(client(), request(model = "claude-opus-4-8", params = GenParams(effort = Effort.NONE)))
        body = server.takeRequest().json()
        assertEquals("disabled", body["thinking"]!!.jsonObject["type"]!!.jsonPrimitive.content)

        // Budget-era model: thinking enabled with a budget below max_tokens.
        server.enqueue(sse("anthropic_thinking.txt"))
        collect(client(), request(model = "claude-sonnet-4-5", params = GenParams(effort = Effort.MEDIUM)))
        body = server.takeRequest().json()
        assertEquals("enabled", body["thinking"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        val budget = body["thinking"]!!.jsonObject["budget_tokens"]!!.jsonPrimitive.content.toInt()
        assertTrue(budget < body["max_tokens"]!!.jsonPrimitive.content.toInt())
    }

    @Test
    fun utilityRequestsAreLean() {
        server.enqueue(sse("anthropic_thinking.txt"))
        collect(
            client(),
            ChatRequest("claude-opus-4-8", null, listOf(user("Title this")), GenParams(webSearch = true, effort = Effort.MAX), ModelCatalog.claudeCaps("claude-opus-4-8"), utility = true),
        )
        val body = server.takeRequest().json()
        assertEquals(1024, body["max_tokens"]!!.jsonPrimitive.content.toInt())
        assertNull(body["tools"])
        assertNull(body["fallbacks"])
        assertNull(body["cache_control"])
        assertEquals("disabled", body["thinking"]!!.jsonObject["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun imagesAndPdfsBecomeContentBlocks() {
        server.enqueue(sse("anthropic_thinking.txt"))
        val msg = ChatMessage(
            Role.USER,
            listOf(Part.Text("What is this?"), Part.Image("image/png", byteArrayOf(1, 2, 3)), Part.Document("application/pdf", "a.pdf", byteArrayOf(4, 5))),
        )
        collect(client(), request(messages = listOf(msg)))
        val content = server.takeRequest().json()["messages"]!!.jsonArray[0].jsonObject["content"]!!.jsonArray
        assertEquals(listOf("image", "document", "text"), content.map { it.jsonObject["type"]!!.jsonPrimitive.content })
        assertEquals("AQID", content[0].jsonObject["source"]!!.jsonObject["data"]!!.jsonPrimitive.content)
    }

    @Test
    fun listsModelsWithPaginationAndCapabilities() = runBlocking {
        server.enqueue(json(200, """{"data":[{"type":"model","id":"claude-opus-5-5","display_name":"Claude Opus 5.5","created_at":"2026-06-01T00:00:00Z","max_input_tokens":1000000,"max_tokens":128000,"capabilities":{"image_input":{"supported":true},"thinking":{"supported":true,"types":{"enabled":{"supported":false},"adaptive":{"supported":true}}},"effort":{"supported":true,"low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},"xhigh":{"supported":true},"max":{"supported":true}}}}],"has_more":true,"first_id":"claude-opus-5-5","last_id":"claude-opus-5-5"}"""))
        server.enqueue(json(200, """{"data":[{"type":"model","id":"claude-haiku-4-5-20251001","display_name":"Claude Haiku 4.5","created_at":"2025-10-01T00:00:00Z","max_input_tokens":200000,"max_tokens":64000,"capabilities":{"image_input":{"supported":true},"thinking":{"supported":true,"types":{"enabled":{"supported":true},"adaptive":{"supported":false}}},"effort":{"supported":false}}}],"has_more":false}"""))
        val models = client().listModels()
        assertEquals(listOf("claude-opus-5-5", "claude-haiku-4-5-20251001"), models.map { it.id })
        val opus = models[0]
        assertEquals("Claude Opus 5.5", opus.displayName)
        assertEquals(1_000_000, opus.contextWindow)
        assertEquals(ReasoningKind.EFFORT, opus.caps.reasoning.kind)
        assertFalse(Effort.NONE in opus.caps.reasoning.efforts) // can't disable on Opus 5.5
        assertEquals(Effort.MEDIUM, opus.caps.reasoning.defaultEffort)
        assertTrue(opus.caps.refusalFallback && opus.caps.fastMode && !opus.caps.sampling)
        val haiku = models[1]
        assertEquals(ReasoningKind.BUDGET, haiku.caps.reasoning.kind)
        assertTrue(haiku.caps.sampling)
        server.takeRequest()
        assertEquals("claude-opus-5-5", server.takeRequest().url.queryParameter("after_id"))
    }

    private fun JsonArrayOf(json: String): JsonArray = kotlinx.serialization.json.Json.parseToJsonElement(json).jsonArray
}
