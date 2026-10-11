package io.dtsoftware.facet.sync

import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.data.parseParams
import io.dtsoftware.facet.domain.tools.ToolTrace
import io.dtsoftware.facet.llm.ApiStyle
import io.dtsoftware.facet.llm.Effort
import io.dtsoftware.facet.llm.ProviderBlocks
import kotlinx.serialization.Serializable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Records written by the web and Windows client (client/test/android-fixture.test.ts) decode here:
 * the two codebases share one synced format.
 */
class WebRecordsCompatTest {
    @Serializable private data class Fixture(val vaultKeyHex: String, val records: List<RecordDto>)

    private val box = object : SecretBox {
        override fun seal(plain: ByteArray) = "v1:" + FacetCrypto.b64(plain)
        override fun open(sealed: String) = FacetCrypto.unb64(sealed.removePrefix("v1:"))
    }

    private val fixture = AppJson.decodeFromString<Fixture>(
        javaClass.classLoader!!.getResource("web-records.json")!!.readText(),
    )
    private val codec = RecordCodec(fixture.vaultKeyHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray(), box)
    private val opened = fixture.records.mapNotNull { codec.open(it) }

    private fun one(type: String, id: String) = opened.single { it.type == type && it.id == id }

    @Test
    fun opensEveryRecord() {
        assertEquals(fixture.records.size, opened.size)
    }

    @Test
    fun conversationAndParams() {
        val c = codec.conversation(one(RecordType.CONVERSATION, "c1"))
        assertEquals("Web chat", c.title)
        assertTrue(c.titleSet && c.pinned && !c.archived)
        assertEquals("builtin.code", c.assistantId)
        assertEquals("m2", c.currentLeafId)
        // The PC and folder the chat works on (docs/REMOTE.md); the Windows-only local folder never syncs.
        assertEquals("host-1", c.computerHost)
        assertEquals("C:\\Users\\alex\\app", c.computerFolder)
        val params = parseParams(c.paramsJson)
        assertEquals(Effort.HIGH, params.effort)
        assertTrue(params.webSearch)
        assertEquals(0.7f, params.temperature!!, 0.0001f)
        assertTrue(one(RecordType.CONVERSATION, "c2").deleted)
    }

    @Test
    fun messageWithToolTraceAndBlocks() {
        val m = codec.message(one(RecordType.MESSAGE, "m2"))
        assertEquals("Hello from the web", m.content)
        assertEquals("DONE", m.status)
        assertEquals(1200L, m.thinkingMs)
        val trace = AppJson.decodeFromString<ToolTrace>(m.stepsJson!!)
        assertEquals("COMPUTER", trace.steps.single().calls.single().kind)
        assertEquals(ApiStyle.ANTHROPIC, AppJson.decodeFromString<ProviderBlocks>(m.blocksJson!!).style)
    }

    @Test
    fun libraryProvidersToolsAndSettings() {
        val a = codec.attachment(one(RecordType.ATTACHMENT, "a1"), null)
        assertTrue(a.uploaded)
        assertEquals(20, a.height)
        assertEquals("Chef", codec.assistant(one(RecordType.ASSISTANT, "s1")).name)
        assertEquals("Work", codec.folder(one(RecordType.FOLDER, "f1")).name)
        assertEquals("Summarize this:", codec.prompt(one(RecordType.PROMPT, "q1")).body)
        val p = codec.provider(one(RecordType.PROVIDER, "p1"), null)
        assertEquals("sk-ant-web", box.openString(p.apiKeySealed))
        assertTrue(p.modelPrefsJson.contains("Opus"))
        val mcp = codec.mcpServer(one(RecordType.MCP, "x1"), null)
        assertEquals("""{"X-Key":"abc"}""", box.openString(mcp.headersSealed))
        assertEquals("", mcp.oauthSealed)
        assertEquals("notes", codec.skill(one(RecordType.SKILL, "k1")).name)
        val s = codec.settings(one(RecordType.SETTINGS, RecordType.SETTINGS_ID))
        assertEquals("Ada", s.profileName)
        assertTrue(s.yoloMode)
        assertTrue(!s.autoFreeSpace)
        assertEquals("claude-opus-5-5", s.defaultModel?.modelId)
        assertNull(s.titleModel)
    }
}
