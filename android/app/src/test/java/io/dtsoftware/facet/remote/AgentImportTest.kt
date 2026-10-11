package io.dtsoftware.facet.remote

import io.dtsoftware.facet.data.MessageTree
import io.dtsoftware.facet.data.db.MessageStatus
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.llm.GenParams
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Continuing a Claude Code or Codex session turns it into a new chat (docs/REMOTE.md). */
class AgentImportTest {
    private val now = 1_770_000_000_000L
    private val folder = "C:\\Users\\alex\\Desktop\\Projects\\app"
    private val session = AgentSession(
        id = "s1",
        title = "Fix the flaky test",
        cwd = folder,
        updatedAt = now - 60_000,
        messages = listOf(
            AgentMessage("user", "The login test fails sometimes.", at = now - 600_000),
            AgentMessage("assistant", "› Ran `npm test`\n› Edited src/login.ts\nIt was a race; fixed.", at = now - 500_000),
            AgentMessage("user", "  ", at = now - 400_000),
            AgentMessage("assistant", "Anything else?"),
            AgentMessage("user", "Add a regression test.", at = now - 300_000),
        ),
    )

    @Test
    fun buildsOneBranchOfDoneMessages() {
        val model = ModelRef("p-anthropic", "claude-opus-5-5")
        val (conv, messages) = AgentImport.build(session, CodingAgent.CLAUDE, "host-1", folder, model, GenParams(), now)
        assertEquals("Fix the flaky test", conv.title)
        assertTrue(conv.titleSet)
        assertEquals("host-1", conv.computerHost)
        assertEquals(folder, conv.computerFolder)
        assertEquals("p-anthropic", conv.providerId)
        assertEquals("claude-opus-5-5", conv.modelId)
        assertEquals(
            "This chat continues a Claude Code session from $folder. The messages so far were imported from it; " +
                "tool calls appear as lines starting with ›. Pick up where it left off.",
            conv.systemPrompt,
        )
        assertTrue(conv.dirty)

        // Blank messages are left out; the rest chain into one branch ending at the current leaf.
        assertEquals(4, messages.size)
        assertEquals(listOf("user", "assistant", "assistant", "user"), messages.map { it.role })
        assertEquals(messages.last().id, conv.currentLeafId)
        val path = MessageTree(messages).activePath(conv.currentLeafId)
        assertEquals(messages.map { it.id }, path.map { it.id })
        assertNull(messages.first().parentId)
        messages.forEach {
            assertEquals(conv.id, it.conversationId)
            assertEquals(MessageStatus.DONE.name, it.status)
            assertNull(it.providerId)
            assertNull(it.modelId)
            assertTrue(it.dirty)
        }
        assertEquals("Claude Code", messages[1].modelName)
        assertNull(messages[0].modelName)
        // Times follow the session and only move forward.
        assertEquals(now - 600_000, messages[0].createdAt)
        assertEquals(now - 500_000, messages[1].createdAt)
        assertEquals(now - 499_999, messages[2].createdAt)
        assertEquals(now - 300_000, messages[3].createdAt)
        assertTrue(messages.zipWithNext().all { (a, b) -> a.createdAt < b.createdAt })
    }

    @Test
    fun codexAndFallbacks() {
        val untitled = session.copy(title = "", messages = listOf(AgentMessage("user", "Refactor the parser\nand add docs"), AgentMessage("assistant", "Done.")))
        val (conv, messages) = AgentImport.build(untitled, CodingAgent.CODEX, "host-1", folder, null, GenParams(), now)
        assertEquals("Refactor the parser", conv.title)
        assertTrue(conv.systemPrompt!!.startsWith("This chat continues a Codex session from $folder."))
        assertEquals("Codex", messages[1].modelName)
        assertNull(conv.providerId)
        assertTrue(messages.all { it.createdAt < now })
        assertEquals("Codex session", AgentImport.title(AgentSession("x"), CodingAgent.CODEX))
        assertThrows(IllegalArgumentException::class.java) {
            AgentImport.build(AgentSession("x", messages = listOf(AgentMessage("user", " "))), CodingAgent.CLAUDE, "h", folder, null, GenParams(), now)
        }
    }
}
