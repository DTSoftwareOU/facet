package io.dtsoftware.facet.core.net

import java.io.IOException
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

val JsonMediaType = "application/json; charset=utf-8".toMediaType()

fun String.toJsonBody(): RequestBody = toRequestBody(JsonMediaType)

/** A non-2xx HTTP response. [body] is the (truncated) response body, useful for error mapping. */
class HttpStatusException(
    val code: Int,
    val body: String,
    val retryAfterSeconds: Long?,
) : IOException("HTTP $code") {
    companion object {
        private const val MAX_BODY = 64 * 1024

        /** Consumes and closes [response]. */
        fun from(response: Response): HttpStatusException {
            val body = runCatching {
                response.body.source().let { src ->
                    src.request(MAX_BODY.toLong())
                    val n = minOf(src.buffer.size, MAX_BODY.toLong())
                    src.buffer.readUtf8(n)
                }
            }.getOrDefault("")
            response.close()
            return HttpStatusException(response.code, body, parseRetryAfter(response.header("retry-after")))
        }

        fun parseRetryAfter(value: String?): Long? {
            if (value.isNullOrBlank()) return null
            value.trim().toLongOrNull()?.let { return it.coerceAtLeast(0) }
            value.trim().toDoubleOrNull()?.let { return kotlin.math.ceil(it).toLong().coerceAtLeast(0) }
            return null
        }
    }
}

/** Suspends until the response headers arrive. Cancelling the coroutine cancels the call. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) {
            cont.resume(response) { _, value, _ -> value.close() }
        }

        override fun onFailure(call: Call, e: IOException) {
            cont.resumeWithException(e)
        }
    })
}

/** Executes [request] and returns the body as a string. Throws [HttpStatusException] on non-2xx. */
suspend fun OkHttpClient.fetchString(request: Request): String {
    val response = newCall(request).await()
    if (!response.isSuccessful) throw HttpStatusException.from(response)
    return response.use { it.body.string() }
}
