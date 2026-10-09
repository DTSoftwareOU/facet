package io.dtsoftware.facet.llm

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Client tool calling (function calling) round trips for every adapter. */
class ToolCallingTest : MockServerTest() {

    private val weather = ToolSpec(
        name = "get_weather",
        description = "Current weather for a city.",
        inputSchemaJson = """{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}""",
    )

    private fun JsonObject.s(key: String) = this[key]!!.jsonPrimitive.content
    private fun arr(json: String) = Json.parseToJsonElement(json).jsonArray

    // ------------------------------------------------------------------ Anthropic

    private fun anthropic() = LlmClients.create(config(ProviderKind.ANTHROPIC), http, quirks)

    private fun anthropicRequest(messages: List<ChatMessage>, tools: List<ToolSpec> = listOf(weather)) = ChatRequest(
        model = "claude-opus-5-5", system = "Be brief.", messages = messages,
        params = GenParams(effort = Effort.LOW), caps = ModelCatalog.claudeCaps("claude-opus-5-5"), tools = tools,
    )

    @Test
    fun anthropicTwoStepRoundTripWithParallelCalls() {
        server.enqueue(sse("anthropic_tool_step1.txt"))
        val step1 = collect(anthropic(), anthropicRequest(listOf(user("Weather in Paris and Rome?"))))

        assertEquals(StreamEvent.Started("claude-opus-5-5"), step1.first())
        assertEquals("Let me check both cities.", step1.text())
        assertEquals(
            listOf(StreamEvent.ToolCallStarted("toolu_01A", "get_weather"), StreamEvent.ToolCallStarted("toolu_01B", "get_weather")),
            step1.filterIsInstance<StreamEvent.ToolCallStarted>(),
        )
        assertEquals(
            listOf(
                StreamEvent.ToolCallReady("toolu_01A", "get_weather", """{"city":"Paris"}"""),
                StreamEvent.ToolCallReady("toolu_01B", "get_weather", """{"city":"Rome"}"""),
            ),
            step1.filterIsInstance<StreamEvent.ToolCallReady>(),
        )
        val done = step1.last() as StreamEvent.Completed
        assertEquals(StopReason.TOOL_USE, done.stopReason)
        val blocks = arr(done.blocks!!.json)
        assertEquals(listOf("text", "tool_use", "tool_use"), blocks.map { it.jsonObject.s("type") })
        assertEquals("Paris", blocks[1].jsonObject["input"]!!.jsonObject.s("city"))

        val body1 = server.takeRequest().json()
        val tool = body1["tools"]!!.jsonArray.single().jsonObject
        assertEquals("get_weather", tool.s("name"))
        assertEquals("object", tool["input_schema"]!!.jsonObject.s("type"))
        assertEquals("true", tool.s("eager_input_streaming"))

        // Step 2: replay the step verbatim plus both results in one user message.
        server.enqueue(sse("anthropic_tool_step2.txt"))
        val history = listOf(
            user("Weather in Paris and Rome?"),
            ChatMessage(
                Role.ASSISTANT,
                listOf(
                    Part.Text("Let me check both cities."),
                    Part.ToolCall("toolu_01A", "get_weather", """{"city":"Paris"}"""),
                    Part.ToolCall("toolu_01B", "get_weather", """{"city":"Rome"}"""),
                ),
                done.blocks,
            ),
            ChatMessage(
                Role.USER,
                listOf(
                    Part.ToolResult("toolu_01A", "get_weather", "18°C"),
                    Part.ToolResult("toolu_01B", "get_weather", "Service unavailable", isError = true),
                ),
            ),
        )
        val step2 = collect(anthropic(), anthropicRequest(history))
        assertEquals("Paris is 18°C; Rome's lookup failed.", step2.text())
        assertEquals(StopReason.END, (step2.last() as StreamEvent.Completed).stopReason)

        val messages = server.takeRequest().json()["messages"]!!.jsonArray
        assertEquals(3, messages.size)
        val assistant = messages[1].jsonObject["content"]!!.jsonArray
        assertEquals(listOf("text", "tool_use", "tool_use"), assistant.map { it.jsonObject.s("type") })
        val results = messages[2].jsonObject["content"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("tool_result", "tool_result"), results.map { it.s("type") })
        assertEquals("toolu_01A", results[0].s("tool_use_id"))
        assertEquals("18°C", results[0].s("content"))
        assertNull(results[0]["is_error"])
        assertEquals("true", results[1].s("is_error"))
    }

