package io.dtsoftware.facet.mcp

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockResponseBody
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okio.BufferedSink
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.rules.Timeout
import org.junit.Test

class McpClientTest {
    @get:Rule val timeout: Timeout = Timeout.seconds(30)

    private lateinit var server: MockWebServer
    private val http = OkHttpClient.Builder().readTimeout(10, TimeUnit.SECONDS).build()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()

    @Before fun start() {
        server = MockWebServer()
        server.start()
    }

    @After fun stop() {
        server.close()
    }

    // ---------------------------------------------------------------- helpers

    private class MemoryTokens : McpTokenStore {
        val map = ConcurrentHashMap<String, McpOAuthState>()
        override fun load(serverId: String) = map[serverId]
        override fun save(serverId: String, state: McpOAuthState?) {
            if (state == null) map.remove(serverId) else map[serverId] = state
        }
    }

    private fun config(auth: McpAuthMode = McpAuthMode.NONE, headers: Map<String, String> = emptyMap()) =
        McpServerConfig("srv", "Test Server", server.url("/mcp").toString(), auth, headers)

    private fun RecordedRequest.json(): JsonObject = Mcp.json.parseToJsonElement(body!!.utf8()).jsonObject
    private fun RecordedRequest.rpcMethod(): String? = runCatching { json().str("method") }.getOrNull()
    private fun RecordedRequest.rpcId(): String? = runCatching { (json()["id"] as? JsonPrimitive)?.contentOrNull }.getOrNull()

    private fun jsonResponse(body: String, code: Int = 200, vararg headers: Pair<String, String>) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json")
            .apply { headers.forEach { (k, v) -> addHeader(k, v) } }.body(body).build()

    private fun sseResponse(body: String) =
        MockResponse.Builder().code(200).addHeader("Content-Type", "text/event-stream").body(body).build()

    private fun accepted() = MockResponse.Builder().code(202).build()

    private fun initResult(id: String?, version: String = "2025-11-25", name: String = "fake-server") =
        """{"jsonrpc":"2.0","id":$id,"result":{"protocolVersion":"$version","capabilities":{"tools":{}},"serverInfo":{"name":"$name","version":"1.2.3"},"instructions":"Use me wisely."}}"""

    private fun result(id: String?, result: String) = """{"jsonrpc":"2.0","id":$id,"result":$result}"""

    private val toolsPage = """{"tools":[{"name":"search","title":"Search","description":"Searches things","inputSchema":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]},"annotations":{"readOnlyHint":true,"openWorldHint":true}}]}"""

