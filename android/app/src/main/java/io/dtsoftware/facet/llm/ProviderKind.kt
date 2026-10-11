package io.dtsoftware.facet.llm

import androidx.annotation.StringRes
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings

/**
 * Provider presets. [id] is persisted; never rename it.
 * Any OpenAI-compatible service works through [CUSTOM].
 */
enum class ProviderKind(
    val id: String,
    /** Brand name; [CUSTOM] shows a translated name instead (see [displayName]). */
    private val brandName: String,
    val style: ApiStyle,
    val defaultBaseUrl: String,
    /** Where users create a key. */
    val keyUrl: String?,
    /** What the provider's keys look like (e.g. "sk-…"). The UI shows its own words for providers that need no key. */
    val keyHint: String,
    val requiresKey: Boolean = true,
    /** Short description shown in the provider picker. */
    @StringRes val blurbRes: Int,
) {
    OPENAI(
        "openai", "OpenAI", ApiStyle.OPENAI_RESPONSES, "https://api.openai.com/v1",
        "https://platform.openai.com/api-keys", "sk-…", blurbRes = R.string.catalog_blurb_openai,
    ),
    ANTHROPIC(
        "anthropic", "Anthropic", ApiStyle.ANTHROPIC, "https://api.anthropic.com",
        "https://console.anthropic.com/settings/keys", "sk-ant-…", blurbRes = R.string.catalog_blurb_anthropic,
    ),
    GOOGLE(
        "google", "Google Gemini", ApiStyle.OPENAI_CHAT, "https://generativelanguage.googleapis.com/v1beta/openai",
        "https://aistudio.google.com/apikey", "AIza…", blurbRes = R.string.catalog_blurb_google,
    ),
    OPENROUTER(
        "openrouter", "OpenRouter", ApiStyle.OPENAI_CHAT, "https://openrouter.ai/api/v1",
        "https://openrouter.ai/keys", "sk-or-…", blurbRes = R.string.catalog_blurb_openrouter,
    ),
    XAI(
        "xai", "xAI", ApiStyle.OPENAI_CHAT, "https://api.x.ai/v1",
        "https://console.x.ai", "xai-…", blurbRes = R.string.catalog_blurb_xai,
    ),
    DEEPSEEK(
        "deepseek", "DeepSeek", ApiStyle.OPENAI_CHAT, "https://api.deepseek.com/v1",
        "https://platform.deepseek.com/api_keys", "sk-…", blurbRes = R.string.catalog_blurb_deepseek,
    ),
    MISTRAL(
        "mistral", "Mistral", ApiStyle.OPENAI_CHAT, "https://api.mistral.ai/v1",
        "https://console.mistral.ai/api-keys", "…", blurbRes = R.string.catalog_blurb_mistral,
    ),
    GROQ(
        "groq", "Groq", ApiStyle.OPENAI_CHAT, "https://api.groq.com/openai/v1",
        "https://console.groq.com/keys", "gsk_…", blurbRes = R.string.catalog_blurb_fast_open,
    ),
    CEREBRAS(
        "cerebras", "Cerebras", ApiStyle.OPENAI_CHAT, "https://api.cerebras.ai/v1",
        "https://cloud.cerebras.ai", "csk-…", blurbRes = R.string.catalog_blurb_fast_open,
    ),
    TOGETHER(
        "together", "Together AI", ApiStyle.OPENAI_CHAT, "https://api.together.xyz/v1",
        "https://api.together.ai/settings/api-keys", "…", blurbRes = R.string.catalog_blurb_open_at_scale,
    ),
    FIREWORKS(
        "fireworks", "Fireworks", ApiStyle.OPENAI_CHAT, "https://api.fireworks.ai/inference/v1",
        "https://fireworks.ai/account/api-keys", "fw_…", blurbRes = R.string.catalog_blurb_open_at_scale,
    ),
    PERPLEXITY(
        "perplexity", "Perplexity", ApiStyle.OPENAI_CHAT, "https://api.perplexity.ai",
        "https://www.perplexity.ai/settings/api", "pplx-…", blurbRes = R.string.catalog_blurb_perplexity,
    ),
    HUGGINGFACE(
        "huggingface", "Hugging Face", ApiStyle.OPENAI_CHAT, "https://router.huggingface.co/v1",
        "https://huggingface.co/settings/tokens", "hf_…", blurbRes = R.string.catalog_blurb_huggingface,
    ),
    MOONSHOT(
        "moonshot", "Moonshot AI", ApiStyle.OPENAI_CHAT, "https://api.moonshot.ai/v1",
        "https://platform.moonshot.ai/console/api-keys", "sk-…", blurbRes = R.string.catalog_blurb_moonshot,
    ),
    ZAI(
        "zai", "Z.ai", ApiStyle.OPENAI_CHAT, "https://api.z.ai/api/paas/v4",
        "https://z.ai/manage-apikey/apikey-list", "…", blurbRes = R.string.catalog_blurb_zai,
    ),
    QWEN(
        "qwen", "Alibaba Qwen", ApiStyle.OPENAI_CHAT, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "https://modelstudio.console.alibabacloud.com/", "sk-…", blurbRes = R.string.catalog_blurb_qwen,
    ),
    MINIMAX(
        "minimax", "MiniMax", ApiStyle.OPENAI_CHAT, "https://api.minimax.io/v1",
        "https://www.minimax.io/platform/user-center/basic-information/interface-key", "…", blurbRes = R.string.catalog_blurb_minimax,
    ),
    COHERE(
        "cohere", "Cohere", ApiStyle.OPENAI_CHAT, "https://api.cohere.ai/compatibility/v1",
        "https://dashboard.cohere.com/api-keys", "…", blurbRes = R.string.catalog_blurb_cohere,
    ),
    NVIDIA(
        "nvidia", "NVIDIA NIM", ApiStyle.OPENAI_CHAT, "https://integrate.api.nvidia.com/v1",
        "https://build.nvidia.com/settings/api-keys", "nvapi-…", blurbRes = R.string.catalog_blurb_nvidia,
    ),
    DEEPINFRA(
        "deepinfra", "DeepInfra", ApiStyle.OPENAI_CHAT, "https://api.deepinfra.com/v1/openai",
        "https://deepinfra.com/dash/api_keys", "…", blurbRes = R.string.catalog_blurb_deepinfra,
    ),
    NEBIUS(
        "nebius", "Nebius AI Studio", ApiStyle.OPENAI_CHAT, "https://api.studio.nebius.com/v1",
        "https://studio.nebius.com/settings/api-keys", "…", blurbRes = R.string.catalog_blurb_nebius,
    ),
    SAMBANOVA(
        "sambanova", "SambaNova", ApiStyle.OPENAI_CHAT, "https://api.sambanova.ai/v1",
        "https://cloud.sambanova.ai/apis", "…", blurbRes = R.string.catalog_blurb_fast_open,
    ),
    HYPERBOLIC(
        "hyperbolic", "Hyperbolic", ApiStyle.OPENAI_CHAT, "https://api.hyperbolic.xyz/v1",
        "https://app.hyperbolic.xyz/settings", "…", blurbRes = R.string.catalog_blurb_open_low_cost,
    ),
    NOVITA(
        "novita", "Novita AI", ApiStyle.OPENAI_CHAT, "https://api.novita.ai/v3/openai",
        "https://novita.ai/settings/key-management", "sk_…", blurbRes = R.string.catalog_blurb_open_low_cost,
    ),
    VENICE(
        "venice", "Venice", ApiStyle.OPENAI_CHAT, "https://api.venice.ai/api/v1",
        "https://venice.ai/settings/api", "…", blurbRes = R.string.catalog_blurb_venice,
    ),
    VERCEL(
        "vercel", "Vercel AI Gateway", ApiStyle.OPENAI_CHAT, "https://ai-gateway.vercel.sh/v1",
        "https://vercel.com/dashboard", "…", blurbRes = R.string.catalog_blurb_vercel,
    ),
    INCEPTION(
        "inception", "Inception", ApiStyle.OPENAI_CHAT, "https://api.inceptionlabs.ai/v1",
        "https://platform.inceptionlabs.ai", "…", blurbRes = R.string.catalog_blurb_inception,
    ),
    ELEVENLABS(
        "elevenlabs", "ElevenLabs", ApiStyle.MEDIA, "https://api.elevenlabs.io",
        "https://elevenlabs.io/app/settings/api-keys", "sk_…", blurbRes = R.string.catalog_blurb_elevenlabs,
    ),
    STABILITY(
        "stability", "Stability AI", ApiStyle.MEDIA, "https://api.stability.ai",
        "https://platform.stability.ai/account/keys", "sk-…", blurbRes = R.string.catalog_blurb_stability,
    ),
    BFL(
        "bfl", "Black Forest Labs", ApiStyle.MEDIA, "https://api.bfl.ai",
        "https://dashboard.bfl.ai", "…", blurbRes = R.string.catalog_blurb_bfl,
    ),
    DEEPGRAM(
        "deepgram", "Deepgram", ApiStyle.MEDIA, "https://api.deepgram.com",
        "https://console.deepgram.com", "…", blurbRes = R.string.catalog_blurb_deepgram,
    ),
    OLLAMA(
        "ollama", "Ollama", ApiStyle.OPENAI_CHAT, "http://192.168.1.2:11434/v1",
        "https://ollama.com", "Not needed", requiresKey = false, blurbRes = R.string.catalog_blurb_local,
    ),
    LMSTUDIO(
        "lmstudio", "LM Studio", ApiStyle.OPENAI_CHAT, "http://192.168.1.2:1234/v1",
        "https://lmstudio.ai", "Not needed", requiresKey = false, blurbRes = R.string.catalog_blurb_local,
    ),
    CUSTOM(
        "custom", "Custom endpoint", ApiStyle.OPENAI_CHAT, "https://",
        null, "Optional", requiresKey = false, blurbRes = R.string.catalog_blurb_custom,
    );

    /** Name shown in the UI: the brand name, or "Custom endpoint" in the app's language. */
    val displayName: String
        get() = if (this == CUSTOM) Strings.get(R.string.catalog_custom_endpoint) else brandName

    /** Short description shown in the provider picker, in the app's language. */
    val blurb: String get() = Strings.get(blurbRes)

    companion object {
        fun fromId(id: String): ProviderKind = entries.firstOrNull { it.id == id } ?: CUSTOM
    }
}
