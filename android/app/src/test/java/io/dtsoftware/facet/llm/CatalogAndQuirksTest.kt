package io.dtsoftware.facet.llm

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CatalogAndQuirksTest {

    @Test
    fun parsesClaudeIds() {
        assertEquals(ModelCatalog.ClaudeModel(ModelCatalog.ClaudeTier.OPUS, 5, 5), ModelCatalog.parseClaude("claude-opus-5-5"))
        assertEquals(ModelCatalog.ClaudeModel(ModelCatalog.ClaudeTier.OPUS, 4, 0), ModelCatalog.parseClaude("claude-opus-4-20250514"))
        assertEquals(ModelCatalog.ClaudeModel(ModelCatalog.ClaudeTier.HAIKU, 4, 5), ModelCatalog.parseClaude("claude-haiku-4-5-20251001"))
        assertEquals(ModelCatalog.ClaudeModel(ModelCatalog.ClaudeTier.SONNET, 3, 7), ModelCatalog.parseClaude("claude-3-7-sonnet-20250219"))
        assertEquals(ModelCatalog.ClaudeTier.FABLE, ModelCatalog.parseClaude("anthropic/claude-fable-5-1")!!.tier)
        assertNull(ModelCatalog.parseClaude("gpt-5"))
    }

    @Test
    fun claudeFamilyRules() {
        val opus55 = ModelCatalog.claudeCaps("claude-opus-5-5")
        assertFalse(opus55.sampling)
        assertFalse(Effort.NONE in opus55.reasoning.efforts)
        assertTrue(opus55.fastMode && opus55.refusalFallback)
        val sonnet46 = ModelCatalog.claudeCaps("claude-sonnet-4-6")
        assertTrue(sonnet46.sampling)
        assertEquals(listOf(Effort.NONE, Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.MAX), sonnet46.reasoning.efforts)
        val haiku45 = ModelCatalog.claudeCaps("claude-haiku-4-5")
        assertEquals(ReasoningKind.BUDGET, haiku45.reasoning.kind)
        assertEquals(ModelCatalog.ThinkingOff.BETWEEN_TOOLS, ModelCatalog.parseClaude("claude-sonnet-5-5")!!.thinkingOff)
        assertEquals(ModelCatalog.ThinkingOff.CANNOT, ModelCatalog.parseClaude("claude-fable-5-1")!!.thinkingOff)
        assertTrue(ModelCatalog.parseClaude("claude-opus-4-6")!!.webSearchV2)
        assertFalse(ModelCatalog.parseClaude("claude-haiku-5-5")!!.webSearchV2)
    }

    @Test
    fun openAiCapabilities() {
        assertEquals(listOf(Effort.MINIMAL, Effort.LOW, Effort.MEDIUM, Effort.HIGH), ModelCatalog.openAiCaps("gpt-5-mini").reasoning.efforts)
        assertTrue(Effort.NONE in ModelCatalog.openAiCaps("gpt-5.1").reasoning.efforts)
        assertTrue(Effort.XHIGH in ModelCatalog.openAiCaps("gpt-5.5").reasoning.efforts)
        val sol = ModelCatalog.openAiCaps("gpt-6.1-sol")
        assertTrue(Effort.MAX in sol.reasoning.efforts)
        assertFalse(Effort.NONE in sol.reasoning.efforts)
        assertTrue(sol.proMode)
        assertFalse(Effort.NONE in ModelCatalog.openAiCaps("gpt-6-astra").reasoning.efforts)
        assertEquals(listOf(Effort.HIGH), ModelCatalog.openAiCaps("o3-pro").reasoning.efforts)
        val gpt41 = ModelCatalog.openAiCaps("gpt-4.1")
        assertEquals(ReasoningKind.NONE, gpt41.reasoning.kind)
        assertTrue(gpt41.sampling && gpt41.vision && gpt41.webSearch)
        assertFalse(ModelCatalog.isOpenAiChatModel("text-embedding-3-small"))
        assertFalse(ModelCatalog.isOpenAiChatModel("gpt-4o-realtime-preview"))
        assertTrue(ModelCatalog.isOpenAiChatModel("o4-mini"))
        assertTrue(ModelCatalog.isOpenAiChatModel("gpt-5.1-codex"))
    }

    @Test
    fun displayNames() {
        assertEquals("GPT-5.5", ModelCatalog.displayName(ProviderKind.OPENAI, "gpt-5.5"))
        assertEquals("GPT-4o mini", ModelCatalog.displayName(ProviderKind.OPENAI, "gpt-4o-mini"))
        assertEquals("GPT-5.6 Sol", ModelCatalog.displayName(ProviderKind.OPENAI, "gpt-5.6-sol"))
        assertEquals("o3-pro", ModelCatalog.displayName(ProviderKind.OPENAI, "o3-pro"))
        assertEquals("Llama 3.3 70B Versatile", ModelCatalog.displayName(ProviderKind.GROQ, "llama-3.3-70b-versatile"))
        assertEquals("GPT OSS 120B", ModelCatalog.displayName(ProviderKind.GROQ, "openai/gpt-oss-120b"))
        assertEquals("Gemini 2.5 Pro", ModelCatalog.displayName(ProviderKind.GOOGLE, "models/gemini-2.5-pro"))
    }

    @Test
    fun healerDiagnoses() {
        val sent = listOf(
            ParamSpec("summary", listOf("reasoning.summary", "summary")),
            ParamSpec("effort", listOf("reasoning.effort", "effort")),
            ParamSpec("temperature", listOf("temperature")),
            ParamSpec("max_tokens", listOf("max_tokens")),
        )
        assertEquals(HealAction.Drop("temperature"), ParamHealer.diagnose("Unsupported parameter: 'temperature'", sent, null, emptyList()))
        assertEquals(
            HealAction.CapMaxTokens(32000),
            ParamHealer.diagnose("max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-1", sent, null, emptyList()),
        )
        assertEquals(
            HealAction.EffortValue(Effort.XHIGH, Effort.HIGH),
            ParamHealer.diagnose("Invalid value 'xhigh' for reasoning.effort. Supported values are: 'low', 'medium' and 'high'.", sent, Effort.XHIGH, emptyList()),
        )
        assertNull(ParamHealer.diagnose("prompt is too long: 250000 tokens > 200000 maximum", sent, null, emptyList()))
        assertNull(ParamHealer.diagnose("Something unrelated broke", sent, null, emptyList()))
    }

    @Test
    fun effortResolutionHonorsQuirks() {
        val levels = listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.XHIGH)
        assertEquals(Effort.XHIGH, resolveEffort(Effort.MAX, levels, emptySet()))
        assertEquals(Effort.MEDIUM, resolveEffort(Effort.HIGH, levels, setOf("effort:high", "effort:xhigh")))
        assertEquals(Effort.LOW, resolveEffort(Effort.MINIMAL, levels, emptySet()))
        assertNull(resolveEffort(Effort.HIGH, levels, setOf("effort")))
        assertEquals(32000, maxTokensCap(setOf("max_tokens:64000", "max_tokens:32000", "temperature")))
    }

    @Test
    fun errorsRedactKeys() {
        val cfg = ProviderConfig("p", ProviderKind.OPENAI, "x", "https://api.openai.com/v1", "sk-proj-SECRETSECRET123")
        val e = io.dtsoftware.facet.core.net.HttpStatusException(
            401,
            """{"error":{"message":"Incorrect API key provided: sk-proj-SECRETSECRET123. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}""",
            null,
        )
        val err = LlmErrors.fromHttp(cfg, "gpt-5", e)
        assertEquals(ErrorKind.AUTH, err.kind)
        assertFalse(err.detail!!.contains("SECRET"))
        assertFalse(err.message.contains("SECRET"))
        val quota = LlmErrors.fromHttp(cfg, "gpt-5", io.dtsoftware.facet.core.net.HttpStatusException(429, """{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}""", null))
        assertEquals(ErrorKind.QUOTA, quota.kind)
        val ctx = LlmErrors.fromHttp(cfg, "gpt-5", io.dtsoftware.facet.core.net.HttpStatusException(400, """{"error":{"message":"This model's maximum context length is 128000 tokens.","code":"context_length_exceeded"}}""", null))
        assertEquals(ErrorKind.CONTEXT_LENGTH, ctx.kind)
        val overloaded = LlmErrors.fromHttp(cfg, null, io.dtsoftware.facet.core.net.HttpStatusException(529, """{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}""", null))
        assertEquals(ErrorKind.OVERLOADED, overloaded.kind)
    }

    @Test
    fun pricingBuiltInAndCost() {
        val catalog = PricingCatalog(null, null)
        val opus = catalog.priceFor(ProviderKind.ANTHROPIC, "claude-opus-5-5")!!
        assertEquals(4.0, opus.input, 1e-9)
        assertNotNull(catalog.priceFor(ProviderKind.ANTHROPIC, "claude-haiku-4-5-20251001"))
        assertNotNull(catalog.priceFor(ProviderKind.OPENAI, "gpt-4.1-mini"))
        assertNull(catalog.priceFor(ProviderKind.GROQ, "llama-3.3-70b-versatile"))
        // 1M uncached input + 1M output at $4/$20, plus 1M cache reads at $0.20.
        val usage = Usage(inputTokens = 2_000_000, outputTokens = 1_000_000, cacheReadTokens = 1_000_000)
        assertEquals(24.2, catalog.cost(opus, usage), 1e-9)
    }

    @Test
    fun pricingFeedParsesAndCaches(): Unit = runBlocking {
        val server = mockwebserver3.MockWebServer()
        server.start()
        try {
            val feed = """{"data":[
                {"id":"x-ai/grok-4","pricing":{"prompt":"0.000003","completion":"0.000015"}},
                {"id":"openai/gpt-5.5","pricing":{"prompt":"0.000002","completion":"0.000016","input_cache_read":"0.0000002"}},
                {"id":"openrouter/auto","pricing":{"prompt":"-1","completion":"-1"}},
                {"id":"deepseek/deepseek-chat:free","pricing":{"prompt":"0","completion":"0"}}
            ]}"""
            server.enqueue(mockwebserver3.MockResponse.Builder().code(200).body(feed).build())
            val dir = Files.createTempDirectory("pricing").toFile()
            val file = File(dir, "pricing.json")
            val http = OkHttpClient.Builder()
                .addInterceptor { chain -> chain.proceed(chain.request().newBuilder().url(server.url("/api/v1/models")).build()) }
                .build()
            val catalog = PricingCatalog(file, http)
            assertTrue(catalog.refreshIfStale())
            assertEquals(3.0, catalog.priceFor(ProviderKind.XAI, "grok-4")!!.input, 1e-9)
            assertEquals(16.0, catalog.priceFor(ProviderKind.OPENAI, "gpt-5.5")!!.output, 1e-9)
            assertEquals(3.0, catalog.priceFor(ProviderKind.OPENROUTER, "x-ai/grok-4")!!.input, 1e-9)
            assertNull(catalog.priceFor(ProviderKind.OPENROUTER, "openrouter/auto"))
            assertFalse(catalog.refreshIfStale()) // fresh
            // A new instance loads from the cache file without network.
            val reloaded = PricingCatalog(file, null)
            assertEquals(3.0, reloaded.priceFor(ProviderKind.XAI, "grok-4")!!.input, 1e-9)
            dir.deleteRecursively()
        } finally {
            server.close()
        }
    }
}
