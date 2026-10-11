package io.dtsoftware.facet.domain.tools

import android.content.Context
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.db.FacetDatabase
import io.dtsoftware.facet.data.db.McpServerEntity
import io.dtsoftware.facet.mcp.McpAuthMode
import io.dtsoftware.facet.mcp.McpAuthRequiredException
import io.dtsoftware.facet.mcp.McpCallResult
import io.dtsoftware.facet.mcp.McpClient
import io.dtsoftware.facet.mcp.McpException
import io.dtsoftware.facet.mcp.McpOAuth
import io.dtsoftware.facet.mcp.McpOAuthState
import io.dtsoftware.facet.mcp.McpPendingAuth
import io.dtsoftware.facet.mcp.McpServerConfig
import io.dtsoftware.facet.mcp.McpTokenStore
import io.dtsoftware.facet.mcp.McpTool
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient

/**
 * Remote MCP servers: configuration (secrets sealed locally, synced end-to-end encrypted),
 * cached tool lists (so tools are ready in every new chat and after restarts), connections,
 * OAuth sign-in and token refresh. Tokens refreshed on one device sync to the others.
 */
class McpManager(
    context: Context,
    private val db: FacetDatabase,
    private val secrets: SecretBox,
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
    private val onLocalChange: () -> Unit,
) : McpTokenStore {
    private val dao = db.mcpServers()
    private val prefs = context.getSharedPreferences("facet_mcp_pending", Context.MODE_PRIVATE)
    private val clients = ConcurrentHashMap<String, Pair<Long, McpClient>>()
    private val tokenCache = ConcurrentHashMap<String, McpOAuthState>()
    private val refreshLocks = ConcurrentHashMap<String, Mutex>()

    /** Redirect URI registered with authorization servers; MainActivity routes it back here. */
    val redirectUri: String = "${context.packageName}:/oauth/mcp"

    fun observeAll(): Flow<List<McpServerEntity>> = dao.observeAll()
    fun observe(id: String): Flow<McpServerEntity?> = dao.observe(id)
    suspend fun all(): List<McpServerEntity> = dao.all()
    suspend fun get(id: String): McpServerEntity? = dao.get(id)

    // ---- configuration ----

    suspend fun add(name: String, url: String, authMode: McpAuthMode, headers: Map<String, String>): McpServerEntity {
        val now = Clock.now()
        val e = McpServerEntity(
            id = Ids.new(),
            name = name.trim().ifEmpty { hostOf(url) },
            url = url.trim(),
            authMode = authMode.name,
            headersSealed = sealHeaders(headers),
            sort = dao.all().size,
            createdAt = now,
            updatedAt = now,
        )
        dao.upsert(e)
        onLocalChange()
        return e
    }

    suspend fun update(id: String, name: String, url: String, authMode: McpAuthMode, headers: Map<String, String>?) {
        val e = dao.get(id) ?: return
        val urlChanged = e.url != url.trim()
        mutate(id) {
            it.copy(
                name = name.trim().ifEmpty { hostOf(url) },
                url = url.trim(),
                authMode = authMode.name,
                headersSealed = headers?.let { h -> sealHeaders(h) } ?: it.headersSealed,
                oauthSealed = if (urlChanged || authMode != McpAuthMode.OAUTH) "" else it.oauthSealed,
            )
        }
        if (urlChanged) tokenCache.remove(id)
        dropClient(id)
    }

    suspend fun setEnabled(id: String, enabled: Boolean) = mutate(id) { it.copy(enabled = enabled) }
    suspend fun setApproval(id: String, approval: ToolApproval) = mutate(id) { it.copy(approval = approval.name) }

    suspend fun setToolEnabled(id: String, tool: String, enabled: Boolean) = mutate(id) { e ->
        val set = disabledTools(e).toMutableSet().apply { if (enabled) remove(tool) else add(tool) }
        e.copy(disabledToolsJson = AppJson.encodeToString(set.toList()))
    }

    suspend fun setAutoApprove(id: String, tool: String, auto: Boolean) = mutate(id) { e ->
        val set = autoApproved(e).toMutableSet().apply { if (auto) add(tool) else remove(tool) }
        e.copy(autoApprovedJson = AppJson.encodeToString(set.toList()))
    }

    suspend fun delete(id: String) {
        mutate(id) { it.copy(deleted = true, headersSealed = "", oauthSealed = "") }
        tokenCache.remove(id)
        dropClient(id)
    }

    suspend fun signOut(id: String) {
        mutate(id) { it.copy(oauthSealed = "") }
        tokenCache.remove(id)
        dropClient(id)
    }

    private suspend fun mutate(id: String, transform: (McpServerEntity) -> McpServerEntity) {
        val e = dao.get(id) ?: return
        dao.upsert(transform(e).copy(updatedAt = Clock.now(), dirty = true))
        onLocalChange()
    }

    fun tools(e: McpServerEntity): List<McpTool> =
        runCatching { AppJson.decodeFromString<List<McpTool>>(e.toolsJson) }.getOrDefault(emptyList())

    fun disabledTools(e: McpServerEntity): Set<String> =
        runCatching { AppJson.decodeFromString<List<String>>(e.disabledToolsJson).toSet() }.getOrDefault(emptySet())

    fun autoApproved(e: McpServerEntity): Set<String> =
        runCatching { AppJson.decodeFromString<List<String>>(e.autoApprovedJson).toSet() }.getOrDefault(emptySet())

    fun approval(e: McpServerEntity): ToolApproval = runCatching { ToolApproval.valueOf(e.approval) }.getOrDefault(ToolApproval.WRITES)

    fun headers(e: McpServerEntity): Map<String, String> = if (e.headersSealed.isBlank()) emptyMap() else
        runCatching { AppJson.decodeFromString<Map<String, String>>(secrets.openString(e.headersSealed)) }.getOrDefault(emptyMap())

    fun isSignedIn(e: McpServerEntity): Boolean = e.oauthSealed.isNotBlank() || tokenCache[e.id]?.accessToken != null

    private fun sealHeaders(h: Map<String, String>): String =
        if (h.isEmpty()) "" else secrets.sealString(AppJson.encodeToString(h.filterKeys { it.isNotBlank() }))

    private fun config(e: McpServerEntity) = McpServerConfig(
        id = e.id,
        name = e.name,
        url = e.url,
        authMode = runCatching { McpAuthMode.valueOf(e.authMode) }.getOrDefault(McpAuthMode.NONE),
        headers = headers(e),
    )

    /** One live client per server, reused until its connection settings change (token refreshes don't reset it). */
    private fun client(e: McpServerEntity): McpClient {
        val stamp = (e.url + '|' + e.authMode + '|' + e.headersSealed).hashCode().toLong()
        clients[e.id]?.let { (s, c) -> if (s == stamp) return c }
        clients.remove(e.id)?.second?.close()
        val c = McpClient(config(e), http, this)
        clients[e.id] = stamp to c
        return c
    }

    private fun dropClient(id: String) {
        clients.remove(id)?.second?.close()
    }

    // ---- connection ----

    /** Connects, lists tools and caches them. Marks the server "sign in required" when OAuth is needed. */
    suspend fun refreshTools(id: String): Result<List<McpTool>> {
        val e = dao.get(id) ?: return Result.failure(McpException("Server not found."))
        return try {
            val c = client(e)
            val info = c.connect()
            val tools = c.listTools()
            dao.setTools(id, AppJson.encodeToString(tools), Clock.now(), info.instructions?.take(4000))
            Result.success(tools)
        } catch (ex: McpAuthRequiredException) {
            dao.setStatus(id, STATUS_SIGN_IN)
            Result.failure(ex)
        } catch (ex: Exception) {
            dao.setStatus(id, ex.message ?: "Couldn't connect.")
            Result.failure(ex)
        }
    }

    suspend fun call(serverId: String, tool: String, argumentsJson: String): McpCallResult {
        val e = dao.get(serverId)?.takeIf { !it.deleted } ?: throw McpException("That MCP server was removed.")
        return try {
            client(e).callTool(tool, argumentsJson)
        } catch (ex: McpAuthRequiredException) {
            dao.setStatus(serverId, STATUS_SIGN_IN)
            throw McpException("${e.name} needs you to sign in again. Open Settings → MCP servers.")
        }
    }

    /** Refreshes tool lists for servers that have none cached yet (new or synced from another device). */
    fun warmUp() {
        scope.launch {
            dao.all().filter { it.enabled && it.toolsFetchedAt == 0L }.forEach { runCatching { refreshTools(it.id) } }
        }
    }

    // ---- OAuth ----

    /** Starts browser sign-in. Returns the URL to open. */
    suspend fun beginSignIn(id: String): String {
        val e = dao.get(id) ?: throw McpException("Server not found.")
        val previous = load(id)
        val wwwAuth = probeWwwAuthenticate(e)
        val pending = McpOAuth.begin(id, e.url, wwwAuth, redirectUri, "Facet AI", http, previous)
        prefs.edit().putString("pending_" + pending.state, secrets.sealString(AppJson.encodeToString(pending))).apply()
        return pending.authorizationUrl
    }

    /** Finishes sign-in from the redirect. Returns the server id. */
    suspend fun completeSignIn(state: String, code: String): String {
        val sealed = prefs.getString("pending_$state", null) ?: throw McpException("This sign-in link expired. Start again from Settings.")
        prefs.edit().remove("pending_$state").apply()
        val pending = AppJson.decodeFromString<McpPendingAuth>(secrets.openString(sealed))
        val oauth = McpOAuth.complete(pending, code, http)
        save(pending.serverId, oauth)
        mutate(pending.serverId) { it.copy(authMode = McpAuthMode.OAUTH.name, oauthSealed = secrets.sealString(AppJson.encodeToString(oauth))) }
        dropClient(pending.serverId)
        refreshTools(pending.serverId)
        return pending.serverId
    }

    private suspend fun probeWwwAuthenticate(e: McpServerEntity): String? = runCatching {
        client(e).connect()
        null
    }.getOrElse { ex -> (ex as? McpAuthRequiredException)?.wwwAuthenticate }

    // ---- McpTokenStore (called by McpClient, possibly off the main thread) ----

    override fun load(serverId: String): McpOAuthState? {
        tokenCache[serverId]?.let { return it }
        val e = kotlinx.coroutines.runBlocking { dao.get(serverId) } ?: return null
        if (e.oauthSealed.isBlank()) return null
        return runCatching { AppJson.decodeFromString<McpOAuthState>(secrets.openString(e.oauthSealed)) }.getOrNull()
            ?.also { tokenCache[serverId] = it }
    }

    override fun save(serverId: String, state: McpOAuthState?) {
        if (state == null) tokenCache.remove(serverId) else tokenCache[serverId] = state
        scope.launch {
            refreshLocks.getOrPut(serverId) { Mutex() }.withLock {
                val e = dao.get(serverId) ?: return@withLock
                val sealed = state?.let { secrets.sealString(AppJson.encodeToString(it)) } ?: ""
                dao.upsert(e.copy(oauthSealed = sealed, updatedAt = Clock.now(), dirty = true))
                onLocalChange()
            }
        }
    }

    companion object {
        const val STATUS_SIGN_IN = "Sign in required"
        fun hostOf(url: String) = runCatching { java.net.URI(url.trim()).host?.removePrefix("www.") }.getOrNull() ?: "MCP server"
    }
}
