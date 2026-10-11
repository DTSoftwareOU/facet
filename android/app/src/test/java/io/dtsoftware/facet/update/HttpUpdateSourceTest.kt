package io.dtsoftware.facet.update

import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class HttpUpdateSourceTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var server: MockWebServer
    private val http = OkHttpClient.Builder().readTimeout(10, TimeUnit.SECONDS).build()

    private val apk = ByteArray(300_000) { (it % 251).toByte() }
    private val sha = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }

    @Before
    fun start() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun stop() {
        server.close()
    }

    private fun source() = HttpUpdateSource(http, server.url("/download/android/latest.json").toString(), requireHttps = false)

    private fun manifest(size: Long = apk.size.toLong()) =
        UpdateManifest(2, "1.1.0", server.url("/download/android/facet-1.1.0.apk").toString(), sha, size)

    private fun dest() = File(tmp.root, "updates/facet-2.apk")

    private fun apkResponse(body: ByteArray, code: Int = 200) = MockResponse.Builder()
        .code(code)
        .addHeader("Content-Type", "application/vnd.android.package-archive")
        .body(Buffer().write(body))
        .build()

    private fun expectError(expected: UpdateError, block: suspend () -> Unit) {
        val e = runCatching { runBlocking { block() } }.exceptionOrNull()
        assertTrue("expected $expected, got $e", e is UpdateException && e.error == expected)
    }

    @Test
    fun fetchesTheManifestUncached() = runBlocking {
        server.enqueue(
            MockResponse.Builder().code(200).addHeader("Content-Type", "application/json")
                .body("""{"versionCode":2,"versionName":"1.1.0","url":"https://facet.dtsoftware.io/download/android/facet-1.1.0.apk","sha256":"$sha","size":${apk.size},"notes":"Faster sync."}""")
                .build(),
        )
        val m = source().fetchManifest()
        assertEquals(2L, m.versionCode)
        assertEquals("Faster sync.", m.notes)
        val request = server.takeRequest()
        assertEquals("/download/android/latest.json", request.url.encodedPath)
        assertEquals("no-cache", request.headers["Cache-Control"])
    }

    @Test
    fun serverErrorIsACheckError() {
        server.enqueue(MockResponse.Builder().code(503).body("busy").build())
        expectError(UpdateError.CHECK) { source().fetchManifest() }
    }

    @Test
    fun unreadableManifestIsReported() {
        server.enqueue(MockResponse.Builder().code(200).body("<html>Not here</html>").build())
        expectError(UpdateError.BAD_MANIFEST) { source().fetchManifest() }
    }

    @Test
    fun offlineIsACheckError() {
        val url = server.url("/download/android/latest.json").toString()
        server.close()
        expectError(UpdateError.CHECK) { HttpUpdateSource(http, url, requireHttps = false).fetchManifest() }
    }

    @Test
    fun downloadsWithProgressAndVerifies() = runBlocking {
        server.enqueue(apkResponse(apk))
        val progress = mutableListOf<Long>()
        source().download(manifest(), dest()) { bytes, total ->
            assertEquals(apk.size.toLong(), total)
            progress += bytes
        }
        assertArrayEquals(apk, dest().readBytes())
        assertEquals(0L, progress.first())
        assertEquals(apk.size.toLong(), progress.last())
        assertTrue("progress reported along the way", progress.size > 3)
        assertEquals(progress.sorted(), progress)
        assertFalse(File(dest().path + ".part").exists())
    }

    @Test
    fun tamperedDownloadLeavesNothingBehind() {
        val tampered = apk.copyOf().also { it[1234] = (it[1234] + 1).toByte() }
        server.enqueue(apkResponse(tampered))
        expectError(UpdateError.CORRUPT) { source().download(manifest(), dest()) { _, _ -> } }
        assertFalse(dest().exists())
        assertFalse(File(dest().path + ".part").exists())
    }

    @Test
    fun truncatedDownloadIsCorrupt() {
        server.enqueue(apkResponse(apk.copyOf(apk.size - 10)))
        expectError(UpdateError.CORRUPT) { source().download(manifest(), dest()) { _, _ -> } }
        assertFalse(dest().exists())
    }

    @Test
    fun downloadLargerThanAdvertisedStopsEarly() {
        server.enqueue(apkResponse(apk))
        var maxSeen = 0L
        expectError(UpdateError.CORRUPT) { source().download(manifest(size = 1000), dest()) { bytes, _ -> maxSeen = maxOf(maxSeen, bytes) } }
        assertTrue(maxSeen <= 1000)
        assertFalse(dest().exists())
    }

    @Test
    fun httpErrorIsADownloadError() {
        server.enqueue(apkResponse("missing".toByteArray(), code = 404))
        expectError(UpdateError.DOWNLOAD) { source().download(manifest(), dest()) { _, _ -> } }
        assertFalse(dest().exists())
    }

    @Test
    fun replacesAStaleFile() = runBlocking {
        dest().parentFile!!.mkdirs()
        dest().writeText("old")
        server.enqueue(apkResponse(apk))
        source().download(manifest(), dest()) { _, _ -> }
        assertArrayEquals(apk, dest().readBytes())
    }
}
