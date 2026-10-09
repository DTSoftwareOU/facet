package io.dtsoftware.facet.llm

/**
 * Provider presets. [id] is persisted; never rename it.
 * Any OpenAI-compatible service works through [CUSTOM].
 */
enum class ProviderKind(
    val id: String,
    val displayName: String,
    val style: ApiStyle,
    val defaultBaseUrl: String,
    /** Where users create a key. */
    val keyUrl: String?,
    val keyHint: String,
    val requiresKey: Boolean = true,
    /** Short description shown in the provider picker. */
    val blurb: String,
) {
    OPENAI(
        "openai", "OpenAI", ApiStyle.OPENAI_RESPONSES, "https://api.openai.com/v1",
        "https://platform.openai.com/api-keys", "sk-…", blurb = "GPT and o-series models",
    ),
    ANTHROPIC(
        "anthropic", "Anthropic", ApiStyle.ANTHROPIC, "https://api.anthropic.com",
        "https://console.anthropic.com/settings/keys", "sk-ant-…", blurb = "Claude models",
    ),
    GOOGLE(
        "google", "Google Gemini", ApiStyle.OPENAI_CHAT, "https://generativelanguage.googleapis.com/v1beta/openai",
        "https://aistudio.google.com/apikey", "AIza…", blurb = "Gemini models",
    ),
    OPENROUTER(
        "openrouter", "OpenRouter", ApiStyle.OPENAI_CHAT, "https://openrouter.ai/api/v1",
        "https://openrouter.ai/keys", "sk-or-…", blurb = "Hundreds of models with one key",
    ),
    XAI(
        "xai", "xAI", ApiStyle.OPENAI_CHAT, "https://api.x.ai/v1",
        "https://console.x.ai", "xai-…", blurb = "Grok models",
    ),
    DEEPSEEK(
        "deepseek", "DeepSeek", ApiStyle.OPENAI_CHAT, "https://api.deepseek.com/v1",
        "https://platform.deepseek.com/api_keys", "sk-…", blurb = "DeepSeek chat and reasoner",
    ),
    MISTRAL(
        "mistral", "Mistral", ApiStyle.OPENAI_CHAT, "https://api.mistral.ai/v1",
        "https://console.mistral.ai/api-keys", "…", blurb = "Mistral and Magistral models",
    ),
    GROQ(
        "groq", "Groq", ApiStyle.OPENAI_CHAT, "https://api.groq.com/openai/v1",
        "https://console.groq.com/keys", "gsk_…", blurb = "Very fast open models",
    ),
    CEREBRAS(
        "cerebras", "Cerebras", ApiStyle.OPENAI_CHAT, "https://api.cerebras.ai/v1",
        "https://cloud.cerebras.ai", "csk-…", blurb = "Very fast open models",
    ),
    TOGETHER(
        "together", "Together AI", ApiStyle.OPENAI_CHAT, "https://api.together.xyz/v1",
        "https://api.together.ai/settings/api-keys", "…", blurb = "Open models at scale",
    ),
    FIREWORKS(
        "fireworks", "Fireworks", ApiStyle.OPENAI_CHAT, "https://api.fireworks.ai/inference/v1",
        "https://fireworks.ai/account/api-keys", "fw_…", blurb = "Open models at scale",
    ),
    PERPLEXITY(
        "perplexity", "Perplexity", ApiStyle.OPENAI_CHAT, "https://api.perplexity.ai",
        "https://www.perplexity.ai/settings/api", "pplx-…", blurb = "Search-grounded Sonar models",
    ),
    HUGGINGFACE(
        "huggingface", "Hugging Face", ApiStyle.OPENAI_CHAT, "https://router.huggingface.co/v1",
        "https://huggingface.co/settings/tokens", "hf_…", blurb = "Open models from many inference providers",
    ),
    MOONSHOT(
        "moonshot", "Moonshot AI", ApiStyle.OPENAI_CHAT, "https://api.moonshot.ai/v1",
        "https://platform.moonshot.ai/console/api-keys", "sk-…", blurb = "Kimi models",
    ),
    ZAI(
        "zai", "Z.ai", ApiStyle.OPENAI_CHAT, "https://api.z.ai/api/paas/v4",
        "https://z.ai/manage-apikey/apikey-list", "…", blurb = "GLM models",
    ),
    QWEN(
        "qwen", "Alibaba Qwen", ApiStyle.OPENAI_CHAT, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "https://modelstudio.console.alibabacloud.com/", "sk-…", blurb = "Qwen models from Alibaba Cloud",
    ),
    MINIMAX(
        "minimax", "MiniMax", ApiStyle.OPENAI_CHAT, "https://api.minimax.io/v1",
        "https://www.minimax.io/platform/user-center/basic-information/interface-key", "…", blurb = "MiniMax models",
    ),
    COHERE(
        "cohere", "Cohere", ApiStyle.OPENAI_CHAT, "https://api.cohere.ai/compatibility/v1",
        "https://dashboard.cohere.com/api-keys", "…", blurb = "Command models",
    ),
    NVIDIA(
        "nvidia", "NVIDIA NIM", ApiStyle.OPENAI_CHAT, "https://integrate.api.nvidia.com/v1",
        "https://build.nvidia.com/settings/api-keys", "nvapi-…", blurb = "Open models on NVIDIA GPUs",
    ),
    DEEPINFRA(
        "deepinfra", "DeepInfra", ApiStyle.OPENAI_CHAT, "https://api.deepinfra.com/v1/openai",
        "https://deepinfra.com/dash/api_keys", "…", blurb = "Low-cost open models",
    ),
    NEBIUS(
        "nebius", "Nebius AI Studio", ApiStyle.OPENAI_CHAT, "https://api.studio.nebius.com/v1",
        "https://studio.nebius.com/settings/api-keys", "…", blurb = "Open models in the EU",
    ),
    SAMBANOVA(
        "sambanova", "SambaNova", ApiStyle.OPENAI_CHAT, "https://api.sambanova.ai/v1",
        "https://cloud.sambanova.ai/apis", "…", blurb = "Very fast open models",
    ),
    HYPERBOLIC(
        "hyperbolic", "Hyperbolic", ApiStyle.OPENAI_CHAT, "https://api.hyperbolic.xyz/v1",
        "https://app.hyperbolic.xyz/settings", "…", blurb = "Open models at low cost",
    ),
    NOVITA(
        "novita", "Novita AI", ApiStyle.OPENAI_CHAT, "https://api.novita.ai/v3/openai",
        "https://novita.ai/settings/key-management", "sk_…", blurb = "Open models at low cost",
    ),
    VENICE(
        "venice", "Venice", ApiStyle.OPENAI_CHAT, "https://api.venice.ai/api/v1",
        "https://venice.ai/settings/api", "…", blurb = "Private, uncensored open models",
    ),
    VERCEL(
        "vercel", "Vercel AI Gateway", ApiStyle.OPENAI_CHAT, "https://ai-gateway.vercel.sh/v1",
        "https://vercel.com/dashboard", "…", blurb = "Many providers through one key",
    ),
    INCEPTION(
        "inception", "Inception", ApiStyle.OPENAI_CHAT, "https://api.inceptionlabs.ai/v1",
        "https://platform.inceptionlabs.ai", "…", blurb = "Mercury diffusion models",
    ),
    ELEVENLABS(
        "elevenlabs", "ElevenLabs", ApiStyle.MEDIA, "https://api.elevenlabs.io",
        "https://elevenlabs.io/app/settings/api-keys", "sk_…", blurb = "Voices, music, sound effects and transcription",
    ),
    STABILITY(
        "stability", "Stability AI", ApiStyle.MEDIA, "https://api.stability.ai",
        "https://platform.stability.ai/account/keys", "sk-…", blurb = "Stable Image and Stable Audio",
    ),
    BFL(
        "bfl", "Black Forest Labs", ApiStyle.MEDIA, "https://api.bfl.ai",
        "https://dashboard.bfl.ai", "…", blurb = "FLUX image models",
    ),
    DEEPGRAM(
        "deepgram", "Deepgram", ApiStyle.MEDIA, "https://api.deepgram.com",
        "https://console.deepgram.com", "…", blurb = "Transcription and Aura voices",
    ),
    OLLAMA(
        "ollama", "Ollama", ApiStyle.OPENAI_CHAT, "http://192.168.1.2:11434/v1",
        "https://ollama.com", "Not needed", requiresKey = false, blurb = "Models on your own computer",
    ),
    LMSTUDIO(
        "lmstudio", "LM Studio", ApiStyle.OPENAI_CHAT, "http://192.168.1.2:1234/v1",
        "https://lmstudio.ai", "Not needed", requiresKey = false, blurb = "Models on your own computer",
    ),
    CUSTOM(
        "custom", "Custom endpoint", ApiStyle.OPENAI_CHAT, "https://",
        null, "Optional", requiresKey = false, blurb = "Any OpenAI-compatible API",
    );

    companion object {
        fun fromId(id: String): ProviderKind = entries.firstOrNull { it.id == id } ?: CUSTOM
    }
}
