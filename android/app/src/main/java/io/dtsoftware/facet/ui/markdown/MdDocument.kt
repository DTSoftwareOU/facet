package io.dtsoftware.facet.ui.markdown

/**
 * Incremental parse cache for one rendered document. Segments whose source is unchanged since
 * the previous [update] reuse their parsed blocks (same instances), so Compose can skip them.
 */
internal class MdDocument(colors: InlineColors, links: LinkHandler) {

    private val parser = MdParser(colors, links)
    private var segments: List<Segmenter.Segment> = emptyList()
    private var parsed: List<List<KeyedBlock>> = emptyList()
    private var last: String? = null
    private var lastResult: List<KeyedBlock> = emptyList()

    /** Number of segment parses performed; exposed for tests. */
    var parseCount = 0
        private set

    fun update(text: String): List<KeyedBlock> {
        if (text == last) return lastResult
        val next = Segmenter.split(text)
        val nextParsed = ArrayList<List<KeyedBlock>>(next.size)
        for ((i, seg) in next.withIndex()) {
            val reuse = segments.getOrNull(i)?.takeIf { it == seg }?.let { parsed[i] }
            nextParsed += reuse ?: parseSegment(i, seg)
        }
        segments = next
        parsed = nextParsed
        last = text
        lastResult = if (nextParsed.size == 1) nextParsed[0] else nextParsed.flatten()
        return lastResult
    }

    private fun parseSegment(index: Int, seg: Segmenter.Segment): List<KeyedBlock> {
        parseCount++
        val blocks = when (seg.kind) {
            Segmenter.Segment.Kind.MATH -> listOf(MdBlock.Math(seg.text))
            Segmenter.Segment.Kind.MARKDOWN -> parser.parse(seg.text)
        }
        return blocks.mapIndexed { j, b -> KeyedBlock("$index:$j", b) }
    }
}