    @Test
    fun anthropicConvertsToolHistoryFromAnotherProvider() {
        server.enqueue(sse("anthropic_tool_step2.txt"))
        val foreign = ProviderBlocks(ApiStyle.OPENAI_RESPONSES, "gpt-5.5", "[]")
        val history = listOf(
            user("Weather?"),
            ChatMessage(Role.ASSISTANT, listOf(Part.ToolCall("call_abc", "get_weather", """{"city":"Oslo"}""")), foreign),
            ChatMessage(Role.USER, listOf(Part.ToolResult("call_abc", "get_weather", "9°C"))),
        )
        collect(anthropic(), anthropicRequest(history))
        val messages = server.takeRequest().json()["messages"]!!.jsonArray
        val toolUse = messages[1].jsonObject["content"]!!.jsonArray.single().jsonObject
        assertEquals("tool_use", toolUse.s("type"))
        assertEquals("call_abc", toolUse.s("id"))
        assertEquals("Oslo", toolUse["input"]!!.jsonObject.s("city"))
        val result = messages[2].jsonObject["content"]!!.jsonArray.single().jsonObject
        assertEquals("call_abc", result.s("tool_use_id"))
    }

    @Test
    fun anthropicDropsToolsWhenModelRejectsThem() {
        server.enqueue(json(400, """{"type":"error","error":{"type":"invalid_request_error","message":"This model does not support tools."}}"""))
        server.enqueue(sse("anthropic_tool_step2.txt"))
        val events = collect(anthropic(), anthropicRequest(listOf(user("Hi"))))
        assertTrue(events.last() is StreamEvent.Completed)
        assertTrue(server.takeRequest().json().containsKey("tools"))
        assertFalse(server.takeRequest().json().containsKey("tools"))
        assertTrue("tools" in quirks.dropped("p1", "claude-opus-5-5"))
    }

    @Test
    fun anthropicNoToolsRequestHasNoToolsKey() {
        server.enqueue(sse("anthropic_tool_step2.txt"))
        collect(anthropic(), anthropicRequest(listOf(user("Hi")), tools = emptyList()))
        assertFalse(server.takeRequest().json().containsKey("tools"))
    }

    // ------------------------------------------------------------------ OpenAI Responses

    private fun responses() = LlmClients.create(config(ProviderKind.OPENAI, "/v1"), http, quirks)

    private fun responsesRequest(messages: List<ChatMessage>) = ChatRequest(
        model = "gpt-5.5", system = "Be brief.", messages = messages,
        params = GenParams(effort = Effort.LOW), caps = ModelCatalog.openAiCaps("gpt-5.5"), tools = listOf(weather),
    )

    @Test
    fun responsesTwoStepRoundTrip() {
        server.enqueue(sse("openai_tool_step1.txt"))
        val step1 = collect(responses(), responsesRequest(listOf(user("Weather in Oslo?"))))
        assertEquals("Need the weather.", step1.thinking())
        assertEquals(StreamEvent.ToolCallStarted("call_abc", "get_weather"), step1.only<StreamEvent.ToolCallStarted>())
        assertEquals(StreamEvent.ToolCallReady("call_abc", "get_weather", """{"city":"Oslo"}"""), step1.only<StreamEvent.ToolCallReady>())
        val done = step1.last() as StreamEvent.Completed
        assertEquals(StopReason.TOOL_USE, done.stopReason)
        assertEquals(listOf("reasoning", "function_call"), arr(done.blocks!!.json).map { it.jsonObject.s("type") })

        val body1 = server.takeRequest().json()
        val fn = body1["tools"]!!.jsonArray.single().jsonObject
        assertEquals("function", fn.s("type"))
        assertEquals("get_weather", fn.s("name"))
        assertEquals("false", fn.s("strict"))
        assertEquals("object", fn["parameters"]!!.jsonObject.s("type"))

        server.enqueue(sse("openai_tool_step2.txt"))
        val history = listOf(
            user("Weather in Oslo?"),
            ChatMessage(Role.ASSISTANT, listOf(Part.ToolCall("call_abc", "get_weather", """{"city":"Oslo"}""")), done.blocks),
            ChatMessage(Role.USER, listOf(Part.ToolResult("call_abc", "get_weather", "9°C"))),
        )
        val step2 = collect(responses(), responsesRequest(history))
        assertEquals("Oslo is 9°C.", step2.text())
        assertEquals(StopReason.END, (step2.last() as StreamEvent.Completed).stopReason)

        val input = server.takeRequest().json()["input"]!!.jsonArray.map { it.jsonObject }
        assertEquals("user", input[0].s("role"))
        assertEquals("reasoning", input[1].s("type"))
        assertEquals("enc123", input[1].s("encrypted_content"))
        assertEquals("function_call", input[2].s("type"))
        assertEquals("function_call_output", input[3].s("type"))
        assertEquals("call_abc", input[3].s("call_id"))
        assertEquals("9°C", input[3].s("output"))
        assertEquals(4, input.size)
    }

