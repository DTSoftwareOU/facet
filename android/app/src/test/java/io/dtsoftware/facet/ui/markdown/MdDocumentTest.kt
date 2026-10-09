package io.dtsoftware.facet.ui.markdown

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class MdDocumentTest {

    private val colors = InlineColors(Color.Cyan, Color.DarkGray, Color.White)
    private fun doc() = MdDocument(colors, LinkHandler())
    private fun parse(md: String) = doc().update(md).map { it.block }

    @Test
    fun parsesBlockTypes() {
        val md = """
            # Title

            Intro with **bold**, *italic*, ~~gone~~ and `code`.

            - [ ] todo
            - [x] done

            1. one
            2. two

            > quoted
            > more

            | a | b | c |
            |:--|:-:|--:|
            | 1 | 2 | 3 |

            ```kotlin
            val x = 1
            ```

            ---
        """.trimIndent()
        val blocks = parse(md)
        assertEquals(
            listOf("Heading", "Paragraph", "ListBlock", "ListBlock", "Quote", "Table", "Code", "Rule"),
            blocks.map { it::class.simpleName },
        )
        val tasks = blocks[2] as MdBlock.ListBlock
        assertEquals(listOf(false, true), tasks.items.map { it.task })
        val ordered = blocks[3] as MdBlock.ListBlock
        assertTrue(ordered.ordered)
        assertEquals(1, ordered.start)
        val quote = blocks[4] as MdBlock.Quote
        val quoteText = (quote.children.single() as MdBlock.Paragraph).content.text.text
        assertEquals("quoted\nmore", quoteText)
        val table = blocks[5] as MdBlock.Table
        assertEquals(listOf(CellAlign.START, CellAlign.CENTER, CellAlign.END), table.aligns)
        assertEquals("b", table.header[1].text.text)
        assertEquals("3", table.rows[0][2].text.text)
        val code = blocks[6] as MdBlock.Code
        assertEquals("kotlin", code.language)
        assertEquals("val x = 1", code.code)
        assertTrue(code.closed)
        val para = (blocks[1] as MdBlock.Paragraph).content.text
        assertEquals("Intro with bold, italic, gone and code.", para.text)
    }

    @Test
    fun unclosedFenceIsOpenCodeBlock() {
        val blocks = parse("Here:\n\n```python\nprint(1)\nprint(2)")
        val code = blocks.last() as MdBlock.Code
        assertFalse(code.closed)
        assertEquals("print(1)\nprint(2)", code.code)
    }

    @Test
    fun orderedListStartAndNesting() {
        val blocks = parse("3. three\n4. four\n   - nested a\n   - nested b")
        val list = blocks.single() as MdBlock.ListBlock
        assertEquals(3, list.start)
        val nested = list.items[1].children.last() as MdBlock.ListBlock
        assertFalse(nested.ordered)
        assertEquals(2, nested.items.size)
    }

    @Test
    fun linksAreSafeAndAnnotated() {
        val p = parse("See [docs](https://example.com) and [bad](javascript:alert(1)) and https://x.io.").single() as MdBlock.Paragraph
        val links = p.content.text.getLinkAnnotations(0, p.content.text.length).map { (it.item as LinkAnnotation.Url).url }
        assertEquals(listOf("https://example.com", "https://x.io"), links)
        assertEquals("See docs and bad and https://x.io.", p.content.text.text)
    }

    @Test
    fun imagesBecomeLinksNotImages() {
        val p = parse("![A chart](https://img.example/c.png)").single() as MdBlock.Paragraph
        assertEquals("A chart", p.content.text.text)
        assertEquals(1, p.content.text.getLinkAnnotations(0, p.content.text.length).size)
    }

    @Test
    fun entitiesAndEscapesDecoded() {
        val p = parse("Tom &amp; Jerry \\*not em\\* &#x2713;").single() as MdBlock.Paragraph
        assertEquals("Tom & Jerry *not em* ✓", p.content.text.text)
    }

    @Test
    fun rawHtmlIsShownAsText() {
        val p = parse("<div>hi</div>").single() as MdBlock.Paragraph
        assertEquals("<div>hi</div>", p.content.text.text)
    }

    @Test
    fun inlineMathBecomesInlineContent() {
        val p = parse("Area is \$\\pi r^2\$ for \$r_1\$.").single() as MdBlock.Paragraph
        assertEquals(listOf("\\pi r^2", "r_1"), p.content.math.map { it.latex })
        assertTrue(p.content.text.text.contains("\\pi r^2"))
        assertFalse(p.content.text.text.contains(MathPrepass.OPEN))
    }

    @Test
    fun displayMathParagraphBecomesMathBlock() {
        val blocks = parse("Before\n\n\$\$\n\\sum_{i=1}^n i\n\$\$\n\nAfter")
        assertEquals(listOf("Paragraph", "Math", "Paragraph"), blocks.map { it::class.simpleName })
        assertEquals("\\sum_{i=1}^n i", (blocks[1] as MdBlock.Math).latex)
    }

    @Test
    fun mathInCodeIsRestoredVerbatim() {
        val code = parse("```\nprice = \$5 and \$x\$\n```").single() as MdBlock.Code
        assertEquals("price = \$5 and \$x\$", code.code)
    }

    @Test
    fun citationMarkersStayPlain() {
        val p = parse("As shown [1] and [2].").single() as MdBlock.Paragraph
        assertEquals("As shown [1] and [2].", p.content.text.text)
    }

    @Test
    fun incrementalUpdateReparsesOnlyTail() {
        val d = doc()
        val part1 = "# Heading\n\nFirst paragraph is complete.\n\n"
        val first = d.update(part1 + "Second para")
        val countAfterFirst = d.parseCount
        val second = d.update(part1 + "Second paragraph grows")
        assertEquals(countAfterFirst + 1, d.parseCount)
        assertSame(first[0].block, second[0].block)
        assertSame(first[1].block, second[1].block)
        assertEquals("0:0", second[0].key)
        // Unchanged text is a no-op.
        val third = d.update(part1 + "Second paragraph grows")
        assertSame(second, third)
        assertEquals(countAfterFirst + 1, d.parseCount)
    }

    @Test
    fun streamingSimulationStaysConsistentWithFullParse() {
        val full = """
            ## Plan

            Here is a list:

            1. Install the **SDK**
            2. Run `./gradlew build`

            ```bash
            echo "hi"
            ```

            | k | v |
            |---|---|
            | a | 1 |

            Done with ${'$'}x^2${'$'}.
        """.trimIndent()
        val d = doc()
        var i = 0
        while (i < full.length) {
            i = (i + 7).coerceAtMost(full.length)
            d.update(full.substring(0, i))
        }
        val incremental = d.update(full).map { it.block }
        val fresh = parse(full)
        assertEquals(fresh, incremental)
    }

    @Test
    fun streamingLongReplyStaysCheapPerUpdate() {
        val section = """
            ## Section

            Some **bold** text with `code`, a [link](https://example.com) and ${'$'}x^2${'$'} math.

            - item one
            - item two

            ```kotlin
            fun main() { println("hi") }
            ```

        """.trimIndent() + "\n\n"
        val full = section.repeat(60) // ~14 KB
        val d = doc()
        val start = System.nanoTime()
        var updates = 0
        var i = 0
        while (i < full.length) {
            i = (i + 8).coerceAtMost(full.length)
            d.update(full.substring(0, i))
            updates++
        }
        val avgMs = (System.nanoTime() - start) / 1e6 / updates
        println("streamed ${full.length} chars in $updates updates, avg ${"%.3f".format(avgMs)} ms/update, ${d.parseCount} segment parses")
        // Only the tail is re-parsed: parses grow with updates, not with updates × segments.
        assertTrue("parseCount=${d.parseCount}", d.parseCount < updates + 400)
        assertTrue("avg=$avgMs ms", avgMs < 20.0)
    }

    @Test
    fun linkDefinitionsResolveWithinSegment() {
        val p = parse("Read [the guide][g].\n[g]: https://guide.example").first() as MdBlock.Paragraph
        val link = p.content.text.getLinkAnnotations(0, p.content.text.length).singleOrNull()
        assertEquals("https://guide.example", (link?.item as? LinkAnnotation.Url)?.url)
    }

    @Test
    fun emptyInputHasNoBlocks() {
        assertTrue(parse("").isEmpty())
        assertTrue(parse("\n\n   \n").isEmpty())
        assertNull(parse("x").firstOrNull { it is MdBlock.Code })
    }
}
