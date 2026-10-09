package io.dtsoftware.facet.ui.markdown

import io.dtsoftware.facet.ui.markdown.SyntaxHighlighter.Token
import io.dtsoftware.facet.ui.theme.BasaltColors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class SyntaxHighlighterTest {

    /** Returns the token covering the first occurrence of [needle] (whole needle must be one span). */
    private fun tokenOf(code: String, lang: String?, needle: String, occurrence: Int = 0): Token? {
        val spans = SyntaxHighlighter.tokenize(code, lang)
        var from = 0
        var idx = -1
        repeat(occurrence + 1) {
            idx = code.indexOf(needle, from)
            from = idx + 1
        }
        require(idx >= 0) { "needle not found: $needle" }
        var i = 0
        while (i < spans.size) {
            val s = spans[i + 1]
            val e = spans[i + 2]
            if (idx >= s && idx + needle.length <= e) return Token.entries[spans[i]]
            i += 3
        }
        return null
    }

    @Test
    fun kotlin() {
        val code = """
            @Composable
            fun greet(name: String): Int {
                // say hi
                val s = "Hello, ${'$'}name"
                return 42 + 0x1F
            }
        """.trimIndent()
        assertEquals(Token.ANNOTATION, tokenOf(code, "kotlin", "@Composable"))
        assertEquals(Token.KEYWORD, tokenOf(code, "kt", "fun"))
        assertEquals(Token.FUNCTION, tokenOf(code, "kt", "greet"))
        assertEquals(Token.TYPE, tokenOf(code, "kt", "String"))
        assertEquals(Token.COMMENT, tokenOf(code, "kt", "// say hi"))
        assertEquals(Token.STRING, tokenOf(code, "kt", "\"Hello, "))
        assertEquals(Token.NUMBER, tokenOf(code, "kt", "42"))
        assertEquals(Token.NUMBER, tokenOf(code, "kt", "0x1F"))
        assertEquals(Token.KEYWORD, tokenOf(code, "kt", "return"))
    }

    @Test
    fun python() {
        val code = "@dataclass\nclass A:\n    \"\"\"Doc\nstring\"\"\"\n    def f(self):\n        return f\"x={1}\"  # note\n"
        assertEquals(Token.ANNOTATION, tokenOf(code, "py", "@dataclass"))
        assertEquals(Token.STRING, tokenOf(code, "python", "\"\"\"Doc\nstring\"\"\""))
        assertEquals(Token.KEYWORD, tokenOf(code, "py", "def"))
        assertEquals(Token.STRING, tokenOf(code, "py", "f\"x={1}\""))
        assertEquals(Token.COMMENT, tokenOf(code, "py", "# note"))
    }

    @Test
    fun jsonKeysAndValues() {
        val code = """{"name": "Facet", "n": -1.5e3, "ok": true, "x": null}"""
        assertEquals(Token.ATTRIBUTE, tokenOf(code, "json", "\"name\""))
        assertEquals(Token.STRING, tokenOf(code, "json", "\"Facet\""))
        assertEquals(Token.NUMBER, tokenOf(code, "json", "-1.5e3"))
        assertEquals(Token.KEYWORD, tokenOf(code, "json", "true"))
    }

    @Test
    fun yamlAndToml() {
        val yaml = "server:\n  port: 8080 # http\n  name: \"facet\"\n  - item\n"
        assertEquals(Token.ATTRIBUTE, tokenOf(yaml, "yml", "server"))
        assertEquals(Token.NUMBER, tokenOf(yaml, "yaml", "8080"))
        assertEquals(Token.COMMENT, tokenOf(yaml, "yaml", "# http"))
        assertEquals(Token.STRING, tokenOf(yaml, "yaml", "\"facet\""))
        val toml = "[package]\nname = \"facet\"\nversion = 2\n"
        assertEquals(Token.TYPE, tokenOf(toml, "toml", "[package]"))
        assertEquals(Token.ATTRIBUTE, tokenOf(toml, "toml", "name"))
        assertEquals(Token.NUMBER, tokenOf(toml, "toml", "2"))
    }

    @Test
    fun markupAndCss() {
        val html = "<!-- c --><div class=\"a\">Hi &amp; bye</div>"
        assertEquals(Token.COMMENT, tokenOf(html, "html", "<!-- c -->"))
        assertEquals(Token.TAG, tokenOf(html, "html", "div"))
        assertEquals(Token.ATTRIBUTE, tokenOf(html, "html", "class"))
        assertEquals(Token.STRING, tokenOf(html, "html", "\"a\""))
        val css = ".card > h1 { color: #fff; margin: 12px !important; }"
        assertEquals(Token.TAG, tokenOf(css, "css", ".card"))
        assertEquals(Token.ATTRIBUTE, tokenOf(css, "css", "color"))
        assertEquals(Token.NUMBER, tokenOf(css, "css", "#fff"))
        assertEquals(Token.NUMBER, tokenOf(css, "css", "12px"))
        assertEquals(Token.KEYWORD, tokenOf(css, "css", "!important"))
    }

    @Test
    fun shellSqlAndDiff() {
        val sh = "# install\nexport PATH=\$HOME/bin:\$PATH\necho \"done\" # ok\n"
        assertEquals(Token.COMMENT, tokenOf(sh, "bash", "# install"))
        assertEquals(Token.KEYWORD, tokenOf(sh, "sh", "export"))
        assertEquals(Token.TYPE, tokenOf(sh, "sh", "\$HOME"))
        assertEquals(Token.FUNCTION, tokenOf(sh, "sh", "echo"))
        val sql = "SELECT id FROM users WHERE name = 'x' -- c"
        assertEquals(Token.KEYWORD, tokenOf(sql, "sql", "SELECT"))
        assertEquals(Token.STRING, tokenOf(sql, "sql", "'x'"))
        assertEquals(Token.COMMENT, tokenOf(sql, "sql", "-- c"))
        val diff = "@@ -1 +1 @@\n-old\n+new\n"
        assertEquals(Token.ANNOTATION, tokenOf(diff, "diff", "@@ -1 +1 @@"))
        assertEquals(Token.TAG, tokenOf(diff, "diff", "-old"))
        assertEquals(Token.STRING, tokenOf(diff, "diff", "+new"))
    }

    @Test
    fun rustLifetimesAndChars() {
        val rs = "fn f<'a>(x: &'a str) -> char { 'z' }"
        assertEquals(Token.ANNOTATION, tokenOf(rs, "rust", "'a", 0))
        assertEquals(Token.STRING, tokenOf(rs, "rs", "'z'"))
    }

    @Test
    fun displayNames() {
        assertEquals("Kotlin", SyntaxHighlighter.displayName("kt"))
        assertEquals("TypeScript", SyntaxHighlighter.displayName("ts"))
        assertEquals("text", SyntaxHighlighter.displayName(null))
        assertEquals("brainfuck", SyntaxHighlighter.displayName("brainfuck"))
    }

    @Test
    fun spansAreOrderedAndInBounds_fuzz() {
        val langs = listOf(null, "kotlin", "python", "json", "yaml", "toml", "html", "css", "bash", "sql", "rust", "c", "diff", "powershell", "ruby", "php", "lua", "go", "swift")
        val alphabet = "abcXYZ019_ \n\t\"'`#/*-+=<>{}()[];:.,@$\\!&|%"
        val rnd = Random(7)
        repeat(400) {
            val len = rnd.nextInt(0, 300)
            val code = buildString { repeat(len) { append(alphabet[rnd.nextInt(alphabet.length)]) } }
            for (lang in langs) {
                val spans = SyntaxHighlighter.tokenize(code, lang)
                var prevEnd = 0
                var i = 0
                while (i < spans.size) {
                    val s = spans[i + 1]
                    val e = spans[i + 2]
                    assertTrue("span order $lang", s >= prevEnd && e > s && e <= code.length)
                    prevEnd = e
                    i += 3
                }
                SyntaxHighlighter.highlight(code, lang, BasaltColors.syntax)
            }
        }
    }

    @Test
    fun hugeCodeIsNotHighlighted() {
        val big = "val x = 1\n".repeat(4000)
        val result = SyntaxHighlighter.highlight(big, "kotlin", BasaltColors.syntax)
        assertTrue(result.spanStyles.isEmpty())
        assertEquals(big, result.text)
    }
}
