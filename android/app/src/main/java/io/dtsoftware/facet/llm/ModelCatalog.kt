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
                // The first o1 previews shipped without function calling.
                tools = !(s.startsWith("o1-mini") || s.startsWith("o1-preview")),
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
        // ChatGPT snapshot aliases don't support function calling.
        return ModelCaps(vision = vision, pdf = vision, webSearch = webSearch, sampling = true, tools = !s.startsWith("chatgpt-"))
    }

    // ---------------------------------------------------------------- OpenAI-compatible

    private val compatExclude = listOf(
        "embed", "tts", "whisper", "transcribe", "dall-e", "imagen", "flux", "stable-diffusion", "sdxl",
        "moderation", "rerank", "guard", "audio", "speech", "-image", "image-", "veo", "lyria", "aqa",
        "bge-", "e5-", "nomic", "playai", "orpheus", "distil-whisper", "ocr", "realtime", "shield",
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
                    tools = "gemma" !in s,
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
                tools = false,
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

    // ---------------------------------------------------------------- Media models

    private val notMedia = listOf("embed", "rerank", "moderation", "guard", "realtime", "native-audio", "-live", "live-", "search")

    /** What a non-chat model produces, judged from its id; null when it isn't a media model Facet can run. */
    fun mediaOutput(kind: ProviderKind, id: String): ModelOutput? {
        val s = id.lowercase(Locale.ROOT).removePrefix("models/")
        if (notMedia.any { it in s }) return null
        return when {
            // Mistral: Voxtral Mini is the transcription model; Voxtral Small is chat with audio input.
            kind == ProviderKind.MISTRAL && s.startsWith("voxtral-mini") && "tts" !in s -> ModelOutput.TRANSCRIPTION
            "transcribe" in s || "whisper" in s || s.startsWith("scribe") || s.startsWith("nova-") -> ModelOutput.TRANSCRIPTION
            "tts" in s || s.startsWith("aura") || s.startsWith("eleven_") -> ModelOutput.SPEECH
            "lyria" in s || s.startsWith("music_") || "stable-audio" in s || s == "sound_effects" -> ModelOutput.MUSIC
            "veo-" in s || (kind == ProviderKind.GOOGLE && "omni" in s) || "-video" in s || "video-" in s -> ModelOutput.VIDEO
            "image" in s || "dall-e" in s || "imagen" in s || "nano-banana" in s || "flux" in s || "stable-diffusion" in s ||
                "sdxl" in s || s.startsWith("sd3") || "seedream" in s || "ideogram" in s || "recraft" in s || "hidream" in s -> ModelOutput.IMAGE
            else -> null
        }
    }

    /** Whether Facet can run [output] models from [kind] (see MediaGen for the APIs behind each pair). */
    fun canRun(kind: ProviderKind, output: ModelOutput): Boolean = when (output) {
        ModelOutput.TEXT -> kind.style != ApiStyle.MEDIA
        ModelOutput.IMAGE -> kind in setOf(
            ProviderKind.OPENAI, ProviderKind.GOOGLE, ProviderKind.OPENROUTER, ProviderKind.XAI, ProviderKind.TOGETHER,
            ProviderKind.DEEPINFRA, ProviderKind.NEBIUS, ProviderKind.STABILITY, ProviderKind.BFL, ProviderKind.CUSTOM,
        )
        ModelOutput.VIDEO -> kind == ProviderKind.GOOGLE
        ModelOutput.SPEECH -> kind in setOf(ProviderKind.OPENAI, ProviderKind.GOOGLE, ProviderKind.MISTRAL, ProviderKind.ELEVENLABS, ProviderKind.DEEPGRAM, ProviderKind.CUSTOM)
        ModelOutput.MUSIC -> kind in setOf(ProviderKind.GOOGLE, ProviderKind.ELEVENLABS, ProviderKind.STABILITY)
        ModelOutput.TRANSCRIPTION -> kind in setOf(
            ProviderKind.OPENAI, ProviderKind.MISTRAL, ProviderKind.GROQ, ProviderKind.TOGETHER, ProviderKind.DEEPINFRA,
            ProviderKind.ELEVENLABS, ProviderKind.DEEPGRAM, ProviderKind.CUSTOM,
        )
    }

    /** Built-in lists for providers that make only media (their APIs don't list models, or list only some). */
    fun mediaProviderModels(kind: ProviderKind): List<ModelInfo> {
        fun m(id: String, name: String, out: ModelOutput) = ModelInfo(id, name, output = out)
        return when (kind) {
            ProviderKind.ELEVENLABS -> listOf(
                m("eleven_v3", "Eleven v3", ModelOutput.SPEECH),
                m("eleven_multilingual_v2", "Eleven Multilingual v2", ModelOutput.SPEECH),
                m("eleven_flash_v2_5", "Eleven Flash v2.5", ModelOutput.SPEECH),
                m("music_v2_5", "Eleven Music v2.5", ModelOutput.MUSIC),
                m("music_v1", "Eleven Music", ModelOutput.MUSIC),
                m("sound_effects", "Sound effects", ModelOutput.MUSIC),
                m("scribe_v2", "Scribe v2", ModelOutput.TRANSCRIPTION),
            )
            ProviderKind.STABILITY -> listOf(
                m("stable-image-ultra", "Stable Image Ultra", ModelOutput.IMAGE),
                m("stable-image-core", "Stable Image Core", ModelOutput.IMAGE),
                m("sd3.5-large", "Stable Diffusion 3.5 Large", ModelOutput.IMAGE),
                m("sd3.5-large-turbo", "Stable Diffusion 3.5 Large Turbo", ModelOutput.IMAGE),
                m("sd3.5-medium", "Stable Diffusion 3.5 Medium", ModelOutput.IMAGE),
                m("stable-audio-2.5", "Stable Audio 2.5", ModelOutput.MUSIC),
            )
            ProviderKind.BFL -> listOf(
                m("flux-2-max", "FLUX.2 [max]", ModelOutput.IMAGE),
                m("flux-2-pro", "FLUX.2 [pro]", ModelOutput.IMAGE),
                m("flux-2-flex", "FLUX.2 [flex]", ModelOutput.IMAGE),
                m("flux-kontext-max", "FLUX.1 Kontext [max]", ModelOutput.IMAGE),
                m("flux-kontext-pro", "FLUX.1 Kontext [pro]", ModelOutput.IMAGE),
                m("flux-pro-1.1-ultra", "FLUX1.1 [pro] Ultra", ModelOutput.IMAGE),
            )
            ProviderKind.DEEPGRAM -> listOf(
                m("nova-3", "Nova-3", ModelOutput.TRANSCRIPTION),
                m("nova-2", "Nova-2", ModelOutput.TRANSCRIPTION),
                m("aura-2", "Aura-2", ModelOutput.SPEECH),
            )
            else -> emptyList()
        }
    }

    /** Current Gemini media models, used when the model list doesn't include any of a kind. */
    val geminiMediaDefaults = listOf(
        ModelInfo("gemini-nano-banana-2.1", "Nano Banana 2.1", output = ModelOutput.IMAGE),
        ModelInfo("gemini-omni-1.1-flash", "Gemini Omni 1.1 Flash", output = ModelOutput.VIDEO),
        ModelInfo("gemini-3.8-flash-tts", "Gemini 3.8 Flash TTS", output = ModelOutput.SPEECH),
        ModelInfo("lyria-3.5", "Lyria 3.5", output = ModelOutput.MUSIC),
    )

    private val mediaNames = mapOf(
        "gpt-image-1" to "GPT Image 1", "gpt-image-1-mini" to "GPT Image 1 mini", "dall-e-3" to "DALL·E 3", "dall-e-2" to "DALL·E 2",
        "tts-1" to "TTS 1", "tts-1-hd" to "TTS 1 HD", "gpt-4o-mini-tts" to "GPT-4o mini TTS", "whisper-1" to "Whisper",
        "gpt-4o-transcribe" to "GPT-4o Transcribe", "gpt-4o-mini-transcribe" to "GPT-4o mini Transcribe",
    )

    /** Picks the most capable media model of [output] from [models] when the user hasn't chosen one. */
    fun preferredMedia(output: ModelOutput, models: List<ModelInfo>): ModelInfo? {
        val ranking = when (output) {
            ModelOutput.IMAGE -> listOf("nano-banana", "gpt-image", "flux-2-pro", "stable-image-ultra", "grok", "flux", "image")
            ModelOutput.VIDEO -> listOf("omni", "veo-3.1-generate", "veo")
            ModelOutput.SPEECH -> listOf("gpt-4o-mini-tts", "eleven_multilingual", "eleven", "flash-tts", "tts", "aura")
            ModelOutput.MUSIC -> listOf("music_v2", "music", "lyria", "stable-audio", "sound")
            ModelOutput.TRANSCRIPTION -> listOf("gpt-4o-transcribe", "scribe", "nova-3", "voxtral", "whisper-large-v3-turbo", "transcribe", "whisper")
            ModelOutput.TEXT -> emptyList()
        }
        val ofKind = models.filter { it.output == output }
        return ranking.firstNotNullOfOrNull { key -> ofKind.firstOrNull { key in it.id.lowercase(Locale.ROOT) } } ?: ofKind.firstOrNull()
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
        mediaNames[raw.lowercase(Locale.ROOT)]?.let { return it }
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
