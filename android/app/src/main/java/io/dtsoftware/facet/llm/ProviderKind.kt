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
