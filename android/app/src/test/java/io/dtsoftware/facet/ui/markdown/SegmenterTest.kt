package io.dtsoftware.facet.ui.markdown

import io.dtsoftware.facet.ui.markdown.Segmenter.Segment.Kind
import org.junit.Assert.assertEquals
import org.junit.Test

class SegmenterTest {

    private fun kinds(text: String) = Segmenter.split(text).map { it.kind }
    private fun texts(text: String) = Segmenter.split(text).map { it.text }

    @Test
    fun splitsParagraphsAtBlankLines() {
        val segs = texts("# Title\n\nFirst para.\n\nSecond para.")
        assertEquals(listOf("# Title\n\n", "First para.\n\n", "Second para."), segs)
    }

    @Test
    fun segmentsConcatenateBackToSource() {
        val src = "a\n\n```kt\nval x = 1\n\nval y = 2\n```\n\n- one\n\n- two\n\n> q\n\ntext"
        val segs = Segmenter.split(src)
        assertEquals(src, segs.joinToString("") { it.text })
    }

    @Test
    fun neverSplitsInsideFence() {
        val src = "Intro\n\n```python\ndef f():\n\n    return 1\n\nprint(f())\n```\n\nAfter"
        val segs = texts(src)
        assertEquals(3, segs.size)
        assertEquals("```python\ndef f():\n\n    return 1\n\nprint(f())\n```\n\n", segs[1])
    }

    @Test
    fun unclosedFenceStaysOneSegment() {
        val src = "Intro\n\n```js\nconst a = 1\n\nconst b = 2\n"
        assertEquals(2, texts(src).size)
    }

    @Test
    fun keepsLooseListsTogether() {
        val src = "Steps:\n\n1. one\n\n2. two\n\n   more about two\n\n3. three\n\nDone."
        val segs = texts(src)
        assertEquals(listOf("Steps:\n\n", "1. one\n\n2. two\n\n   more about two\n\n3. three\n\n", "Done."), segs)
    }

    @Test
    fun thematicBreakStartsNewSegment() {
        assertEquals(2, texts("para\n\n---\n").size)
    }

    @Test
    fun displayMathBecomesItsOwnSegment() {
        val src = "The formula:\n$$\nE = mc^2\n$$\nwhere m is mass."
        val segs = Segmenter.split(src)
        assertEquals(listOf(Kind.MARKDOWN, Kind.MATH, Kind.MARKDOWN), segs.map { it.kind })
        assertEquals("E = mc^2", segs[1].text)
    }

    @Test
    fun singleLineDisplayMath() {
        val segs = Segmenter.split("$$ a^2 + b^2 = c^2 $$")
        assertEquals(listOf(Kind.MATH), segs.map { it.kind })
        assertEquals("a^2 + b^2 = c^2", segs[0].text)
        assertEquals(listOf(Kind.MATH), kinds("\\[ x \\]"))
    }

    @Test
    fun unclosedDisplayMathIsPlainText() {
        assertEquals(listOf(Kind.MARKDOWN), kinds("Intro\n$$\nE = mc"))
    }

    @Test
    fun mathInsideFenceIsIgnored() {
        assertEquals(listOf(Kind.MARKDOWN), kinds("```\n$$\nx\n$$\n```"))
    }
}
