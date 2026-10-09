package io.dtsoftware.facet.mcp

import kotlinx.serialization.Serializable

/*
 * Contract for Facet's Model Context Protocol client (remote servers only: Android can't spawn
 * stdio servers). Implementations live in this package; the app talks to [McpClient] and [McpOAuth].
 */

/** How the client authenticates to a server. */
@Serializable
enum class McpAuthMode { NONE, HEADERS, OAUTH }

/** A configured MCP server. Secrets are decrypted only in memory. */
data class McpServerConfig(
    val id: String,
    val name: String,
    /** Streamable HTTP endpoint (e.g. https://mcp.example.com/mcp). Legacy HTTP+SSE endpoints are detected automatically. */
    val url: String,
    val authMode: McpAuthMode = McpAuthMode.NONE,
    /** Static headers (e.g. Authorization: Bearer …) used when [authMode] is HEADERS. */
    val headers: Map<String, String> = emptyMap(),
)

@Serializable
data class McpServerInfo(
    val name: String,
    val version: String? = null,
    val protocolVersion: String,
    /** Server-provided usage instructions, if any (shown to the model with its tools). */
    val instructions: String? = null,
)

@Serializable
data class McpTool(
    val name: String,
    val title: String? = null,
    val description: String? = null,
    /** JSON Schema object for the arguments, as a JSON string. */
    val inputSchemaJson: String = "{\"type\":\"object\",\"properties\":{}}",
    /** MCP tool annotations: hints only, never security guarantees. */
    val readOnlyHint: Boolean? = null,
    val destructiveHint: Boolean? = null,
    val openWorldHint: Boolean? = null,
)

/** Result of tools/call, flattened for the model. */
data class McpCallResult(
    /** Text the model should see: text content, resource text, and a JSON rendering of structuredContent. */
    val text: String,
    val isError: Boolean,
    /** Image content blocks (mimeType to bytes), if the tool returned any. */
    val images: List<Pair<String, ByteArray>> = emptyList(),
)

/** OAuth state persisted per server (client registration + tokens). Stored encrypted by the app. */
@Serializable
data class McpOAuthState(
    val authorizationEndpoint: String,
    val tokenEndpoint: String,
    val registrationEndpoint: String? = null,
    val issuer: String? = null,
    /** RFC 8707 resource indicator for this server. */
    val resource: String? = null,
    val scope: String? = null,
    val clientId: String,
    val clientSecret: String? = null,
    val redirectUri: String,
    val accessToken: String? = null,
    val refreshToken: String? = null,
    /** Epoch ms; null if unknown. */
    val expiresAt: Long? = null,
)

/** Persists [McpOAuthState] per server id. */
interface McpTokenStore {
    fun load(serverId: String): McpOAuthState?
    fun save(serverId: String, state: McpOAuthState?)
}

/** Thrown when the server requires OAuth and no usable token exists. The app should run [McpOAuth.begin]. */
class McpAuthRequiredException(
    val serverId: String,
    /** Value of the WWW-Authenticate header from the 401, used for discovery. */
    val wwwAuthenticate: String?,
) : Exception("This server needs you to sign in.")

/** Any other MCP failure, with a user-facing message. */
class McpException(message: String, val httpStatus: Int? = null, cause: Throwable? = null) : Exception(message, cause)

/** A pending browser sign-in, returned by [McpOAuth.begin]. Keep it until the redirect arrives. */
@Serializable
data class McpPendingAuth(
    val serverId: String,
    /** Open this URL in the browser. */
    val authorizationUrl: String,
    /** Opaque `state` parameter to match the redirect. */
    val state: String,
    val codeVerifier: String,
    /** Partially filled state (endpoints + client registration, no tokens yet). */
    val oauth: McpOAuthState,
)
