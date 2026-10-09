package io.dtsoftware.facet.llm

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable

/**
 * Provider-agnostic contract between the chat engine/UI and provider adapters.
 * Adapters live in llm/anthropic, llm/openai; [LlmClients.create] picks one by [ApiStyle].
 */

/** Wire protocol a provider speaks. */
enum class ApiStyle { ANTHROPIC, OPENAI_RESPONSES, OPENAI_CHAT }

/** A configured provider instance (one API key). Secrets are decrypted only in memory. */
data class ProviderConfig(
    val id: String,
    val kind: ProviderKind,
    val label: String,
    val baseUrl: String,
    val apiKey: String,
    val headers: Map<String, String> = emptyMap(),
)

/** Reasoning effort levels across providers. Not every model supports every level. */
@Serializable
enum class Effort(val wire: String, val label: String) {
    NONE("none", "Off"),
    MINIMAL("minimal", "Minimal"),
    LOW("low", "Low"),
    MEDIUM("medium", "Medium"),
    HIGH("high", "High"),
    XHIGH("xhigh", "Extra high"),
    MAX("max", "Max"),
}

@Serializable
enum class Verbosity(val wire: String, val label: String) {
    LOW("low", "Concise"), MEDIUM("medium", "Balanced"), HIGH("high", "Detailed")
}

/** How a model exposes reasoning control. */
@Serializable
enum class ReasoningKind {
    /** No reasoning control. */
    NONE,
    /** Discrete effort levels (OpenAI reasoning.effort, Anthropic output_config.effort, compat reasoning_effort). */
    EFFORT,
    /** Token budget (older Anthropic models: thinking.type=enabled + budget_tokens). Effort levels map to budgets. */
    BUDGET,
}

@Serializable
data class ReasoningSupport(
    val kind: ReasoningKind = ReasoningKind.NONE,
    /** Supported effort levels, ascending. Empty when [kind] is NONE. */
    val efforts: List<Effort> = emptyList(),
    /** Provider default level, if known. */
    val defaultEffort: Effort? = null,
    /** Whether the model streams readable reasoning summaries/thinking text. */
    val summaries: Boolean = false,
)

@Serializable
data class ModelCaps(
    val vision: Boolean = false,
    val pdf: Boolean = false,
    val reasoning: ReasoningSupport = ReasoningSupport(),
    val webSearch: Boolean = false,
    /** Accepts temperature/top_p. */
    val sampling: Boolean = true,
    /** OpenAI text.verbosity. */
    val verbosity: Boolean = false,
    /** OpenAI reasoning.mode = "pro". */
    val proMode: Boolean = false,
    /** Anthropic speed = "fast" (premium pricing). */
    val fastMode: Boolean = false,
    /** Anthropic server-side refusal fallbacks ("fallbacks": "default"). */
    val refusalFallback: Boolean = false,
)

/** USD per 1M tokens. */
@Serializable
data class ModelPricing(
    val input: Double,
    val output: Double,
    val cacheRead: Double? = null,
    val cacheWrite: Double? = null,
)

@Serializable
data class ModelInfo(
    val id: String,
    val displayName: String,
    val contextWindow: Int? = null,
    val maxOutput: Int? = null,
    val caps: ModelCaps = ModelCaps(),
    val pricing: ModelPricing? = null,
    val createdAt: Long? = null,
)

/** Per-conversation generation settings. Null = provider default. */
@Serializable
data class GenParams(
    val effort: Effort? = null,
    val showThinking: Boolean = true,
    val verbosity: Verbosity? = null,
    val proMode: Boolean = false,
    val fastMode: Boolean = false,
    val temperature: Float? = null,
    val topP: Float? = null,
    val maxOutputTokens: Int? = null,
    val webSearch: Boolean = false,
)

enum class Role { USER, ASSISTANT }

sealed interface Part {
    data class Text(val text: String) : Part
    data class Image(val mimeType: String, val bytes: ByteArray) : Part
    /** PDF or other document the provider can read natively. */
    data class Document(val mimeType: String, val name: String, val bytes: ByteArray) : Part
}

/**
 * Raw provider content kept so a turn can be replayed losslessly to the same provider
 * (Anthropic thinking blocks with signatures, OpenAI reasoning items with encrypted content).
 * [json] is a JSON array string: Anthropic `content` blocks or OpenAI Responses `output` items.
 */
@Serializable
data class ProviderBlocks(
    val style: ApiStyle,
    val model: String,
    val json: String,
)

data class ChatMessage(
    val role: Role,
    val parts: List<Part>,
    val blocks: ProviderBlocks? = null,
)

data class ChatRequest(
    val model: String,
    val system: String?,
    val messages: List<ChatMessage>,
    val params: GenParams,
    val caps: ModelCaps,
    /** Used for short utility calls (titles): no thinking, low effort, small output. */
    val utility: Boolean = false,
)

@Serializable
data class Citation(val url: String, val title: String? = null, val snippet: String? = null)

@Serializable
data class Usage(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
    val reasoningTokens: Long = 0,
)

enum class StopReason { END, MAX_TOKENS, REFUSAL, CANCELLED, ERROR }

enum class ErrorKind { AUTH, PERMISSION, RATE_LIMIT, QUOTA, CONTEXT_LENGTH, BAD_REQUEST, NOT_FOUND, OVERLOADED, SERVER, NETWORK, TIMEOUT, REFUSAL, UNKNOWN }

data class LlmError(
    val kind: ErrorKind,
    /** User-facing sentence: what happened and what to do. */
    val message: String,
    val httpStatus: Int? = null,
    val retryAfterSeconds: Long? = null,
    /** Raw provider message for the details view. */
    val detail: String? = null,
)

class LlmException(val error: LlmError) : Exception(error.message)

sealed interface StreamEvent {
    /** Request accepted; [model] is the model actually serving (may differ after a fallback). */
    data class Started(val model: String) : StreamEvent
    data class TextDelta(val text: String) : StreamEvent
    data class ThinkingDelta(val text: String) : StreamEvent
    /** Model is reasoning but not exposing text (hidden/omitted thinking). */
    data object ThinkingStarted : StreamEvent
    data object ThinkingEnded : StreamEvent
    data class WebSearch(val query: String?, val done: Boolean) : StreamEvent
    data class Citations(val citations: List<Citation>) : StreamEvent
    data class UsageUpdate(val usage: Usage) : StreamEvent
    /** Informational, e.g. "Answered by claude-opus-4-8 after a refusal fallback." */
    data class Notice(val text: String) : StreamEvent
    data class Completed(val stopReason: StopReason, val blocks: ProviderBlocks?) : StreamEvent
    data class Failed(val error: LlmError) : StreamEvent
}

interface LlmClient {
    val config: ProviderConfig

    /** Lists chat-capable models with capabilities (live metadata when the provider exposes it). */
    suspend fun listModels(): List<ModelInfo>

    /**
     * Streams one assistant turn. Cold flow: collection starts the request, cancellation aborts it.
     * Always terminates with exactly one [StreamEvent.Completed] or [StreamEvent.Failed]
     * (except on coroutine cancellation).
     */
    fun stream(request: ChatRequest): Flow<StreamEvent>

    /** Cheap authenticated call to validate the key. */
    suspend fun verify(): Result<Unit>
}

/** Remembers request parameters a given model rejected, so retries and future calls omit them. */
interface QuirkStore {
    fun dropped(providerId: String, model: String): Set<String>
    fun markDropped(providerId: String, model: String, param: String)
}
