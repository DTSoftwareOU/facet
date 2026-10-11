package io.dtsoftware.facet.update

import androidx.annotation.StringRes
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.net.await
import io.dtsoftware.facet.core.net.fetchString
import io.dtsoftware.facet.update.ApkVerifier.toHex
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/** What went wrong, in words for the person using Facet (docs/DESIGN.md "Voice"). */
enum class UpdateError(@StringRes val messageRes: Int) {
    CHECK(R.string.updater_error_check),
    BAD_MANIFEST(R.string.updater_error_bad_manifest),
    DOWNLOAD(R.string.updater_error_download),
    NO_SPACE(R.string.updater_error_no_space),
    CORRUPT(R.string.updater_error_corrupt),
    NOT_FACET(R.string.updater_error_not_facet),
    INSTALL(R.string.updater_error_install),
    INSTALL_CONFLICT(R.string.updater_error_install_conflict),
    INSTALL_STORAGE(R.string.updater_error_install_storage),
    ;

    /** The message in the app's language. */
    val message: String get() = Strings.get(messageRes)

    /** The check failed, not the update itself; retrying the update is still "Update". */
    val isCheck: Boolean get() = this == CHECK || this == BAD_MANIFEST
}

class UpdateException(val error: UpdateError, cause: Throwable? = null) : Exception(error.name, cause)

/** Where updates come from. */
interface UpdateSource {
    /** Fetches and validates the manifest. Throws [UpdateException] ([UpdateError.CHECK] or [UpdateError.BAD_MANIFEST]). */
    suspend fun fetchManifest(): UpdateManifest

    /**
     * Downloads [manifest]'s APK to [dest], checking its size and SHA-256 while it streams. [dest] only
     * appears once it matches. Throws [UpdateException] ([UpdateError.DOWNLOAD] or [UpdateError.CORRUPT]).
     */
    suspend fun download(manifest: UpdateManifest, dest: File, onProgress: (bytes: Long, total: Long) -> Unit)
}

/** [UpdateSource] over the app's OkHttp client (shared connection pool), with timeouts suited to updates. */
class HttpUpdateSource(
    http: OkHttpClient,
    private val manifestUrl: String = UpdateConfig.MANIFEST_URL,
    private val requireHttps: Boolean = true,
) : UpdateSource {
    // The app client waits minutes for slow model replies; a stalled download should fail much sooner.
    private val client = http.newBuilder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val manifestClient = client.newBuilder().callTimeout(20, TimeUnit.SECONDS).build()

    override suspend fun fetchManifest(): UpdateManifest {
        val request = Request.Builder().url(manifestUrl).header("Cache-Control", "no-cache").build()
        val text = try {
            manifestClient.fetchString(request)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw UpdateException(UpdateError.CHECK, e)
        }
        return UpdateManifest.parse(text, requireHttps) ?: throw UpdateException(UpdateError.BAD_MANIFEST)
    }

    override suspend fun download(manifest: UpdateManifest, dest: File, onProgress: (bytes: Long, total: Long) -> Unit) {
        val dir = dest.absoluteFile.parentFile ?: throw UpdateException(UpdateError.DOWNLOAD)
        dir.mkdirs()
        val part = File(dir, dest.name + ".part")
        val call = client.newCall(Request.Builder().url(manifest.url).build())
        try {
            coroutineScope {
                // A blocked socket read doesn't notice coroutine cancellation; cancelling the call does.
                val canceller = launch { try { awaitCancellation() } finally { call.cancel() } }
                try {
                    val response = try { call.await() } catch (e: IOException) { throw UpdateException(UpdateError.DOWNLOAD, e) }
                    withContext(Dispatchers.IO) {
                        response.use { r ->
                            if (!r.isSuccessful) throw UpdateException(UpdateError.DOWNLOAD, IOException("HTTP ${r.code}"))
                            val digest = MessageDigest.getInstance("SHA-256")
                            var received = 0L
                            var lastPercent = -1L
                            onProgress(0, manifest.size)
                            try {
                                r.body.byteStream().use { input ->
                                    part.outputStream().use { out ->
                                        val buf = ByteArray(64 * 1024)
                                        while (true) {
                                            ensureActive()
                                            val n = input.read(buf)
                                            if (n < 0) break
                                            received += n
                                            if (received > manifest.size) throw UpdateException(UpdateError.CORRUPT)
                                            digest.update(buf, 0, n)
                                            out.write(buf, 0, n)
                                            val percent = received * 100 / manifest.size
                                            if (percent != lastPercent) {
                                                lastPercent = percent
                                                onProgress(received, manifest.size)
                                            }
                                        }
                                    }
                                }
                            } catch (e: IOException) {
                                ensureActive()
                                throw UpdateException(UpdateError.DOWNLOAD, e)
                            }
                            if (received != manifest.size || digest.digest().toHex() != manifest.sha256.lowercase()) {
                                throw UpdateException(UpdateError.CORRUPT)
                            }
                        }
                        dest.delete()
                        if (!part.renameTo(dest)) throw UpdateException(UpdateError.DOWNLOAD)
                    }
                } finally {
                    canceller.cancel()
                }
            }
        } finally {
            part.delete()
        }
    }
}
