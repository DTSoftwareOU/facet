package io.dtsoftware.facet.llm

import java.util.Locale

/**
 * Capability inference and display names for model ids. Live metadata (Anthropic Models API,
 * OpenRouter /models) wins where available; these heuristics fill the gaps, and the adapters'
 * self-healing retry corrects any wrong guess at request time.
 */
object ModelCatalog {

    // ---------------------------------------------------------------- Claude

    enum class ClaudeTier { OPUS, SONNET, HAIKU, FABLE, MYTHOS }

    /** How a Claude model turns thinking off for [Effort.NONE]. */
    enum class ThinkingOff { DISABLED, BETWEEN_TOOLS, OMIT, CANNOT }

    data class ClaudeModel(val tier: ClaudeTier, val major: Int, val minor: Int) {
        val version: Double get() = major + minor / 10.0
        fun atLeast(maj: Int, min: Int = 0) = major > maj || (major == maj && minor >= min)

        val adaptive: Boolean
            get() = when (tier) {
                ClaudeTier.FABLE, ClaudeTier.MYTHOS -> true
                ClaudeTier.OPUS, ClaudeTier.SONNET -> atLeast(4, 6)
                ClaudeTier.HAIKU -> atLeast(5)
            }

        /** Older models with manual `budget_tokens` extended thinking. */
        val budgetThinking: Boolean
            get() = !adaptive && when (tier) {
                ClaudeTier.OPUS -> atLeast(4)
                ClaudeTier.SONNET -> atLeast(3, 7)
                ClaudeTier.HAIKU -> atLeast(4, 5)
                else -> false
            }

        /** Thinking runs when `thinking` is omitted. */
        val thinkingOnByDefault: Boolean
            get() = when (tier) {
                ClaudeTier.FABLE, ClaudeTier.MYTHOS -> true
                ClaudeTier.OPUS, ClaudeTier.SONNET, ClaudeTier.HAIKU -> atLeast(5)
            }

        val thinkingOff: ThinkingOff
            get() = when (tier) {
                ClaudeTier.FABLE, ClaudeTier.MYTHOS -> ThinkingOff.CANNOT
                ClaudeTier.OPUS -> when {
                    atLeast(5, 5) -> ThinkingOff.CANNOT
                    atLeast(4, 7) -> ThinkingOff.DISABLED
                    else -> ThinkingOff.OMIT
                }
                ClaudeTier.SONNET -> when {
                    atLeast(5, 5) -> ThinkingOff.BETWEEN_TOOLS
                    atLeast(5) -> ThinkingOff.DISABLED
                    else -> ThinkingOff.OMIT
                }
                ClaudeTier.HAIKU -> if (atLeast(5)) ThinkingOff.DISABLED else ThinkingOff.OMIT
            }

        val defaultEffort: Effort
            get() = when {
                tier == ClaudeTier.OPUS && atLeast(5, 5) -> Effort.MEDIUM
                tier == ClaudeTier.HAIKU && atLeast(5) -> Effort.MEDIUM
                else -> Effort.HIGH
            }

