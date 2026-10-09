package io.dtsoftware.facet.mcp

// TEMPORARY stand-ins so the app compiles while the MCP client is built on its own branch.
// Delete this file when merging that branch.

import okhttp3.OkHttpClient

class McpClient(val config: McpServerConfig, http: OkHttpClient, tokens: McpTokenStore) {
    suspend fun connect(): McpServerInfo = throw McpException("pending merge")
    suspend fun listTools(): List<McpTool> = emptyList()
    suspend fun callTool(name: String, argumentsJson: String): McpCallResult = throw McpException("pending merge")
    fun close() {}
}

object McpOAuth {
    suspend fun begin(
        serverId: String,
        serverUrl: String,
        wwwAuthenticate: String?,
        redirectUri: String,
        clientName: String,
        http: OkHttpClient,
        previous: McpOAuthState? = null,
    ): McpPendingAuth = throw McpException("pending merge")

    suspend fun complete(pending: McpPendingAuth, code: String, http: OkHttpClient): McpOAuthState = throw McpException("pending merge")
}
