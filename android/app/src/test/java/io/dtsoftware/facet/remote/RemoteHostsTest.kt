package io.dtsoftware.facet.remote

import io.dtsoftware.facet.core.util.Ids
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Discovery, host state and remote calls (docs/REMOTE.md) over an in-memory relay. */
class RemoteHostsTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val relay = FakeRelay()
    private val known = object : KnownHostStore {
        val map = HashMap<String, String>()
        override fun names() = map.toMap()
        override fun remember(hostId: String, name: String) { map[hostId] = name }
    }
    private val remote = RemoteHosts(scope, relay, known)

    @After fun tearDown() = scope.cancel()

    private suspend fun RemoteHosts.awaitHost(hostId: String) = eventually { hosts.value.containsKey(hostId) }

    private suspend fun expectRemoteError(code: String, block: suspend () -> Unit): RemoteException {
        try {
            block()
        } catch (e: RemoteException) {
            assertEquals(code, e.code)
            return e
        }
        fail("expected RemoteException $code")
        throw AssertionError()
    }

    @Test
    fun discoversPcsOnReadyAndFollowsPresence() = runBlocking {
        val pc = relay.add(FakePc(relay))
        relay.online += "sess-web"
        relay.ready()
        remote.awaitHost("host-1")
        // hello goes to every peer; only the PC answers.
        eventually { relay.messagesTo("sess-web", "hello").size == 1 && relay.messagesTo(pc.session, "hello").size == 1 }
        val h = remote.hosts.value.getValue("host-1")
        assertEquals("OFFICE-PC", h.name)
        assertEquals(pc.session, h.sessionId)
        assertTrue(h.remote)
        assertEquals("C:\\Users\\alex\\Documents", h.defaultFolder)
        assertEquals(listOf("C:\\Users\\alex\\Desktop\\Projects\\app"), h.recentFolders)
        assertEquals("OFFICE-PC", known.map["host-1"])

        // The PC's last stream closes: forget it, but remember its name.
        relay.presence(pc.session, false)
        eventually { remote.hosts.value.isEmpty() }
        assertEquals("OFFICE-PC", remote.nameOf("host-1"))

        // A new session comes online: say hello, and it's back.
        val second = relay.add(FakePc(relay, session = "sess-pc-2", hostId = "host-2", name = "LAPTOP"))
        relay.presence(second.session, true)
        remote.awaitHost("host-2")
    }

    @Test
    fun newestSessionWinsAndUnsolicitedAnnouncementsUpdate() = runBlocking {
        val pc = relay.add(FakePc(relay))
        pc.announce()
        remote.awaitHost("host-1")
        // Remote use switched off on the PC: it announces itself again.
        pc.remote = false
        pc.announce()
        eventually { remote.hosts.value["host-1"]?.remote == false }
        // The same install signs in again on a new session.
        val again = relay.add(FakePc(relay, session = "sess-pc-new", hostId = "host-1", name = "OFFICE-PC"))
        again.announce()
        eventually { remote.hosts.value["host-1"]?.sessionId == "sess-pc-new" }
        assertEquals(1, remote.hosts.value.size)
    }

    @Test
    fun readyForgetsPcsThatLeftWhileDisconnected() = runBlocking {
        val pc = relay.add(FakePc(relay))
        pc.announce()
        remote.awaitHost("host-1")
        relay.closed()
        // Still known while reconnecting.
        delay(50)
        assertTrue(remote.hosts.value.containsKey("host-1"))
        relay.online.remove(pc.session)
        relay.ready()
        eventually { remote.hosts.value.isEmpty() }
    }

    @Test
    fun signingOutForgetsEverything() = runBlocking {
        relay.add(FakePc(relay)).announce()
        remote.awaitHost("host-1")
        relay.signedIn = false
        relay.closed()
        eventually { remote.hosts.value.isEmpty() }
    }

    @Test
    fun callsReturnTypedValuesAndHoldTheStream() = runBlocking {
        val pc = relay.add(FakePc(relay, features = listOf("files", "claude", "codex")))
        pc.handler = { method, params ->
            when (method) {
                RemoteMethod.FILES_LIST -> if (params["path"] is kotlinx.serialization.json.JsonNull) {
                    buildJsonObject {
                        put("path", kotlinx.serialization.json.JsonNull)
                        put("parent", kotlinx.serialization.json.JsonNull)
                        put("places", buildJsonArray { add(buildJsonObject { put("name", "Home"); put("path", "C:\\Users\\alex") }) })
                    }
                } else {
                    buildJsonObject {
                        put("path", "C:\\Users\\alex")
                        put("parent", "C:\\Users")
                        put("folders", buildJsonArray { add(buildJsonObject { put("name", "app"); put("path", "C:\\Users\\alex\\app") }) })
                    }
                }
                RemoteMethod.AGENTS_LIST -> buildJsonObject {
                    put("sessions", buildJsonArray {
                        add(buildJsonObject { put("id", "s1"); put("title", "Fix the build"); put("updatedAt", 1_760_000_000_000); put("messageCount", 12) })
                        add(buildJsonObject { put("id", "s2"); put("title", "Older"); put("updatedAt", "2025-10-01T10:00:00Z"); put("messageCount", 3) })
                    })
                }
                else -> null
            }
        }
        pc.announce()
        remote.awaitHost("host-1")
        assertEquals("Home", remote.listFolders("host-1", null).places.single().name)
        val listing = remote.listFolders("host-1", "C:\\Users\\alex")
        assertEquals("C:\\Users", listing.parent)
        assertEquals("C:\\Users\\alex\\app", listing.folders.single().path)
        assertEquals("C:\\Users\\alex", pc.calls.last().second["path"]!!.let { (it as JsonPrimitive).content })

        val sessions = remote.listAgentSessions("host-1", "claude", "C:\\Users\\alex\\app")
        assertEquals(listOf("s1", "s2"), sessions.map { it.id })
        assertEquals(1_760_000_000_000L, sessions[0].updatedAt)
        assertEquals(java.time.Instant.parse("2025-10-01T10:00:00Z").toEpochMilli(), sessions[1].updatedAt)
        assertEquals(0, relay.holds.get())
    }

    @Test
    fun errorsFromThePc() = runBlocking {
        val pc = relay.add(FakePc(relay, features = listOf("files", "claude", "codex")))
        pc.handler = { method, _ ->
            when (method) {
                RemoteMethod.FILES_LIST -> throw RemoteException("not_found", "No such folder")
                else -> throw RemoteException("remote_disabled", "Remote use is off")
            }
        }
        pc.announce()
        remote.awaitHost("host-1")
        expectRemoteError("not_found") { remote.listFolders("host-1", "C:\\gone") }
        val e = expectRemoteError(RemoteException.REMOTE_DISABLED) { remote.computerTools("host-1") }
        assertEquals(RemoteHosts.turnOnHint("OFFICE-PC"), e.message)
        assertFalse(remote.hosts.value.getValue("host-1").remote)
    }

    @Test
    fun peerOfflineFailsAtOnceAndForgetsThePc() = runBlocking {
        val pc = relay.add(FakePc(relay))
        pc.announce()
        remote.awaitHost("host-1")
        relay.online.remove(pc.session)
        val started = System.currentTimeMillis()
        expectRemoteError(RemoteException.OFFLINE) { remote.listFolders("host-1", null) }
        assertTrue(System.currentTimeMillis() - started < 2_000)
        assertTrue(remote.hosts.value.isEmpty())
        expectRemoteError(RemoteException.OFFLINE) { remote.listFolders("host-1", null) }
        Unit
    }

    @Test
    fun aPcGoingAwayFailsItsPendingCalls() = runBlocking {
        val pc = relay.add(FakePc(relay, features = listOf("files", "claude", "codex")))
        pc.handler = { _, _ -> null }
        pc.announce()
        remote.awaitHost("host-1")
        val call = async { runCatching { remote.listFolders("host-1", null) } }
        eventually { pc.calls.isNotEmpty() }
        relay.presence(pc.session, false)
        assertEquals(RemoteException.OFFLINE, (call.await().exceptionOrNull() as RemoteException).code)
    }

    @Test
    fun timesOut() = runBlocking {
        val pc = relay.add(FakePc(relay, features = listOf("files", "claude", "codex")))
        pc.handler = { _, _ -> null }
        pc.announce()
        remote.awaitHost("host-1")
        expectRemoteError(RemoteException.TIMEOUT) { remote.call("host-1", RemoteMethod.COMPUTER_INFO, timeoutMs = 200) }
        assertEquals(0, relay.holds.get())
    }

    @Test
    fun stoppingAComputerCallCancelsItOnThePc() = runBlocking {
        val pc = relay.add(FakePc(relay, features = listOf("files", "claude", "codex")))
        pc.handler = { method, _ -> if (method == RemoteMethod.COMPUTER_CALL) null else buildJsonArray {} }
        pc.announce()
        remote.awaitHost("host-1")
        val job = launch { remote.computerCall("host-1", "run_command", """{"command":"npm test"}""", "C:\\Users\\alex\\app", "call_1") }
        eventually { pc.calls.any { it.first == RemoteMethod.COMPUTER_CALL } }
        assertEquals(1, relay.holds.get())
        val params = pc.calls.last().second
        assertEquals("C:\\Users\\alex\\app", (params["cwd"] as JsonPrimitive).content)
        assertEquals("call_1", (params["callId"] as JsonPrimitive).content)
        job.cancel()
        val callId = relay.messagesTo(pc.session, "call").last().str("id")
        eventually { pc.cancelled == listOf(callId) }
        eventually { relay.holds.get() == 0 }
    }

    @Test
    fun waitsForTheStreamBeforeCalling() = runBlocking {
        val pc = relay.add(FakePc(relay, features = listOf("files", "claude", "codex")))
        pc.handler = { _, _ -> buildJsonObject { put("os", "Windows 11"); put("hostname", "OFFICE-PC") } }
        pc.announce()
        remote.awaitHost("host-1")
        relay.connected.value = false
        val info = async { remote.computerInfo("host-1") }
        delay(150)
        assertTrue(pc.calls.isEmpty())
        relay.connected.value = true
        assertEquals("OFFICE-PC", info.await().hostname)
    }

    @Test
    fun dropsForgedReplayedAndStaleMessages() = runBlocking {
        val pc = relay.add(FakePc(relay))
        // Sealed with another key, or for another sender: not from this account's PC.
        relay.deliver(pc.session, pc.hostMessage(), sealKey = ByteArray(32))
        relay.deliver(pc.session, pc.hostMessage(), sealFrom = "sess-other")
        // Too old.
        val stale = buildJsonObject {
            pc.hostMessage().forEach { (k, v) -> put(k, v) }
            put("ts", System.currentTimeMillis() - 11 * 60_000)
        }
        relay.deliver(pc.session, stale)
        delay(150)
        assertTrue(remote.hosts.value.isEmpty())

        val msg = pc.hostMessage()
        relay.deliver(pc.session, msg)
        remote.awaitHost("host-1")
        // The same message again (same id) can't change anything.
        relay.online.remove(pc.session)
        relay.presence(pc.session, false)
        eventually { remote.hosts.value.isEmpty() }
        relay.deliver(pc.session, msg)
        delay(150)
        assertNull(remote.hosts.value["host-1"])
    }

    @Test
    fun cachesToolsUntilThePcRestarts() = runBlocking {
        val pc = relay.add(FakePc(relay))
        pc.handler = { method, _ ->
            if (method == RemoteMethod.COMPUTER_TOOLS) buildJsonArray {
                add(buildJsonObject { put("name", "read_file"); put("description", "Read a file"); put("inputSchemaJson", "{}"); put("readOnly", true) })
            } else buildJsonObject { put("os", "Windows 11") }
        }
        pc.announce()
        remote.awaitHost("host-1")
        // Warmed up when the PC appeared.
        eventually { pc.calls.count { it.first == RemoteMethod.COMPUTER_TOOLS } == 1 }
        assertEquals("read_file", remote.computerTools("host-1").single().name)
        assertEquals(1, pc.calls.count { it.first == RemoteMethod.COMPUTER_TOOLS })
        // A new session for the same PC fetches them again.
        val again = relay.add(FakePc(relay, session = "sess-pc-2", handler = pc.handler))
        again.announce()
        eventually { again.calls.count { it.first == RemoteMethod.COMPUTER_TOOLS } == 1 }
        assertTrue(Ids.new().length >= 16)
    }
}