        val effortLevels: List<Effort>
            get() = when {
                tier == ClaudeTier.FABLE || tier == ClaudeTier.MYTHOS -> FULL_EFFORT
                tier == ClaudeTier.OPUS && atLeast(4, 7) -> FULL_EFFORT
                tier == ClaudeTier.OPUS && atLeast(4, 6) -> listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.MAX)
                tier == ClaudeTier.SONNET && atLeast(5) -> FULL_EFFORT
                tier == ClaudeTier.SONNET && atLeast(4, 6) -> listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.MAX)
                tier == ClaudeTier.HAIKU && atLeast(5) -> FULL_EFFORT
                else -> emptyList()
            }

        /** temperature / top_p accepted (removed from Opus 4.7+, Sonnet 5+, Haiku 5+, Fable). */
        val sampling: Boolean
            get() = when (tier) {
                ClaudeTier.OPUS, ClaudeTier.SONNET -> !atLeast(4, 7) && !(tier == ClaudeTier.SONNET && atLeast(5))
                ClaudeTier.HAIKU -> !atLeast(5)
                else -> false
            }

        val fastMode: Boolean get() = tier == ClaudeTier.OPUS && atLeast(4, 8)

        val refusalFallback: Boolean
            get() = when (tier) {
                ClaudeTier.FABLE -> true
                ClaudeTier.OPUS -> atLeast(5)
                ClaudeTier.SONNET -> atLeast(5, 5)
                else -> false
            }

        /** Supports `web_search_20260209` (dynamic filtering). */
        val webSearchV2: Boolean
            get() = (tier == ClaudeTier.OPUS || tier == ClaudeTier.SONNET) && atLeast(4, 6)

        val defaultMaxOutput: Int
            get() = when {
                tier == ClaudeTier.FABLE || tier == ClaudeTier.MYTHOS -> 128_000
                (tier == ClaudeTier.OPUS || tier == ClaudeTier.SONNET) && atLeast(4, 6) -> 128_000
                tier == ClaudeTier.HAIKU && atLeast(5) -> 128_000
                tier == ClaudeTier.HAIKU && atLeast(4, 5) -> 64_000
                tier == ClaudeTier.SONNET && atLeast(3, 7) -> 64_000
                tier == ClaudeTier.OPUS && atLeast(4, 5) -> 64_000
                tier == ClaudeTier.OPUS && atLeast(4) -> 32_000
                else -> 8_192
            }
    }

    private val FULL_EFFORT = listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.XHIGH, Effort.MAX)
    private val BUDGET_LEVELS = listOf(Effort.NONE, Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.MAX)
    private val claudeNew = Regex("""claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?=-|$)""")
    private val claudeOld = Regex("""claude-(\d+)(?:-(\d))?-(opus|sonnet|haiku)""")

    fun parseClaude(id: String): ClaudeModel? {
        val s = id.lowercase(Locale.ROOT).substringAfterLast('/')
        claudeNew.find(s)?.let { m ->
            val tier = ClaudeTier.valueOf(m.groupValues[1].uppercase(Locale.ROOT))
            return ClaudeModel(tier, m.groupValues[2].toInt(), m.groupValues[3].toIntOrNull() ?: 0)
        }
        claudeOld.find(s)?.let { m ->
            val tier = ClaudeTier.valueOf(m.groupValues[3].uppercase(Locale.ROOT))
            return ClaudeModel(tier, m.groupValues[1].toInt(), m.groupValues[2].toIntOrNull() ?: 0)
        }
        return null
    }

    /** Heuristic Claude capabilities, used when the Models API omits `capabilities`. */
    fun claudeCaps(id: String): ModelCaps {
        val c = parseClaude(id) ?: return ModelCaps(vision = true, pdf = true, webSearch = true, sampling = true)
        val reasoning = when {
            c.adaptive -> {
                val levels = c.effortLevels
                ReasoningSupport(
                    kind = ReasoningKind.EFFORT,
                    efforts = (if (c.thinkingOff != ThinkingOff.CANNOT) listOf(Effort.NONE) else emptyList()) +
                        levels.ifEmpty { listOf(Effort.HIGH) },
                    defaultEffort = if (c.thinkingOnByDefault) c.defaultEffort else Effort.NONE,
                    summaries = true,
                )
            }
            c.budgetThinking -> ReasoningSupport(ReasoningKind.BUDGET, BUDGET_LEVELS, Effort.NONE, summaries = true)
            else -> ReasoningSupport()
        }
        return ModelCaps(
            vision = c.major >= 3,
            pdf = c.major >= 3,
            reasoning = reasoning,
            webSearch = true,
            sampling = c.sampling,
            fastMode = c.fastMode,
            refusalFallback = c.refusalFallback,
        )
    }

    /** Merges Anthropic Models API `capabilities` with family knowledge. */
    internal fun claudeCapsFromApi(
        id: String,
        imageInput: Boolean?,
        adaptive: Boolean?,
        enabled: Boolean?,
        effortLevels: List<Effort>?,
    ): ModelCaps {
        val base = claudeCaps(id)
        val c = parseClaude(id)
        val canOff = c?.thinkingOff?.let { it != ThinkingOff.CANNOT } ?: true
        val reasoning = when {
            adaptive == true -> {
                val levels = (effortLevels ?: c?.effortLevels).orEmpty().ifEmpty { listOf(Effort.HIGH) }
                ReasoningSupport(
                    kind = ReasoningKind.EFFORT,
                    efforts = (if (canOff) listOf(Effort.NONE) else emptyList()) + levels,
                    defaultEffort = if (c?.thinkingOnByDefault == true) c.defaultEffort.takeIf { it in levels } ?: levels.last() else Effort.NONE,
                    summaries = true,
                )
            }
            enabled == true -> ReasoningSupport(ReasoningKind.BUDGET, BUDGET_LEVELS, Effort.NONE, summaries = true)
            adaptive == false && enabled == false -> ReasoningSupport()
            else -> base.reasoning
        }
        return base.copy(
            vision = imageInput ?: base.vision,
            pdf = imageInput ?: base.pdf,
            reasoning = reasoning,
        )
    }

    // ---------------------------------------------------------------- OpenAI

    private val dateSuffix = Regex("""-(\d{4}-\d{2}-\d{2}|\d{8})$""")
    private val openAiExclude = listOf(
        "embedding", "tts", "whisper", "transcribe", "dall-e", "gpt-image", "image", "moderation",
        "realtime", "audio", "search-preview", "search-api", "computer-use", "babbage", "davinci",
        "instruct", "sora", "deep-research", "codex-mini-latest", "omni",
    )

    fun isOpenAiChatModel(id: String): Boolean {
        val s = id.lowercase(Locale.ROOT)
        if (openAiExclude.any { it in s }) return false
        if (s.startsWith("ft:")) return true
        return s.startsWith("gpt-") || s.startsWith("chatgpt-") || Regex("""^o\d""").containsMatchIn(s)
    }

    /** Drops dated snapshots when the undated alias is also listed. */
    fun hideDatedDuplicates(ids: Collection<String>): Set<String> {
        val set = ids.toSet()
        return set.filter { id ->
            val m = dateSuffix.find(id) ?: return@filter true
            id.removeRange(m.range) !in set
        }.toSet()
    }

    private data class OaVersion(val major: Int, val minor: Int) {
        fun atLeast(maj: Int, min: Int = 0) = major > maj || (major == maj && minor >= min)
    }

    private fun gptVersion(s: String): OaVersion? {
        val m = Regex("""^gpt-(\d+)(?:\.(\d+))?""").find(s) ?: return null
        return OaVersion(m.groupValues[1].toInt(), m.groupValues[2].toIntOrNull() ?: 0)
    }

    fun openAiCaps(id: String): ModelCaps {
        val s = id.lowercase(Locale.ROOT).removePrefix("openai/")
        val oSeries = Regex("""^o(\d+)""").find(s)
        if (oSeries != null) {
            val miniOld = s.startsWith("o1-mini") || s.startsWith("o3-mini")
            val pro = "-pro" in s
            return ModelCaps(
                vision = !miniOld,
                pdf = !miniOld,
                reasoning = ReasoningSupport(
                    ReasoningKind.EFFORT,
                    if (pro) listOf(Effort.HIGH) else listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH),
                    if (pro) Effort.HIGH else Effort.MEDIUM,
                    summaries = !s.startsWith("o1"),
                ),
                webSearch = s.startsWith("o3") || s.startsWith("o4"),
                sampling = false,
            )
        }
        val v = gptVersion(s)
        if (v != null && v.major >= 5 && "chat" !in s) {
            val pro = Regex("""-pro\b""").containsMatchIn(s)
            val codex = "codex" in s
            val efforts: List<Effort>
            var default: Effort? = Effort.MEDIUM
            when {
                v.atLeast(5, 6) || v.major >= 6 -> {
                    efforts = when {
                        "astra" in s -> listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.XHIGH, Effort.MAX)
                        v.atLeast(6, 1) && "sol" in s -> listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.XHIGH, Effort.MAX)
                        pro -> listOf(Effort.MEDIUM, Effort.HIGH, Effort.XHIGH, Effort.MAX)
                        else -> listOf(Effort.NONE, Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.XHIGH, Effort.MAX)
                    }
                    if (pro) default = Effort.HIGH
                }
                v.atLeast(5, 2) -> {
                    efforts = if (pro) listOf(Effort.MEDIUM, Effort.HIGH, Effort.XHIGH)
                    else listOf(Effort.NONE, Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.XHIGH)
                    default = if (pro) Effort.HIGH else if (v.atLeast(5, 5)) Effort.MEDIUM else null
                }
                v.atLeast(5, 1) -> {
                    efforts = when {
                        "codex-max" in s -> listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.XHIGH)
                        codex -> listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH)
                        pro -> listOf(Effort.HIGH)
                        else -> listOf(Effort.NONE, Effort.LOW, Effort.MEDIUM, Effort.HIGH)
                    }
                    default = if (codex) Effort.MEDIUM else if (pro) Effort.HIGH else Effort.NONE
                }
                else -> {
                    efforts = when {
                        pro -> listOf(Effort.HIGH)
                        codex -> listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH)
                        else -> listOf(Effort.MINIMAL, Effort.LOW, Effort.MEDIUM, Effort.HIGH)
                    }
                    if (pro) default = Effort.HIGH
                }
            }
            return ModelCaps(
                vision = true,
                pdf = true,
                reasoning = ReasoningSupport(ReasoningKind.EFFORT, efforts, default, summaries = true),
                webSearch = !("nano" in s && !v.atLeast(5, 1)),
                sampling = false,
                verbosity = !codex,
                proMode = (v.atLeast(5, 6) || v.major >= 6) && !pro,
            )
        }
        // Non-reasoning chat models (gpt-4o, gpt-4.1, gpt-5-chat, chatgpt-4o, gpt-4-turbo, gpt-3.5…).
        val vision = "gpt-4o" in s || "gpt-4.1" in s || "4-turbo" in s || "chatgpt" in s ||
            "vision" in s || (v != null && v.major >= 5)
        val webSearch = ("gpt-4o" in s || "gpt-4.1" in s || (v != null && v.major >= 5)) && "nano" !in s
        return ModelCaps(vision = vision, pdf = vision, webSearch = webSearch, sampling = true)
    }

    // ---------------------------------------------------------------- OpenAI-compatible

    private val compatExclude = listOf(
        "embed", "tts", "whisper", "transcribe", "dall-e", "imagen", "flux", "stable-diffusion", "sdxl",
        "moderation", "rerank", "guard", "audio", "speech", "-image", "image-", "veo", "lyria", "aqa",
        "bge-", "e5-", "nomic", "playai", "orpheus", "distil-whisper",
    )

    fun isCompatChatModel(id: String): Boolean {
        val s = id.lowercase(Locale.ROOT)
        return compatExclude.none { it in s }
    }

    private val visionHints = listOf(
        "vision", "-vl", "vl-", "pixtral", "llava", "llama-4", "llama4", "scout", "maverick", "gemma-3", "gemma3",
        "gemini", "gpt-4o", "gpt-4.1", "gpt-5", "claude", "grok-4", "grok-2-vision", "qwen2.5-vl", "qwen3-vl",
        "mistral-medium", "mistral-small-3", "minicpm-v", "moondream", "internvl", "glm-4.5v", "kimi-vl",
    )

    fun looksVision(id: String): Boolean {
        val s = id.lowercase(Locale.ROOT)
        return visionHints.any { it in s }
    }

    private val reasoningHints = listOf(
        "reason", "think", "-r1", "r1-", "qwq", "gpt-oss", "qwen3", "magistral", "deepseek-v3.1", "deepseek-v3.2",
        "sonar-reasoning", "kimi-k2-thinking", "glm-4.5", "glm-4.6", "phi-4-reasoning", "o1", "o3", "o4",
    )

    /** Capabilities for an OpenAI-compatible provider model without live metadata. */
    fun compatCaps(kind: ProviderKind, id: String): ModelCaps {
        val s = id.lowercase(Locale.ROOT).removePrefix("models/")
        val textOnly = ModelCaps(vision = looksVision(s), pdf = false, sampling = true)
        val showsReasoning = reasoningHints.any { it in s } && "non-reasoning" !in s
        return when (kind) {
            ProviderKind.GOOGLE -> {
                val gem3 = Regex("""gemini-(\d+)""").find(s)?.groupValues?.get(1)?.toIntOrNull()?.let { it >= 3 } == true
                val thinks = gem3 || "gemini-2.5" in s
                val efforts = when {
                    !thinks -> emptyList()
                    "pro" in s -> listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH)
                    else -> listOf(Effort.NONE, Effort.LOW, Effort.MEDIUM, Effort.HIGH)
                }
                ModelCaps(
                    vision = "gemma" !in s || looksVision(s),
                    pdf = false,
                    reasoning = if (thinks) ReasoningSupport(ReasoningKind.EFFORT, efforts, null, summaries = true) else ReasoningSupport(),
                    sampling = true,
                )
            }
            ProviderKind.DEEPSEEK -> {
                val reasoner = "reasoner" in s || "r1" in s
                ModelCaps(
                    reasoning = ReasoningSupport(summaries = reasoner),
                    sampling = !reasoner,
                )
            }
            ProviderKind.XAI -> {
                val mini3 = "grok-3-mini" in s
                ModelCaps(
                    vision = looksVision(s) || ("grok-4" in s),
                    reasoning = when {
                        mini3 -> ReasoningSupport(ReasoningKind.EFFORT, listOf(Effort.LOW, Effort.HIGH), Effort.LOW, summaries = true)
                        else -> ReasoningSupport()
                    },
                    sampling = true,
                )
            }
            ProviderKind.PERPLEXITY -> ModelCaps(
                reasoning = ReasoningSupport(summaries = "reasoning" in s || "deep-research" in s),
                sampling = true,
            )
            else -> {
                val gptOss = "gpt-oss" in s
                when {
                    gptOss -> textOnly.copy(
                        reasoning = ReasoningSupport(ReasoningKind.EFFORT, listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH), Effort.MEDIUM, summaries = true),
                    )
                    showsReasoning -> textOnly.copy(reasoning = ReasoningSupport(summaries = true))
                    else -> textOnly
                }
            }
        }
    }

    fun perplexityModels(): List<ModelInfo> = listOf(
        "sonar" to "Sonar",
        "sonar-pro" to "Sonar Pro",
        "sonar-reasoning" to "Sonar Reasoning",
        "sonar-reasoning-pro" to "Sonar Reasoning Pro",
        "sonar-deep-research" to "Sonar Deep Research",
    ).map { (id, name) ->
        ModelInfo(id, name, contextWindow = 128_000, caps = compatCaps(ProviderKind.PERPLEXITY, id))
    }

    // ---------------------------------------------------------------- Display names

    private val wordMap = mapOf(
        "gpt" to "GPT", "oss" to "OSS", "llama" to "Llama", "qwen" to "Qwen", "deepseek" to "DeepSeek",
        "grok" to "Grok", "gemini" to "Gemini", "gemma" to "Gemma", "mistral" to "Mistral", "mixtral" to "Mixtral",
        "claude" to "Claude", "sonar" to "Sonar", "kimi" to "Kimi", "glm" to "GLM", "phi" to "Phi", "it" to "IT",
        "vl" to "VL", "r1" to "R1", "qwq" to "QwQ", "ai" to "AI", "api" to "API", "pixtral" to "Pixtral",
        "codestral" to "Codestral", "magistral" to "Magistral", "devstral" to "Devstral", "ministral" to "Ministral",
        "nemotron" to "Nemotron", "hermes" to "Hermes", "instruct" to "Instruct",
    )

    fun displayName(kind: ProviderKind, id: String): String {
        val raw = id.removePrefix("models/")
        if (kind == ProviderKind.OPENAI || raw.startsWith("gpt-") || raw.startsWith("chatgpt-")) {
            openAiDisplayName(raw)?.let { return it }
        }
        val base = raw.substringAfterLast('/')
        return base.split('-', '_', ' ').filter { it.isNotEmpty() }.joinToString(" ") { w ->
            val lw = w.lowercase(Locale.ROOT)
            wordMap[lw] ?: when {
                Regex("""^\d+(\.\d+)?[bmk]$""").matches(lw) -> lw.uppercase(Locale.ROOT)
                Regex("""^[a-z]\d""").matches(lw) && lw.length <= 4 -> lw.uppercase(Locale.ROOT)
                lw.first().isDigit() -> lw
                else -> lw.replaceFirstChar { it.titlecase(Locale.ROOT) }
            }
        }
    }

    private fun openAiDisplayName(id: String): String? {
        val s = id.lowercase(Locale.ROOT)
        if (Regex("""^o\d""").containsMatchIn(s)) return s
        val chatgpt = s.startsWith("chatgpt-")
        val rest = s.removePrefix("chatgpt-").removePrefix("gpt-")
        if (rest == s) return null
        val tokens = rest.split('-')
        val version = tokens.first()
        if (version.firstOrNull()?.isDigit() != true) return null
        val tail = tokens.drop(1).joinToString(" ") { t ->
            when (t) {
                "mini", "nano", "latest", "preview" -> t
                "oss" -> "OSS"
                else -> if (t.firstOrNull()?.isDigit() == true) t else t.replaceFirstChar { it.titlecase(Locale.ROOT) }
            }
        }
        val head = (if (chatgpt) "ChatGPT-" else "GPT-") + version
        return if (tail.isEmpty()) head else "$head $tail"
    }

    /** Strips date stamps / aliases so ids compare across providers. */
    fun normalizeId(id: String): String {
        var s = id.lowercase(Locale.ROOT).substringAfterLast('/').substringBefore(':')
        s = s.replace(dateSuffix, "").removeSuffix("-latest")
        return s.replace('.', '-')
    }
}
