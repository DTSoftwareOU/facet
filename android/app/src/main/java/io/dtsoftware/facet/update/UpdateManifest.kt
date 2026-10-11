package io.dtsoftware.facet.update

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * The Android update manifest, `latest.json` (docs/UPDATES.md): the newest release's versionCode
 * and versionName, where its APK lives, the APK's SHA-256 and size, and release notes.
 */
@Serializable
data class UpdateManifest(
    val versionCode: Long,
    val versionName: String,
    val url: String,
    val sha256: String,
    val size: Long,
    val notes: String = "",
) {
    /** Release notes, one change per line, without list markers. */
    val noteLines: List<String>
        get() = notes.lines()
            .map { line -> line.trim().removePrefix("-").removePrefix("•").removePrefix("*").trim() }
            .filter { it.isNotEmpty() }

    companion object {
        /** Far above any real Facet APK; rejects a malformed size before anything is downloaded. */
        const val MAX_SIZE = 512L * 1024 * 1024

        private val json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
            coerceInputValues = true
        }
        private val SHA256_HEX = Regex("^[0-9a-fA-F]{64}$")

        /**
         * Parses and validates a manifest. Unknown fields are ignored; null when a required field is
         * missing or malformed. The APK must be served over HTTPS unless [requireHttps] is off (tests).
         */
        fun parse(text: String, requireHttps: Boolean = true): UpdateManifest? {
            val m = runCatching { json.decodeFromString<UpdateManifest>(text) }.getOrNull() ?: return null
            val url = m.url.trim().toHttpUrlOrNull() ?: return null
            if (requireHttps && !url.isHttps) return null
            val sha = m.sha256.trim()
            if (m.versionCode <= 0 || m.versionName.isBlank() || !SHA256_HEX.matches(sha) || m.size !in 1..MAX_SIZE) return null
            return m.copy(versionName = m.versionName.trim(), url = url.toString(), sha256 = sha.lowercase(), notes = m.notes.trim())
        }

        fun encode(manifest: UpdateManifest): String = json.encodeToString(serializer(), manifest)
    }
}