    @Test
    fun responsesConvertsToolHistoryFromAnotherProvider() {
        server.enqueue(sse("openai_tool_step2.txt"))
        val anthropicBlocks = ProviderBlocks(ApiStyle.ANTHROPIC, "claude-opus-5-5", """[{"type":"tool_use","id":"toolu_9","name":"get_weather","input":{"city":"Oslo"}}]""")
        val history = listOf(
            user("Weather?"),
            ChatMessage(Role.ASSISTANT, listOf(Part.Text("Checking."), Part.ToolCall("toolu_9", "get_weather", """{"city":"Oslo"}""")), anthropicBlocks),
            ChatMessage(Role.USER, listOf(Part.ToolResult("toolu_9", "get_weather", "boom", isError = true), Part.Text("Also, thanks!"))),
        )
        collect(responses(), responsesRequest(history))
        val input = server.takeRequest().json()["input"]!!.jsonArray.map { it.jsonObject }
        assertEquals("assistant", input[1].s("role"))
        assertEquals("function_call", input[2].s("type"))
        assertEquals("toolu_9", input[2].s("call_id"))
        assertEquals("""{"city":"Oslo"}""", input[2].s("arguments"))
        assertEquals("function_call_output", input[3].s("type"))
        assertEquals("Error: boom", input[3].s("output"))
        assertEquals("user", input[4].s("role"))
    }

    // ------------------------------------------------------------------ Chat Completions

    private fun chat(kind: ProviderKind) = LlmClients.create(config(kind, "/v1"), http, quirks)

    private fun chatRequest(kind: ProviderKind, model: String, messages: List<ChatMessage>, tools: List<ToolSpec> = listOf(weather)) =
        ChatRequest(model, "System prompt", messages, GenParams(), ModelCatalog.compatCaps(kind, model), tools = tools)

    @Test
    fun chatTwoStepRoundTrip() {
        server.enqueue(sse("chat_tool_step1.txt"))
        val step1 = collect(chat(ProviderKind.GROQ), chatRequest(ProviderKind.GROQ, "llama-3.3-70b", listOf(user("Lima weather?"))))
        assertEquals("Checking.", step1.text())
        assertEquals(StreamEvent.ToolCallStarted("call_x1", "get_weather"), step1.only<StreamEvent.ToolCallStarted>())
        assertEquals(StreamEvent.ToolCallReady("call_x1", "get_weather", """{"city":"Lima"}"""), step1.only<StreamEvent.ToolCallReady>())
        val done = step1.last() as StreamEvent.Completed
        assertEquals(StopReason.TOOL_USE, done.stopReason)
        assertEquals(ApiStyle.OPENAI_CHAT, done.blocks!!.style)
        val stored = arr(done.blocks.json).single().jsonObject
        assertEquals("Checking.", stored.s("content"))
        assertEquals("call_x1", stored["tool_calls"]!!.jsonArray.single().jsonObject.s("id"))

        val body1 = server.takeRequest().json()
        val fn = body1["tools"]!!.jsonArray.single().jsonObject
        assertEquals("function", fn.s("type"))
        assertEquals("get_weather", fn["function"]!!.jsonObject.s("name"))
        assertNull(body1["tool_choice"])

        server.enqueue(sse("chat_tool_step2.txt"))
        val history = listOf(
            user("Lima weather?"),
            ChatMessage(Role.ASSISTANT, listOf(Part.Text("Checking."), Part.ToolCall("call_x1", "get_weather", """{"city":"Lima"}""")), done.blocks),
            ChatMessage(Role.USER, listOf(Part.ToolResult("call_x1", "get_weather", "20°C"))),
        )
        val step2 = collect(chat(ProviderKind.GROQ), chatRequest(ProviderKind.GROQ, "llama-3.3-70b", history))
        assertEquals("Lima is 20°C.", step2.text())
        assertEquals(StreamEvent.Completed(StopReason.END, null), step2.last())

        val messages = server.takeRequest().json()["messages"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("system", "user", "assistant", "tool"), messages.map { it.s("role") })
        assertEquals("Checking.", messages[2].s("content"))
        val call = messages[2]["tool_calls"]!!.jsonArray.single().jsonObject
        assertEquals("call_x1", call.s("id"))
        assertEquals("""{"city":"Lima"}""", call["function"]!!.jsonObject.s("arguments"))
        assertNull(messages[2]["reasoning_content"])
        assertEquals("call_x1", messages[3].s("tool_call_id"))
        assertEquals("20°C", messages[3].s("content"))
    }

