package io.dtsoftware.facet.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class UpdateManifestTest {
    private val sha = "ab".repeat(32)

    private fun json(vararg fields: Pair<String, Any?>): String = fields.joinToString(",", "{", "}") { (k, v) ->
        "\"$k\":" + when (v) {
            null -> "null"
            is String -> "\"$v\""
            else -> v.toString()
        }
    }

    private val complete = arrayOf<Pair<String, Any?>>(
        "versionCode" to 2,
        "versionName" to "1.1.0",
        "url" to "https://facet.dtsoftware.io/download/android/facet-1.1.0.apk",
        "sha256" to sha,
        "size" to 3712345,
        "notes" to "Faster sync.\\nNew update screen.",
    )

    private fun without(key: String) = complete.filterNot { it.first == key }.toTypedArray()

    @Test
    fun parsesTheDocumentedManifest() {
        val m = UpdateManifest.parse(json(*complete))
        assertNotNull(m)
        m!!
        assertEquals(2L, m.versionCode)
        assertEquals("1.1.0", m.versionName)
        assertEquals("https://facet.dtsoftware.io/download/android/facet-1.1.0.apk", m.url)
        assertEquals(sha, m.sha256)
        assertEquals(3712345L, m.size)
        assertEquals(listOf("Faster sync.", "New update screen."), m.noteLines)
    }

    @Test
    fun ignoresExtraFields() {
        val m = UpdateManifest.parse(json(*complete, "minSdk" to 26, "channel" to "stable", "extra" to null))
        assertEquals(2L, m?.versionCode)
    }

    @Test
    fun notesAreOptional() {
        val m = UpdateManifest.parse(json(*without("notes")))
        assertEquals("", m?.notes)
        assertEquals(emptyList<String>(), m?.noteLines)
        assertEquals("", UpdateManifest.parse(json(*without("notes"), "notes" to null))?.notes)
    }

    @Test
    fun missingRequiredFieldsAreRejected() {
        for (key in listOf("versionCode", "versionName", "url", "sha256", "size")) {
            assertNull("missing $key", UpdateManifest.parse(json(*without(key))))
            assertNull("null $key", UpdateManifest.parse(json(*without(key), key to null)))
        }
    }

    @Test
    fun malformedValuesAreRejected() {
        fun withField(key: String, value: Any?) = UpdateManifest.parse(json(*without(key), key to value))
        assertNull(withField("versionCode", 0))
        assertNull(withField("versionCode", -3))
        assertNull(withField("versionName", "  "))
        assertNull(withField("sha256", "ab".repeat(31)))
        assertNull(withField("sha256", "zz".repeat(32)))
        assertNull(withField("size", 0))
        assertNull(withField("size", UpdateManifest.MAX_SIZE + 1))
        assertNull(withField("url", "not a url"))
        assertNull(withField("url", "ftp://facet.dtsoftware.io/facet.apk"))
        assertNull(UpdateManifest.parse("<html>502 Bad Gateway</html>"))
        assertNull(UpdateManifest.parse(""))
        assertNull(UpdateManifest.parse("[]"))
    }

    @Test
    fun requiresHttpsUnlessTestingLocally() {
        val plain = json(*without("url"), "url" to "http://127.0.0.1:8080/facet.apk")
        assertNull(UpdateManifest.parse(plain))
        assertEquals("http://127.0.0.1:8080/facet.apk", UpdateManifest.parse(plain, requireHttps = false)?.url)
    }

    @Test
    fun normalizesShaAndWhitespace() {
        val m = UpdateManifest.parse(json(*without("sha256"), "sha256" to " ${sha.uppercase()} "))
        assertEquals(sha, m?.sha256)
    }

    @Test
    fun noteLinesDropListMarkersAndBlankLines() {
        val m = UpdateManifest.parse(json(*without("notes"), "notes" to "- One\\n\\n• Two\\n* Three\\n  Four  "))
        assertEquals(listOf("One", "Two", "Three", "Four"), m?.noteLines)
    }

    @Test
    fun encodeRoundTrips() {
        val m = UpdateManifest.parse(json(*complete))!!
        assertEquals(m, UpdateManifest.parse(UpdateManifest.encode(m)))
    }
}
