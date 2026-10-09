package io.dtsoftware.facet.core.net

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SseTest {

    private fun read(text: String): List<SseEvent> {
        val reader = SseReader(Buffer().writeUtf8(text))
        return generateSequence { reader.next() }.toList()
    }

    @Test
    fun parsesFieldsMultilineDataAndComments() {
        val events = read(
            ": comment\n" +
                "event: update\n" +
                "id: 7\n" +
                "data: line one\n" +
                "data:line two\n" +
                "\n" +
                "data: {\"a\":1}\n" +
                "\n",
        )
        assertEquals(listOf(SseEvent("update", "line one\nline two", "7"), SseEvent(null, "{\"a\":1}", "7")), events)
    }

    @Test
    fun handlesCrlfAndMissingTrailingBlankLine() {
        val events = read("event: a\r\ndata: x\r\n\r\ndata: tail")
        assertEquals(listOf(SseEvent("a", "x", null), SseEvent(null, "tail", null)), events)
    }

    @Test
    fun ignoresEventsWithoutData() {
        assertEquals(listOf(SseEvent(null, "ok", null)), read("event: ping\n\n: keepalive\n\ndata: ok\n\n"))
        assertEquals(listOf(SseEvent(null, "", null)), read("data\n\n"))
    }

    @Test
    fun flowSurfacesHttpErrors() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse.Builder().code(503).addHeader("Retry-After", "12").body("""{"error":"busy"}""").build())
            try {
                OkHttpClient().sseFlow(Request.Builder().url(server.url("/s")).build()).toList()
                fail("expected HttpStatusException")
            } catch (e: HttpStatusException) {
                assertEquals(503, e.code)
                assertEquals(12L, e.retryAfterSeconds)
                assertTrue(e.body.contains("busy"))
            }
        }
    }

    @Test
    fun cancellingTheCollectorClosesTheCall() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            // First event arrives immediately; the rest of the body trickles for a long time.
            val body = "data: first\n\n" + "data: later\n\n".repeat(2000)
            server.enqueue(
                MockResponse.Builder().code(200).addHeader("Content-Type", "text/event-stream")
                    .body(body).throttleBody(16, 1, TimeUnit.SECONDS).build(),
            )
            val client = OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).build()
            val started = System.nanoTime()
            val first = withTimeout(10_000) { client.sseFlow(Request.Builder().url(server.url("/s")).build()).first() }
            assertEquals("first", first.data)
            val elapsedMs = (System.nanoTime() - started) / 1_000_000
            assertTrue("collection took $elapsedMs ms", elapsedMs < 9_000)
            assertEquals(0, client.dispatcher.runningCallsCount())
        }
    }

    @Test
    fun parsesRetryAfter() {
        assertEquals(5L, HttpStatusException.parseRetryAfter("5"))
        assertEquals(2L, HttpStatusException.parseRetryAfter("1.2"))
        assertNull(HttpStatusException.parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT"))
    }
}
