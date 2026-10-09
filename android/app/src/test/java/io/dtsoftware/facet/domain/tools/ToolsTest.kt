package io.dtsoftware.facet.domain.tools

import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.data.db.MessageEntity
import io.dtsoftware.facet.sync.RecordCodec
import io.dtsoftware.facet.sync.RecordDto
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ToolsTest {
    @Test
    fun parsesSkillFrontmatter() {
        val md = """
            ---
            name: PDF Tools
            description: >
              Extract text from PDFs.
              Use when the user shares a PDF.
            license: MIT
            ---
            # PDF tools

            Step one.
        """.trimIndent()
        val p = SkillParser.parse(md)
        assertEquals("pdf-tools", p.name)
        assertEquals("Extract text from PDFs. Use when the user shares a PDF.", p.description)
        assertTrue(p.body.startsWith("# PDF tools"))
    }

    @Test
    fun skillWithoutFrontmatterUsesHeading() {
        val p = SkillParser.parse("# Weekly Report\n\nSummarize the week in five bullets.")
        assertEquals("weekly-report", p.name)
        assertEquals("Summarize the week in five bullets.", p.description)
    }

    @Test
    fun extractsReadableTextFromHtml() {
        val html = """
            <html><head><title>Lisbon &amp; Porto</title><style>.x{}</style></head>
            <body><nav>Menu</nav><main><h1>Guide</h1><p>Trams are &quot;yellow&quot;.</p>
            <ul><li>Alfama</li><li>Belém</li></ul><a href="https://example.com/more">Read more</a>
            <script>alert(1)</script></main><footer>Footer</footer></body></html>
        """.trimIndent()
        val (title, text) = HtmlText.extract(html)
        assertEquals("Lisbon & Porto", title)
        assertTrue(text.contains("# Guide"))
        assertTrue(text.contains("Trams are \"yellow\"."))
        assertTrue(text.contains("- Alfama"))
        assertTrue(text.contains("Read more (https://example.com/more)"))
        assertTrue(!text.contains("alert") && !text.contains("Menu") && !text.contains("Footer"))
    }

    @Test
    fun parsesSearchProviders() = runBlocking {
        val server = MockWebServer()
        server.start()
        val base = server.url("/").toString().trimEnd('/')
        val search = WebSearch(OkHttpClient())
        server.enqueue(MockResponse.Builder().body("""{"web":{"results":[{"title":"Tram 28","url":"https://a.example","description":"The <strong>famous</strong> tram"}]}}""").build())
        val brave = search.search(SearchConfig(SearchKind.BRAVE, "k", base), "tram 28")
        assertEquals("The famous tram", brave.single().snippet)
        assertEquals("k", server.takeRequest().headers["X-Subscription-Token"])

        server.enqueue(MockResponse.Builder().body("""{"results":[{"title":"T","url":"https://b.example","content":"Body"}]}""").build())
        val tavily = search.search(SearchConfig(SearchKind.TAVILY, "tv", base), "q")
        assertEquals("https://b.example", tavily.single().url)
        assertEquals("Bearer tv", server.takeRequest().headers["Authorization"])

        server.enqueue(MockResponse.Builder().code(401).body("{}").build())
        val e = assertThrows(SearchException::class.java) { runBlocking { search.search(SearchConfig(SearchKind.EXA, "bad", base), "q") } }
        assertTrue(e.message!!.contains("rejected the search key"))
        server.close()
    }

    @Test
    fun pageReaderRefusesLocalNetworks() = runBlocking {
        val server = MockWebServer()
        server.start()
        server.enqueue(MockResponse.Builder().body("<html><title>Router</title><body>admin</body></html>").build())
        val e = runCatching { WebSearch(OkHttpClient()).fetchPage(server.url("/").toString()) }.exceptionOrNull()
        assertTrue("localhost must be refused, got $e", e?.message?.contains("local or private networks") == true)
        // The same page is readable when the guard is off (tests and self-hosted setups).
        server.enqueue(MockResponse.Builder().body("<html><title>Router</title><body>admin</body></html>").build())
        assertEquals("Router", WebSearch(OkHttpClient(), allowPrivateAddresses = true).fetchPage(server.url("/").toString()).first)
        server.close()

        fun ip(s: String) = java.net.InetAddress.getByName(s)
        for (private in listOf("127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "0.0.0.0")) {
            assertTrue(private, isPrivateAddress(ip(private)))
        }
        for (public in listOf("8.8.8.8", "1.1.1.1", "2606:4700::1111", "100.128.0.1")) {
            assertTrue(public, !isPrivateAddress(ip(public)))
        }
    }

    private class PlainBox : SecretBox {
        override fun seal(plain: ByteArray) = "v1:" + FacetCrypto.b64(plain)
        override fun open(sealed: String) = FacetCrypto.unb64(sealed.removePrefix("v1:"))
    }

    @Test
    fun recordsAreOpaqueAndPadded() {
        val key = FacetCrypto.randomBytes(32)
        val codec = RecordCodec(key, PlainBox())
        val short = MessageEntity("m1", "c1", null, "user", "hi", createdAt = 1, updatedAt = 1)
        val longer = short.copy(id = "m2", content = "x".repeat(300))
        val a = codec.encode(short)
        val b = codec.encode(longer)
        assertEquals(RecordCodec.WIRE_TYPE, a.type)
        assertNotEquals("m1", a.id)
        assertEquals(codec.wireId("msg", "m1"), a.id)
        // Both fit the same 512-byte bucket, so their ciphertext lengths are equal.
        assertEquals(FacetCrypto.unb64(a.ct!!).size, FacetCrypto.unb64(b.ct!!).size)
        val opened = codec.open(a)!!
        assertEquals("msg", opened.type)
        assertEquals("m1", opened.id)
        assertEquals("hi", codec.message(opened).content)
        // A server can't move a record to another id.
        assertThrows(Exception::class.java) { codec.open(RecordDto(codec.wireId("msg", "m2"), a.type, a.updatedAt, a.deleted, a.ct)) }
        // Deletions are encrypted too, so other devices know what to delete.
        val tomb = codec.open(codec.encode(short.copy(deleted = true)))!!
        assertTrue(tomb.deleted || tomb.payload == null)
        assertEquals("m1", tomb.id)
        // Another account's key derives different ids.
        assertNotEquals(a.id, RecordCodec(FacetCrypto.randomBytes(32), PlainBox()).wireId("msg", "m1"))
    }
}
