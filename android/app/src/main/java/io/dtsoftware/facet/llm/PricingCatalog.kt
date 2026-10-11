package io.dtsoftware.facet.llm

import io.dtsoftware.facet.core.net.fetchString
import io.dtsoftware.facet.llm.internal.LlmJson
import io.dtsoftware.facet.llm.internal.arr
import io.dtsoftware.facet.llm.internal.obj
import io.dtsoftware.facet.llm.internal.parseObjectOrNull
import io.dtsoftware.facet.llm.internal.str
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * USD-per-million-token prices for cost estimates.
 *
 * Sources, in order: a built-in table of first-party prices, then the public OpenRouter model
 * feed (no key needed, cached to [cacheFile], refreshed at most daily). Prices are estimates;
 * tiered/long-context pricing isn't modeled.
 */
class PricingCatalog(
    private val cacheFile: File?,
    private val http: OkHttpClient?,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    @Serializable
    private data class CacheFile(val fetchedAt: Long, val models: Map<String, ModelPricing>)

    @Volatile private var byFullId: Map<String, ModelPricing> = emptyMap()
    @Volatile private var byVendorKey: Map<String, ModelPricing> = emptyMap()
    @Volatile var fetchedAt: Long = 0L
        private set

    init {
        cacheFile?.takeIf { it.isFile }?.let { f ->
            runCatching { LlmJson.decodeFromString(CacheFile.serializer(), f.readText()) }
                .getOrNull()?.let { install(it.models, it.fetchedAt) }
        }
    }

    /** Refreshes from OpenRouter when the cache is older than [maxAgeMs]. Returns true if refreshed. */
    suspend fun refreshIfStale(maxAgeMs: Long = DAY_MS): Boolean {
        val client = http ?: return false
        if (clock() - fetchedAt < maxAgeMs && byFullId.isNotEmpty()) return false
        return runCatching {
            val body = client.fetchString(Request.Builder().url(OPENROUTER_MODELS).get().build())
            val models = parseOpenRouterFeed(body)
            if (models.isEmpty()) return false
            val now = clock()
            install(models, now)
            cacheFile?.let { f ->
                withContext(Dispatchers.IO) {
                    f.parentFile?.mkdirs()
                    val tmp = File(f.parentFile, f.name + ".tmp")
                    tmp.writeText(LlmJson.encodeToString(CacheFile.serializer(), CacheFile(now, models)))
                    if (!tmp.renameTo(f)) {
                        f.delete()
                        tmp.renameTo(f)
                    }
                }
            }
            true
        }.getOrDefault(false)
    }

    /** Price for [modelId] served by [kind], or null when unknown. */
    fun priceFor(kind: ProviderKind, modelId: String): ModelPricing? {
        if (kind == ProviderKind.OPENROUTER) {
            return byFullId[modelId] ?: byFullId[modelId.substringBefore(':')]
        }
        val key = ModelCatalog.normalizeId(modelId)
        if (kind in FIRST_PARTY) BUILT_IN[key]?.let { return it }
        val vendor = VENDOR[kind] ?: return null
        return byVendorKey["$vendor/$key"]
    }

    /** Estimated USD cost of [usage] at [pricing]. */
    fun cost(pricing: ModelPricing, usage: Usage): Double = Companion.cost(pricing, usage)

    fun estimate(kind: ProviderKind, modelId: String, usage: Usage): Double? =
        priceFor(kind, modelId)?.let { cost(it, usage) }

    private fun install(models: Map<String, ModelPricing>, at: Long) {
        byFullId = models
        val vendorMap = HashMap<String, ModelPricing>(models.size)
        for ((id, price) in models) {
            val vendor = id.substringBefore('/', missingDelimiterValue = "")
            if (vendor.isEmpty()) continue
            val key = "$vendor/${ModelCatalog.normalizeId(id)}"
            // Prefer the plain variant over ":free"/":beta" duplicates.
            if (!id.contains(':') || key !in vendorMap) vendorMap[key] = price
        }
        byVendorKey = vendorMap
        fetchedAt = at
    }

    companion object {
        const val DAY_MS = 24L * 60 * 60 * 1000
        const val OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models"

        private val FIRST_PARTY = setOf(ProviderKind.ANTHROPIC, ProviderKind.OPENAI, ProviderKind.GOOGLE)

        private val VENDOR = mapOf(
            ProviderKind.OPENAI to "openai",
            ProviderKind.ANTHROPIC to "anthropic",
            ProviderKind.GOOGLE to "google",
            ProviderKind.XAI to "x-ai",
            ProviderKind.DEEPSEEK to "deepseek",
            ProviderKind.MISTRAL to "mistralai",
            ProviderKind.PERPLEXITY to "perplexity",
        )

        private fun p(input: Double, output: Double, cacheRead: Double? = null, cacheWrite: Double? = null) =
            ModelPricing(input, output, cacheRead, cacheWrite)

        /** Keys are [ModelCatalog.normalizeId] forms. */
        val BUILT_IN: Map<String, ModelPricing> = mapOf(
            // Anthropic (cache write = 5-minute TTL rate)
            "claude-fable-5-1" to p(10.0, 50.0, 0.25, 12.5),
            "claude-mythos-5-1" to p(10.0, 50.0, 0.25, 12.5),
            "claude-fable-5" to p(10.0, 50.0, 1.0, 12.5),
            "claude-opus-5-5" to p(4.0, 20.0, 0.20, 5.0),
            "claude-opus-5" to p(5.0, 25.0, 0.50, 6.25),
            "claude-opus-4-8" to p(5.0, 25.0, 0.50, 6.25),
            "claude-opus-4-7" to p(5.0, 25.0, 0.50, 6.25),
            "claude-opus-4-6" to p(5.0, 25.0, 0.50, 6.25),
            "claude-opus-4-5" to p(5.0, 25.0, 0.50, 6.25),
            "claude-opus-4-1" to p(15.0, 75.0, 1.50, 18.75),
            "claude-opus-4-0" to p(15.0, 75.0, 1.50, 18.75),
            "claude-opus-4" to p(15.0, 75.0, 1.50, 18.75),
            "claude-sonnet-5-5" to p(2.0, 10.0, 0.20, 2.5),
            "claude-sonnet-5" to p(2.0, 10.0, 0.20, 2.5),
            "claude-sonnet-4-6" to p(3.0, 15.0, 0.30, 3.75),
            "claude-sonnet-4-5" to p(3.0, 15.0, 0.30, 3.75),
            "claude-sonnet-4-0" to p(3.0, 15.0, 0.30, 3.75),
            "claude-sonnet-4" to p(3.0, 15.0, 0.30, 3.75),
            "claude-haiku-5-5" to p(0.10, 0.50, 0.01, 0.125),
            "claude-haiku-4-5" to p(1.0, 5.0, 0.10, 1.25),
            // OpenAI
            "gpt-4o" to p(2.5, 10.0, 1.25),
            "gpt-4o-mini" to p(0.15, 0.60, 0.075),
            "gpt-4-1" to p(2.0, 8.0, 0.50),
            "gpt-4-1-mini" to p(0.40, 1.60, 0.10),
            "gpt-4-1-nano" to p(0.10, 0.40, 0.025),
            "o3" to p(2.0, 8.0, 0.50),
            "o3-mini" to p(1.10, 4.40, 0.55),
            "o4-mini" to p(1.10, 4.40, 0.275),
            "gpt-5" to p(1.25, 10.0, 0.125),
            "gpt-5-mini" to p(0.25, 2.0, 0.025),
            "gpt-5-nano" to p(0.05, 0.40, 0.005),
            "gpt-5-1" to p(1.25, 10.0, 0.125),
            // Google (≤200K-token prompts)
            "gemini-2-5-pro" to p(1.25, 10.0, 0.3125),
            "gemini-2-5-flash" to p(0.30, 2.50, 0.075),
            "gemini-2-5-flash-lite" to p(0.10, 0.40, 0.025),
        )

        fun cost(pricing: ModelPricing, usage: Usage): Double {
            val cached = usage.cacheReadTokens + usage.cacheWriteTokens
            val uncached = (usage.inputTokens - cached).coerceAtLeast(0)
            val total = uncached * pricing.input +
                usage.cacheReadTokens * (pricing.cacheRead ?: pricing.input) +
                usage.cacheWriteTokens * (pricing.cacheWrite ?: pricing.input) +
                usage.outputTokens * pricing.output
            return total / 1_000_000.0
        }

        /** Per-token USD strings from OpenRouter → per-million doubles; negative = variable, skipped. */
        internal fun openRouterPricing(pricing: JsonObject?): ModelPricing? {
            pricing ?: return null
            fun f(key: String): Double? = pricing.str(key)?.toDoubleOrNull()?.takeIf { it >= 0 }?.times(1_000_000)
            val input = f("prompt") ?: return null
            val output = f("completion") ?: return null
            return ModelPricing(input, output, f("input_cache_read"), f("input_cache_write"))
        }

        internal fun parseOpenRouterFeed(body: String): Map<String, ModelPricing> {
            val data = parseObjectOrNull(body)?.arr("data") ?: return emptyMap()
            val out = LinkedHashMap<String, ModelPricing>(data.size)
            for (el in data) {
                val m = el as? JsonObject ?: continue
                val id = m.str("id") ?: continue
                openRouterPricing(m.obj("pricing"))?.let { out[id] = it }
            }
            return out
        }
    }
}
