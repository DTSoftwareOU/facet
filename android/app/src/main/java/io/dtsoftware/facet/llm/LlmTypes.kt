package io.dtsoftware.facet.llm

import androidx.annotation.StringRes
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable

/**
 * Provider-agnostic contract between the chat engine/UI and provider adapters.
 * Adapters live in llm/anthropic, llm/openai; [LlmClients.create] picks one by [ApiStyle].
 */

/** Wire protocol a provider speaks. */
/** MEDIA providers make images, video, speech, music or transcripts, but no chat. */
enum class ApiStyle { ANTHROPIC, OPENAI_RESPONSES, OPENAI_CHAT, MEDIA }

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
enum class Effort(val wire: String, @StringRes val labelRes: Int) {
    NONE("none", R.string.llm_effort_off),
    MINIMAL("minimal", R.string.llm_effort_minimal),
    LOW("low", R.string.llm_effort_low),
    MEDIUM("medium", R.string.llm_effort_medium),
    HIGH("high", R.string.llm_effort_high),
    XHIGH("xhigh", R.string.llm_effort_xhigh),
    MAX("max", R.string.llm_effort_max);

    /** The level's name in the app's language. */
    val label: String get() = Strings.get(labelRes)
}

@Serializable
enum class Verbosity(val wire: String, @StringRes val labelRes: Int) {
    LOW("low", R.string.llm_verbosity_concise), MEDIUM("medium", R.string.llm_verbosity_balanced), HIGH("high", R.string.llm_verbosity_detailed);

    /** The level's name in the app's language. */
    val label: String get() = Strings.get(labelRes)
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
    /** Supports function/tool calling (client tools: Facet search, MCP, skills). */
    val tools: Boolean = true,
)

/** USD per 1M tokens. */
@Serializable
data class ModelPricing(
    val input: Double,
    val output: Double,
    val cacheRead: Double? = null,
    val cacheWrite: Double? = null,
)

/**
 * What a model produces. Chat pickers list TEXT models; the others are media models chosen in Settings.
 * [label] is interface text; [noun] and [what] are English words for file names and model-facing text.
 */
@Serializable
enum class ModelOutput(@StringRes val labelRes: Int, val noun: String, val what: String) {
    TEXT(R.string.llm_output_chat, "chat", "chat"),
    IMAGE(R.string.llm_output_images, "image", "images"),
    VIDEO(R.string.llm_output_video, "video", "video"),
    SPEECH(R.string.llm_output_speech, "speech", "speech"),
    MUSIC(R.string.llm_output_music, "music", "music"),
    TRANSCRIPTION(R.string.llm_output_transcription, "transcription", "transcripts");

    /** The kind's name in the app's language, e.g. "Images". */
    val label: String get() = Strings.get(labelRes)
}

@Serializable
data class ModelInfo(
    val id: String,
    val displayName: String,
    val contextWindow: Int? = null,
    val maxOutput: Int? = null,
    val caps: ModelCaps = ModelCaps(),
    val pricing: ModelPricing? = null,
    val createdAt: Long? = null,
    val output: ModelOutput = ModelOutput.TEXT,
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
    /** Offer MCP tools and skills to the model in this chat. */
    val tools: Boolean = true,
    /** MCP server ids turned off for this chat. */
    val disabledMcpServers: List<String> = emptyList(),
)

enum class Role { USER, ASSISTANT }

sealed interface Part {
    data class Text(val text: String) : Part
    data class Image(val mimeType: String, val bytes: ByteArray) : Part
    /** PDF or other document the provider can read natively. */
    data class Document(val mimeType: String, val name: String, val bytes: ByteArray) : Part
    /** Assistant side: the model asked to call a client tool. [argumentsJson] is a JSON object string. */
    data class ToolCall(val id: String, val name: String, val argumentsJson: String) : Part
    /** User side: the result of a client tool call, paired with [ToolCall.id]. */
    data class ToolResult(val callId: String, val name: String, val content: String, val isError: Boolean = false) : Part
}

/**
 * A client-side tool the model may call. [inputSchemaJson] is a JSON Schema object (as a JSON string)
 * describing the arguments. Names match ^[a-zA-Z0-9_-]{1,64}$.
 */
@Serializable
data class ToolSpec(val name: String, val description: String, val inputSchemaJson: String)

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
    /** The model's output-token ceiling from [ModelInfo.maxOutput], used to size `max_tokens` when unset. */
    val modelMaxOutput: Int? = null,
    /** Client tools offered to the model. Empty = no function calling. */
    val tools: List<ToolSpec> = emptyList(),
)

@Serializable
data class Citation(val url: String, val title: String? = null, val snippet: String? = null)

/**
 * Token usage for one assistant turn, normalized across providers:
 * [inputTokens] counts ALL prompt tokens including [cacheReadTokens] and [cacheWriteTokens];
 * [outputTokens] includes [reasoningTokens].
 */
@Serializable
data class Usage(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
    val reasoningTokens: Long = 0,
)

/** [TOOL_USE]: the model stopped to call client tools; run them and continue the turn. */
enum class StopReason { END, MAX_TOKENS, REFUSAL, CANCELLED, ERROR, TOOL_USE }

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
    /** Cumulative, de-duplicated list of sources seen so far this turn (replace, don't append). */
    data class Citations(val citations: List<Citation>) : StreamEvent
    /** Cumulative usage for the turn so far (replace, don't add). */
    data class UsageUpdate(val usage: Usage) : StreamEvent
    /** Informational, e.g. "Answered by claude-opus-4-8 after a refusal fallback." */
    data class Notice(val text: String) : StreamEvent
    /** The model began writing a call to client tool [name] (arguments still streaming). */
    data class ToolCallStarted(val id: String, val name: String) : StreamEvent
    /** A complete client tool call. All calls of a step arrive before [Completed] with [StopReason.TOOL_USE]. */
    data class ToolCallReady(val id: String, val name: String, val argumentsJson: String) : StreamEvent
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
