package io.dtsoftware.facet.remote

import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.RelayCrypto
import io.dtsoftware.facet.core.crypto.ReplayGuard
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Ids
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The account's PCs that this device can use (docs/REMOTE.md, "Discovery"), and the client for
 * their methods. Hosts live in memory only: on the stream's `ready` this device asks the server
 * for the online sessions and says `hello` to each; PCs answer with a `host` message. Everything
 * between the devices is sealed with a key derived from the vault key; the server only forwards it.
 */
class RemoteHosts(
    private val scope: CoroutineScope,
    private val transport: RelayTransport,
    private val known: KnownHostStore? = null,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    private val _hosts = MutableStateFlow<Map<String, RemoteHost>>(emptyMap())
    /** Online PCs by hostId (with or without remote use switched on). */
    val hosts: StateFlow<Map<String, RemoteHost>> = _hosts.asStateFlow()

    private val _names = MutableStateFlow(known?.names().orEmpty())
    /** Names of PCs seen on this device, including offline ones. */
    val knownNames: StateFlow<Map<String, String>> = _names.asStateFlow()

    private val _lastUsed = MutableStateFlow(known?.lastUsed())
    /** The PC this device used last (chats that haven't chosen a PC prefer it). */
    val lastUsed: StateFlow<String?> = _lastUsed.asStateFlow()

    private class Pending(val sessionId: String, val result: CompletableDeferred<JsonObject>)
    private class Cached<T>(val sessionId: String, val version: String, val value: T)

    private val events = Channel<Pair<String, String>>(Channel.UNLIMITED)
    private val guard = ReplayGuard()
    private val pending = ConcurrentHashMap<String, Pending>()
    private val toolsCache = ConcurrentHashMap<String, Cached<List<ComputerToolInfo>>>()
    private val infoCache = ConcurrentHashMap<String, Cached<ComputerInfo>>()
    private val warming: MutableSet<String> = ConcurrentHashMap.newKeySet()
    @Volatile private var keyCache: Pair<ByteArray, ByteArray>? = null

    init {
        transport.listen { event, data -> events.trySend(event to data) }
        scope.launch {
            for ((event, data) in events) {
                try {
                    handle(event, data)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // A malformed event never stops the loop.
                }
            }
        }
    }

    /** The PC's name, from the online host or remembered; null when this device never saw it. */
    fun nameOf(hostId: String): String? = _hosts.value[hostId]?.name ?: _names.value[hostId]

    /** The PC a chat that hasn't chosen one uses now (docs/REMOTE.md); see [pickAutomatic]. */
    fun automatic(hosts: Map<String, RemoteHost> = _hosts.value): RemoteHost? = pickAutomatic(hosts.values, _lastUsed.value)

    /** Notes that this device used [hostId], so chats that haven't chosen a PC prefer it. */
    fun markUsed(hostId: String) {
        if (hostId == NO_PC || _lastUsed.value == hostId) return
        _lastUsed.value = hostId
        known?.markUsed(hostId)
    }

    // ---- stream events ----

    private fun handle(event: String, data: String) {
        when (event) {
            "ready" -> onReady()
            "presence" -> {
                val obj = RelayMessages.parse(data) ?: return
                val session = obj.str("sessionId") ?: return
                if ((obj["online"] as? JsonPrimitive)?.content == "true") scope.launch { hello(session) } else dropSession(session)
            }
            "relay" -> {
                val obj = RelayMessages.parse(data) ?: return
                receive(obj.str("from") ?: return, obj.str("msg") ?: return)
            }
            // Keep the last known hosts across reconnects (`ready` reconciles them); forget them when signed out.
            "closed" -> if (transport.sessionId == null || transport.vaultKey() == null) clear()
        }
    }

    private fun onReady() {
        val readyAt = clock()
        scope.launch {
            val peers = try {
                transport.peers().toSet()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return@launch
            }
            // Hosts whose session went away while the stream was down, unless they spoke up since.
            val gone = _hosts.value.values.filter { it.sessionId !in peers && it.seenAt < readyAt }.map { it.sessionId }.toSet()
            gone.forEach(::dropSession)
            peers.forEach { session -> launch { hello(session) } }
        }
    }

    private suspend fun hello(session: String) {
        runCatching { sendTo(session, RelayMessages.hello(Ids.new(), clock())) }
    }

    private fun relayKey(): ByteArray? {
        val vault = transport.vaultKey() ?: return null
        keyCache?.let { (v, k) -> if (v.contentEquals(vault)) return k }
        return RelayCrypto.relayKey(vault).also { keyCache = vault.copyOf() to it }
    }

    private fun receive(from: String, envelopeB64: String) {
        val me = transport.sessionId ?: return
        val key = relayKey() ?: return
        val envelope = runCatching { FacetCrypto.unb64(envelopeB64) }.getOrNull() ?: return
        // Anything that doesn't decrypt for this pair of sessions is dropped.
        val json = runCatching { RelayCrypto.open(key, from, me, envelope) }.getOrNull() ?: return
        val msg = RelayMessages.parse(json) ?: return
        if (msg.long("v") != RelayMessages.VERSION.toLong()) return
        if (!guard.accept(msg.str("id"), msg.long("ts"), clock())) return
        when (msg.str("type")) {
            "host" -> RemoteHost.parse(msg, from, clock())?.let(::upsert)
            "result" -> msg.str("re")?.let { re -> pending[re]?.takeIf { it.sessionId == from }?.result?.complete(msg) }
            else -> Unit // This device isn't a host: hello, call and cancel aren't for it.
        }
    }

    private fun upsert(host: RemoteHost) {
        val previous = _hosts.value[host.hostId]
        // One session speaks for one host; the newest session for a host wins.
        _hosts.update { m -> m.filterValues { it.sessionId != host.sessionId || it.hostId == host.hostId } + (host.hostId to host) }
        if (_names.value[host.hostId] != host.name) {
            known?.remember(host.hostId, host.name)
            _names.update { it + (host.hostId to host.name) }
        }
        if (previous != null && previous.sessionId != host.sessionId) {
            failPending(previous.sessionId) { RemoteException(RemoteException.OFFLINE, Strings.get(R.string.remote_error_restarted, host.name)) }
        }
        // Warm the tool list so the first reply on this PC doesn't wait for it.
        if (host.remote && host.has(RemoteFeature.COMPUTER) && cached(toolsCache, host) == null && warming.add(host.hostId)) {
            scope.launch {
                try {
                    if (runCatching { computerTools(host.hostId) }.isSuccess) runCatching { computerInfo(host.hostId) }
                } finally {
                    warming.remove(host.hostId)
                }
            }
        }
    }

    private fun dropSession(session: String) {
        val names = _hosts.value.values.filter { it.sessionId == session }.map { it.name }
        _hosts.update { m -> m.filterValues { it.sessionId != session } }
        val name = names.firstOrNull()
        failPending(session) {
            RemoteException(
                RemoteException.OFFLINE,
                if (name != null) Strings.get(R.string.remote_error_went_offline, name) else Strings.get(R.string.remote_error_pc_went_offline),
            )
        }
    }

    private fun failPending(session: String, error: () -> RemoteException) {
        pending.values.filter { it.sessionId == session }.forEach { it.result.completeExceptionally(error()) }
    }

    private fun clear() {
        _hosts.value = emptyMap()
        toolsCache.clear()
        infoCache.clear()
        pending.values.forEach { it.result.completeExceptionally(RemoteException(RemoteException.NOT_CONNECTED, Strings.get(R.string.remote_error_signed_out))) }
    }

    // ---- sending ----

    private suspend fun sendTo(session: String, msg: JsonObject) {
        val me = transport.sessionId ?: throw RemoteException(RemoteException.NOT_CONNECTED, Strings.get(R.string.remote_error_sign_in))
        val key = relayKey() ?: throw RemoteException(RemoteException.NOT_CONNECTED, Strings.get(R.string.remote_error_sign_in))
        val envelope = RelayCrypto.seal(key, me, session, RelayMessages.encode(msg))
        try {
            transport.send(session, FacetCrypto.b64(envelope))
        } catch (e: PeerOfflineException) {
            // The host went away: fail at once and treat it as offline.
            val name = _hosts.value.values.firstOrNull { it.sessionId == session }?.name
            dropSession(session)
            throw RemoteException(
                RemoteException.OFFLINE,
                if (name != null) Strings.get(R.string.remote_error_offline, name) else Strings.get(R.string.remote_error_pc_offline),
            )
        } catch (e: io.dtsoftware.facet.sync.ApiException) {
            throw RemoteException("failed", e.message ?: Strings.get(R.string.remote_error_relay_failed))
        } catch (e: io.dtsoftware.facet.sync.AuthException) {
            throw RemoteException(RemoteException.NOT_CONNECTED, e.message ?: Strings.get(R.string.remote_error_sign_in))
        } catch (e: IOException) {
            throw RemoteException(RemoteException.NOT_CONNECTED, Strings.get(R.string.remote_error_unreachable))
        }
    }

    private suspend fun ensureConnected() {
        if (transport.sessionId == null || transport.vaultKey() == null) {
            throw RemoteException(RemoteException.NOT_CONNECTED, Strings.get(R.string.remote_error_sign_in))
        }
        if (transport.connected.value) return
        withTimeoutOrNull(CONNECT_TIMEOUT_MS) { transport.connected.first { it } }
            ?: throw RemoteException(RemoteException.NOT_CONNECTED, Strings.get(R.string.remote_error_unreachable))
    }

    /**
     * Calls [method] on the PC [hostId] and returns its value. Keeps the stream open while it waits (also in the
     * background). Cancelling a `computer.call` asks the PC to stop it. Throws [RemoteException].
     */
    suspend fun call(
        hostId: String,
        method: String,
        params: JsonObject = JsonObject(emptyMap()),
        timeoutMs: Long = RemoteMethod.timeoutMs(method),
    ): JsonElement {
        val release = transport.holdStream()
        try {
            ensureConnected()
            val host = _hosts.value[hostId] ?: throw RemoteException(
                RemoteException.OFFLINE,
                nameOf(hostId)?.let { Strings.get(R.string.remote_error_offline, it) } ?: Strings.get(R.string.remote_error_your_pc_offline),
            )
            val id = Ids.new()
            val result = CompletableDeferred<JsonObject>()
            pending[id] = Pending(host.sessionId, result)
            try {
                sendTo(host.sessionId, RelayMessages.call(id, clock(), method, params))
                val msg = withTimeoutOrNull(timeoutMs) { result.await() }
                    ?: throw RemoteException(RemoteException.TIMEOUT, Strings.get(R.string.remote_error_no_answer, host.name))
                return try {
                    RelayMessages.resultValue(msg)
                } catch (e: RemoteException) {
                    if (e.code == RemoteException.REMOTE_DISABLED) {
                        _hosts.update { m -> m[hostId]?.let { m + (hostId to it.copy(remote = false)) } ?: m }
                        throw RemoteException(e.code, turnOnHint(host.name))
                    }
                    throw e
                }
            } catch (e: CancellationException) {
                // Stopping a reply stops the command on the PC too (best effort).
                if (method == RemoteMethod.COMPUTER_CALL) {
                    scope.launch { runCatching { sendTo(host.sessionId, RelayMessages.cancel(Ids.new(), clock(), id)) } }
                }
                throw e
            } finally {
                pending.remove(id)
            }
        } finally {
            release()
        }
    }

    private fun <T> decode(value: JsonElement, serializer: kotlinx.serialization.KSerializer<T>): T = try {
        AppJson.decodeFromJsonElement(serializer, value)
    } catch (e: Exception) {
        throw RemoteException("bad_response", Strings.get(R.string.remote_error_bad_response))
    }

    private fun <T> cached(cache: ConcurrentHashMap<String, Cached<T>>, host: RemoteHost): T? =
        cache[host.hostId]?.takeIf { it.sessionId == host.sessionId && it.version == host.version }?.value

    /** The PC's computer tools (cached until it restarts or updates). */
    suspend fun computerTools(hostId: String): List<ComputerToolInfo> {
        _hosts.value[hostId]?.let { h -> cached(toolsCache, h)?.let { return it } }
        val value = call(hostId, RemoteMethod.COMPUTER_TOOLS)
        val tools = decode(value, ListSerializer(ComputerToolInfo.serializer()))
        _hosts.value[hostId]?.let { h -> toolsCache[hostId] = Cached(h.sessionId, h.version, tools) }
        return tools
    }

    /** The PC's OS, shell, home folder, user and hostname (cached like [computerTools]). */
    suspend fun computerInfo(hostId: String): ComputerInfo {
        _hosts.value[hostId]?.let { h -> cached(infoCache, h)?.let { return it } }
        val info = decode(call(hostId, RemoteMethod.COMPUTER_INFO), ComputerInfo.serializer())
        _hosts.value[hostId]?.let { h -> infoCache[hostId] = Cached(h.sessionId, h.version, info) }
        return info
    }

    /** Runs a computer tool in [cwd] on the PC. [callId] identifies it to the PC. */
    suspend fun computerCall(hostId: String, name: String, argumentsJson: String, cwd: String, callId: String): ComputerCallResult {
        val params = buildJsonObject {
            put("name", name)
            put("argumentsJson", argumentsJson)
            put("cwd", cwd)
            put("callId", callId)
        }
        return decode(call(hostId, RemoteMethod.COMPUTER_CALL, params), ComputerCallResult.serializer())
    }

    /** Folders in [path] on the PC, or its places (home, Desktop, drives, recent folders) when [path] is null. */
    suspend fun listFolders(hostId: String, path: String?): FolderListing {
        val params = buildJsonObject { if (path == null) put("path", JsonNull) else put("path", path) }
        return decode(call(hostId, RemoteMethod.FILES_LIST, params), FolderListing.serializer())
    }

    /** Claude Code ("claude") or Codex ("codex") sessions whose working folder is [cwd], newest first. */
    suspend fun listAgentSessions(hostId: String, agent: String, cwd: String): List<AgentSessionInfo> {
        val params = buildJsonObject {
            put("agent", agent)
            put("cwd", cwd)
        }
        return decode(call(hostId, RemoteMethod.AGENTS_LIST, params), AgentSessionList.serializer()).sessions
    }

    suspend fun readAgentSession(hostId: String, agent: String, cwd: String, id: String): AgentSession {
        val params = buildJsonObject {
            put("agent", agent)
            put("cwd", cwd)
            put("id", id)
        }
        return decode(call(hostId, RemoteMethod.AGENTS_READ, params), AgentSession.serializer())
    }

    companion object {
        /** How long a call waits for the change stream to (re)connect before giving up. */
        const val CONNECT_TIMEOUT_MS = 15_000L

        /** `computerHost` of a chat that doesn't use a PC ("Don't use a PC"). Host ids are 16+ characters, so it can't clash. */
        const val NO_PC = "none"

        /**
         * The PC for a chat that hasn't chosen one: an online PC that can run tools, preferring ones that
         * allow remote use, then the one this device used last, then by name.
         */
        fun pickAutomatic(hosts: Collection<RemoteHost>, lastUsed: String?): RemoteHost? {
            val pcs = hosts.filter { it.features.isEmpty() || it.has(RemoteFeature.COMPUTER) }
            if (pcs.isEmpty()) return null
            val pool = pcs.filter { it.remote }.ifEmpty { pcs }
            return pool.firstOrNull { it.hostId == lastUsed } ?: pool.minByOrNull { it.name.lowercase() }
        }

        fun turnOnHint(pcName: String) = Strings.get(R.string.remote_turn_on_hint, pcName)
    }
}
