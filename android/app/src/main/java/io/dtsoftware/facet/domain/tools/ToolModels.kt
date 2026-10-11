package io.dtsoftware.facet.domain.tools

import androidx.annotation.StringRes
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.llm.Citation
import io.dtsoftware.facet.llm.ProviderBlocks
import io.dtsoftware.facet.llm.ToolSpec
import kotlinx.serialization.Serializable

/** When an MCP tool needs the user's go-ahead before it runs. */
@Serializable
enum class ToolApproval(@StringRes val labelRes: Int, @StringRes val blurbRes: Int) {
    ALWAYS(R.string.toolrun_approval_always, R.string.toolrun_approval_always_blurb),
    WRITES(R.string.toolrun_approval_writes, R.string.toolrun_approval_writes_blurb),
    NEVER(R.string.toolrun_approval_never, R.string.toolrun_approval_never_blurb);

    /** The option's name in the app's language. */
    val label: String get() = Strings.get(labelRes)

    /** What the option does, in the app's language. */
    val blurb: String get() = Strings.get(blurbRes)
}

/** Stored by name in [ToolCallRecord.kind]. COMPUTER: tools that run on a PC (here: one of the account's PCs, docs/REMOTE.md). */
enum class ToolKind { SEARCH, FETCH, SKILL, MCP, MEDIA, COMPUTER }

/** A tool offered to the model for one request. */
data class ToolDef(
    val spec: ToolSpec,
    val kind: ToolKind,
    /** MCP server id (for COMPUTER tools: the PC's hostId) and the tool's original name on that server. */
    val serverId: String? = null,
    val serverName: String? = null,
    val remoteName: String? = null,
    val needsApproval: Boolean = false,
    /** For MEDIA tools: what the tool makes. */
    val output: io.dtsoftware.facet.llm.ModelOutput? = null,
)

/**
 * Where a tool runs: the reply's chat, the model's id for this call (so a PC can stop it), and a way to
 * show progress (e.g. "Creating video · 1:20").
 */
data class ToolContext(val conversationId: String? = null, val callId: String? = null, val onProgress: (String) -> Unit = {})

/** What a tool returned, ready for the model and the UI. */
data class ToolOutcome(
    val content: String,
    val isError: Boolean = false,
    val citations: List<Citation> = emptyList(),
    /** Short past-tense line for the UI, e.g. "Searched “rent prices in Porto”". */
    val label: String? = null,
    /** Media the tool created, shown with the reply. */
    val attachments: List<io.dtsoftware.facet.data.AttachmentRef> = emptyList(),
)

@Serializable
data class SkillResource(val path: String, val content: String)

/** One executed tool call, stored with the reply. */
@Serializable
data class ToolCallRecord(
    val id: String,
    val name: String,
    val kind: String,
    val label: String,
    val argumentsJson: String,
    val result: String,
    val isError: Boolean,
    val durationMs: Long = 0,
    val serverName: String? = null,
)

/** One assistant step that ended in tool calls. */
@Serializable
data class ToolStep(
    val text: String,
    val calls: List<ToolCallRecord>,
    val blocks: ProviderBlocks? = null,
)

/** All tool steps of a reply plus the text of the final step, for exact replay. */
@Serializable
data class ToolTrace(val steps: List<ToolStep>, val finalText: String)

/** Bring-your-own-key web search backends for models without built-in search. */
enum class SearchKind(
    val id: String,
    val displayName: String,
    @StringRes val blurbRes: Int,
    val keyUrl: String?,
    val needsKey: Boolean,
    val defaultUrl: String,
) {
    BRAVE("search.brave", "Brave Search", R.string.websearch_blurb_brave, "https://api-dashboard.search.brave.com/app/keys", true, "https://api.search.brave.com"),
    TAVILY("search.tavily", "Tavily", R.string.websearch_blurb_tavily, "https://app.tavily.com/home", true, "https://api.tavily.com"),
    EXA("search.exa", "Exa", R.string.websearch_blurb_exa, "https://dashboard.exa.ai/api-keys", true, "https://api.exa.ai"),
    JINA("search.jina", "Jina Search", R.string.websearch_blurb_jina, "https://jina.ai/api-dashboard/key-manager", true, "https://s.jina.ai"),
    SEARXNG("search.searxng", "SearXNG", R.string.websearch_blurb_searxng, "https://docs.searxng.org", false, "https://");

    /** What the service offers, in the app's language. */
    val blurb: String get() = Strings.get(blurbRes)

    companion object {
        const val PREFIX = "search."
        fun fromId(id: String): SearchKind? = entries.firstOrNull { it.id == id }
        fun isSearch(kindId: String) = kindId.startsWith(PREFIX)
    }
}
