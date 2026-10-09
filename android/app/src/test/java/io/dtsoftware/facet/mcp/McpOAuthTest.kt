package io.dtsoftware.facet.mcp

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.rules.Timeout
import org.junit.Test

class McpOAuthTest {
    @get:Rule val timeout: Timeout = Timeout.seconds(30)

    private lateinit var server: MockWebServer
    private val http = OkHttpClient.Builder().readTimeout(10, TimeUnit.SECONDS).build()
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val redirect = "io.dtsoftware.facet:/oauth/mcp"

    @Before fun start() {
        server = MockWebServer()
        server.start()
    }

    @After fun stop() = server.close()

    private fun json(body: String, code: Int = 200) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

    private fun notFound() = MockResponse.Builder().code(404).build()

    /** Protected resource at /mcp, authorization server at /auth (issuer with a path). */
    private fun standardServer(prmPath: String = "/.well-known/oauth-protected-resource/mcp", withRegistration: Boolean = true, methods: String = "[\"S256\"]") =
        object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val auth = server.url("/auth").toString()
                return when (request.url.encodedPath) {
                    prmPath -> json(
                        """{"resource":"${server.url("/mcp").toString().trimEnd('/')}","authorization_servers":["$auth"],"scopes_supported":["tools:read","tools:write"]}""",
                    )
                    "/.well-known/oauth-authorization-server/auth" -> json(
                        """{"issuer":"$auth","authorization_endpoint":"$auth/authorize","token_endpoint":"$auth/token",""" +
                            (if (withRegistration) """"registration_endpoint":"$auth/register",""" else "") +
                            """"code_challenge_methods_supported":$methods,"response_types_supported":["code"]}""",
                    )
                    "/auth/register" -> json("""{"client_id":"cid-123","client_id_issued_at":1}""", 201)
                    "/auth/token" -> json("""{"access_token":"at-1","refresh_token":"rt-1","expires_in":120,"token_type":"Bearer","scope":"tools:read"}""")
                    else -> notFound()
                }
            }
        }

    @Test fun discoversRegistersAndBuildsAuthorizationUrl() = runBlocking {
        server.dispatcher = standardServer()
        val serverUrl = server.url("/mcp").toString()
        val pending = McpOAuth.begin("srv", serverUrl, null, redirect, "Facet", http)

        val url = pending.authorizationUrl.toHttpUrl()
        assertEquals("/auth/authorize", url.encodedPath)
        assertEquals("code", url.queryParameter("response_type"))
        assertEquals("cid-123", url.queryParameter("client_id"))
        assertEquals(redirect, url.queryParameter("redirect_uri"))
        assertEquals("S256", url.queryParameter("code_challenge_method"))
        assertEquals(Mcp.s256(pending.codeVerifier), url.queryParameter("code_challenge"))
        assertEquals(pending.state, url.queryParameter("state"))
        assertEquals(serverUrl.trimEnd('/'), url.queryParameter("resource"))
        assertEquals("tools:read tools:write", url.queryParameter("scope"))
        assertTrue(pending.codeVerifier.length in 43..128)

        val reg = requests.first { it.url.encodedPath == "/auth/register" }
        val body = reg.body!!.utf8().let { kotlinx.serialization.json.Json.parseToJsonElement(it).jsonObject }
        assertEquals("Facet", (body["client_name"] as JsonPrimitive).content)
        assertEquals(redirect, ((body["redirect_uris"] as JsonArray)[0] as JsonPrimitive).content)
        assertEquals("none", (body["token_endpoint_auth_method"] as JsonPrimitive).content)

        assertEquals("cid-123", pending.oauth.clientId)
        assertNull(pending.oauth.accessToken)

        // Exchange the code.
        val state = McpOAuth.complete(pending, "code-xyz", http)
        assertEquals("at-1", state.accessToken)
        assertEquals("rt-1", state.refreshToken)
        assertEquals("tools:read", state.scope)
        assertNotNull(state.expiresAt)
        val tokenReq = requests.first { it.url.encodedPath == "/auth/token" }
        val form = tokenReq.body!!.utf8()
        assertTrue(form.contains("grant_type=authorization_code"))
        assertTrue(form.contains("code=code-xyz"))
        assertTrue(form.contains("code_verifier=${pending.codeVerifier}"))
        assertTrue(form.contains("client_id=cid-123"))
        assertTrue(form.contains("resource="))
        assertNull(tokenReq.headers["Authorization"]) // public client
    }

    @Test fun usesResourceMetadataFromChallengeAndScopeFromHeader() = runBlocking {
        server.dispatcher = standardServer(prmPath = "/custom/prm")
        val challenge = "Bearer resource_metadata=\"${server.url("/custom/prm")}\", scope=\"tools:read\""
        val pending = McpOAuth.begin("srv", server.url("/mcp").toString(), challenge, redirect, "Facet", http)
        assertEquals("tools:read", pending.authorizationUrl.toHttpUrl().queryParameter("scope"))
        // Path-suffixed well-known was not needed.
        assertTrue(requests.none { it.url.encodedPath == "/.well-known/oauth-protected-resource/mcp" })
    }

    @Test fun reusesPreviousRegistration() = runBlocking {
        server.dispatcher = standardServer()
        val first = McpOAuth.begin("srv", server.url("/mcp").toString(), null, redirect, "Facet", http)
        val before = requests.count { it.url.encodedPath == "/auth/register" }
        val second = McpOAuth.begin("srv", server.url("/mcp").toString(), null, redirect, "Facet", http, previous = first.oauth)
        assertEquals(before, requests.count { it.url.encodedPath == "/auth/register" })
        assertEquals("cid-123", second.oauth.clientId)
    }

    @Test fun fallsBackToOriginWhenNoProtectedResourceMetadata() = runBlocking {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val origin = server.url("/").toString().trimEnd('/')
                return when (request.url.encodedPath) {
                    "/.well-known/oauth-authorization-server" -> json(
                        """{"issuer":"$origin","authorization_endpoint":"$origin/oauth/authorize","token_endpoint":"$origin/oauth/token","registration_endpoint":"$origin/oauth/register"}""",
                    )
                    "/oauth/register" -> json("""{"client_id":"legacy-client"}""")
                    else -> notFound()
                }
            }
        }
        val pending = McpOAuth.begin("srv", server.url("/sse").toString(), null, redirect, "Facet", http)
        assertEquals("/oauth/authorize", pending.authorizationUrl.toHttpUrl().encodedPath)
        assertEquals("legacy-client", pending.oauth.clientId)
        assertNull(pending.authorizationUrl.toHttpUrl().queryParameter("scope"))
    }

    @Test fun defaultEndpointsWhenNoMetadataAtAll() = runBlocking {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return if (request.url.encodedPath == "/register") json("""{"client_id":"d"}""") else notFound()
            }
        }
        val pending = McpOAuth.begin("srv", server.url("/mcp").toString(), null, redirect, "Facet", http)
        assertEquals("/authorize", pending.authorizationUrl.toHttpUrl().encodedPath)
        assertTrue(pending.oauth.tokenEndpoint.endsWith("/token"))
    }

    @Test fun refusesWithoutRegistrationEndpoint() = runBlocking {
        server.dispatcher = standardServer(withRegistration = false)
        try {
            McpOAuth.begin("srv", server.url("/mcp").toString(), null, redirect, "Facet", http)
            fail("expected McpException")
        } catch (e: McpException) {
            assertTrue(e.message!!.contains("registered in advance"))
        }
    }

    @Test fun refusesWithoutS256() = runBlocking {
        server.dispatcher = standardServer(methods = "[\"plain\"]")
        try {
            McpOAuth.begin("srv", server.url("/mcp").toString(), null, redirect, "Facet", http)
            fail("expected McpException")
        } catch (e: McpException) {
            assertTrue(e.message!!.contains("PKCE"))
        }
    }

    @Test fun tokenErrorsAreReadable() = runBlocking {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.url.encodedPath == "/auth/token") {
                    json("""{"error":"invalid_grant","error_description":"Code expired"}""", 400)
                } else {
                    standardServer().dispatch(request)
                }
        }
        val pending = McpOAuth.begin("srv", server.url("/mcp").toString(), null, redirect, "Facet", http)
        try {
            McpOAuth.complete(pending, "old-code", http)
            fail("expected McpException")
        } catch (e: McpException) {
            assertTrue(e.message!!.contains("Code expired"))
        }
    }

    @Test fun confidentialClientUsesBasicAuth() = runBlocking {
        server.dispatcher = standardServer()
        val pending = McpOAuth.begin("srv", server.url("/mcp").toString(), null, redirect, "Facet", http)
        val withSecret = pending.copy(oauth = pending.oauth.copy(clientSecret = "s3cret"))
        McpOAuth.complete(withSecret, "c", http)
        val tokenReq = requests.last { it.url.encodedPath == "/auth/token" }
        assertTrue(tokenReq.headers["Authorization"]!!.startsWith("Basic "))
    }

    @Test fun parsesChallenges() {
        val p = parseBearerChallenge("""Bearer realm="x", resource_metadata="https://a.b/.well-known/oauth-protected-resource", scope="a b", error=insufficient_scope""")
        assertEquals("https://a.b/.well-known/oauth-protected-resource", p["resource_metadata"])
        assertEquals("a b", p["scope"])
        assertEquals("insufficient_scope", p["error"])
        assertTrue(parseBearerChallenge(null).isEmpty())
    }

    @Test fun canonicalizesResources() {
        assertEquals("https://mcp.example.com/mcp", canonicalResource("HTTPS://MCP.Example.com:443/mcp/"))
        assertEquals("http://localhost:8080", canonicalResource("http://localhost:8080/"))
        assertEquals("https://x.io/a", canonicalResource("https://x.io/a?b=1#frag"))
    }
}
