package io.dtsoftware.facet.mcp

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Talks to a real public MCP server. Off by default; enable with `-Dfacet.mcpLive=true`
 * or the environment variable `FACET_MCP_LIVE=1`.
 */
class McpLiveTest {
    private val enabled = System.getProperty("facet.mcpLive") == "true" || System.getenv("FACET_MCP_LIVE") == "1"

    private class NoTokens : McpTokenStore {
        override fun load(serverId: String): McpOAuthState? = null
        override fun save(serverId: String, state: McpOAuthState?) = Unit
    }

    @Test fun deepWiki() = runBlocking {
        assumeTrue("live MCP test disabled", enabled)
        val http = OkHttpClient.Builder().readTimeout(90, TimeUnit.SECONDS).build()
        val client = McpClient(McpServerConfig("deepwiki", "DeepWiki", "https://mcp.deepwiki.com/mcp"), http, NoTokens())
        try {
            val info = client.connect()
            println("Connected to ${info.name} ${info.version ?: ""} (MCP ${info.protocolVersion})")
            val tools = client.listTools()
            println("Tools: ${tools.joinToString { it.name }}")
            assertTrue(tools.isNotEmpty())
            val structure = tools.firstOrNull { it.name == "read_wiki_structure" } ?: tools.first()
            val result = client.callTool(structure.name, """{"repoName":"modelcontextprotocol/kotlin-sdk"}""")
            println("Call result (${result.text.length} chars, error=${result.isError}): ${result.text.take(300)}")
            assertFalse(result.text.isBlank())
        } finally {
            client.close()
        }
    }
}
