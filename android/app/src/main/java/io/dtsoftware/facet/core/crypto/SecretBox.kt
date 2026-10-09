package io.dtsoftware.facet.core.crypto

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.nio.charset.StandardCharsets.UTF_8
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts small local secrets (API keys, vault key, tokens) at rest. */
interface SecretBox {
    fun seal(plain: ByteArray): String
    fun open(sealed: String): ByteArray

    fun sealString(plain: String): String = seal(plain.toByteArray(UTF_8))
    fun openString(sealed: String): String = String(open(sealed), UTF_8)
}

/** Backed by a non-exportable AES-256-GCM key in the Android Keystore. */
class KeystoreSecretBox(private val alias: String = "facet_local_v1") : SecretBox {
    private val key: SecretKey by lazy { loadOrCreate() }

    private fun loadOrCreate(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    override fun seal(plain: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val ct = cipher.doFinal(plain)
        return "v1:" + FacetCrypto.b64(cipher.iv + ct)
    }

    override fun open(sealed: String): ByteArray {
        require(sealed.startsWith("v1:")) { "Unknown sealed format" }
        val data = FacetCrypto.unb64(sealed.substring(3))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, data, 0, 12))
        return cipher.doFinal(data, 12, data.size - 12)
    }
}
