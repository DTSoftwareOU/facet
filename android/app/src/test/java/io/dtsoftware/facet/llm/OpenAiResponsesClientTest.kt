package io.dtsoftware.facet.llm

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenAiResponsesClientTest : MockServerTest() {

    private fun client() = LlmClients.create(config(ProviderKind.OPENAI, "/v1"), http, quirks)

    private fun request(
        model: String = "gpt-5.5",
        params: GenParams = GenParams(effort = Effort.HIGH, webSearch = true),
        messages: List<ChatMessage> = listOf(user("Tell me about Facet")),
    ) = ChatRequest(model, "You are helpful.", messages, params, ModelCatalog.openAiCaps(model))

    @Test
    fun streamsReasoningSearchTextAndUsage() {
        server.enqueue(sse("openai_reasoning.txt"))
        val events = collect(client(), request())

        assertEquals(StreamEvent.Started("gpt-5.5"), events.first())
        assertEquals("**Planning** the answer\n\nChecking sources", events.thinking())
        assertEquals(1, events.count { it == StreamEvent.ThinkingStarted })
        assertEquals(1, events.count { it == StreamEvent.ThinkingEnded })
        assertEquals(
            listOf(StreamEvent.WebSearch(null, false), StreamEvent.WebSearch("facet android", true)),
            events.filterIsInstance<StreamEvent.WebSearch>(),
        )
        assertEquals("Facet is great.", events.text())
        assertEquals(listOf("https://facet.dtsoftware.io"), events.lastOf<StreamEvent.Citations>().citations.map { it.url })
        assertEquals(Usage(100, 250, cacheReadTokens = 40, reasoningTokens = 180), events.lastOf<StreamEvent.UsageUpdate>().usage)
        val done = events.last() as StreamEvent.Completed
        assertEquals(StopReason.END, done.stopReason)
        assertEquals(ApiStyle.OPENAI_RESPONSES, done.blocks!!.style)
        assertEquals(3, Json.parseToJsonElement(done.blocks!!.json).jsonArray.size)

        val recorded = server.takeRequest()
        assertEquals("/v1/responses", recorded.url.encodedPath)
        assertEquals("Bearer sk-test-key-1234567890", recorded.headers["Authorization"])
        val body = recorded.json()
        assertEquals("false", body["store"]!!.jsonPrimitive.content)
        assertEquals("You are helpful.", body["instructions"]!!.jsonPrimitive.content)
        val reasoning = body["reasoning"]!!.jsonObject
        assertEquals("high", reasoning["effort"]!!.jsonPrimitive.content)
        assertEquals("auto", reasoning["summary"]!!.jsonPrimitive.content)
        assertEquals("reasoning.encrypted_content", body["include"]!!.jsonArray[0].jsonPrimitive.content)
        assertEquals("web_search", body["tools"]!!.jsonArray[0].jsonObject["type"]!!.jsonPrimitive.content)
        assertNull(body["temperature"])
        val content = body["input"]!!.jsonArray[0].jsonObject["content"]!!.jsonArray
        assertEquals("input_text", content[0].jsonObject["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun incompleteMeansMaxTokens() {
        server.enqueue(sse("openai_incomplete.txt"))
        val events = collect(client(), request(model = "gpt-4.1", params = GenParams(temperature = 0.3f)))
        assertEquals("Partial", events.text())
        assertEquals(StopReason.MAX_TOKENS, (events.last() as StreamEvent.Completed).stopReason)
        val body = server.takeRequest().json()
        assertNull(body["reasoning"])
        assertEquals("0.3", body["temperature"]!!.jsonPrimitive.content)
    }

    @Test
    fun failedResponseMapsToError() {
        server.enqueue(sse("openai_failed.txt"))
        val failed = collect(client(), request()).last() as StreamEvent.Failed
        assertEquals(ErrorKind.SERVER, failed.error.kind)
    }

    @Test
    fun replaysOutputItemsOnlyForSameModel() {
        val items = """[{"id":"rs_1","type":"reasoning","encrypted_content":"enc","summary":[]},{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Prev","annotations":[]}]}]"""
        val history = listOf(
            user("One"),
            ChatMessage(Role.ASSISTANT, listOf(Part.Text("Prev")), ProviderBlocks(ApiStyle.OPENAI_RESPONSES, "gpt-5.5", items)),
            user("Two"),
        )
        server.enqueue(sse("openai_reasoning.txt"))
        collect(client(), request(messages = history))
        val input = server.takeRequest().json()["input"]!!.jsonArray
        assertEquals("reasoning", input[1].jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals("enc", input[1].jsonObject["encrypted_content"]!!.jsonPrimitive.content)

        server.enqueue(sse("openai_reasoning.txt"))
        collect(client(), request(model = "gpt-5.4", messages = history))
        val input2 = server.takeRequest().json()["input"]!!.jsonArray
        assertEquals("assistant", input2[1].jsonObject["role"]!!.jsonPrimitive.content)
        assertEquals("output_text", input2[1].jsonObject["content"]!!.jsonArray[0].jsonObject["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun stepsDownUnsupportedEffortUsingListedValues() {
        server.enqueue(json(400, """{"error":{"message":"Unsupported value: 'reasoning.effort' does not support 'minimal' with this model. Supported values are: 'low', 'medium', and 'high'.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_value"}}"""))
        server.enqueue(sse("openai_reasoning.txt"))
        val events = collect(client(), request(model = "gpt-5", params = GenParams(effort = Effort.MINIMAL)))
        assertTrue(events.last() is StreamEvent.Completed)
        assertEquals("minimal", server.takeRequest().json()["reasoning"]!!.jsonObject["effort"]!!.jsonPrimitive.content)
        assertEquals("low", server.takeRequest().json()["reasoning"]!!.jsonObject["effort"]!!.jsonPrimitive.content)
        assertTrue("effort:minimal" in quirks.dropped("p1", "gpt-5"))
    }

    @Test
    fun dropsSummaryWhenOrganizationUnverified() {
        server.enqueue(json(400, """{"error":{"message":"Your organization must be verified to generate reasoning summaries. Please go to: https://platform.openai.com/settings/organization/general","type":"invalid_request_error","param":"reasoning.summary","code":"unsupported_value"}}"""))
        server.enqueue(sse("openai_reasoning.txt"))
        val events = collect(client(), request())
        assertTrue(events.last() is StreamEvent.Completed)
        server.takeRequest()
        assertNull(server.takeRequest().json()["reasoning"]!!.jsonObject["summary"])
        assertTrue("summary" in quirks.dropped("p1", "gpt-5.5"))
    }

    @Test
    fun proModeAndVerbosity() {
        server.enqueue(sse("openai_reasoning.txt"))
        collect(client(), request(model = "gpt-5.6-sol", params = GenParams(effort = Effort.MAX, proMode = true, verbosity = Verbosity.LOW)))
        val body = server.takeRequest().json()
        assertEquals("pro", body["reasoning"]!!.jsonObject["mode"]!!.jsonPrimitive.content)
        assertEquals("max", body["reasoning"]!!.jsonObject["effort"]!!.jsonPrimitive.content)
        assertEquals("low", body["text"]!!.jsonObject["verbosity"]!!.jsonPrimitive.content)
    }

    @Test
    fun filtersAndNamesModels() = runBlocking {
        server.enqueue(json(200, """{"object":"list","data":[
            {"id":"gpt-5.5","object":"model","created":1770000000,"owned_by":"system"},
            {"id":"gpt-5.5-2026-04-23","object":"model","created":1769000000,"owned_by":"system"},
            {"id":"text-embedding-3-large","object":"model","created":1700000000,"owned_by":"system"},
            {"id":"whisper-1","object":"model","created":1600000000,"owned_by":"system"},
            {"id":"gpt-image-1","object":"model","created":1740000000,"owned_by":"system"},
            {"id":"o4-mini","object":"model","created":1744000000,"owned_by":"system"},
            {"id":"gpt-4o-mini-tts","object":"model","created":1742000000,"owned_by":"system"},
            {"id":"gpt-realtime","object":"model","created":1756000000,"owned_by":"system"},
            {"id":"dall-e-3","object":"model","created":1698000000,"owned_by":"system"},
            {"id":"gpt-4.1","object":"model","created":1744300000,"owned_by":"system"},
            {"id":"gpt-4o-mini","object":"model","created":1721000000,"owned_by":"system"}
        ]}"""))
        val models = client().listModels()
        assertEquals(listOf("gpt-5.5", "gpt-4.1", "o4-mini", "gpt-4o-mini"), models.map { it.id })
        assertEquals(listOf("GPT-5.5", "GPT-4.1", "o4-mini", "GPT-4o mini"), models.map { it.displayName })
        assertEquals(ReasoningKind.EFFORT, models[0].caps.reasoning.kind)
        assertTrue(models[3].caps.sampling && models[3].caps.vision)
    }
}
