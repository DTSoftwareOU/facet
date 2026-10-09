package io.dtsoftware.facet.core.crypto

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets.US_ASCII
import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import java.util.Base64
import java.util.zip.Deflater
import java.util.zip.Inflater
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/** Thrown when ciphertext fails authentication (wrong key, tampered data, wrong record id). */
class DecryptionException(message: String) : Exception(message)

/** Keys derived from a password or recovery code. See docs/SECURITY.md. */
class DerivedKeys(val authHash: ByteArray, val wrapKey: ByteArray)

/**
 * Facet's client-side cryptography, implementing docs/SECURITY.md exactly.
 * Server never sees passwords, master keys, or the vault key.
 */
object FacetCrypto {
    const val DEFAULT_ITERATIONS = 600_000
    const val VERSION: Byte = 0x01

    private const val NONCE = 12
    private const val TAG_BITS = 128
    private const val COMPRESS_THRESHOLD = 1024
    private const val AAD_VAULT = "facet:vault-key:v1"
    private const val AAD_VAULT_RECOVERY = "facet:vault-key-recovery:v1"

    private val random = SecureRandom()

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }

    fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    fun unb64(s: String): ByteArray = Base64.getDecoder().decode(s)

    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    fun normalizePassword(password: String): String = Normalizer.normalize(password, Normalizer.Form.NFKC)

    /** PBKDF2-HMAC-SHA256 over the NFKC-normalized UTF-8 password, 32-byte output. */
    fun pbkdf2(password: String, salt: ByteArray, iterations: Int): ByteArray {
        val normalized = normalizePassword(password)
        return try {
            // Platform implementations encode the password chars as UTF-8, matching the spec.
            val spec = PBEKeySpec(normalized.toCharArray(), salt, iterations, 256)
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } catch (e: Exception) {
            pbkdf2Manual(normalized.toByteArray(UTF_8), salt, iterations)
        }
    }

    internal fun pbkdf2Manual(password: ByteArray, salt: ByteArray, iterations: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(password, "HmacSHA256"))
        mac.update(salt)
        mac.update(byteArrayOf(0, 0, 0, 1))
        var u = mac.doFinal()
        val out = u.copyOf()
        for (i in 1 until iterations) {
            u = mac.doFinal(u)
            for (j in out.indices) out[j] = (out[j].toInt() xor u[j].toInt()).toByte()
        }
        return out
    }

    /** HKDF-SHA256 (RFC 5869) with a 32-zero-byte salt. */
    fun hkdf(ikm: ByteArray, info: String, length: Int = 32): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val infoBytes = info.toByteArray(UTF_8)
        val out = ByteArrayOutputStream()
        var t = ByteArray(0)
        var counter = 1
        while (out.size() < length) {
            mac.update(t)
            mac.update(infoBytes)
            mac.update(counter.toByte())
            t = mac.doFinal()
            out.write(t)
            counter++
        }
        return out.toByteArray().copyOf(length)
    }

    fun deriveFromPassword(password: String, salt: ByteArray, iterations: Int): DerivedKeys {
        val master = pbkdf2(password, salt, iterations)
        return try {
            DerivedKeys(hkdf(master, "facet:auth:v1"), hkdf(master, "facet:wrap:v1"))
        } finally {
            master.fill(0)
        }
    }

    fun deriveFromRecovery(code: ByteArray): DerivedKeys =
        DerivedKeys(hkdf(code, "facet:recovery-auth:v1"), hkdf(code, "facet:recovery-wrap:v1"))

    fun gcmEncrypt(key: ByteArray, plaintext: ByteArray, aad: ByteArray, nonce: ByteArray = randomBytes(NONCE)): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(aad)
        return cipher.doFinal(plaintext)
    }

    fun gcmDecrypt(key: ByteArray, nonce: ByteArray, ciphertext: ByteArray, aad: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(aad)
        return try {
            cipher.doFinal(ciphertext)
        } catch (e: AEADBadTagException) {
            throw DecryptionException("Authentication failed")
        }
    }

    // ---- Vault key wrapping ----

    fun wrapVaultKey(wrapKey: ByteArray, vaultKey: ByteArray, recovery: Boolean = false, nonce: ByteArray = randomBytes(NONCE)): ByteArray {
        val aad = (if (recovery) AAD_VAULT_RECOVERY else AAD_VAULT).toByteArray(US_ASCII)
        return byteArrayOf(VERSION) + nonce + gcmEncrypt(wrapKey, vaultKey, aad, nonce)
    }

    fun unwrapVaultKey(wrapKey: ByteArray, wrapped: ByteArray, recovery: Boolean = false): ByteArray {
        if (wrapped.size != 61 || wrapped[0] != VERSION) throw DecryptionException("Bad wrapped key")
        val aad = (if (recovery) AAD_VAULT_RECOVERY else AAD_VAULT).toByteArray(US_ASCII)
        return gcmDecrypt(wrapKey, wrapped.copyOfRange(1, 13), wrapped.copyOfRange(13, wrapped.size), aad)
    }

    // ---- Records ----

    private fun recordAad(type: String, id: String) = "facet:rec:v1:$type:$id".toByteArray(US_ASCII)

    /**
     * Encrypts a record body. With [pad], the (possibly compressed) body is framed with a 4-byte length
     * and zero-padded to a size bucket (flags bit1) so ciphertext length doesn't reveal content length.
     */
    fun encryptRecord(vaultKey: ByteArray, type: String, id: String, json: String, nonce: ByteArray = randomBytes(NONCE), pad: Boolean = false): ByteArray {
        val raw = json.toByteArray(UTF_8)
        val compress = raw.size > COMPRESS_THRESHOLD
        var body = if (compress) deflate(raw) else raw
        if (pad) body = frame(body)
        val flags = (if (compress) 0x01 else 0) or (if (pad) 0x02 else 0)
        return byteArrayOf(VERSION, flags.toByte()) + nonce + gcmEncrypt(vaultKey, body, recordAad(type, id), nonce)
    }

    /** Pads to 512-byte buckets up to 16 KiB, then 4 KiB buckets. */
    internal fun paddedSize(n: Int): Int {
        val total = n + 4
        val step = if (total <= 16 * 1024) 512 else 4096
        return (total + step - 1) / step * step
    }

    private fun frame(body: ByteArray): ByteArray {
        val out = ByteArray(paddedSize(body.size))
        out[0] = (body.size ushr 24).toByte(); out[1] = (body.size ushr 16).toByte()
        out[2] = (body.size ushr 8).toByte(); out[3] = body.size.toByte()
        System.arraycopy(body, 0, out, 4, body.size)
        return out
    }

    private fun unframe(padded: ByteArray): ByteArray {
        if (padded.size < 4) throw DecryptionException("Bad padding")
        val n = ((padded[0].toInt() and 0xFF) shl 24) or ((padded[1].toInt() and 0xFF) shl 16) or
            ((padded[2].toInt() and 0xFF) shl 8) or (padded[3].toInt() and 0xFF)
        if (n < 0 || n > padded.size - 4) throw DecryptionException("Bad padding")
        return padded.copyOfRange(4, 4 + n)
    }

    fun decryptRecord(vaultKey: ByteArray, type: String, id: String, envelope: ByteArray): String {
        if (envelope.size < 30 || envelope[0] != VERSION) throw DecryptionException("Bad record envelope")
        val flags = envelope[1].toInt()
        val nonce = envelope.copyOfRange(2, 14)
        var body = gcmDecrypt(vaultKey, nonce, envelope.copyOfRange(14, envelope.size), recordAad(type, id))
        if (flags and 0x02 != 0) body = unframe(body)
        val raw = if (flags and 0x01 != 0) inflate(body) else body
        return String(raw, UTF_8)
    }

    // ---- Blobs ----

    private fun blobAad(id: String) = "facet:blob:v1:$id".toByteArray(US_ASCII)

    fun encryptBlob(vaultKey: ByteArray, blobId: String, bytes: ByteArray, nonce: ByteArray = randomBytes(NONCE)): ByteArray =
        byteArrayOf(VERSION) + nonce + gcmEncrypt(vaultKey, bytes, blobAad(blobId), nonce)

    fun decryptBlob(vaultKey: ByteArray, blobId: String, blob: ByteArray): ByteArray {
        if (blob.size < 29 || blob[0] != VERSION) throw DecryptionException("Bad blob")
        return gcmDecrypt(vaultKey, blob.copyOfRange(1, 13), blob.copyOfRange(13, blob.size), blobAad(blobId))
    }

    // ---- Compression (raw DEFLATE, RFC 1951) ----

    fun deflate(input: ByteArray): ByteArray {
        val deflater = Deflater(Deflater.DEFAULT_COMPRESSION, true)
        try {
            deflater.setInput(input)
            deflater.finish()
            val out = ByteArrayOutputStream(input.size / 2 + 64)
            val buf = ByteArray(8192)
            while (!deflater.finished()) out.write(buf, 0, deflater.deflate(buf))
            return out.toByteArray()
        } finally {
            deflater.end()
        }
    }

    fun inflate(input: ByteArray): ByteArray {
        val inflater = Inflater(true)
        try {
            // A trailing dummy byte is required by some zlib builds in nowrap mode.
            inflater.setInput(input + byteArrayOf(0))
            val out = ByteArrayOutputStream(input.size * 3)
            val buf = ByteArray(8192)
            while (!inflater.finished()) {
                val n = inflater.inflate(buf)
                if (n == 0 && (inflater.needsInput() || inflater.needsDictionary())) break
                out.write(buf, 0, n)
            }
            return out.toByteArray()
        } finally {
            inflater.end()
        }
    }
}

