package io.dtsoftware.facet.llm

import io.dtsoftware.facet.llm.anthropic.AnthropicClient
import io.dtsoftware.facet.llm.media.MediaProviderClient
import io.dtsoftware.facet.llm.openai.OpenAiChatClient
import io.dtsoftware.facet.llm.openai.OpenAiResponsesClient
import okhttp3.OkHttpClient

/** Entry point for provider adapters. */
object LlmClients {
    /**
     * Creates the adapter for [config]'s wire protocol. [http] is shared (connection pool);
     * adapters derive a long-read-timeout client for streaming. [quirks] persists parameters a
     * model rejected; [pricing] (optional) fills [ModelInfo.pricing] in [LlmClient.listModels].
     */
    fun create(
        config: ProviderConfig,
        http: OkHttpClient,
        quirks: QuirkStore,
        pricing: PricingCatalog? = null,
    ): LlmClient = when (config.kind.style) {
        ApiStyle.ANTHROPIC -> AnthropicClient(config, http, quirks, pricing)
        ApiStyle.OPENAI_RESPONSES -> OpenAiResponsesClient(config, http, quirks, pricing)
        ApiStyle.OPENAI_CHAT -> OpenAiChatClient(config, http, quirks, pricing)
        ApiStyle.MEDIA -> MediaProviderClient(config, http)
    }
}
