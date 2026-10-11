package io.dtsoftware.facet.update

import java.io.File
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ApkVerifierTest {
    @get:Rule val tmp = TemporaryFolder()

    private val bytes = ByteArray(200_000) { (it * 31 + 7).toByte() }
    private val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun file(content: ByteArray = bytes): File = tmp.newFile().apply { writeBytes(content) }

    @Test
    fun knownVector() {
        val empty = tmp.newFile()
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", ApkVerifier.sha256(empty))
        val abc = file("abc".toByteArray())
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", ApkVerifier.sha256(abc))
    }

    @Test
    fun matchingSizeAndHashPass() {
        assertEquals(ApkVerifier.Result.OK, ApkVerifier.verify(file(), bytes.size.toLong(), sha))
        assertEquals(ApkVerifier.Result.OK, ApkVerifier.verify(file(), bytes.size.toLong(), sha.uppercase()))
    }

    @Test
    fun wrongSizeFails() {
        assertEquals(ApkVerifier.Result.SIZE_MISMATCH, ApkVerifier.verify(file(), bytes.size + 1L, sha))
        assertEquals(ApkVerifier.Result.SIZE_MISMATCH, ApkVerifier.verify(file(bytes.copyOf(bytes.size - 1)), bytes.size.toLong(), sha))
    }

    @Test
    fun tamperedContentFails() {
        val tampered = bytes.copyOf().also { it[123_456] = (it[123_456] + 1).toByte() }
        assertEquals(ApkVerifier.Result.HASH_MISMATCH, ApkVerifier.verify(file(tampered), bytes.size.toLong(), sha))
        assertEquals(ApkVerifier.Result.HASH_MISMATCH, ApkVerifier.verify(file(), bytes.size.toLong(), "00".repeat(32)))
    }

    @Test
    fun missingFileFails() {
        assertEquals(ApkVerifier.Result.MISSING, ApkVerifier.verify(File(tmp.root, "nope.apk"), 1, sha))
    }

    @Test
    fun archiveMustBeFacetAtTheAdvertisedVersion() {
        val m = UpdateManifest(7, "1.6.0", "https://facet.dtsoftware.io/a.apk", sha, bytes.size.toLong())
        assertTrue(ApkVerifier.isExpectedArchive(ArchiveIdentity("io.dtsoftware.facet", 7), m))
        assertFalse(ApkVerifier.isExpectedArchive(ArchiveIdentity("io.dtsoftware.facet", 6), m))
        assertFalse(ApkVerifier.isExpectedArchive(ArchiveIdentity("io.dtsoftware.facet", 8), m))
        assertFalse(ApkVerifier.isExpectedArchive(ArchiveIdentity("io.dtsoftware.facet.debug", 7), m))
        assertFalse(ApkVerifier.isExpectedArchive(ArchiveIdentity("com.example.evil", 7), m))
        assertFalse(ApkVerifier.isExpectedArchive(null, m))
    }
}
