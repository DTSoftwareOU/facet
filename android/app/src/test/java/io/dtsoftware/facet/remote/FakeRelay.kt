package io.dtsoftware.facet.remote

import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.RelayCrypto
import io.dtsoftware.facet.core.util.Ids
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * An in-memory relay for tests: this device is [me]; [FakePc]s and other [online] sessions answer through it.
 * Every message really is sealed and opened with the relay envelope, so tests see what the server would forward.
 */
class FakeRelay(val me: String = "sess-phone", val vault: ByteArray = ByteArray(32) { (it * 7).toByte() }) : RelayTransport {
    private val key = RelayCrypto.relayKey(vault)
    var signedIn = true
    override val sessionId: String? get() = if (signedIn) me else null
    override fun vaultKey(): ByteArray? = if (signedIn) vault else null
    override val connected = MutableStateFlow(true)

    val holds = AtomicInteger(0)
    override fun holdStream(): () -> Unit {
        holds.incrementAndGet()
        var released = false
        return { if (!released) { released = true; holds.decrementAndGet() } }
    }

    /** Sessions with an open stream (PCs and other devices). */
    val online: MutableSet<String> = ConcurrentHashMap.newKeySet()
    val pcs = ConcurrentHashMap<String, FakePc>()
    /** Every message this device sent, opened: (recipient, message). */
    val sent: MutableList<Pair<String, JsonObject>> = Collections.synchronizedList(ArrayList())

    override suspend fun peers(): List<String> = online.toList()

    private var listener: (String, String) -> Unit = { _, _ -> }
    override fun listen(listener: (event: String, data: String) -> Unit) {
        this.listener = listener
    }

    override suspend fun send(to: String, envelopeB64: String) {
        if (to !in online) throw PeerOfflineException()
        val msg = RelayMessages.parse(RelayCrypto.open(key, me, to, FacetCrypto.unb64(envelopeB64)))!!
        sent += to to msg
        pcs[to]?.receive(msg)
    }

    /** A message from [from] arrives on this device's stream (sealed for [from] → [me] unless told otherwise). */
    fun deliver(from: String, msg: JsonObject, sealFrom: String = from, sealKey: ByteArray = key) {
        val env = RelayCrypto.seal(sealKey, sealFrom, me, RelayMessages.encode(msg))
        listener("relay", """{"from":"$from","msg":"${FacetCrypto.b64(env)}"}""")
    }

    fun ready() = listener("ready", """{"cursor":0}""")
    fun presence(session: String, online: Boolean) = listener("presence", """{"sessionId":"$session","online":$online}""")
    fun closed() = listener("closed", "")

    fun add(pc: FakePc): FakePc {
        online += pc.session
        pcs[pc.session] = pc
        return pc
    }

    fun messagesTo(session: String, type: String) = synchronized(sent) { sent.filter { it.first == session && it.second.str("type") == type }.map { it.second } }
}

/**
 * A scripted Facet for Windows: answers hello with a host message and calls with [handler]'s value
 * (null: don't answer, as for a command still running; a thrown [RemoteException]: an error result).
 */
class FakePc(
    private val relay: FakeRelay,
    val session: String = "sess-pc",
    val hostId: String = "host-1",
    var name: String = "OFFICE-PC",
    var remote: Boolean = true,
    var features: List<String> = listOf("computer", "files", "claude", "codex"),
    var handler: (method: String, params: JsonObject) -> JsonElement? = { _, _ -> JsonObject(emptyMap()) },
) {
    val calls: MutableList<Pair<String, JsonObject>> = Collections.synchronizedList(ArrayList())
    val cancelled: MutableList<String> = Collections.synchronizedList(ArrayList())

    fun hostMessage(re: String? = null) = buildJsonObject {
        put("v", 1)
        put("id", Ids.new())
        put("ts", System.currentTimeMillis())
        put("type", "host")
        re?.let { put("re", it) }
        put("hostId", hostId)
        put("name", name)
        put("os", "Windows 11")
        put("version", "1.1.0")
        put("remote", remote)
        put("home", "C:\\Users\\alex")
        put("defaultFolder", "C:\\Users\\alex\\Documents")
        put("recentFolders", buildJsonArray { add(JsonPrimitive("C:\\Users\\alex\\Desktop\\Projects\\app")) })
        put("features", buildJsonArray { features.forEach { add(JsonPrimitive(it)) } })
    }

    fun announce() = relay.deliver(session, hostMessage())

    fun receive(msg: JsonObject) {
        val id = msg.str("id")!!
        when (msg.str("type")) {
            "hello" -> relay.deliver(session, hostMessage(id))
            "cancel" -> cancelled += msg.str("re")!!
            "call" -> {
                val method = msg.str("method")!!
                val params = msg["params"] as JsonObject
                calls += method to params
                val reply = try {
                    handler(method, params)?.let { value -> result(id) { put("ok", true); put("value", value) } }
                } catch (e: RemoteException) {
                    result(id) {
                        put("ok", false)
                        put("error", buildJsonObject { put("code", e.code); put("message", e.message ?: "") })
                    }
                }
                reply?.let { relay.deliver(session, it) }
            }
        }
    }

    fun result(re: String, body: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) = buildJsonObject {
        put("v", 1)
        put("id", Ids.new())
        put("ts", System.currentTimeMillis())
        put("type", "result")
        put("re", re)
        body()
    }
}

/** Polls [check] until it holds (or fails after [timeoutMs]). */
suspend fun eventually(timeoutMs: Long = 5_000, check: () -> Boolean) {
    withTimeout(timeoutMs) { while (!check()) delay(10) }
}
