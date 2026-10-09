package io.dtsoftware.facet.domain.tools

import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.data.prefs.SettingsStore
import io.dtsoftware.facet.data.repo.ProviderRepository
import io.dtsoftware.facet.llm.GenParams
import io.dtsoftware.facet.llm.ModelCaps
import io.dtsoftware.facet.llm.ToolSpec
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** The tools prepared for one reply, plus any extra system instructions they bring. */
data class PreparedTools(
    val defs: List<ToolDef>,
    val systemAddendum: String?,
    val maxRounds: Int = ToolRegistry.MAX_TOOL_ROUNDS,
) {
    val byName: Map<String, ToolDef> = defs.associateBy { it.spec.name }
}

/**
 * Decides which client tools a model gets for a reply and runs them:
 * Facet web search + page reader (for models without built-in search), skills, and MCP tools.
 */
class ToolRegistry(
    private val search: WebSearch,
    private val providers: ProviderRepository,
    private val mcp: McpManager,
    private val skills: SkillRepository,
    private val settings: SettingsStore,
    private val media: io.dtsoftware.facet.domain.media.MediaService? = null,
) {
    /** The configured BYOK search backend, if any. */
    suspend fun searchConfig(): SearchConfig? = providers.all()
        .firstOrNull { it.enabled && SearchKind.isSearch(it.kind) }
        ?.let { p -> SearchKind.fromId(p.kind)?.let { SearchConfig(it, providers.apiKey(p), p.baseUrl) } }

    /** True when this model will search with Facet's tool rather than its own. */
    suspend fun usesFacetSearch(params: GenParams, caps: ModelCaps): Boolean =
        params.webSearch && caps.tools && (!caps.webSearch || !settings.synced.value.preferNativeSearch) && searchConfig() != null

    suspend fun prepare(params: GenParams, caps: ModelCaps): PreparedTools {
        val defs = ArrayList<ToolDef>()
        val addendum = ArrayList<String>()
        val yolo = settings.synced.value.yoloMode

        val facetSearch = caps.tools && usesFacetSearch(params, caps)
        if (facetSearch) defs += ToolDef(ToolSpec(WEB_SEARCH, WEB_SEARCH_DESC, WEB_SEARCH_SCHEMA), ToolKind.SEARCH)
        // Reading a link needs no search key: offer it with search, or whenever tools are on.
        if (caps.tools && (facetSearch || params.tools)) defs += ToolDef(ToolSpec(FETCH_PAGE, FETCH_PAGE_DESC, FETCH_PAGE_SCHEMA), ToolKind.FETCH)

        if (params.tools) {
            val enabledSkills = skills.all().filter { it.enabled }
            enabledSkills.filter { it.alwaysOn }.forEach { s ->
                addendum += "## Skill: ${s.name}\n${s.instructions}"
            }
            val onDemand = enabledSkills.filterNot { it.alwaysOn }
            if (caps.tools && onDemand.isNotEmpty()) {
                val index = onDemand.joinToString("\n") { "- ${it.name}: ${it.description}" }
                defs += ToolDef(
                    ToolSpec(
                        USE_SKILL,
                        "Load the full instructions of a skill before doing a task it covers. Load a skill whenever its description matches the request, then follow its instructions.\n\nAvailable skills:\n$index",
                        """{"type":"object","properties":{"name":{"type":"string","description":"Skill name from the list"}},"required":["name"],"additionalProperties":false}""",
                    ),
                    ToolKind.SKILL,
                )
                if (onDemand.any { skills.resources(it).isNotEmpty() }) {
                    defs += ToolDef(
                        ToolSpec(
                            READ_SKILL_FILE,
                            "Read a reference file bundled with a skill, by the path listed in that skill's instructions.",
                            """{"type":"object","properties":{"skill":{"type":"string"},"path":{"type":"string"}},"required":["skill","path"],"additionalProperties":false}""",
                        ),
                        ToolKind.SKILL,
                    )
                }
            }

            if (caps.tools) {
                val used = HashSet<String>(defs.map { it.spec.name })
                for (server in mcp.all().filter { it.enabled && it.id !in params.disabledMcpServers }) {
                    val disabled = mcp.disabledTools(server)
                    val auto = mcp.autoApproved(server)
                    val approval = mcp.approval(server)
                    val prefix = "mcp_" + slug(server.name).take(14)
                    mcp.tools(server).filter { it.name !in disabled }.forEach { t ->
                        var name = (prefix + "_" + slug(t.name)).take(64)
                        var n = 2
                        while (!used.add(name)) name = (prefix + "_" + slug(t.name)).take(60) + "_" + n++
                        val needsApproval = !yolo && t.name !in auto && when (approval) {
                            ToolApproval.ALWAYS -> true
                            ToolApproval.WRITES -> t.readOnlyHint != true
                            ToolApproval.NEVER -> false
                        }
                        val desc = buildString {
                            append("[").append(server.name).append("] ")
                            append(t.description?.trim()?.takeIf { it.isNotEmpty() } ?: t.title ?: t.name)
                        }.take(1024)
                        defs += ToolDef(
                            ToolSpec(name, desc, t.inputSchemaJson.ifBlank { EMPTY_SCHEMA }),
                            ToolKind.MCP, server.id, server.name, t.name, needsApproval,
                        )
                    }
                    server.instructions?.takeIf { it.isNotBlank() }?.let { addendum += "## Tools from ${server.name}\n${it.take(2000)}" }
                }
            }
        }
        val svc = media
        if (params.tools && caps.tools && svc != null && settings.synced.value.media.chatTools) {
            for (output in MEDIA_TOOLS.keys) {
                val choice = runCatching { svc.resolve(output) }.getOrNull() ?: continue
                defs += mediaTool(output, choice.model.displayName)
            }
        }

        return PreparedTools(
            defs,
            addendum.takeIf { it.isNotEmpty() }?.joinToString("\n\n"),
            maxRounds = if (yolo) YOLO_TOOL_ROUNDS else MAX_TOOL_ROUNDS,
        )
    }

    suspend fun execute(def: ToolDef, argumentsJson: String, ctx: ToolContext = ToolContext()): ToolOutcome {
        val args = runCatching { AppJson.parseToJsonElement(argumentsJson.ifBlank { "{}" }).jsonObject }.getOrNull()
            ?: return ToolOutcome("The tool arguments were not valid JSON. Send a JSON object matching the schema.", isError = true)
        fun str(k: String) = args[k]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
        return when (def.kind) {
            ToolKind.SEARCH -> {
                val q = str("query")
                val config = searchConfig() ?: return ToolOutcome("Web search isn't set up.", true)
                val results = search.search(config, q, args["max_results"]?.jsonPrimitive?.intOrNull ?: 6)
                ToolOutcome(search.formatResults(q, results), citations = search.citations(results), label = "Searched “${q.take(60)}”")
            }
            ToolKind.FETCH -> {
                val url = str("url")
                val (title, text) = search.fetchPage(url)
                val host = runCatching { java.net.URI(url).host?.removePrefix("www.") }.getOrNull() ?: url
                ToolOutcome(
                    buildString {
                        if (title.isNotBlank()) append("# ").append(title).append('\n')
                        append(url).append("\n\n").append(text.ifBlank { "(The page had no readable text.)" })
                    },
                    citations = listOf(io.dtsoftware.facet.llm.Citation(url, title.ifBlank { host })),
                    label = "Read $host",
                )
            }
            ToolKind.SKILL -> when (def.spec.name) {
                USE_SKILL -> {
                    val name = str("name")
                    val s = skills.all().firstOrNull { it.enabled && it.name.equals(name, ignoreCase = true) }
                        ?: return ToolOutcome("No enabled skill named \"$name\".", true)
                    val files = skills.resources(s)
                    ToolOutcome(
                        buildString {
                            append("# Skill: ").append(s.name).append("\n\n").append(s.instructions)
                            if (files.isNotEmpty()) {
                                append("\n\nBundled files (read with read_skill_file):\n")
                                files.forEach { append("- ").append(it.path).append('\n') }
                            }
                        },
                        label = "Used skill ${s.name}",
                    )
                }
                else -> {
                    val s = skills.all().firstOrNull { it.enabled && it.name.equals(str("skill"), ignoreCase = true) }
                        ?: return ToolOutcome("No enabled skill named \"${str("skill")}\".", true)
                    val f = skills.resources(s).firstOrNull { it.path == str("path").trimStart('/') }
                        ?: return ToolOutcome("The skill ${s.name} has no file \"${str("path")}\".", true)
                    ToolOutcome(f.content, label = "Read ${f.path} from ${s.name}")
                }
            }
            ToolKind.MEDIA -> {
                val output = def.output ?: return ToolOutcome("Unknown media tool.", true)
                val svc = media ?: return ToolOutcome("Media models aren't available.", true)
                val convId = ctx.conversationId ?: return ToolOutcome("Media can only be created in a chat.", true)
                val prompt = str(if (output == io.dtsoftware.facet.llm.ModelOutput.SPEECH) "text" else "prompt")
                if (prompt.isBlank()) return ToolOutcome("Describe what to create in \"prompt\".", true)
                val aspect = when (str("aspect_ratio").lowercase()) {
                    "portrait" -> io.dtsoftware.facet.llm.media.Aspect.PORTRAIT
                    "landscape" -> io.dtsoftware.facet.llm.media.Aspect.LANDSCAPE
                    "square" -> io.dtsoftware.facet.llm.media.Aspect.SQUARE
                    else -> null
                }
                val seconds = args["seconds"]?.jsonPrimitive?.intOrNull
                val (att, choice) = svc.create(output, prompt, convId, aspect, seconds, ctx.onProgress)
                val what = MEDIA_TOOLS.getValue(output).noun
                val size = if (att.width != null && att.height != null) ", ${att.width}×${att.height}" else ""
                ToolOutcome(
                    "Created the $what with ${choice.model.displayName} (${att.mimeType}$size). It is already shown to the user " +
                        "below your message; don't link or describe a file path. Briefly say what you made, and offer changes.",
                    label = "Created $what with ${choice.model.displayName}",
                    attachments = listOf(io.dtsoftware.facet.data.repo.AttachmentStore.ref(att)),
                )
            }
            ToolKind.MCP -> {
                val r = mcp.call(def.serverId!!, def.remoteName!!, AppJson.encodeToString(JsonObject.serializer(), args))
                val text = buildString {
                    append(r.text.ifBlank { if (r.isError) "The tool failed without a message." else "(No output.)" })
                    if (r.images.isNotEmpty()) append("\n\n[The tool also returned ${r.images.size} image(s), which aren't shown to the model.]")
                }
                ToolOutcome(text, r.isError, label = "${def.serverName}: ${def.remoteName}")
            }
        }
    }

    private fun mediaTool(output: io.dtsoftware.facet.llm.ModelOutput, modelName: String): ToolDef {
        val t = MEDIA_TOOLS.getValue(output)
        return ToolDef(ToolSpec(t.name, t.description.replace("{model}", modelName), t.schema), ToolKind.MEDIA, output = output)
    }

    private class MediaToolSpec(val name: String, val noun: String, val description: String, val schema: String)

    companion object {
        const val WEB_SEARCH = "web_search"
        const val FETCH_PAGE = "fetch_page"
        const val USE_SKILL = "use_skill"
        const val READ_SKILL_FILE = "read_skill_file"
        /** Tool rounds per reply before Facet stops the model; YOLO mode allows longer runs. */
        const val MAX_TOOL_ROUNDS = 12
        const val YOLO_TOOL_ROUNDS = 40
        const val EMPTY_SCHEMA ="""{"type":"object","properties":{}}"""
        /** Cap on tool output kept in history (sent to the model and stored identically). */
        const val MAX_RESULT_CHARS = 30_000

        private val MEDIA_TOOLS = linkedMapOf(
            io.dtsoftware.facet.llm.ModelOutput.IMAGE to MediaToolSpec(
                "generate_image", "image",
                "Create an image with {model} and show it to the user. Use for any request to draw, paint, design, illustrate or " +
                    "picture something (photos, art, logos, diagrams). Write a rich, specific visual prompt in English; include style, " +
                    "subject, composition, lighting and any text to render.",
                """{"type":"object","properties":{"prompt":{"type":"string","description":"Detailed description of the image"},"aspect_ratio":{"type":"string","enum":["square","portrait","landscape"]}},"required":["prompt"],"additionalProperties":false}""",
            ),
            io.dtsoftware.facet.llm.ModelOutput.VIDEO to MediaToolSpec(
                "generate_video", "video",
                "Create a short video clip (a few seconds, with sound when the model supports it) with {model} and show it to the user. " +
                    "It takes a minute or more. Describe the scene, motion, camera and audio.",
                """{"type":"object","properties":{"prompt":{"type":"string","description":"Scene, action, camera movement and sound"},"aspect_ratio":{"type":"string","enum":["landscape","portrait"]}},"required":["prompt"],"additionalProperties":false}""",
            ),
            io.dtsoftware.facet.llm.ModelOutput.SPEECH to MediaToolSpec(
                "generate_speech", "audio clip",
                "Turn text into natural spoken audio with {model} and give the user the clip. Use when they ask to hear something, " +
                    "want a voiceover, or want audio of a text.",
                """{"type":"object","properties":{"text":{"type":"string","description":"Exactly what to say"}},"required":["text"],"additionalProperties":false}""",
            ),
            io.dtsoftware.facet.llm.ModelOutput.MUSIC to MediaToolSpec(
                "generate_music", "track",
                "Compose music or a sound effect with {model} and give the user the audio. Describe genre, mood, instruments, " +
                    "tempo and structure (or the sound, for effects).",
                """{"type":"object","properties":{"prompt":{"type":"string","description":"Genre, mood, instruments, tempo; or the sound to make"},"seconds":{"type":"integer","minimum":3,"maximum":300}},"required":["prompt"],"additionalProperties":false}""",
            ),
        )

        private const val WEB_SEARCH_DESC =
            "Search the web for current information. Use for recent events, facts you aren't sure about, prices, or anything that may have changed. Returns numbered results with URLs and snippets."
        private const val WEB_SEARCH_SCHEMA =
            """{"type":"object","properties":{"query":{"type":"string","description":"A focused search query"},"max_results":{"type":"integer","minimum":1,"maximum":10}},"required":["query"],"additionalProperties":false}"""
        private const val FETCH_PAGE_DESC =
            "Read the text of a web page by URL, e.g. a search result or a link the user shared."
        private const val FETCH_PAGE_SCHEMA =
            """{"type":"object","properties":{"url":{"type":"string","description":"An http(s) URL"}},"required":["url"],"additionalProperties":false}"""

        fun slug(s: String) = s.lowercase().replace(Regex("[^a-z0-9_-]+"), "_").trim('_').ifEmpty { "tool" }
    }
}
