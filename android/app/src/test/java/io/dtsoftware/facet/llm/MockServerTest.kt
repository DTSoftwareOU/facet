package io.dtsoftware.facet.llm

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Before

/** Shared MockWebServer scaffolding for adapter tests. */
abstract class MockServerTest {
    protected lateinit var server: MockWebServer
    protected val http: OkHttpClient = OkHttpClient.Builder().readTimeout(10, TimeUnit.SECONDS).build()
    protected val quirks = InMemoryQuirkStore()

    @Before
    fun startServer() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun stopServer() {
        server.close()
    }

    protected fun resource(name: String): String =
        requireNotNull(javaClass.classLoader!!.getResource("sse/$name")) { "missing sse/$name" }.readText()

    protected fun sse(name: String): MockResponse = sseBody(resource(name))

    protected fun sseBody(body: String): MockResponse = MockResponse.Builder()
        .code(200)
        .addHeader("Content-Type", "text/event-stream")
        .body(body)
        .build()

    protected fun json(code: Int, body: String, vararg headers: Pair<String, String>): MockResponse =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json")
            .apply { headers.forEach { (k, v) -> addHeader(k, v) } }
            .body(body).build()

    protected fun config(kind: ProviderKind, path: String = "", key: String = "sk-test-key-1234567890") = ProviderConfig(
        id = "p1",
        kind = kind,
        label = "Test",
        baseUrl = server.url(path).toString().trimEnd('/'),
        apiKey = key,
    )

    protected fun collect(client: LlmClient, request: ChatRequest): List<StreamEvent> = runBlocking {
        withTimeout(15_000) { client.stream(request).toList() }
    }

    protected fun RecordedRequest.json(): JsonObject = Json.parseToJsonElement(body!!.utf8()).jsonObject

    protected fun user(text: String) = ChatMessage(Role.USER, listOf(Part.Text(text)))

    protected fun List<StreamEvent>.text() = filterIsInstance<StreamEvent.TextDelta>().joinToString("") { it.text }
    protected fun List<StreamEvent>.thinking() = filterIsInstance<StreamEvent.ThinkingDelta>().joinToString("") { it.text }
    protected inline fun <reified T : StreamEvent> List<StreamEvent>.only(): T = filterIsInstance<T>().single()
    protected inline fun <reified T : StreamEvent> List<StreamEvent>.lastOf(): T = filterIsInstance<T>().last()
}
