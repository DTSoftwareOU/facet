package io.dtsoftware.facet.core.crypto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The relay envelope against the shared vectors in docs/REMOTE.md (client/src/sync/relay.test.ts uses the same). */
class RelayCryptoTest {
    private val vault = ByteArray(32) { it.toByte() }
    private val nonce = ByteArray(12) { 7 }
    private val smallJson = """{"v":1,"id":"msg-0001-abcdefgh","ts":1760000000000,"type":"hello"}"""
    private val small = "AQAHBwcHBwcHBwcHBwco5etj3MZ1O0AcAYo6sg/2ELJhqlNKT/V8JWweomY3ddGCWQ6K2Dn7CCxx06k3ySjLkqvv6vzL1T0QUn+wsi0+XeSV3sIe45wvWXrITrhvlBJQ"
    private val big =
        "AQEHBwcHBwcHBwcHBwe+DKxPJMdVX8jD38My+nCxRGVHtsMSZdNX0eosh1v6l/Xqqv3fEbh6WRlEZK2GCXAwQjryknSB/iMFRy+93cSCruZ5ZiATT4coRQlPofP7bYINaThOj42w3awQsPui/0pbvUQwLLjrxVPTOAGOzvH9bLFpGwAm9KkZfEr5BhC5pdGilLSDVTQkbM4="

    private val key = RelayCrypto.relayKey(vault)

    @Test
    fun sealsTheSmallVectorByteExactly() {
        assertEquals(small, FacetCrypto.b64(RelayCrypto.seal(key, "sessA", "sessB", smallJson, nonce)))
        assertEquals(smallJson, RelayCrypto.open(key, "sessA", "sessB", FacetCrypto.unb64(small)))
    }

    @Test
    fun opensTheCompressedVector() {
        val json = RelayCrypto.open(key, "sessA", "sessB", FacetCrypto.unb64(big))
        val obj = Json.parseToJsonElement(json).jsonObject
        assertEquals("result", obj["type"]!!.jsonPrimitive.content)
        assertEquals("line\n".repeat(400), obj["value"]!!.jsonObject["content"]!!.jsonPrimitive.content)
    }

    @Test
    fun compressesLargeBodiesAndRoundTrips() {
        val json = """{"text":"${"abc ".repeat(5000)}"}"""
        val sealed = RelayCrypto.seal(key, "a", "b", json)
        assertEquals(1, sealed[1].toInt() and 1)
        assertTrue(sealed.size < json.length / 4)
        assertEquals(json, RelayCrypto.open(key, "a", "b", sealed))
        // Small bodies stay uncompressed.
        assertEquals(0, RelayCrypto.seal(key, "a", "b", smallJson)[1].toInt())
    }

    @Test
    fun rejectsRelabeledOrForeignMessages() {
        val sealed = RelayCrypto.seal(key, "sessA", "sessB", smallJson)
        assertThrows(DecryptionException::class.java) { RelayCrypto.open(key, "sessC", "sessB", sealed) }
        assertThrows(DecryptionException::class.java) { RelayCrypto.open(key, "sessA", "sessC", sealed) }
        assertThrows(DecryptionException::class.java) { RelayCrypto.open(RelayCrypto.relayKey(ByteArray(32)), "sessA", "sessB", sealed) }
        // Flipping the flags byte breaks the AAD.
        val flipped = sealed.copyOf().also { it[1] = 1 }
        assertThrows(DecryptionException::class.java) { RelayCrypto.open(key, "sessA", "sessB", flipped) }
        assertThrows(DecryptionException::class.java) { RelayCrypto.open(key, "sessA", "sessB", ByteArray(10)) }
    }

    @Test
    fun replayGuardDropsRepeatsAndStaleMessages() {
        val g = ReplayGuard()
        val now = 1_760_000_000_000L
        assertTrue(g.accept("id-00000001", now, now))
        assertFalse(g.accept("id-00000001", now, now + 1000))
        assertFalse(g.accept("id-00000002", now - 11 * 60_000, now))
        assertFalse(g.accept("id-00000003", now + 11 * 60_000, now))
        assertFalse(g.accept("short", now, now))
        assertFalse(g.accept("id-00000004", null, now))
        assertFalse(g.accept(null, now, now))
    }

    @Test
    fun replayGuardForgetsOldIds() {
        val g = ReplayGuard(10 * 60_000, 60_000)
        val now = 1_760_000_000_000L
        assertTrue(g.accept("id-00000001", now, now))
        assertTrue(g.accept("id-00000002", now + 120_000, now + 120_000))
        assertTrue(g.accept("id-00000001", now + 120_000, now + 120_000))
    }
}