    @Test
    fun chatSynthesizesIdsWhenGeminiOmitsThem() {
        server.enqueue(sse("chat_tool_gemini.txt"))
        val events = collect(chat(ProviderKind.GOOGLE), chatRequest(ProviderKind.GOOGLE, "gemini-2.5-flash", listOf(user("Weather in Kyiv and Oslo?"))))
        val ready = events.filterIsInstance<StreamEvent.ToolCallReady>()
        assertEquals(listOf("""{"city":"Kyiv"}""", """{"city":"Oslo"}"""), ready.map { it.argumentsJson })
        assertTrue(ready.all { it.id.isNotBlank() })
        assertNotEquals(ready[0].id, ready[1].id)
        assertEquals(ready.map { it.id }, events.filterIsInstance<StreamEvent.ToolCallStarted>().map { it.id })
        assertEquals(StopReason.TOOL_USE, (events.last() as StreamEvent.Completed).stopReason)
    }

    @Test
    fun chatPassesInvalidArgumentsThroughRaw() {
        server.enqueue(sse("chat_tool_invalid.txt"))
        val events = collect(chat(ProviderKind.DEEPSEEK), chatRequest(ProviderKind.DEEPSEEK, "deepseek-chat", listOf(user("Weather?"))))
        assertEquals("""{"city": "Li""", events.only<StreamEvent.ToolCallReady>().argumentsJson)
        val done = events.last() as StreamEvent.Completed
        assertEquals(StopReason.TOOL_USE, done.stopReason)
        assertEquals("Look it up.", arr(done.blocks!!.json).single().jsonObject.s("reasoning_content"))
    }

    @Test
    fun chatRetriesWithReasoningContentWhenProviderAsks() {
        server.enqueue(json(400, """{"error":{"message":"Missing `reasoning_content` field in the assistant message at message index 2","type":"invalid_request_error"}}"""))
        server.enqueue(sse("chat_tool_step2.txt"))
        val blocks = ProviderBlocks(ApiStyle.OPENAI_CHAT, "deepseek-reasoner", """[{"role":"assistant","content":"","tool_calls":[],"reasoning_content":"Think first."}]""")
        val history = listOf(
            user("Weather?"),
            ChatMessage(Role.ASSISTANT, listOf(Part.ToolCall("call_1", "get_weather", """{"city":"Lima"}""")), blocks),
            ChatMessage(Role.USER, listOf(Part.ToolResult("call_1", "get_weather", "20°C"))),
        )
        val events = collect(chat(ProviderKind.DEEPSEEK), chatRequest(ProviderKind.DEEPSEEK, "deepseek-reasoner", history))
        assertTrue(events.last() is StreamEvent.Completed)
        assertNull(server.takeRequest().json()["messages"]!!.jsonArray[2].jsonObject["reasoning_content"])
        assertEquals("Think first.", server.takeRequest().json()["messages"]!!.jsonArray[2].jsonObject.s("reasoning_content"))
        assertFalse("tools" in quirks.dropped("p1", "deepseek-reasoner"))
    }

