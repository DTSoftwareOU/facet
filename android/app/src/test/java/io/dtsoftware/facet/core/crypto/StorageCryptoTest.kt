package io.dtsoftware.facet.core.crypto

import io.dtsoftware.facet.sync.compressible
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Space-saving envelope details: Padmé record padding and compressed (v2) attachment blobs. */
class StorageCryptoTest {
    private val key = ByteArray(32) { it.toByte() }

    @Test
    fun padmeOverheadIsSmallAndSizesStayBucketed() {
        for (n in listOf(1, 100, 251, 252, 600, 1_000, 5_000, 20_000, 100_000, 1_500_000)) {
            val p = FacetCrypto.paddedSize(n)
            assertTrue("never smaller than the framed body ($n)", p >= n + 4)
            assertTrue("minimum bucket ($n)", p >= 256)
            if (n > 1_000) assertTrue("overhead under 12% ($n → $p)", p <= (n + 4) * 1.12)
        }
        // Few distinct sizes: every padded size in 1..64 KiB is a multiple of a power of two.
        val distinct = (1..65_536).map { FacetCrypto.paddedSize(it) }.toSet()
        assertTrue("Padmé leaks only a coarse size, got ${distinct.size} buckets", distinct.size < 600)
    }

    @Test
    fun paddedRecordsRoundTripAndShrink() {
        val json = buildString { repeat(300) { append("""{"role":"assistant","text":"Day $it: pastéis de nata"},""") } }
        val env = FacetCrypto.encryptRecord(key, "e", "id1", json, pad = true)
        assertEquals(json, FacetCrypto.decryptRecord(key, "e", "id1", env))
        assertTrue("compressed well below the JSON size", env.size < json.length / 3)
        val tiny = FacetCrypto.encryptRecord(key, "e", "id2", """{"t":"x"}""", pad = true)
        assertEquals("""{"t":"x"}""", FacetCrypto.decryptRecord(key, "e", "id2", tiny))
    }

    @Test
    fun compressibleBlobsUseV2AndRoundTrip() {
        val text = buildString { repeat(4_000) { append("line $it of a log file\n") } }.toByteArray()
        val v2 = FacetCrypto.encryptBlob(key, "blob1", text, compressible = true)
        assertEquals(FacetCrypto.BLOB_V2, v2[0])
        assertTrue(v2.size < text.size / 3)
        assertArrayEquals(text, FacetCrypto.decryptBlob(key, "blob1", v2))

        // Already-compressed data (or compressible = false) stays a v1 envelope.
        val noise = ByteArray(10_000).also { java.util.Random(7).nextBytes(it) }
        val v1 = FacetCrypto.encryptBlob(key, "blob2", noise, compressible = true)
        assertEquals(FacetCrypto.VERSION, v1[0])
        assertArrayEquals(noise, FacetCrypto.decryptBlob(key, "blob2", v1))
    }

    @Test
    fun v2FlagsAreAuthenticated() {
        val text = ByteArray(5_000) { 'a'.code.toByte() }
        val blob = FacetCrypto.encryptBlob(key, "blob3", text, compressible = true)
        val tampered = blob.copyOf().also { it[1] = 0 } // claim "not compressed"
        assertThrows(Exception::class.java) { FacetCrypto.decryptBlob(key, "blob3", tampered) }
        assertThrows(Exception::class.java) { FacetCrypto.decryptBlob(key, "other-id", blob) }
    }

    @Test
    fun onlyTextLikeFilesAreCompressed() {
        assertTrue(compressible("text/plain"))
        assertTrue(compressible("application/pdf"))
        assertTrue(compressible("audio/wav"))
        assertTrue(!compressible("image/jpeg"))
        assertTrue(!compressible("audio/mpeg"))
        assertTrue(!compressible("video/mp4"))
    }
}
