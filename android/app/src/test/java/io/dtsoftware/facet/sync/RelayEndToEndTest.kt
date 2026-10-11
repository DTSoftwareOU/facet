package io.dtsoftware.facet.sync

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.room.Room
import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.RelayCrypto
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.net.SseReader
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.db.FacetDatabase
import io.dtsoftware.facet.data.prefs.SettingsStore
import io.dtsoftware.facet.data.repo.AttachmentStore
import io.dtsoftware.facet.remote.RelayMessages
import io.dtsoftware.facet.remote.RemoteException
import io.dtsoftware.facet.remote.RemoteHosts
import io.dtsoftware.facet.remote.RemoteMethod
import io.dtsoftware.facet.remote.eventually
import io.dtsoftware.facet.remote.str
import java.io.File
import java.util.Collections
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * This phone finds and uses a PC through a real Facet server's relay (docs/REMOTE.md): discovery over the
 * change stream, sealed calls and results, the stream held open in the background, and presence. The PC is
 * scripted here. Skipped unless a server runs at -Dfacet.e2eServer (default http://127.0.0.1:8788).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class RelayEndToEndTest {
    private val server = System.getProperty("facet.e2eServer") ?: "http://127.0.0.1:8788"
    private val http = OkHttpClient()
    private val streamHttp = http.newBuilder().readTimeout(70, TimeUnit.SECONDS).build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun serverUp(): Boolean = runCatching {
        http.newCall(Request.Builder().url("$server/v1/health").build()).execute().use { it.isSuccessful } &&
            http.newCall(Request.Builder().url("$server/v1/relay/peers").build()).execute().use { it.code == 401 }
    }.getOrDefault(false)

    private class DeviceContext(base: Context, private val prefix: String) : ContextWrapper(base) {
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = super.getSharedPreferences("$prefix-$name", mode)
        override fun getApplicationContext(): Context = this
        override fun getFilesDir(): File = File(super.getFilesDir(), prefix).apply { mkdirs() }
    }

    private class PlainBox : SecretBox {
        override fun seal(plain: ByteArray) = "v1:" + FacetCrypto.b64(plain)
        override fun open(sealed: String) = FacetCrypto.unb64(sealed.removePrefix("v1:"))
    }

    /** This Android device: sync engine, relay transport and hosts, as in the app. */
    private inner class Phone {
        val ctx = DeviceContext(RuntimeEnvironment.getApplication(), "phone" + Ids.new())
        val db: FacetDatabase = Room.inMemoryDatabaseBuilder(ctx, FacetDatabase::class.java).build()
        val secrets = PlainBox()
        val settings = SettingsStore(ctx)
        val api = SyncApi(http)
        val auth = AuthManager(ctx, api, secrets).apply { setServerUrl(server) }
        val sync = SyncEngine(ctx, scope, db, auth, api, settings, AttachmentStore(ctx, db) {}, secrets, http)
        val remote = RemoteHosts(scope, SyncRelayTransport(sync, auth, api))
    }

    /** A scripted PC: answers hello with a host message and calls with canned values, over its own stream. */
    private inner class Pc(val hostId: String) {
        val ctx = DeviceContext(RuntimeEnvironment.getApplication(), "pc" + Ids.new())
        val api = SyncApi(http)
        val auth = AuthManager(ctx, api, PlainBox()).apply { setServerUrl(server) }
        val received: MutableList<JsonObject> = Collections.synchronizedList(ArrayList())
        @Volatile var ready = false
        private var call: Call? = null
        val session get() = auth.sessionId!!
        private val key get() = RelayCrypto.relayKey(auth.vaultKey()!!)

        fun start() {
            scope.launch {
                val token = auth.authed { _, t -> t }
                val c = api.streamCall(streamHttp, server, token).also { call = it }
                runCatching {
                    c.execute().use { resp ->
                        val reader = SseReader(resp.body.source())
                        while (true) {
                            val ev = reader.next() ?: break
                            when (ev.event) {
                                "ready" -> ready = true
                                "relay" -> {
                                    val data = AppJson.parseToJsonElement(ev.data).jsonObject
                                    val from = data.str("from")!!
                                    val msg = RelayMessages.parse(RelayCrypto.open(key, from, session, FacetCrypto.unb64(data.str("msg")!!)))!!
                                    received += msg
                                    scope.launch { answer(from, msg) }
                                }
                            }
                        }
                    }
                }
                ready = false
            }
        }

        fun stop() = call?.cancel()

        private suspend fun send(to: String, msg: JsonObject) {
            val env = RelayCrypto.seal(key, session, to, RelayMessages.encode(msg))
            auth.authed { base, token -> api.relay(base, token, to, FacetCrypto.b64(env)) }
        }

        private fun base(type: String, re: String?, body: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) = buildJsonObject {
            put("v", 1); put("id", Ids.new()); put("ts", System.currentTimeMillis()); put("type", type)
            re?.let { put("re", it) }
            body()
        }

        private suspend fun answer(from: String, msg: JsonObject) {
            val id = msg.str("id")!!
            when (msg.str("type")) {
                "hello" -> send(from, base("host", id) {
                    put("hostId", hostId); put("name", "OFFICE-PC"); put("os", "Windows 11"); put("version", "1.1.0"); put("remote", true)
                    put("home", "C:\\Users\\alex"); put("defaultFolder", "C:\\Users\\alex\\Documents")
                    put("recentFolders", buildJsonArray {}); put("features", buildJsonArray { add(JsonPrimitive("computer")); add(JsonPrimitive("files")) })
                })
                "call" -> {
                    val params = msg["params"]!!.jsonObject
                    val value: JsonElement = when (msg.str("method")) {
                        RemoteMethod.FILES_LIST -> buildJsonObject {
                            put("path", kotlinx.serialization.json.JsonNull); put("parent", kotlinx.serialization.json.JsonNull)
                            put("places", buildJsonArray { add(buildJsonObject { put("name", "Home"); put("path", "C:\\Users\\alex") }) })
                        }
                        RemoteMethod.COMPUTER_TOOLS -> buildJsonArray {
                            add(buildJsonObject { put("name", "run_command"); put("description", "Run a command"); put("inputSchemaJson", "{}"); put("readOnly", false) })
                        }
                        RemoteMethod.COMPUTER_INFO -> buildJsonObject { put("os", "Windows 11"); put("hostname", "OFFICE-PC") }
                        RemoteMethod.COMPUTER_CALL -> {
                            val args = AppJson.parseToJsonElement(params.str("argumentsJson")!!).jsonObject
                            val big = args.str("command") == "big"
                            buildJsonObject {
                                put("content", if (big) "line\n".repeat(4000) else "ran in " + params.str("cwd"))
                                put("isError", false)
                                put("label", "Ran `${args.str("command")}`")
                            }
                        }
                        else -> buildJsonObject {}
                    }
                    send(from, base("result", id) { put("ok", true); put("value", value) })
                }
            }
        }
    }

    @Test
    fun phoneUsesThePcThroughTheServer() = runBlocking {
        assumeTrue("Facet server with the relay not running at $server", serverUp())
        val email = "relay-${Ids.new()}@example.com"
        val password = "correct horse battery staple ✓"
        val phone = Phone()
        phone.auth.register(email, password, null)
        val pc = Pc("host-e2e")
        pc.auth.login(email, password)
        try {
            pc.start()
            eventually(10_000) { pc.ready }

            // Discovery: the phone's stream says ready, it asks for peers and says hello; the PC answers.
            phone.sync.start()
            phone.sync.setForeground(true)
            eventually(15_000) { phone.remote.hosts.value.containsKey("host-e2e") }
            val host = phone.remote.hosts.value.getValue("host-e2e")
            assertEquals(pc.session, host.sessionId)
            assertEquals("OFFICE-PC", host.name)
            assertTrue(pc.received.any { it.str("type") == "hello" })

            // Calls and results, sealed both ways; a large result is compressed.
            assertEquals("Home", phone.remote.listFolders("host-e2e", null).places.single().name)
            val r = phone.remote.computerCall("host-e2e", "run_command", """{"command":"npm test"}""", "C:\\Users\\alex\\app", "call_1")
            assertEquals("ran in C:\\Users\\alex\\app", r.content)
            assertEquals("Ran `npm test`", r.label)
            assertEquals("line\n".repeat(4000), phone.remote.computerCall("host-e2e", "run_command", """{"command":"big"}""", "C:\\", "call_2").content)

            // In the background the stream closes, but a call holds it open until the result is back.
            phone.sync.setForeground(false)
            eventually(10_000) { !phone.sync.streamConnected.value }
            assertEquals("OFFICE-PC", phone.remote.computerInfo("host-e2e").hostname)
            assertEquals("ran in C:\\", phone.remote.computerCall("host-e2e", "run_command", """{"command":"ls"}""", "C:\\", "call_3").content)
            phone.sync.setForeground(true)
            eventually(10_000) { phone.sync.streamConnected.value }

            // The PC's stream closes: presence tells the phone, and calls fail at once.
            pc.stop()
            eventually(10_000) { phone.remote.hosts.value.isEmpty() }
            try {
                phone.remote.listFolders("host-e2e", null)
                fail("expected the PC to be offline")
            } catch (e: RemoteException) {
                assertEquals(RemoteException.OFFLINE, e.code)
            }
        } finally {
            pc.stop()
            phone.sync.setForeground(false)
            scope.cancel()
        }
    }
}
