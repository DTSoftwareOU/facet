package io.dtsoftware.facet.domain.tools

import io.dtsoftware.facet.llm.Citation
import io.dtsoftware.facet.llm.ProviderBlocks
import io.dtsoftware.facet.llm.ToolSpec
import kotlinx.serialization.Serializable

/** When an MCP tool needs the user's go-ahead before it runs. */
@Serializable
enum class ToolApproval(val label: String, val blurb: String) {
    ALWAYS("Always ask", "Ask before every tool call."),
    WRITES("Ask for changes", "Ask unless the server marks a tool as read-only."),
    NEVER("Never ask", "Run tools without asking."),
}

enum class ToolKind { SEARCH, FETCH, SKILL, MCP, MEDIA }

/** A tool offered to the model for one request. */
data class ToolDef(
    val spec: ToolSpec,
    val kind: ToolKind,
    /** MCP server id and the tool's original name on that server. */
    val serverId: String? = null,
    val serverName: String? = null,
    val remoteName: String? = null,
    val needsApproval: Boolean = false,
    /** For MEDIA tools: what the tool makes. */
    val output: io.dtsoftware.facet.llm.ModelOutput? = null,
)

/** Where a tool runs: the reply's chat, and a way to show progress (e.g. "Creating video · 1:20"). */
data class ToolContext(val conversationId: String? = null, val onProgress: (String) -> Unit = {})

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
    val blurb: String,
    val keyUrl: String?,
    val needsKey: Boolean,
    val defaultUrl: String,
) {
    BRAVE("search.brave", "Brave Search", "Independent index. Free tier available.", "https://api-dashboard.search.brave.com/app/keys", true, "https://api.search.brave.com"),
    TAVILY("search.tavily", "Tavily", "Search built for AI agents. Free tier available.", "https://app.tavily.com/home", true, "https://api.tavily.com"),
    EXA("search.exa", "Exa", "Neural search with page text.", "https://dashboard.exa.ai/api-keys", true, "https://api.exa.ai"),
    JINA("search.jina", "Jina Search", "Search with full page content.", "https://jina.ai/api-dashboard/key-manager", true, "https://s.jina.ai"),
    SEARXNG("search.searxng", "SearXNG", "Your own metasearch instance (JSON output enabled).", "https://docs.searxng.org", false, "https://");

    companion object {
        const val PREFIX = "search."
        fun fromId(id: String): SearchKind? = entries.firstOrNull { it.id == id }
        fun isSearch(kindId: String) = kindId.startsWith(PREFIX)
    }
}
