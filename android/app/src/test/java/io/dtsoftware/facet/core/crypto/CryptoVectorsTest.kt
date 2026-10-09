package io.dtsoftware.facet.core.crypto

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/** Verifies the Kotlin implementation of docs/SECURITY.md against the server's reference vectors. */
class CryptoVectorsTest {
    private val v: JsonObject = Json.parseToJsonElement(
        listOf(File("../../docs/test-vectors.json"), File("docs/test-vectors.json")).first { it.exists() }.readText(),
    ).jsonObject

    private fun JsonObject.s(key: String) = this[key]!!.jsonPrimitive.content
    private fun JsonObject.o(key: String) = this[key]!!.jsonObject
    private fun hex(s: String) = ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }

    private val inputs = v.o("inputs")
    private val nonces = inputs.o("nonces")

    @Test
    fun nfkcNormalization() {
        val n = v.o("nfkc")
        assertEquals(n.s("normalized"), FacetCrypto.normalizePassword(n.s("input")))
        assertEquals(n.s("normalizedUtf8Hex"), FacetCrypto.normalizePassword(n.s("input")).toByteArray().hex())
    }

    @Test
    fun passwordDerivationAndWrap() {
        val p = v.o("password")
        val salt = hex(inputs.s("saltHex"))
        val iterations = inputs.s("iterations").toInt()
        val master = FacetCrypto.pbkdf2(inputs.s("password"), salt, iterations)
        assertEquals(p.s("masterKeyHex"), master.hex())
        assertEquals(p.s("masterKeyHex"), FacetCrypto.pbkdf2Manual(FacetCrypto.normalizePassword(inputs.s("password")).toByteArray(), salt, iterations).hex())

        val keys = FacetCrypto.deriveFromPassword(inputs.s("password"), salt, iterations)
        assertEquals(p.s("authKeyHex"), keys.authHash.hex())
        assertEquals(p.s("authHashB64"), FacetCrypto.b64(keys.authHash))
        assertEquals(p.s("wrapKeyHex"), keys.wrapKey.hex())

        val vault = hex(inputs.s("vaultKeyHex"))
        val wrapped = FacetCrypto.wrapVaultKey(keys.wrapKey, vault, nonce = hex(nonces.s("passwordWrapHex")))
        assertEquals(p.s("wrappedVaultKeyHex"), wrapped.hex())
        assertEquals(p.s("wrappedVaultKeyB64"), FacetCrypto.b64(wrapped))
        assertArrayEquals(vault, FacetCrypto.unwrapVaultKey(keys.wrapKey, wrapped))
        assertThrows(DecryptionException::class.java) { FacetCrypto.unwrapVaultKey(keys.wrapKey, wrapped, recovery = true) }
    }

    @Test
    fun recoveryCode() {
        val r = v.o("recovery")
        val bytes = hex(inputs.s("recoveryCodeBytesHex"))
        assertEquals(r.s("codeText"), RecoveryCode.format(bytes))
        r["codeTextVariantsThatMustParse"]!!.jsonArray.forEach { assertArrayEquals(bytes, RecoveryCode.parse(it.jsonPrimitive.content)) }
        assertNull(RecoveryCode.parse("not a code"))

        val keys = FacetCrypto.deriveFromRecovery(bytes)
        assertEquals(r.s("recoveryAuthKeyHex"), keys.authHash.hex())
        assertEquals(r.s("recoveryAuthHashB64"), FacetCrypto.b64(keys.authHash))
        assertEquals(r.s("recoveryWrapKeyHex"), keys.wrapKey.hex())
        val wrapped = FacetCrypto.wrapVaultKey(keys.wrapKey, hex(inputs.s("vaultKeyHex")), recovery = true, nonce = hex(nonces.s("recoveryWrapHex")))
        assertEquals(r.s("recoveryWrappedVaultKeyHex"), wrapped.hex())
    }

    @Test
    fun recordEnvelopes() {
        val vault = hex(inputs.s("vaultKeyHex"))
        v["records"]!!.jsonArray.map { it.jsonObject }.forEach { rec ->
            val type = rec.s("type")
            val id = rec.s("id")
            val plain = rec.s("plaintextJson")
            val envelope = FacetCrypto.unb64(rec.s("envelopeB64"))
            assertEquals(plain, FacetCrypto.decryptRecord(vault, type, id, envelope))
            val ours = FacetCrypto.encryptRecord(vault, type, id, plain, nonce = hex(rec.s("nonceHex")))
            if (rec.s("deterministic").toBoolean()) assertEquals(rec.s("envelopeB64"), FacetCrypto.b64(ours))
            assertEquals(plain, FacetCrypto.decryptRecord(vault, type, id, ours))
            // The record id and type are bound: swapping them must fail.
            assertThrows(DecryptionException::class.java) { FacetCrypto.decryptRecord(vault, type, id + "x", envelope) }
        }
    }

    @Test
    fun blobEnvelope() {
        val b = v.o("blob")
        val vault = hex(inputs.s("vaultKeyHex"))
        val ours = FacetCrypto.encryptBlob(vault, b.s("id"), hex(b.s("plaintextHex")), nonce = hex(b.s("nonceHex")))
        assertEquals(b.s("envelopeB64"), FacetCrypto.b64(ours))
        assertEquals(b.s("plaintextHex"), FacetCrypto.decryptBlob(vault, b.s("id"), FacetCrypto.unb64(b.s("envelopeB64"))).hex())
    }

    @Test
    fun compressionRoundTripsLargeUnicode() {
        val vault = FacetCrypto.randomBytes(32)
        val text = buildString { repeat(400) { append("Ünïcødé 💎 line $it\n") } }
        val env = FacetCrypto.encryptRecord(vault, "msg", "m1", text)
        assertEquals(1, env[1].toInt())
        assertEquals(text, FacetCrypto.decryptRecord(vault, "msg", "m1", env))
    }
}
