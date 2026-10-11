package io.dtsoftware.facet.domain.tools

import androidx.annotation.StringRes
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.db.ConversationEntity
import io.dtsoftware.facet.data.prefs.SettingsStore
import io.dtsoftware.facet.data.repo.ConversationRepository
import io.dtsoftware.facet.llm.ToolSpec
import io.dtsoftware.facet.remote.ComputerInfo
import io.dtsoftware.facet.remote.ComputerToolInfo
import io.dtsoftware.facet.remote.RemoteException
import io.dtsoftware.facet.remote.RemoteFeature
import io.dtsoftware.facet.remote.RemoteHost
import io.dtsoftware.facet.remote.RemoteHosts
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The computer tools of the PC a chat works on (docs/REMOTE.md, "Chats that work in a PC folder").
 * The tool loop runs here, with the user's keys; only the tools run on the PC, through the
 * encrypted relay. Mirrors the Windows app's computer tools (client/src/tools/registry.ts).
 */
class PcTools(
    private val remote: RemoteHosts,
    private val conversations: ConversationRepository,
    private val settings: SettingsStore,
) {
    /** Adds the PC's tools and the computer instructions when [conversation] is bound to an online PC that allows remote use. */
    suspend fun addTools(defs: MutableList<ToolDef>, addendum: MutableList<String>, conversation: ConversationEntity?) {
        val hostId = conversation?.computerHost ?: return
        val host = remote.hosts.value[hostId]?.takeIf { it.remote && (it.features.isEmpty() || it.has(RemoteFeature.COMPUTER)) } ?: return
        // The PC isn't answering: offer no computer tools rather than fail the reply.
        val tools = runCatching { remote.computerTools(hostId) }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return
        val info = runCatching { remote.computerInfo(hostId) }.getOrNull()
        val approval = settings.local.value.pcApproval
        defs += toolDefs(tools, host, approval, defs.map { it.spec.name }.toSet())
        addendum += addendum(info, host, workingFolder(conversation, host))
    }

    /** Runs a computer tool on its PC, in the chat's folder. Stopping the reply cancels it there. */
    suspend fun run(def: ToolDef, argumentsJson: String, ctx: ToolContext): ToolOutcome {
        val hostId = def.serverId ?: return ToolOutcome("This tool has no PC.", isError = true)
        val pcName = def.serverName ?: remote.nameOf(hostId) ?: "The PC"
        val host = remote.hosts.value[hostId]
            ?: return ToolOutcome("$pcName is offline, so this tool can't run. Tell the user, and continue without the computer.", isError = true)
        val conversation = ctx.conversationId?.let { conversations.get(it) }
        val tool = def.remoteName ?: def.spec.name
        return try {
            val r = remote.computerCall(hostId, tool, argumentsJson, workingFolder(conversation, host), ctx.callId ?: Ids.new())
            ToolOutcome(
                r.content.ifBlank { if (r.isError) "The tool failed without a message." else "(No output.)" },
                r.isError,
                label = r.label?.takeIf { it.isNotBlank() }?.let { localizeLabel(it) } ?:"${host.name}: $tool",
            )
        } catch (e: RemoteException) {
            ToolOutcome(e.message ?: "$pcName couldn't run the tool.", isError = true)
        }
    }

    companion object {
        /** One definition per PC tool: names as-is, `computer_<slug>` when a name is taken; approvals per "Your PC → Ask before". */
        fun toolDefs(tools: List<ComputerToolInfo>, host: RemoteHost, approval: ToolApproval, taken: Set<String>): List<ToolDef> {
            val used = HashSet(taken)
            return tools.map { t ->
                var name = t.name.take(64)
                if (name in used) {
                    val base = ("computer_" + ToolRegistry.slug(t.name)).take(60)
                    name = base
                    var n = 2
                    while (name in used) name = base + "_" + n++
                }
                used += name
                // YOLO is checked when the tool runs, as for MCP.
                val needsApproval = when (approval) {
                    ToolApproval.ALWAYS -> true
                    ToolApproval.WRITES -> !t.readOnly
                    ToolApproval.NEVER -> false
                }
                ToolDef(
                    ToolSpec(name, t.description, t.inputSchemaJson.ifBlank { ToolRegistry.EMPTY_SCHEMA }),
                    ToolKind.COMPUTER, serverId = host.hostId, serverName = host.name, remoteName = t.name, needsApproval = needsApproval,
                )
            }
        }

        /** The chat's folder on the PC, else the PC's default folder. */
        fun workingFolder(conversation: ConversationEntity?, host: RemoteHost): String =
            conversation?.computerFolder?.takeIf { conversation.computerHost == host.hostId } ?: host.defaultFolder ?: host.home.orEmpty()

        /** The system prompt addendum of the Windows app (registry.ts `computerAddendum`), naming the PC. */
        fun addendum(info: ComputerInfo?, host: RemoteHost, cwd: String): String {
            val os = info?.os?.takeIf { it.isNotBlank() } ?: host.os
            val pc = info?.hostname?.takeIf { it.isNotBlank() } ?: host.name
            val where = listOf(os, pc).filter { it.isNotBlank() }.joinToString(", ").let { if (it.isEmpty()) "" else " ($it)" }
            val shell = info?.shell?.takeIf { it.isNotBlank() }?.let { " Commands run in $it." }.orEmpty()
            val home = (info?.home?.takeIf { it.isNotBlank() } ?: host.home)?.let { " The user's home folder is $it." }.orEmpty()
            return "## Computer\nYou can use the user's computer$where through the computer tools: run commands and read, search and edit files.$shell " +
                "The working folder for this chat is $cwd; relative paths resolve there.$home " +
                "Stay inside the working folder unless the user asks for something else. Look before you change things, keep changes focused, and tell the user what you changed."
        }

        private fun arg(args: String, key: String): String {
            val obj = runCatching { AppJson.parseToJsonElement(args) as? JsonObject }.getOrNull()
            return (obj?.get(key) as? JsonPrimitive)?.content.orEmpty()
        }

        private fun shortPath(p: String): String {
            val parts = p.replace('\\', '/').split('/').filter { it.isNotEmpty() }
            return if (parts.size > 2) "…/" + parts.takeLast(2).joinToString("/") else p
        }

        /** Labels for computer tools while they run; the PC supplies the final label. */
        fun label(tool: String, args: String, done: Boolean): String {
            val path = shortPath(arg(args, "path"))
            fun pick(@StringRes running: Int, @StringRes finished: Int, vararg values: Any) =
                Strings.get(if (done) finished else running, *values)
            /** Without a path: the general line ("Reading a file"); with one: the line naming it. */
            fun withPath(@StringRes running: Int, @StringRes finished: Int, @StringRes runningPath: Int, @StringRes finishedPath: Int) =
                if (path.isEmpty()) pick(running, finished) else pick(runningPath, finishedPath, path)
            return when (tool) {
                "run_command" -> {
                    val cmd = arg(args, "command").lineSequence().firstOrNull().orEmpty()
                    if (cmd.isEmpty()) pick(R.string.toolrun_running_command, R.string.toolrun_ran_command)
                    else pick(R.string.toolrun_running, R.string.toolrun_ran, "`" + (if (cmd.length > 60) cmd.take(57) + "…" else cmd) + "`")
                }
                "read_file" -> withPath(R.string.toolrun_reading_file, R.string.toolrun_read_file, R.string.toolrun_reading_path, R.string.toolrun_read_path)
                "write_file" -> withPath(R.string.toolrun_writing_file, R.string.toolrun_wrote_file, R.string.toolrun_writing, R.string.toolrun_wrote)
                "edit_file" -> withPath(R.string.toolrun_editing_file, R.string.toolrun_edited_file, R.string.toolrun_editing, R.string.toolrun_edited)
                "list_directory" -> withPath(R.string.toolrun_listing_folder, R.string.toolrun_listed_folder, R.string.toolrun_listing, R.string.toolrun_listed)
                "glob" -> pick(R.string.toolrun_finding_files, R.string.toolrun_found_files, arg(args, "pattern").ifEmpty { "…" })
                "grep" -> pick(R.string.toolrun_searching_for, R.string.toolrun_searched_for, "“${arg(args, "pattern").take(40)}”")
                else -> tool.replace('_', ' ')
            }
        }

        /** Final labels the PC reports in English (the Windows app's bridge), in the app's language when known. */
        private val fixedLabels: Map<String, Int> = mapOf(
            "Ran a command" to R.string.toolrun_ran_command,
            "Read a file" to R.string.toolrun_read_file,
            "Wrote a file" to R.string.toolrun_wrote_file,
            "Edited a file" to R.string.toolrun_edited_file,
            "Listed the folder" to R.string.toolrun_listed_folder,
            "Couldn't run a command" to R.string.toolrun_couldnt_run_command,
            "Couldn't read a file" to R.string.toolrun_couldnt_read_file,
            "Couldn't write a file" to R.string.toolrun_couldnt_write_file,
            "Couldn't edit a file" to R.string.toolrun_couldnt_edit_file,
            "Couldn't list the folder" to R.string.toolrun_couldnt_list_folder,
            "Couldn't search for files" to R.string.toolrun_couldnt_search_files,
            "Couldn't search for text" to R.string.toolrun_couldnt_search_text,
            "Couldn't open the path" to R.string.toolrun_couldnt_open_path,
            "Couldn't find process" to R.string.toolrun_couldnt_find_process,
        )

        /** Patterns of the PC's labels with one variable part; checked in order (the "Couldn't" ones first). */
        private val labelPatterns: List<Pair<Regex, Int>> = listOf(
            "Couldn't run " to R.string.toolrun_couldnt_run,
            "Couldn't read " to R.string.toolrun_couldnt_read,
            "Couldn't write " to R.string.toolrun_couldnt_write,
            "Couldn't edit " to R.string.toolrun_couldnt_edit,
            "Couldn't list " to R.string.toolrun_couldnt_list,
            "Couldn't search for " to R.string.toolrun_couldnt_search_for,
            "Couldn't open " to R.string.toolrun_couldnt_open,
            "Couldn't find process " to R.string.toolrun_couldnt_find_process_id,
            "Unknown tool " to R.string.toolrun_unknown_tool,
            "Timed out: " to R.string.toolrun_timed_out,
            "Ran " to R.string.toolrun_ran,
            "Started " to R.string.toolrun_started,
            "Stopped " to R.string.toolrun_stopped,
            "Checked " to R.string.toolrun_checked,
            "Read " to R.string.toolrun_read_path,
            "Wrote " to R.string.toolrun_wrote,
            "Edited " to R.string.toolrun_edited,
            "Listed " to R.string.toolrun_listed,
            "Found files matching " to R.string.toolrun_found_files,
            "Searched for " to R.string.toolrun_searched_for,
            "Revealed " to R.string.toolrun_revealed,
            "Opened " to R.string.toolrun_opened,
        ).map { (prefix, res) -> Regex("^" + Regex.escape(prefix) + "(.+)$", RegexOption.DOT_MATCHES_ALL) to res }

        /** A final label from the PC (English) in the app's language; unknown labels pass through unchanged. */
        fun localizeLabel(label: String): String {
            fixedLabels[label]?.let { return Strings.get(it) }
            for ((re, res) in labelPatterns) {
                val m = re.find(label) ?: continue
                return Strings.get(res, m.groupValues[1])
            }
            return label
        }

        /** What the model wants to do on the PC, in words, for the approval card: a question and the exact detail. */
        fun approvalSummary(tool: String, args: String, pcName: String?): Pair<String, String?> {
            /** The question without the PC's name, or with it as the last argument. */
            fun ask(@StringRes plain: Int, @StringRes onPc: Int, vararg values: Any): String =
                if (pcName == null) Strings.get(plain, *values) else Strings.get(onPc, *values, pcName)
            return when (tool) {
                "run_command" -> ask(R.string.toolrun_approve_command, R.string.toolrun_approve_command_on) to arg(args, "command")
                "write_file" -> ask(R.string.toolrun_approve_write, R.string.toolrun_approve_write_on, arg(args, "path")) to arg(args, "content").take(2000)
                "edit_file" -> {
                    val old = arg(args, "old_string").lines().joinToString("\n") { "- $it" }
                    val new = arg(args, "new_string").lines().joinToString("\n") { "+ $it" }
                    ask(R.string.toolrun_approve_edit, R.string.toolrun_approve_edit_on, arg(args, "path")) to "$old\n$new".take(3000)
                }
                "stop_process" -> ask(R.string.toolrun_approve_stop_process, R.string.toolrun_approve_stop_process_on) to arg(args, "id")
                "open_path" -> ask(R.string.toolrun_approve_open, R.string.toolrun_approve_open_on, arg(args, "path")) to null
                else -> ask(R.string.toolrun_approve_allow, R.string.toolrun_approve_allow_on, tool.replace('_', ' ')) to null
            }
        }
    }
}
