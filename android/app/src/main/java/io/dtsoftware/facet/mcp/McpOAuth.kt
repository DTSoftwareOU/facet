package io.dtsoftware.facet.mcp

import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.net.await
import io.dtsoftware.facet.core.net.toJsonBody
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.Credentials
import okhttp3.FormBody
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/** An OAuth error response from a token or registration endpoint. */
internal class OAuthErrorException(val error: String?, message: String, val status: Int) : Exception(message)

/** Endpoints and parameters found by discovery. */
internal data class OAuthDiscovery(
    val authorizationEndpoint: String,
    val tokenEndpoint: String,
    val registrationEndpoint: String?,
    val issuer: String?,
    val resource: String,
    val scope: String?,
    val codeChallengeMethods: List<String>?,
)

/**
 * OAuth 2.1 for MCP servers (MCP authorization spec): protected-resource and authorization-server
 * discovery, dynamic client registration (RFC 7591), PKCE (S256), resource indicators (RFC 8707),
 * code exchange and refresh. The browser leg (opening [McpPendingAuth.authorizationUrl] and catching
 * the redirect) belongs to the app.
 */
object McpOAuth {

    /** Discovers endpoints, registers a client if needed, and builds the authorization URL. */
    suspend fun begin(
        serverId: String,
        serverUrl: String,
        wwwAuthenticate: String?,
        redirectUri: String,
        clientName: String,
        http: OkHttpClient,
        previous: McpOAuthState? = null,
    ): McpPendingAuth {
        val d = discover(serverUrl, wwwAuthenticate, http)
        if (d.codeChallengeMethods != null && "S256" !in d.codeChallengeMethods) {
            throw McpException(Strings.get(R.string.mcp_oauth_no_pkce))
        }
        val reuse = previous != null && previous.clientId.isNotBlank() &&
            previous.authorizationEndpoint == d.authorizationEndpoint &&
            previous.tokenEndpoint == d.tokenEndpoint &&
            previous.redirectUri == redirectUri
        val (clientId, clientSecret) = if (reuse) {
            previous.clientId to previous.clientSecret
        } else {
            register(d, redirectUri, clientName, http)
        }
        val verifier = Mcp.randomUrlSafe(48)
        val state = Mcp.randomUrlSafe(24)
        val authUrl = d.authorizationEndpoint.toHttpUrlOrNull()
            ?: throw McpException(Strings.get(R.string.mcp_oauth_invalid_address))
        val url = authUrl.newBuilder()
            .addQueryParameter("response_type", "code")
            .addQueryParameter("client_id", clientId)
            .addQueryParameter("redirect_uri", redirectUri)
            .addQueryParameter("code_challenge", Mcp.s256(verifier))
            .addQueryParameter("code_challenge_method", "S256")
            .addQueryParameter("state", state)
            .addQueryParameter("resource", d.resource)
            .apply { d.scope?.let { addQueryParameter("scope", it) } }
            .build()
        return McpPendingAuth(
            serverId = serverId,
            authorizationUrl = url.toString(),
            state = state,
            codeVerifier = verifier,
            oauth = McpOAuthState(
                authorizationEndpoint = d.authorizationEndpoint,
                tokenEndpoint = d.tokenEndpoint,
                registrationEndpoint = d.registrationEndpoint,
                issuer = d.issuer,
                resource = d.resource,
                scope = d.scope,
                clientId = clientId,
                clientSecret = clientSecret,
                redirectUri = redirectUri,
            ),
        )
    }

    /** Exchanges the authorization code from the redirect for tokens. */
    suspend fun complete(pending: McpPendingAuth, code: String, http: OkHttpClient): McpOAuthState {
        val o = pending.oauth
        val form = linkedMapOf(
            "grant_type" to "authorization_code",
            "code" to code,
            "redirect_uri" to o.redirectUri,
            "client_id" to o.clientId,
            "code_verifier" to pending.codeVerifier,
        )
        o.resource?.let { form["resource"] = it }
        val res = try {
            tokenRequest(o, form, http)
        } catch (e: OAuthErrorException) {
            throw McpException(Strings.get(R.string.mcp_oauth_incomplete, e.message.orEmpty()), e.status)
        }
        return applyTokens(o, res, keepRefresh = null)
    }

    /** Uses the refresh token. Throws [OAuthErrorException] when the grant is no longer valid. */
    internal suspend fun refresh(state: McpOAuthState, http: OkHttpClient): McpOAuthState {
        val refresh = state.refreshToken ?: throw OAuthErrorException("invalid_grant", "No refresh token", 400)
        val form = linkedMapOf(
            "grant_type" to "refresh_token",
            "refresh_token" to refresh,
            "client_id" to state.clientId,
        )
        state.resource?.let { form["resource"] = it }
        return applyTokens(state, tokenRequest(state, form, http), keepRefresh = refresh)
    }

    private fun applyTokens(state: McpOAuthState, res: JsonObject, keepRefresh: String?): McpOAuthState {
        val access = res.str("access_token") ?: throw McpException(Strings.get(R.string.mcp_oauth_no_token))
        val expiresIn = (res["expires_in"] as? JsonPrimitive)?.let { it.longOrNull ?: it.contentOrNull?.toLongOrNull() }
        return state.copy(
            accessToken = access,
            refreshToken = res.str("refresh_token") ?: keepRefresh,
            expiresAt = expiresIn?.let { System.currentTimeMillis() + it * 1000 },
            scope = res.str("scope") ?: state.scope,
        )
    }

    // ---- discovery ----