    @Test
    fun chatDropsToolsWhenOllamaModelCannotUseThem() {
        server.enqueue(json(400, """{"error":{"message":"registry.ollama.ai/library/gemma2:latest does not support tools","type":"api_error"}}"""))
        server.enqueue(sse("chat_tool_step2.txt"))
        val events = collect(chat(ProviderKind.OLLAMA), chatRequest(ProviderKind.OLLAMA, "gemma2", listOf(user("Hi"))))
        assertEquals("Lima is 20°C.", events.text())
        assertTrue(server.takeRequest().json().containsKey("tools"))
        assertFalse(server.takeRequest().json().containsKey("tools"))
        assertTrue("tools" in quirks.dropped("p1", "gemma2"))

        // Subsequent requests skip tools without another failed round trip.
        server.enqueue(sse("chat_tool_step2.txt"))
        collect(chat(ProviderKind.OLLAMA), chatRequest(ProviderKind.OLLAMA, "gemma2", listOf(user("Hi"))))
        assertFalse(server.takeRequest().json().containsKey("tools"))
    }

    @Test
    fun chatMapsToolIdsForMistral() {
        server.enqueue(sse("chat_tool_step2.txt"))
        val history = listOf(
            user("Weather?"),
            ChatMessage(Role.ASSISTANT, listOf(Part.ToolCall("toolu_01A", "get_weather", "not json")), null),
            ChatMessage(Role.USER, listOf(Part.ToolResult("toolu_01A", "get_weather", "20°C"))),
        )
        collect(chat(ProviderKind.MISTRAL), chatRequest(ProviderKind.MISTRAL, "mistral-large-latest", history))
        val messages = server.takeRequest().json()["messages"]!!.jsonArray.map { it.jsonObject }
        val call = messages[2]["tool_calls"]!!.jsonArray.single().jsonObject
        val id = call.s("id")
        assertTrue(id.matches(Regex("[a-zA-Z0-9]{9}")))
        assertEquals(id, messages[3].s("tool_call_id"))
        assertEquals("{}", call["function"]!!.jsonObject.s("arguments"))
    }

    @Test
    fun chatWithoutToolsIsUnchanged() {
        server.enqueue(sse("chat_tool_step2.txt"))
        val history = listOf(user("A"), ChatMessage(Role.ASSISTANT, listOf(Part.Text("B"))), user("C"), user("D"))
        collect(chat(ProviderKind.GROQ), chatRequest(ProviderKind.GROQ, "llama-3.3-70b", history, tools = emptyList()))
        val body = server.takeRequest().json()
        assertNull(body["tools"])
        val messages = body["messages"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("system", "user", "assistant", "user"), messages.map { it.s("role") })
        assertEquals(JsonPrimitive("C\n\nD"), messages[3]["content"])
    }

    @Test
    fun perplexityAndUtilityRequestsNeverSendTools() {
        server.enqueue(sse("chat_perplexity.txt"))
        collect(chat(ProviderKind.PERPLEXITY), chatRequest(ProviderKind.PERPLEXITY, "sonar-pro", listOf(user("Hi"))))
        assertNull(server.takeRequest().json()["tools"])

        server.enqueue(sse("chat_tool_step2.txt"))
        val utility = chatRequest(ProviderKind.GROQ, "llama-3.3-70b", listOf(user("Title?"))).copy(utility = true)
        collect(chat(ProviderKind.GROQ), utility)
        assertNull(server.takeRequest().json()["tools"])
    }

    @Test
    fun catalogToolSupport() {
        assertTrue(ModelCatalog.claudeCaps("claude-opus-5-5").tools)
        assertTrue(ModelCatalog.openAiCaps("gpt-5.5").tools)
        assertFalse(ModelCatalog.openAiCaps("o1-mini").tools)
        assertFalse(ModelCatalog.openAiCaps("chatgpt-4o-latest").tools)
        assertFalse(ModelCatalog.compatCaps(ProviderKind.PERPLEXITY, "sonar").tools)
        assertFalse(ModelCatalog.compatCaps(ProviderKind.GOOGLE, "gemma-3-27b-it").tools)
        assertTrue(ModelCatalog.compatCaps(ProviderKind.OLLAMA, "llama3.2").tools)
        assertTrue(ModelCatalog.perplexityModels().none { it.caps.tools })
    }
}
