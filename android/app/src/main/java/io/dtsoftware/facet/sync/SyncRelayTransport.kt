package io.dtsoftware.facet.sync

import io.dtsoftware.facet.remote.PeerOfflineException
import io.dtsoftware.facet.remote.RelayTransport
import kotlinx.coroutines.flow.StateFlow

/** The relay over this account's sync server: `POST /v1/relay`, `GET /v1/relay/peers` and the change stream's events. */
class SyncRelayTransport(
    private val sync: SyncEngine,
    private val auth: AuthManager,
    private val api: SyncApi,
) : RelayTransport {
    override val sessionId: String? get() = auth.sessionId

    override fun vaultKey(): ByteArray? = if (auth.isSignedIn) auth.vaultKey() else null

    override val connected: StateFlow<Boolean> get() = sync.streamConnected

    override fun holdStream(): () -> Unit = sync.holdStream()

    override suspend fun send(to: String, envelopeB64: String) {
        try {
            auth.authed { base, token -> api.relay(base, token, to, envelopeB64) }
        } catch (e: ApiException) {
            if (e.status == 404 && e.code == "peer_offline") throw PeerOfflineException()
            throw e
        }
    }

    override suspend fun peers(): List<String> = auth.authed { base, token -> api.relayPeers(base, token) }.map { it.sessionId }

    override fun listen(listener: (event: String, data: String) -> Unit) {
        sync.streamListener = listener
    }
}