    internal suspend fun discover(serverUrl: String, wwwAuthenticate: String?, http: OkHttpClient): OAuthDiscovery {
        val server = serverUrl.trim().toHttpUrlOrNull() ?: throw McpException(Strings.get(R.string.mcp_oauth_invalid_url))
        val challenge = parseBearerChallenge(wwwAuthenticate)

        var prm: JsonObject? = challenge["resource_metadata"]?.let { getJson(it, http) }
        if (prm == null) {
            prm = getJson(wellKnown(server, "oauth-protected-resource", includePath = true), http)
                ?: if (server.encodedPath.trimEnd('/').isNotEmpty()) getJson(wellKnown(server, "oauth-protected-resource", includePath = false), http) else null
        }

        val authServer = (prm?.arr("authorization_servers")?.firstOrNull() as? JsonPrimitive)?.contentOrNull
            ?.toHttpUrlOrNull()
            ?: server.newBuilder().encodedPath("/").query(null).fragment(null).build()

        val asHasPath = authServer.encodedPath.trimEnd('/').isNotEmpty()
        val candidates = buildList {
            add(wellKnown(authServer, "oauth-authorization-server", includePath = true))
            add(wellKnown(authServer, "openid-configuration", includePath = true))
            if (asHasPath) add(authServer.toString().trimEnd('/') + "/.well-known/openid-configuration")
        }
        var meta: JsonObject? = null
        for (url in candidates) {
            meta = getJson(url, http)?.takeIf { it.str("authorization_endpoint") != null || it.str("token_endpoint") != null }
            if (meta != null) break
        }

        val origin = originOf(authServer)
        val resource = prm?.str("resource")?.takeIf { it.isNotBlank() } ?: canonicalResource(serverUrl)
        val scope = challenge["scope"]?.takeIf { it.isNotBlank() }
            ?: prm?.arr("scopes_supported")?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }?.joinToString(" ")?.takeIf { it.isNotBlank() }
        return OAuthDiscovery(
            authorizationEndpoint = meta?.str("authorization_endpoint") ?: "$origin/authorize",
            tokenEndpoint = meta?.str("token_endpoint") ?: "$origin/token",
            registrationEndpoint = if (meta != null) meta.str("registration_endpoint") else "$origin/register",
            issuer = meta?.str("issuer"),
            resource = resource,
            scope = scope,
            codeChallengeMethods = meta?.arr("code_challenge_methods_supported")?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull },
        )
    }

    private suspend fun register(d: OAuthDiscovery, redirectUri: String, clientName: String, http: OkHttpClient): Pair<String, String?> {
        val endpoint = d.registrationEndpoint
            ?: throw McpException(Strings.get(R.string.mcp_oauth_registration_required))
        val body = buildJsonObject {
            put("client_name", clientName)
            putJsonArray("redirect_uris") { add(redirectUri) }
            putJsonArray("grant_types") { add("authorization_code"); add("refresh_token") }
            putJsonArray("response_types") { add("code") }
            put("token_endpoint_auth_method", "none")
            d.scope?.let { put("scope", it) }
        }
        val request = Request.Builder().url(endpoint)
            .header("Accept", "application/json")
            .post(Mcp.json.encodeToString(JsonObject.serializer(), body).toJsonBody())
            .build()
        val response = try {
            http.newCall(request).await()
        } catch (e: IOException) {
            throw McpException(Strings.get(R.string.mcp_oauth_unreachable), cause = e)
        }
        val text = response.use { withContext(Dispatchers.IO) { it.body.string() } }
        val json = runCatching { Mcp.json.parseToJsonElement(text) as? JsonObject }.getOrNull()
        if (!response.isSuccessful) {
            val reason = json?.str("error_description") ?: json?.str("error") ?: "HTTP ${response.code}"
            throw McpException(Strings.get(R.string.mcp_oauth_registration_refused, reason), response.code)
        }
        val clientId = json?.str("client_id") ?: throw McpException(Strings.get(R.string.mcp_oauth_no_client_id))
        return clientId to json.str("client_secret")
    }

    // ---- HTTP helpers ----

    private suspend fun getJson(url: String, http: OkHttpClient): JsonObject? {
        val httpUrl = url.toHttpUrlOrNull() ?: return null
        return try {
            val response = http.newCall(Request.Builder().url(httpUrl).header("Accept", "application/json").get().build()).await()
            response.use {
                if (!it.isSuccessful) return null
                val text = withContext(Dispatchers.IO) { it.body.string() }
                Mcp.json.parseToJsonElement(text) as? JsonObject
            }
        } catch (e: IOException) {
            null
        } catch (e: SerializationException) {
            null
        }
    }

    internal suspend fun tokenRequest(state: McpOAuthState, form: Map<String, String>, http: OkHttpClient): JsonObject {
        val body = FormBody.Builder().apply { form.forEach { (k, v) -> add(k, v) } }.build()
        val request = Request.Builder().url(state.tokenEndpoint)
            .header("Accept", "application/json")
            .apply { state.clientSecret?.let { header("Authorization", Credentials.basic(state.clientId, it)) } }
            .post(body)
            .build()
        val response = try {
            http.newCall(request).await()
        } catch (e: IOException) {
            throw McpException(Strings.get(R.string.mcp_oauth_unreachable), cause = e)
        }
        val text = response.use { withContext(Dispatchers.IO) { it.body.string() } }
        val json = runCatching { Mcp.json.parseToJsonElement(text) as? JsonObject }.getOrNull()
        if (!response.isSuccessful || json == null || json.str("error") != null) {
            val error = json?.str("error")
            val description = json?.str("error_description") ?: error ?: "HTTP ${response.code}"
            throw OAuthErrorException(error, description, response.code)
        }
        return json
    }
}
