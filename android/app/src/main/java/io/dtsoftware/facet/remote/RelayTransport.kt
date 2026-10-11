package io.dtsoftware.facet.remote

import android.content.Context
import io.dtsoftware.facet.core.util.AppJson
import kotlinx.coroutines.flow.StateFlow

/** What [RemoteHosts] needs from the sync layer: the relay endpoints and the change stream's events. */
interface RelayTransport {
    /** This device's session id; null when signed out. */
    val sessionId: String?

    /** The account's vault key (the relay key is derived from it); null when signed out. */
    fun vaultKey(): ByteArray?

    /** True while the change stream is open. */
    val connected: StateFlow<Boolean>

    /** Keeps the change stream open (also in the background) until the returned function is called. */
    fun holdStream(): () -> Unit

    /** Posts a sealed envelope (b64) to [to]. Throws [PeerOfflineException] when that session has no open stream. */
    suspend fun send(to: String, envelopeB64: String)

    /** The account's other sessions with an open stream. */
    suspend fun peers(): List<String>

    /** Registers the receiver of `ready`, `presence`, `relay` and `closed` stream events. */
    fun listen(listener: (event: String, data: String) -> Unit)
}

class PeerOfflineException : Exception("That device isn't connected.")

/** Remembers PC names on this device (never synced), so a chat can say which PC is offline. */
interface KnownHostStore {
    fun names(): Map<String, String>
    fun remember(hostId: String, name: String)
}

class PrefsKnownHostStore(context: Context) : KnownHostStore {
    private val prefs = context.getSharedPreferences("facet_remote", Context.MODE_PRIVATE)

    override fun names(): Map<String, String> =
        prefs.getString(KEY, null)?.let { runCatching { AppJson.decodeFromString<Map<String, String>>(it) }.getOrNull() } ?: emptyMap()

    override fun remember(hostId: String, name: String) {
        val current = names()
        if (current[hostId] == name) return
        prefs.edit().putString(KEY, AppJson.encodeToString(current + (hostId to name))).apply()
    }

    private companion object {
        const val KEY = "host_names"
    }
}
