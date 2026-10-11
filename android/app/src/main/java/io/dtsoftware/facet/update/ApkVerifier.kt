package io.dtsoftware.facet.update

import java.io.File
import java.security.MessageDigest

/** What an APK says it is: its package name and versionCode. */
data class ArchiveIdentity(val packageName: String, val versionCode: Long)

/** Checks a downloaded APK against the manifest before it goes anywhere near the installer. */
object ApkVerifier {
    enum class Result { OK, MISSING, SIZE_MISMATCH, HASH_MISMATCH }

    fun verify(file: File, expectedSize: Long, expectedSha256: String): Result {
        if (!file.isFile) return Result.MISSING
        if (file.length() != expectedSize) return Result.SIZE_MISMATCH
        return if (sha256(file).equals(expectedSha256.trim(), ignoreCase = true)) Result.OK else Result.HASH_MISMATCH
    }

    fun verify(file: File, manifest: UpdateManifest): Result = verify(file, manifest.size, manifest.sha256)

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().toHex()
    }

    /** The APK must be Facet ([UpdateConfig.PACKAGE_NAME]) at exactly the advertised versionCode. */
    fun isExpectedArchive(identity: ArchiveIdentity?, manifest: UpdateManifest, packageName: String = UpdateConfig.PACKAGE_NAME): Boolean =
        identity != null && identity.packageName == packageName && identity.versionCode == manifest.versionCode

    internal fun ByteArray.toHex(): String {
        val hex = "0123456789abcdef"
        val out = CharArray(size * 2)
        forEachIndexed { i, b ->
            val v = b.toInt() and 0xFF
            out[i * 2] = hex[v ushr 4]
            out[i * 2 + 1] = hex[v and 0x0F]
        }
        return String(out)
    }
}