    /** A minimal Streamable HTTP server. Override [onCall] for tools/call. */
    private open inner class FakeServer(
        val version: String = "2025-11-25",
        val sessionPrefix: String = "s",
    ) : Dispatcher() {
        val initializes = AtomicInteger(0)
        @Volatile var activeSession: String? = null
        @Volatile var initDelayMs = 0L

        open fun onCall(id: String?, params: JsonObject): MockResponse =
            jsonResponse(result(id, """{"content":[{"type":"text","text":"called ${params.str("name")}"}]}"""))

        open fun onList(id: String?, params: JsonObject?): MockResponse = jsonResponse(result(id, toolsPage))

        override fun dispatch(request: RecordedRequest): MockResponse {
            requests += request
            if (request.url.encodedPath != "/mcp") return MockResponse.Builder().code(404).build()
            if (request.method == "DELETE") return MockResponse.Builder().code(204).build()
            val body = request.json()
            val id = (body["id"] as? JsonPrimitive)?.let { if (it.isString) "\"${it.content}\"" else it.content }
            return when (body.str("method")) {
                "initialize" -> {
                    if (initDelayMs > 0) Thread.sleep(initDelayMs)
                    val sid = sessionPrefix + initializes.incrementAndGet()
                    activeSession = sid
                    jsonResponse(initResult(id, version), 200, "Mcp-Session-Id" to sid)
                }
                "notifications/initialized" -> accepted()
                else -> {
                    if (request.headers["Mcp-Session-Id"] != activeSession) return MockResponse.Builder().code(404).build()
                    when (body.str("method")) {
                        "tools/list" -> onList(id, body.obj("params"))
                        "tools/call" -> onCall(id, body.obj("params")!!)
                        else -> jsonResponse("""{"jsonrpc":"2.0","id":$id,"error":{"code":-32601,"message":"Method not found"}}""")
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------- Streamable HTTP

    @Test fun streamableJsonFlow() = runBlocking {
        val fake = FakeServer()
        server.dispatcher = fake
        val client = McpClient(config(), http, MemoryTokens())
        val info = client.connect()
        assertEquals("fake-server", info.name)
        assertEquals("1.2.3", info.version)
        assertEquals("2025-11-25", info.protocolVersion)
        assertEquals("Use me wisely.", info.instructions)

        val tools = client.listTools()
        assertEquals(1, tools.size)
        val t = tools.single()
        assertEquals("search", t.name)
        assertEquals("Search", t.title)
        assertEquals(true, t.readOnlyHint)
        assertEquals(true, t.openWorldHint)
        assertNull(t.destructiveHint)
        assertTrue(t.inputSchemaJson.contains("\"required\":[\"q\"]"))

        val init = requests.first { it.rpcMethod() == "initialize" }
        assertTrue(init.headers["Accept"]!!.contains("application/json"))
        assertTrue(init.headers["Accept"]!!.contains("text/event-stream"))
        assertNull(init.headers["Mcp-Session-Id"])
        val initParams = init.json().obj("params")!!
        assertEquals("2025-11-25", initParams.str("protocolVersion"))
        assertEquals("Facet", initParams.obj("clientInfo")!!.str("name"))

        val list = requests.first { it.rpcMethod() == "tools/list" }
        assertEquals("s1", list.headers["Mcp-Session-Id"])
        assertEquals("2025-11-25", list.headers["MCP-Protocol-Version"])
        assertTrue(requests.any { it.rpcMethod() == "notifications/initialized" && it.headers["Mcp-Session-Id"] == "s1" })
        client.close()
    }

    @Test fun sseResponseWithNotificationAndServerPing() = runBlocking {
        val fake = object : FakeServer() {
            override fun onCall(id: String?, params: JsonObject) = sseResponse(
                "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":1}}\n\n" +
                    "data: {\"jsonrpc\":\"2.0\",\"id\":\"srv-1\",\"method\":\"ping\"}\n\n" +
                    "data: {\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"streamed answer\"}]}}\n\n",
            )

            override fun dispatch(request: RecordedRequest): MockResponse {
                // Responses to server requests carry no method; accept them.
                val body = runCatching { request.json() }.getOrNull()
                if (body != null && body.str("method") == null && request.url.encodedPath == "/mcp") {
                    requests += request
                    return accepted()
                }
                return super.dispatch(request)
            }
        }
        server.dispatcher = fake
        val client = McpClient(config(), http, MemoryTokens())
        val res = client.callTool("search", """{"q":"x"}""")
        assertEquals("streamed answer", res.text)
        assertFalse(res.isError)
        // The ping is answered asynchronously.
        withTimeout(5_000) {
            while (requests.none { it.rpcId() == "srv-1" && it.json().containsKey("result") }) kotlinx.coroutines.delay(20)
        }
        val pong = requests.first { it.rpcId() == "srv-1" }
        assertEquals("s1", pong.headers["Mcp-Session-Id"])
        client.close()
    }

    @Test fun expiredSessionReinitializesOnce() = runBlocking {
        val fake = FakeServer()
        server.dispatcher = fake
        val client = McpClient(config(), http, MemoryTokens())
        client.connect()
        fake.activeSession = "server-restarted" // the server forgot s1
        // Next request gets 404, client re-initializes (s2) and retries.
        val tools = client.listTools()
        assertEquals(1, tools.size)
        assertEquals(2, fake.initializes.get())
        val lists = requests.filter { it.rpcMethod() == "tools/list" }
        assertEquals(listOf("s1", "s2"), lists.map { it.headers["Mcp-Session-Id"] })
        client.close()
    }

    @Test fun acceptsOlderSupportedVersion() = runBlocking {
        server.dispatcher = FakeServer(version = "2025-06-18")
        val client = McpClient(config(), http, MemoryTokens())
        assertEquals("2025-06-18", client.connect().protocolVersion)
        client.listTools()
        assertEquals("2025-06-18", requests.first { it.rpcMethod() == "tools/list" }.headers["MCP-Protocol-Version"])
        client.close()
    }

    @Test fun olderVersionWithoutHeader() = runBlocking {
        server.dispatcher = FakeServer(version = "2025-03-26")
        val client = McpClient(config(), http, MemoryTokens())
        client.listTools()
        assertNull(requests.first { it.rpcMethod() == "tools/list" }.headers["MCP-Protocol-Version"])
        client.close()
    }

    @Test fun rejectsUnsupportedVersion() = runBlocking {
        server.dispatcher = FakeServer(version = "2030-01-01")
        val client = McpClient(config(), http, MemoryTokens())
        try {
            client.connect()
            fail("expected McpException")
        } catch (e: McpException) {
            assertTrue(e.message!!.contains("2030-01-01"))
        }
        client.close()
    }

    @Test fun followsToolPagination() = runBlocking {
        val fake = object : FakeServer() {
            override fun onList(id: String?, params: JsonObject?) = when (params?.str("cursor")) {
                null -> jsonResponse(result(id, """{"tools":[{"name":"a","inputSchema":{"type":"object"}}],"nextCursor":"page2"}"""))
                "page2" -> jsonResponse(result(id, """{"tools":[{"name":"b"}],"nextCursor":""}"""))
                else -> jsonResponse(result(id, """{"tools":[]}"""))
            }
        }
        server.dispatcher = fake
        val client = McpClient(config(), http, MemoryTokens())
        val tools = client.listTools()
        assertEquals(listOf("a", "b"), tools.map { it.name })
        // A tool without inputSchema still gets an object schema.
        assertTrue(tools[1].inputSchemaJson.contains("\"type\":\"object\""))
        client.close()
    }

    @Test fun flattensCallResults() = runBlocking {
        val png = byteArrayOf(-119, 80, 78, 71)
        val b64 = java.util.Base64.getEncoder().encodeToString(png)
        val fake = object : FakeServer() {
            override fun onCall(id: String?, params: JsonObject) = when (params.str("name")) {
                "rich" -> jsonResponse(
                    result(
                        id,
                        """{"content":[{"type":"text","text":"Found 2 items"},{"type":"image","data":"$b64","mimeType":"image/png"},""" +
                            """{"type":"resource","resource":{"uri":"file:///a.txt","text":"hello"}},{"type":"resource_link","uri":"https://x.io/doc","name":"Doc"},""" +
                            """{"type":"audio","data":"AAA","mimeType":"audio/wav"}],"structuredContent":{"count":2}}""",
                    ),
                )
                "dup" -> jsonResponse(result(id, """{"content":[{"type":"text","text":"{\"count\":2}"}],"structuredContent":{"count":2}}"""))
                else -> jsonResponse(result(id, """{"content":[{"type":"text","text":"Permission denied"}],"isError":true}"""))
            }
        }
        server.dispatcher = fake
        val client = McpClient(config(), http, MemoryTokens())

        val rich = client.callTool("rich", "{}")
        assertFalse(rich.isError)
        assertTrue(rich.text.startsWith("Found 2 items"))
        assertTrue(rich.text.contains("[resource: file:///a.txt]\nhello"))
        assertTrue(rich.text.contains("[resource link: Doc (https://x.io/doc)]"))
        assertTrue(rich.text.contains("[audio omitted]"))
        assertTrue(rich.text.contains("\"count\": 2"))
        assertEquals(1, rich.images.size)
        assertEquals("image/png", rich.images[0].first)
        assertArrayEquals(png, rich.images[0].second)

        val dup = client.callTool("dup", "")
        assertEquals("{\"count\":2}", dup.text)

        val err = client.callTool("broken", "{}")
        assertTrue(err.isError)
        assertEquals("Permission denied", err.text)

        try {
            client.callTool("rich", "not json")
            fail("expected McpException")
        } catch (e: McpException) {
            assertTrue(e.message!!.contains("valid JSON"))
        }
        val call = requests.first { it.rpcMethod() == "tools/call" }.json().obj("params")!!
        assertEquals("rich", call.str("name"))
        assertEquals(JsonObject(emptyMap()), call.obj("arguments"))
        client.close()
    }

    @Test fun jsonRpcErrorsBecomeMcpExceptions() = runBlocking {
        val fake = object : FakeServer() {
            override fun onCall(id: String?, params: JsonObject) =
                jsonResponse("""{"jsonrpc":"2.0","id":$id,"error":{"code":-32602,"message":"Unknown tool: nope"}}""")
        }
        server.dispatcher = fake
        val client = McpClient(config(), http, MemoryTokens())
        try {
            client.callTool("nope", "{}")
            fail("expected McpException")
        } catch (e: McpException) {
            assertTrue(e.message!!.contains("Unknown tool: nope"))
            assertTrue(e.message!!.contains("-32602"))
        }
        client.close()
    }

    @Test fun headersModeSendsStaticHeaders() = runBlocking {
        server.dispatcher = FakeServer()
        val client = McpClient(config(McpAuthMode.HEADERS, mapOf("Authorization" to "Bearer static-key", "X-Team" to "core")), http, MemoryTokens())
        client.listTools()
        requests.filter { it.method == "POST" }.forEach {
            assertEquals("Bearer static-key", it.headers["Authorization"])
            assertEquals("core", it.headers["X-Team"])
        }
        client.close()
    }

    @Test fun concurrentCallsShareOneInitialize() = runBlocking {
        val fake = FakeServer()
        fake.initDelayMs = 300
        server.dispatcher = fake
        val client = McpClient(config(), http, MemoryTokens())
        val results = (1..4).map { n -> async(kotlinx.coroutines.Dispatchers.IO) { client.callTool("t$n", "{}") } }.awaitAll()
        assertEquals(listOf("called t1", "called t2", "called t3", "called t4"), results.map { it.text })
        assertEquals(1, fake.initializes.get())
        val ids = requests.filter { it.rpcMethod() == "tools/call" }.map { it.rpcId() }
        assertEquals(ids.size, ids.toSet().size)
        client.close()
    }

    @Test fun unreachableServerMapsToFriendlyError() = runBlocking {
        val port = server.port
        server.close()
        val client = McpClient(McpServerConfig("srv", "Gone", "http://127.0.0.1:$port/mcp"), http, MemoryTokens())
        try {
            client.connect()
            fail("expected McpException")
        } catch (e: McpException) {
            assertTrue(e.message!!.startsWith("Couldn't reach Gone"))
        }
    }

    @Test fun notAnMcpServer() = runBlocking {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) =
                MockResponse.Builder().code(200).addHeader("Content-Type", "text/html").body("<html>hello</html>").build()
        }
        val client = McpClient(config(), http, MemoryTokens())
        try {
            client.connect()
            fail("expected McpException")
        } catch (e: McpException) {
            assertTrue(e.message!!.contains("not as an MCP server"))
        }
    }

    @Test fun closeDeletesSession() = runBlocking {
        server.dispatcher = FakeServer()
        val client = McpClient(config(), http, MemoryTokens())
        client.connect()
        client.close()
        withTimeout(5_000) { while (requests.none { it.method == "DELETE" }) kotlinx.coroutines.delay(20) }
        assertEquals("s1", requests.first { it.method == "DELETE" }.headers["Mcp-Session-Id"])
        try {
            client.listTools()
            fail("expected McpException after close")
        } catch (e: McpException) {
            assertTrue(e.message!!.contains("closed"))
        }
    }

    // ---------------------------------------------------------------- legacy HTTP+SSE

    /** Streams SSE events pushed into [queue] until "END" arrives or the client disconnects. */
    private class StreamingBody(private val queue: LinkedBlockingQueue<String>) : MockResponseBody {
        override val contentLength: Long = -1
        override fun writeTo(sink: BufferedSink) {
            while (true) {
                val next = queue.poll(15, TimeUnit.SECONDS) ?: return
                if (next == "END") return
                sink.writeUtf8(next)
                sink.flush()
            }
        }
    }

    @Test fun fallsBackToLegacyHttpSse() = runBlocking {
        val events = LinkedBlockingQueue<String>()
        events.put("event: endpoint\ndata: /messages?sessionId=abc\n\n")
        val posted = CopyOnWriteArrayList<JsonObject>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when {
                    request.url.encodedPath == "/mcp" && request.method == "POST" -> MockResponse.Builder().code(405).build()
                    request.url.encodedPath == "/mcp" && request.method == "GET" ->
                        MockResponse.Builder().code(200).addHeader("Content-Type", "text/event-stream").body(StreamingBody(events)).build()
                    request.url.encodedPath == "/messages" -> {
                        assertEquals("abc", request.url.queryParameter("sessionId"))
                        val body = request.json()
                        posted += body
                        val id = (body["id"] as? JsonPrimitive)?.content
                        when (body.str("method")) {
                            "initialize" -> events.put("event: message\ndata: ${initResult(id, "2024-11-05", "legacy")}\n\n")
                            "tools/list" -> events.put("event: message\ndata: ${result(id, toolsPage)}\n\n")
                            "tools/call" -> events.put("event: message\ndata: ${result(id, """{"content":[{"type":"text","text":"legacy ok"}]}""")}\n\n")
                        }
                        accepted()
                    }
                    else -> MockResponse.Builder().code(404).build()
                }
            }
        }
        val client = McpClient(config(), http, MemoryTokens())
        val info = client.connect()
        assertEquals("legacy", info.name)
        assertEquals("2024-11-05", info.protocolVersion)
        assertEquals("search", client.listTools().single().name)
        assertEquals("legacy ok", client.callTool("search", """{"q":"a"}""").text)
        assertTrue(posted.any { it.str("method") == "notifications/initialized" })
        client.close()
        events.put("END")
    }

    // ---------------------------------------------------------------- auth

    @Test fun refreshesExpiredTokenAndRetries() = runBlocking {
        val tokens = MemoryTokens()
        tokens.save(
            "srv",
            McpOAuthState(
                authorizationEndpoint = server.url("/authorize").toString(),
                tokenEndpoint = server.url("/token").toString(),
                resource = server.url("/mcp").toString(),
                clientId = "cid",
                redirectUri = "io.dtsoftware.facet:/oauth/mcp",
                accessToken = "old",
                refreshToken = "r1",
            ),
        )
        val fake = FakeServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.url.encodedPath == "/token") {
                    requests += request
                    val form = request.body!!.utf8()
                    assertTrue(form.contains("grant_type=refresh_token"))
                    assertTrue(form.contains("refresh_token=r1"))
                    assertTrue(form.contains("client_id=cid"))
                    assertTrue(form.contains("resource="))
                    return jsonResponse("""{"access_token":"new","refresh_token":"r2","expires_in":3600,"token_type":"Bearer"}""")
                }
                if (request.headers["Authorization"] != "Bearer new") {
                    requests += request
                    return MockResponse.Builder().code(401).addHeader("WWW-Authenticate", "Bearer error=\"invalid_token\"").build()
                }
                return fake.dispatch(request)
            }
        }
        val client = McpClient(config(McpAuthMode.OAUTH), http, tokens)
        assertEquals(1, client.listTools().size)
        val saved = tokens.load("srv")!!
        assertEquals("new", saved.accessToken)
        assertEquals("r2", saved.refreshToken)
        assertNotNull(saved.expiresAt)
        assertEquals(1, requests.count { it.url.encodedPath == "/token" })
        client.close()
    }

    @Test fun refreshesProactivelyBeforeExpiry() = runBlocking {
        val tokens = MemoryTokens()
        tokens.save(
            "srv",
            McpOAuthState(
                authorizationEndpoint = server.url("/authorize").toString(),
                tokenEndpoint = server.url("/token").toString(),
                clientId = "cid",
                redirectUri = "x:/cb",
                accessToken = "about-to-expire",
                refreshToken = "r1",
                expiresAt = System.currentTimeMillis() + 5_000,
            ),
        )
        val fake = FakeServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.url.encodedPath == "/token") return jsonResponse("""{"access_token":"fresh","expires_in":3600}""")
                assertEquals("Bearer fresh", request.headers["Authorization"])
                return fake.dispatch(request)
            }
        }
        val client = McpClient(config(McpAuthMode.OAUTH), http, tokens)
        client.connect()
        assertEquals("fresh", tokens.load("srv")!!.accessToken)
        // The old refresh token is kept when the server doesn't rotate it.
        assertEquals("r1", tokens.load("srv")!!.refreshToken)
        client.close()
    }

    @Test fun rejectedRefreshClearsTokensAndAsksForSignIn() = runBlocking {
        val tokens = MemoryTokens()
        tokens.save(
            "srv",
            McpOAuthState(
                authorizationEndpoint = server.url("/authorize").toString(),
                tokenEndpoint = server.url("/token").toString(),
                clientId = "cid",
                redirectUri = "x:/cb",
                accessToken = "old",
                refreshToken = "revoked",
            ),
        )
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.url.encodedPath == "/token") {
                    jsonResponse("""{"error":"invalid_grant","error_description":"Refresh token revoked"}""", 400)
                } else {
                    MockResponse.Builder().code(401).addHeader("WWW-Authenticate", "Bearer resource_metadata=\"https://x/prm\"").build()
                }
        }
        val client = McpClient(config(McpAuthMode.OAUTH), http, tokens)
        try {
            client.connect()
            fail("expected McpAuthRequiredException")
        } catch (e: McpAuthRequiredException) {
            assertEquals("srv", e.serverId)
            assertEquals("Bearer resource_metadata=\"https://x/prm\"", e.wwwAuthenticate)
        }
        val state = tokens.load("srv")!!
        assertNull(state.accessToken)
        assertNull(state.refreshToken)
        assertEquals("cid", state.clientId) // registration is kept for the next sign-in
        client.close()
    }

    @Test fun authRequiredWithoutTokens() = runBlocking {
        val challenge = "Bearer resource_metadata=\"${server.url("/.well-known/oauth-protected-resource/mcp")}\", scope=\"tools:read\""
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) =
                MockResponse.Builder().code(401).addHeader("WWW-Authenticate", challenge).build()
        }
        val client = McpClient(config(), http, MemoryTokens())
        try {
            client.listTools()
            fail("expected McpAuthRequiredException")
        } catch (e: McpAuthRequiredException) {
            assertEquals(challenge, e.wwwAuthenticate)
        }
        client.close()
    }

    @Test fun insufficientScopeAsksForSignIn() = runBlocking {
        val fake = object : FakeServer() {
            override fun onCall(id: String?, params: JsonObject): MockResponse =
                MockResponse.Builder().code(403).addHeader("WWW-Authenticate", "Bearer error=\"insufficient_scope\", scope=\"admin\"").build()
        }
        server.dispatcher = fake
        val client = McpClient(config(), http, MemoryTokens())
        try {
            client.callTool("x", "{}")
            fail("expected McpAuthRequiredException")
        } catch (e: McpAuthRequiredException) {
            assertTrue(e.wwwAuthenticate!!.contains("insufficient_scope"))
        }
        client.close()
    }
}
