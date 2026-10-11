package io.dtsoftware.facet.ui.chat

import io.dtsoftware.facet.data.db.PromptEntity
import io.dtsoftware.facet.remote.RemoteHost
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Slash commands (docs/REMOTE.md): when the list opens, what it offers, and how it filters. */
class SlashCommandsTest {
    private fun prompt(title: String, body: String = "Body of $title") = PromptEntity(title, title, body, 0, 0)
    private val prompts = listOf(prompt("Weekly report (draft)"), prompt("Explain like I'm five"), prompt("Résumé tips"))
    private val pc = RemoteHost("host-1", "sess", "OFFICE-PC", remote = true, features = listOf("computer", "files", "claude", "codex"))

    private fun names(items: List<SlashItem>) = items.map { it.name }

    @Test
    fun opensOnlyForACommandAtTheStart() {
        assertEquals("", SlashCommands.query("/"))
        assertEquals("res", SlashCommands.query("/Res"))
        assertEquals("new", SlashCommands.query("/new "))
        assertNull(SlashCommands.query("hello /new"))
        assertNull(SlashCommands.query("/new chat ideas"))
        assertNull(SlashCommands.query("/new\n"))
        assertNull(SlashCommands.query(""))
    }

    @Test
    fun availableCommandsFollowThePc() {
        // No PC: a normal chatbot.
        assertEquals(setOf(SlashCommand.NEW, SlashCommand.MODEL), SlashCommands.available(null, anyPcOnline = false))
        // A PC is online but this chat can't use it (remote use off): only /pc.
        assertEquals(setOf(SlashCommand.NEW, SlashCommand.MODEL, SlashCommand.PC), SlashCommands.available(null, anyPcOnline = true))
        assertEquals(SlashCommand.entries.toSet(), SlashCommands.available(pc, anyPcOnline = true))
        // A PC without Codex support doesn't offer /resume-from-codex.
        assertEquals(
            setOf(SlashCommand.NEW, SlashCommand.MODEL, SlashCommand.PC, SlashCommand.FOLDER, SlashCommand.RESUME_CLAUDE),
            SlashCommands.available(pc.copy(features = listOf("computer", "files", "claude")), anyPcOnline = true),
        )
    }

    @Test
    fun listsCommandsThenPromptsAndFilters() {
        val all = SlashCommands.available(pc, anyPcOnline = true)
        assertEquals(
            listOf("new", "model", "folder", "pc", "resume-from-claude", "resume-from-codex", "weekly-report-draft", "explain-like-i-m-five", "résumé-tips"),
            names(SlashCommands.filter("", all, prompts)),
        )
        assertEquals(listOf("resume-from-claude", "resume-from-codex"), names(SlashCommands.filter("res", all, prompts)))
        assertEquals(listOf("model", "folder", "resume-from-claude", "resume-from-codex"), names(SlashCommands.filter("o", all, emptyList())))
        assertEquals(listOf("resume-from-codex"), names(SlashCommands.filter("codex", all, prompts)))
        assertEquals(listOf("weekly-report-draft"), names(SlashCommands.filter("week", all, prompts)))
        assertEquals(listOf("explain-like-i-m-five"), names(SlashCommands.filter("five", all, prompts)))
        // Unavailable commands never show.
        assertEquals(emptyList<String>(), names(SlashCommands.filter("folder", setOf(SlashCommand.NEW, SlashCommand.MODEL), prompts)))
        val picked = SlashCommands.filter("week", all, prompts).single() as SlashItem.Prompt
        assertEquals("Body of Weekly report (draft)", picked.prompt.body)
    }

    @Test
    fun startsWithBeatsContains() {
        val items = SlashCommands.filter("pc", SlashCommand.entries.toSet(), listOf(prompt("Upcoming PC build")))
        assertEquals(listOf("pc", "upcoming-pc-build"), names(items))
    }

    @Test
    fun exactCommandsAndKebabCase() {
        val all = SlashCommands.available(pc, anyPcOnline = true)
        assertEquals(SlashCommand.NEW, SlashCommands.exact("/new", all))
        assertEquals(SlashCommand.RESUME_CODEX, SlashCommands.exact(" /Resume-From-Codex ", all))
        assertNull(SlashCommands.exact("/folder", setOf(SlashCommand.NEW)))
        assertNull(SlashCommands.exact("/new please", all))
        assertEquals("q3-plan-v2", SlashCommands.kebab("  Q3 plan: v2!  "))
        assertEquals("prompt", SlashCommands.kebab("!!!"))
    }
}
