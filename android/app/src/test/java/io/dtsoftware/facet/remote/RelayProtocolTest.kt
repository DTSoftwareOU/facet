package io.dtsoftware.facet.remote

import io.dtsoftware.facet.core.util.AppJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Message encoding and decoding per docs/REMOTE.md "Messages" and "Methods". */
class RelayProtocolTest {
    @Test
    fun encodesControllerMessages() {
        assertEquals(
            """{"v":1,"id":"msg-0001-abcdefgh","ts":1760000000000,"type":"hello"}""",
            RelayMessages.encode(RelayMessages.hello("msg-0001-abcdefgh", 1_760_000_000_000)),
        )
        val call = RelayMessages.call("id-1234567890abcdef", 5, RemoteMethod.FILES_LIST, buildJsonObject { put("path", kotlinx.serialization.json.JsonNull) })
        assertEquals("""{"v":1,"id":"id-1234567890abcdef","ts":5,"type":"call","method":"files.list","params":{"path":null}}""", RelayMessages.encode(call))
        assertEquals(
            """{"v":1,"id":"id-2","ts":6,"type":"cancel","re":"id-1234567890abcdef"}""",
            RelayMessages.encode(RelayMessages.cancel("id-2", 6, "id-1234567890abcdef")),
        )
    }

    @Test
    fun parsesTheHostMessageFromTheSpec() {
        val json = """{"v":1,"id":"h-0000000000000001","ts":1,"type":"host","re":"x","hostId":"abc","name":"OFFICE-PC","os":"Windows 11","version":"1.1.0",
            "remote":true,"home":"C:\\Users\\alex","defaultFolder":"C:\\Users\\alex\\Documents",
            "recentFolders":["C:\\Users\\alex\\Desktop\\Projects\\app"],"features":["computer","files","claude","codex"]}"""
        val h = RemoteHost.parse(RelayMessages.parse(json)!!, "sess-1", 42)!!
        assertEquals("abc", h.hostId)
        assertEquals("sess-1", h.sessionId)
        assertEquals("OFFICE-PC", h.name)
        assertEquals("Windows 11", h.os)
        assertTrue(h.remote)
        assertEquals("C:\\Users\\alex", h.home)
        assertEquals("C:\\Users\\alex\\Documents", h.defaultFolder)
        assertEquals(listOf("C:\\Users\\alex\\Desktop\\Projects\\app"), h.recentFolders)
        assertTrue(h.has(RemoteFeature.CODEX))
        assertEquals(42, h.seenAt)
        // remote defaults to false; a host without an id isn't one.
        assertFalse(RemoteHost.parse(RelayMessages.parse("""{"type":"host","hostId":"a"}""")!!, "s", 0)!!.remote)
        assertNull(RemoteHost.parse(RelayMessages.parse("""{"type":"host","name":"x"}""")!!, "s", 0))
        assertNull(RemoteHost.parse(RelayMessages.parse("""{"type":"result","hostId":"a"}""")!!, "s", 0))
    }

    @Test
    fun readsResults() {
        val ok = RelayMessages.parse("""{"type":"result","re":"a","ok":true,"value":{"content":"hi","isError":false,"label":"Ran `ls`"}}""")!!
        val r = AppJson.decodeFromJsonElement(ComputerCallResult.serializer(), RelayMessages.resultValue(ok))
        assertEquals("hi", r.content)
        assertEquals("Ran `ls`", r.label)
        val err = RelayMessages.parse("""{"type":"result","re":"a","ok":false,"error":{"code":"too_large","message":"That file is too big."}}""")!!
        val e = assertThrows(RemoteException::class.java) { RelayMessages.resultValue(err) }
        assertEquals("too_large", e.code)
        assertEquals("That file is too big.", e.message)
        // A malformed error still fails cleanly.
        assertEquals("failed", assertThrows(RemoteException::class.java) { RelayMessages.resultValue(JsonObject(mapOf("ok" to JsonPrimitive(false)))) }.code)
        assertNull(RelayMessages.parse("not json"))
    }

    @Test
    fun decodesMethodValues() {
        val tools = AppJson.decodeFromString<List<ComputerToolInfo>>(
            """[{"name":"run_command","description":"Run a command","inputSchemaJson":"{\"type\":\"object\"}","readOnly":false},{"name":"read_file","readOnly":true}]""",
        )
        assertEquals("""{"type":"object"}""", tools[0].inputSchemaJson)
        assertTrue(tools[1].readOnly)
        val listing = AppJson.decodeFromString<FolderListing>("""{"path":null,"parent":null,"places":[{"name":"Home","path":"C:\\Users\\alex"}]}""")
        assertNull(listing.path)
        assertTrue(listing.folders.isEmpty())
        val session = AppJson.decodeFromString<AgentSession>(
            """{"id":"s1","title":"Fix tests","cwd":"C:\\app","updatedAt":"2026-10-01T12:00:00.000Z","truncated":true,
               "messages":[{"role":"user","text":"Run the tests","at":1760000000000},{"role":"assistant","text":"› Ran `npm test`\nAll green."}]}""",
        )
        assertTrue(session.truncated)
        assertEquals(java.time.Instant.parse("2026-10-01T12:00:00Z").toEpochMilli(), session.updatedAt)
        assertEquals(1_760_000_000_000L, session.messages[0].at)
        assertNull(session.messages[1].at)
        assertEquals(15 * 60_000L, RemoteMethod.timeoutMs(RemoteMethod.COMPUTER_CALL))
        assertEquals(60_000L, RemoteMethod.timeoutMs(RemoteMethod.AGENTS_READ))
        assertEquals(20_000L, RemoteMethod.timeoutMs(RemoteMethod.FILES_LIST))
        assertEquals("x", AppJson.parseToJsonElement("""{"a":"x"}""").jsonObject.str("a"))
    }
}
