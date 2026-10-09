package io.dtsoftware.facet.llm

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenAiChatClientTest : MockServerTest() {

    private fun client(kind: ProviderKind, key: String = "sk-test-key-1234567890") =
        LlmClients.create(config(kind, "/v1", key), http, quirks)

    private fun request(kind: ProviderKind, model: String, params: GenParams = GenParams(), messages: List<ChatMessage> = listOf(user("Hi"))) =
        ChatRequest(model, "System prompt", messages, params, ModelCatalog.compatCaps(kind, model))

    @Test
    fun deepSeekReasoningContent() {
        server.enqueue(sse("chat_deepseek.txt"))
        val events = collect(client(ProviderKind.DEEPSEEK), request(ProviderKind.DEEPSEEK, "deepseek-reasoner", GenParams(temperature = 0.7f)))
        assertEquals(StreamEvent.Started("deepseek-reasoner"), events.first())
        assertEquals("Let me think more.", events.thinking())
        assertEquals("Answer here.", events.text())
        assertTrue(events.indexOf(StreamEvent.ThinkingEnded) < events.indexOfFirst { it is StreamEvent.TextDelta })
        assertEquals(Usage(10, 20, cacheReadTokens = 4, reasoningTokens = 12), events.lastOf<StreamEvent.UsageUpdate>().usage)
        assertEquals(StreamEvent.Completed(StopReason.END, null), events.last())

        val recorded = server.takeRequest()
        assertEquals("/v1/chat/completions", recorded.url.encodedPath)
        val body = recorded.json()
        assertNull(body["temperature"]) // reasoner rejects sampling params
        assertEquals("true", body["stream_options"]!!.jsonObject["include_usage"]!!.jsonPrimitive.content)
        val messages = body["messages"]!!.jsonArray
        assertEquals("system", messages[0].jsonObject["role"]!!.jsonPrimitive.content)
        assertEquals(JsonPrimitive("Hi"), messages[1].jsonObject["content"])
    }

    @Test
    fun openRouterReasoningAnnotationsAndUsageChunk() {
        server.enqueue(sse("chat_openrouter.txt"))
        val caps = ModelCaps(reasoning = ReasoningSupport(ReasoningKind.EFFORT, listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH), summaries = true), webSearch = true)
        val req = ChatRequest("anthropic/claude-sonnet-4.5", null, listOf(user("Which?")), GenParams(effort = Effort.HIGH, webSearch = true), caps)
        val events = collect(client(ProviderKind.OPENROUTER), req)
        assertEquals("Weighing options carefully", events.thinking())
        assertEquals("Pick B.", events.text())
        assertEquals("B is best", events.lastOf<StreamEvent.Citations>().citations.single().snippet)
        assertEquals(Usage(120, 64, cacheReadTokens = 100, reasoningTokens = 30), events.lastOf<StreamEvent.UsageUpdate>().usage)
        assertEquals(StopReason.MAX_TOKENS, (events.last() as StreamEvent.Completed).stopReason)

        val recorded = server.takeRequest()
        assertEquals("https://facet.dtsoftware.io", recorded.headers["HTTP-Referer"])
        assertEquals("Facet", recorded.headers["X-Title"])
        val body = recorded.json()
        assertEquals("high", body["reasoning"]!!.jsonObject["effort"]!!.jsonPrimitive.content)
        assertEquals("web", body["plugins"]!!.jsonArray[0].jsonObject["id"]!!.jsonPrimitive.content)
        assertNull(body["reasoning_effort"])
    }

    @Test
    fun thinkTagsSplitAcrossChunks() {
        server.enqueue(sse("chat_think_tags.txt"))
        val events = collect(client(ProviderKind.GROQ), request(ProviderKind.GROQ, "qwen3-32b"))
        assertEquals("Hmm, ok", events.thinking())
        assertEquals("Final answer with <think> literal", events.text())
    }

    @Test
    fun perplexityCitations() {
        server.enqueue(sse("chat_perplexity.txt"))
        val events = collect(client(ProviderKind.PERPLEXITY), request(ProviderKind.PERPLEXITY, "sonar-pro"))
        val citations = events.lastOf<StreamEvent.Citations>().citations
        assertEquals(listOf("https://a.example.com", "https://b.example.com"), citations.map { it.url })
        assertEquals("A site", citations[0].title)
        assertEquals("Per [1], yes.", events.text())
        assertNull(server.takeRequest().json()["stream_options"])
    }

    @Test
    fun groqReasoningFieldAndXGroqUsage() {
        server.enqueue(sse("chat_groq_reasoning.txt"))
        val events = collect(client(ProviderKind.GROQ), request(ProviderKind.GROQ, "openai/gpt-oss-120b", GenParams(effort = Effort.LOW)))
        assertEquals("Short plan.", events.thinking())
        assertEquals("Result.", events.text())
        assertEquals(7L, events.lastOf<StreamEvent.UsageUpdate>().usage.outputTokens)
        assertEquals("low", server.takeRequest().json()["reasoning_effort"]!!.jsonPrimitive.content)
    }

    @Test
    fun localProvidersSendNoAuthHeader() {
        server.enqueue(sse("chat_think_tags.txt"))
        collect(client(ProviderKind.OLLAMA, key = ""), request(ProviderKind.OLLAMA, "llama3.2"))
        assertNull(server.takeRequest().headers["Authorization"])
    }

    @Test
    fun switchesToMaxCompletionTokensWhenAsked() {
        server.enqueue(json(400, """{"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.","type":"invalid_request_error","param":"max_tokens","code":"unsupported_parameter"}}"""))
        server.enqueue(sse("chat_deepseek.txt"))
        val events = collect(client(ProviderKind.CUSTOM), request(ProviderKind.CUSTOM, "some-model", GenParams(maxOutputTokens = 500)))
        assertTrue(events.last() is StreamEvent.Completed)
        assertEquals("500", server.takeRequest().json()["max_tokens"]!!.jsonPrimitive.content)
        val retry = server.takeRequest().json()
        assertNull(retry["max_tokens"])
        assertEquals("500", retry["max_completion_tokens"]!!.jsonPrimitive.content)
    }

    @Test
    fun dropsRejectedReasoningEffort() {
        server.enqueue(json(400, """{"error":{"message":"reasoning_effort is not supported for this model","type":"invalid_request_error"}}"""))
        server.enqueue(sse("chat_groq_reasoning.txt"))
        val events = collect(client(ProviderKind.TOGETHER), request(ProviderKind.TOGETHER, "openai/gpt-oss-20b", GenParams(effort = Effort.HIGH)))
        assertTrue(events.last() is StreamEvent.Completed)
        server.takeRequest()
        assertNull(server.takeRequest().json()["reasoning_effort"])
    }

    @Test
    fun streamErrorChunkFails() {
        server.enqueue(sseBody("""data: {"error":{"message":"Provider returned error","code":502}}""" + "\n\n"))
        val events = collect(client(ProviderKind.OPENROUTER), request(ProviderKind.OPENROUTER, "x/y"))
        assertTrue(events.last() is StreamEvent.Failed)
    }

    @Test
    fun truncatedStreamFails() {
        server.enqueue(sseBody("""data: {"model":"m","choices":[{"index":0,"delta":{"content":"Half"},"finish_reason":null}]}""" + "\n\n"))
        val events = collect(client(ProviderKind.CUSTOM), request(ProviderKind.CUSTOM, "m"))
        assertEquals("Half", events.text())
        assertEquals(ErrorKind.NETWORK, (events.last() as StreamEvent.Failed).error.kind)
    }

    @Test
    fun imagesBecomeContentParts() {
        server.enqueue(sse("chat_deepseek.txt"))
        val msg = ChatMessage(Role.USER, listOf(Part.Text("Describe"), Part.Image("image/jpeg", byteArrayOf(9, 9))))
        collect(client(ProviderKind.XAI), request(ProviderKind.XAI, "grok-4", messages = listOf(msg)))
        val content = server.takeRequest().json()["messages"]!!.jsonArray[1].jsonObject["content"]!!.jsonArray
        assertEquals("image_url", content[1].jsonObject["type"]!!.jsonPrimitive.content)
        assertTrue(content[1].jsonObject["image_url"]!!.jsonObject["url"]!!.jsonPrimitive.content.startsWith("data:image/jpeg;base64,"))
    }

    @Test
    fun openRouterModelListUsesLiveMetadata() = runBlocking {
        server.enqueue(json(200, """{"data":[
            {"id":"anthropic/claude-sonnet-4.5","name":"Anthropic: Claude Sonnet 4.5","created":1759000000,"context_length":1000000,
             "architecture":{"input_modalities":["text","image","file"],"output_modalities":["text"]},
             "pricing":{"prompt":"0.000003","completion":"0.000015","input_cache_read":"0.0000003"},
             "supported_parameters":["reasoning","include_reasoning","max_tokens","tools"],
             "top_provider":{"max_completion_tokens":64000}},
            {"id":"black-forest-labs/flux-pro","name":"Flux","architecture":{"input_modalities":["text"],"output_modalities":["image"]},"pricing":{"prompt":"0","completion":"0"}}
        ]}"""))
        val models = client(ProviderKind.OPENROUTER).listModels()
        val m = models.single()
        assertEquals("Anthropic: Claude Sonnet 4.5", m.displayName)
        assertTrue(m.caps.vision && m.caps.pdf && m.caps.webSearch)
        assertFalse(m.caps.sampling)
        assertEquals(ReasoningKind.EFFORT, m.caps.reasoning.kind)
        assertEquals(3.0, m.pricing!!.input, 1e-9)
        assertEquals(15.0, m.pricing!!.output, 1e-9)
        assertEquals(0.3, m.pricing!!.cacheRead!!, 1e-9)
        assertEquals(64000, m.maxOutput)
    }

    @Test
    fun geminiModelListStripsPrefixAndFilters() = runBlocking {
        server.enqueue(json(200, """{"object":"list","data":[{"id":"models/gemini-2.5-flash","object":"model","owned_by":"google"},{"id":"models/text-embedding-004","object":"model","owned_by":"google"},{"id":"models/gemini-2.5-pro","object":"model","owned_by":"google"}]}"""))
        val models = client(ProviderKind.GOOGLE).listModels()
        assertEquals(listOf("gemini-2.5-flash", "gemini-2.5-pro"), models.map { it.id })
        assertEquals("Gemini 2.5 Flash", models[0].displayName)
        assertTrue(Effort.NONE in models[0].caps.reasoning.efforts)
        assertFalse(Effort.NONE in models[1].caps.reasoning.efforts)
    }

    @Test
    fun perplexityListsStaticModels() = runBlocking {
        val models = client(ProviderKind.PERPLEXITY).listModels()
        assertTrue(models.any { it.id == "sonar-pro" })
        assertEquals(0, server.requestCount)
    }
}
