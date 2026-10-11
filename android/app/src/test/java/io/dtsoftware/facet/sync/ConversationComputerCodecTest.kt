package io.dtsoftware.facet.sync

import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.data.db.ConversationEntity
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** computerHost / computerFolder ride in the encrypted conversation record, omitted when unset (docs/REMOTE.md). */
class ConversationComputerCodecTest {
    private val box = object : SecretBox {
        override fun seal(plain: ByteArray) = "v1:" + FacetCrypto.b64(plain)
        override fun open(sealed: String) = FacetCrypto.unb64(sealed.removePrefix("v1:"))
    }
    private val codec = RecordCodec(ByteArray(32) { it.toByte() }, box)
    private val base = ConversationEntity(
        id = "c1", title = "Fix the build", titleSet = true, providerId = "p1", modelId = "m1",
        createdAt = 1_000, lastActivityAt = 2_000, updatedAt = 3_000,
    )

    private fun payload(e: ConversationEntity): JsonObject = AppJson.parseToJsonElement(codec.open(codec.encode(e))!!.payload!!).jsonObject

    @Test
    fun roundTripsThePcAndFolder() {
        val bound = base.copy(computerHost = "host-1", computerFolder = "C:\\Users\\alex\\app")
        val opened = codec.open(codec.encode(bound))!!
        val p = payload(bound)
        assertEquals("host-1", (p["computerHost"] as kotlinx.serialization.json.JsonPrimitive).content)
        assertEquals("C:\\Users\\alex\\app", (p["computerFolder"] as kotlinx.serialization.json.JsonPrimitive).content)
        val decoded = codec.conversation(opened)
        assertEquals(bound.copy(dirty = false), decoded)
    }

    @Test
    fun omitsThemWhenUnsetAndReadsOlderRecords() {
        val p = payload(base)
        assertFalse(p.containsKey("computerHost"))
        assertFalse(p.containsKey("computerFolder"))
        assertTrue(p.containsKey("title"))
        // A record written before these fields existed.
        val old = OpenedRecord(
            RecordType.CONVERSATION, "c2", 5, false,
            """{"title":"Old","titleSet":false,"paramsJson":"{}","pinned":false,"archived":false,"createdAt":1,"lastActivityAt":1}""",
        )
        val c = codec.conversation(old)
        assertNull(c.computerHost)
        assertNull(c.computerFolder)
        assertEquals("Old", c.title)
    }
}
