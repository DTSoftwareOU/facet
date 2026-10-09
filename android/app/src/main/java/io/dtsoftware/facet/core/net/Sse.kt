package io.dtsoftware.facet.core.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.BufferedSource

/** One dispatched Server-Sent Event. */
data class SseEvent(val event: String?, val data: String, val id: String?)

/**
 * Incremental Server-Sent Events parser (WHATWG event-stream format) over a blocking source.
 * Handles multi-line `data`, comments, `event`/`id` fields and LF / CRLF line endings.
 * Not thread-safe; one reader per stream.
 */
class SseReader(private val source: BufferedSource) {
    private val data = StringBuilder()
    private var hasData = false
    private var event: String? = null
    private var id: String? = null

    /** Returns the next event, or null at end of stream. Blocks while waiting for data. */
    fun next(): SseEvent? {
        while (true) {
            val line = source.readUtf8Line() ?: return dispatch()
            if (line.isEmpty()) {
                dispatch()?.let { return it }
                continue
            }
            if (line[0] == ':') continue
            val colon = line.indexOf(':')
            val field = if (colon < 0) line else line.substring(0, colon)
            val value = when {
                colon < 0 -> ""
                colon + 1 < line.length && line[colon + 1] == ' ' -> line.substring(colon + 2)
                else -> line.substring(colon + 1)
            }
            when (field) {
                "data" -> {
                    if (hasData) data.append('\n')
                    data.append(value)
                    hasData = true
                }
                "event" -> event = value
                "id" -> if (value.indexOf('\u0000') < 0) id = value
                else -> Unit // "retry" and unknown fields are ignored
            }
        }
    }

    private fun dispatch(): SseEvent? {
        if (!hasData) {
            event = null
            return null
        }
        val ev = SseEvent(event?.takeIf { it.isNotEmpty() }, data.toString(), id)
        data.setLength(0)
        hasData = false
        event = null
        return ev
    }
}

/**
 * Executes [request] and streams its SSE events. Cold: each collection makes a new call.
 * Non-2xx responses surface as [HttpStatusException]; cancelling the collector cancels the call
 * immediately (unblocking the reader thread).
 */
fun OkHttpClient.sseFlow(request: Request): Flow<SseEvent> = callbackFlow {
    val call = newCall(request)
    launch(Dispatchers.IO) {
        try {
            call.execute().use { response ->
                if (!response.isSuccessful) throw HttpStatusException.from(response)
                val reader = SseReader(response.body.source())
                while (true) {
                    val ev = reader.next() ?: break
                    send(ev)
                }
            }
            channel.close()
        } catch (t: Throwable) {
            if (call.isCanceled()) channel.close() else channel.close(t)
        }
    }
    awaitClose { call.cancel() }
}
