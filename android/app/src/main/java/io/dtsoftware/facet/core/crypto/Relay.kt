package io.dtsoftware.facet.core.crypto

import java.nio.charset.StandardCharsets.US_ASCII
import java.nio.charset.StandardCharsets.UTF_8

/**
 * End-to-end encrypted messages between the account's devices (docs/REMOTE.md). The sync server
 * forwards them between sessions without being able to read them: the key is derived from the
 * vault key, and the sender and recipient session ids are bound into the AAD.
 *
 * `envelope = 0x01 || flags || nonce(12) || AES-256-GCM(relayKey, body, "facet:relay:v1:{flags}:{from}:{to}")`
 */
object RelayCrypto {
    private const val VERSION: Byte = 0x01
    private const val NONCE = 12
    private const val TAG = 16
    private const val FLAG_DEFLATE = 0x01
    /** Bodies longer than this are compressed when that makes them smaller. */
    private const val COMPRESS_ABOVE = 1024

    /** HKDF-SHA256(vault key, info "facet:relay:v1"), 32 bytes. */
    fun relayKey(vaultKey: ByteArray): ByteArray = FacetCrypto.hkdf(vaultKey, "facet:relay:v1")

    private fun aad(flags: Int, from: String, to: String) = "facet:relay:v1:$flags:$from:$to".toByteArray(US_ASCII)

    /** Seals [json] from session [from] to session [to]. The body is raw-DEFLATEd above 1 KiB when that saves space. */
    fun seal(key: ByteArray, from: String, to: String, json: String, nonce: ByteArray = FacetCrypto.randomBytes(NONCE)): ByteArray {
        val raw = json.toByteArray(UTF_8)
        val deflated = if (raw.size > COMPRESS_ABOVE) FacetCrypto.deflate(raw).takeIf { it.size < raw.size } else null
        val flags = if (deflated != null) FLAG_DEFLATE else 0
        return byteArrayOf(VERSION, flags.toByte()) + nonce + FacetCrypto.gcmEncrypt(key, deflated ?: raw, aad(flags, from, to), nonce)
    }

    /** Opens an envelope sent from [from] to [to]. Throws [DecryptionException] when it doesn't authenticate. */
    fun open(key: ByteArray, from: String, to: String, envelope: ByteArray): String {
        if (envelope.size < 2 + NONCE + TAG || envelope[0] != VERSION) throw DecryptionException("Bad relay envelope")
        val flags = envelope[1].toInt() and 0xFF
        val body = FacetCrypto.gcmDecrypt(key, envelope.copyOfRange(2, 2 + NONCE), envelope.copyOfRange(2 + NONCE, envelope.size), aad(flags, from, to))
        return String(if (flags and FLAG_DEFLATE != 0) FacetCrypto.inflate(body) else body, UTF_8)
    }
}

/** Drops replays: messages outside ±10 minutes of the local clock, or ids seen in the last 20 minutes. */
class ReplayGuard(
    private val skewMs: Long = 10 * 60_000L,
    private val rememberMs: Long = 20 * 60_000L,
) {
    /** Insertion-ordered, so the oldest ids are at the front. */
    private val seen = LinkedHashMap<String, Long>()

    @Synchronized
    fun accept(id: String?, ts: Long?, now: Long = System.currentTimeMillis()): Boolean {
        if (id == null || id.length < 8 || ts == null || kotlin.math.abs(now - ts) > skewMs) return false
        val it = seen.entries.iterator()
        while (it.hasNext()) {
            if (now - it.next().value <= rememberMs) break
            it.remove()
        }
        if (id in seen) return false
        seen[id] = now
        return true
    }
}