/** Crockford base32 recovery codes: 20 random bytes ↔ "XXXX-XXXX-…" (8 groups of 4). */
object RecoveryCode {
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    const val BYTES = 20

    fun generate(): ByteArray = FacetCrypto.randomBytes(BYTES)

    fun format(bytes: ByteArray): String {
        require(bytes.size == BYTES)
        val sb = StringBuilder()
        var buffer = 0
        var bits = 0
        for (b in bytes) {
            buffer = (buffer shl 8) or (b.toInt() and 0xFF)
            bits += 8
            while (bits >= 5) {
                sb.append(ALPHABET[(buffer shr (bits - 5)) and 31])
                bits -= 5
            }
        }
        return sb.chunked(4).joinToString("-")
    }

    /** Parses user input; returns null if it isn't a valid code. */
    fun parse(input: String): ByteArray? {
        val cleaned = input.uppercase()
            .filterNot { it == '-' || it.isWhitespace() }
            .map { c -> when (c) { 'O' -> '0'; 'I', 'L' -> '1'; else -> c } }
        if (cleaned.size != 32) return null
        val out = ByteArrayOutputStream(BYTES)
        var buffer = 0
        var bits = 0
        for (c in cleaned) {
            val v = ALPHABET.indexOf(c)
            if (v < 0) return null
            buffer = (buffer shl 5) or v
            bits += 5
            if (bits >= 8) {
                out.write((buffer shr (bits - 8)) and 0xFF)
                bits -= 8
            }
        }
        return out.toByteArray().takeIf { it.size == BYTES }
    }
}
