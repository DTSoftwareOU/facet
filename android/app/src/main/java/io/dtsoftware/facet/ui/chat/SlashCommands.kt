package io.dtsoftware.facet.ui.chat

import io.dtsoftware.facet.R
import io.dtsoftware.facet.data.db.PromptEntity
import io.dtsoftware.facet.remote.RemoteFeature
import io.dtsoftware.facet.remote.RemoteHost

/** Built-in commands typed as "/name" at the start of an empty message (docs/REMOTE.md, "Slash commands"). */
enum class SlashCommand(val command: String, val description: String, val icon: Int) {
    NEW("new", "Start a new chat", R.drawable.ic_new_chat),
    MODEL("model", "Choose the model", R.drawable.ic_cpu),
    FOLDER("folder", "Choose the chat's working folder on your PC", R.drawable.ic_folder_open),
    PC("pc", "Choose which PC the chat uses, or none", R.drawable.ic_monitor),
    RESUME_CLAUDE("resume-from-claude", "Continue a Claude Code session from the chat's folder", R.drawable.ic_terminal),
    RESUME_CODEX("resume-from-codex", "Continue a Codex session from the chat's folder", R.drawable.ic_terminal),
}

/** One row of the command list: a built-in command, or a saved prompt as "/<title in kebab-case>". */
sealed interface SlashItem {
    val name: String

    data class Command(val command: SlashCommand) : SlashItem {
        override val name get() = command.command
    }

    data class Prompt(val prompt: PromptEntity) : SlashItem {
        override val name get() = SlashCommands.kebab(prompt.title)
    }
}

object SlashCommands {
    /** The text after "/" while the message box holds only a command name being typed; null otherwise. */
    fun query(text: String): String? {
        if (!text.startsWith("/") || text.length > 60) return null
        val name = text.drop(1).trimEnd(' ')
        return name.lowercase().takeIf { n -> n.none { it.isWhitespace() } }
    }

    /** "Weekly report (draft)" → "weekly-report-draft". */
    fun kebab(title: String): String =
        title.lowercase().replace(Regex("[^\\p{L}\\p{N}]+"), "-").trim('-').ifEmpty { "prompt" }

    /**
     * Which built-in commands apply right now. [computer] is the PC the chat can use (online, remote use on);
     * folder and session commands need it, and the PC must offer the feature (older hosts list none).
     */
    fun available(computer: RemoteHost?, anyPcOnline: Boolean): Set<SlashCommand> = buildSet {
        fun supports(feature: String) = computer != null && (computer.features.isEmpty() || computer.has(feature))
        add(SlashCommand.NEW)
        add(SlashCommand.MODEL)
        if (supports(RemoteFeature.FILES)) add(SlashCommand.FOLDER)
        if (anyPcOnline) add(SlashCommand.PC)
        if (supports(RemoteFeature.CLAUDE)) add(SlashCommand.RESUME_CLAUDE)
        if (supports(RemoteFeature.CODEX)) add(SlashCommand.RESUME_CODEX)
    }

    /**
     * Commands then saved prompts matching [query]: names that start with it first, then names (or prompt
     * titles) that contain it. Only [available] commands are listed.
     */
    fun filter(query: String, available: Set<SlashCommand>, prompts: List<PromptEntity>): List<SlashItem> {
        val q = query.trim().lowercase()
        val commands = SlashCommand.entries.filter { it in available }.map { SlashItem.Command(it) }
        val saved = prompts.map { SlashItem.Prompt(it) }
        fun rank(items: List<SlashItem>): List<SlashItem> {
            if (q.isEmpty()) return items
            val starts = items.filter { it.name.startsWith(q) }
            val contains = items.filter { it !in starts && (it.name.contains(q) || (it is SlashItem.Prompt && it.prompt.title.lowercase().contains(q))) }
            return starts + contains
        }
        return rank(commands) + rank(saved)
    }

    /** The available command typed out in full (e.g. "/new"), so sending it runs the command. */
    fun exact(text: String, available: Set<SlashCommand>): SlashCommand? {
        val t = text.trim().lowercase()
        return available.firstOrNull { "/" + it.command == t }
    }
}
