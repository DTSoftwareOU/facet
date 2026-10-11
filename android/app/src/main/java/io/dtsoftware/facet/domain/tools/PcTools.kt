package io.dtsoftware.facet.domain.tools

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
                label = r.label?.takeIf { it.isNotBlank() } ?: "${host.name}: $tool",
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
            return when (tool) {
                "run_command" -> {
                    val cmd = arg(args, "command").lineSequence().firstOrNull().orEmpty()
                    (if (done) "Ran " else "Running ") + if (cmd.isNotEmpty()) "`" + (if (cmd.length > 60) cmd.take(57) + "…" else cmd) + "`" else "a command"
                }
                "read_file" -> (if (done) "Read " else "Reading ") + path.ifEmpty { "a file" }
                "write_file" -> (if (done) "Wrote " else "Writing ") + path.ifEmpty { "a file" }
                "edit_file" -> (if (done) "Edited " else "Editing ") + path.ifEmpty { "a file" }
                "list_directory" -> (if (done) "Listed " else "Listing ") + path.ifEmpty { "the folder" }
                "glob" -> (if (done) "Found files matching " else "Finding files matching ") + arg(args, "pattern").ifEmpty { "…" }
                "grep" -> (if (done) "Searched for " else "Searching for ") + "“${arg(args, "pattern").take(40)}”"
                else -> tool.replace('_', ' ')
            }
        }

        /** What the model wants to do on the PC, in words, for the approval card: a question and the exact detail. */
        fun approvalSummary(tool: String, args: String, pcName: String?): Pair<String, String?> {
            val on = pcName?.let { " on $it" }.orEmpty()
            return when (tool) {
                "run_command" -> "Run this command$on?" to arg(args, "command")
                "write_file" -> "Write ${arg(args, "path")}$on?" to arg(args, "content").take(2000)
                "edit_file" -> {
                    val old = arg(args, "old_string").lines().joinToString("\n") { "- $it" }
                    val new = arg(args, "new_string").lines().joinToString("\n") { "+ $it" }
                    "Edit ${arg(args, "path")}$on?" to "$old\n$new".take(3000)
                }
                "stop_process" -> "Stop this background process$on?" to arg(args, "id")
                "open_path" -> "Open ${arg(args, "path")}$on?" to null
                else -> "Allow ${tool.replace('_', ' ')}$on?" to null
            }
        }
    }
}
