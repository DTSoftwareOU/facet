package io.dtsoftware.facet.data

import io.dtsoftware.facet.data.db.MessageEntity
import org.junit.Assert.assertEquals
import org.junit.Test

class MessageTreeTest {
    private fun msg(id: String, parent: String?, at: Long, role: String = "user") =
        MessageEntity(id = id, conversationId = "c", parentId = parent, role = role, content = id, createdAt = at, updatedAt = at)

    @Test
    fun followsSelectedBranchAndNewestLeaf() {
        // u1 → a1 → u2 → a2
        //        ↘ a1b (regenerated) → u3
        val tree = MessageTree(
            listOf(
                msg("u1", null, 1), msg("a1", "u1", 2, "assistant"), msg("u2", "a1", 3), msg("a2", "u2", 4, "assistant"),
                msg("a1b", "u1", 5, "assistant"), msg("u3", "a1b", 6),
            ),
        )
        assertEquals(listOf("u1", "a1b", "u3"), tree.activePath(null).map { it.id })
        assertEquals(listOf("u1", "a1", "u2", "a2"), tree.activePath("a2").map { it.id })
        // Selecting a mid-branch node follows it to its newest leaf.
        assertEquals(listOf("u1", "a1", "u2", "a2"), tree.activePath("a1").map { it.id })
        assertEquals(listOf("a1", "a1b"), tree.siblings(tree.byId.getValue("a1")).map { it.id })
        assertEquals("u3", tree.latestLeaf("a1b"))
    }

    @Test
    fun orphansAreTreatedAsRoots() {
        val tree = MessageTree(listOf(msg("x", "missing", 1), msg("y", "x", 2, "assistant")))
        assertEquals(listOf("x", "y"), tree.activePath(null).map { it.id })
    }

    @Test
    fun emptyTree() {
        assertEquals(emptyList<MessageEntity>(), MessageTree(emptyList()).activePath("nope"))
    }
}
