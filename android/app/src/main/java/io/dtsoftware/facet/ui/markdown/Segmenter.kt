package io.dtsoftware.facet.ui.markdown

/**
 * Splits a Markdown document into independently parseable segments so that, while a reply
 * streams in, only the last segment needs re-parsing.
 *
 * A new segment starts at a "safe boundary": a non-indented line after a blank line, outside
 * any code fence, that can't continue the previous block (not a list marker). Display-math
 * blocks (`$$…$$` or `\[…\]` starting at column 0) become their own [Segment.Kind.MATH]
 * segments; an unclosed one is left as ordinary text until its closing delimiter arrives.
 */
internal object Segmenter {

    data class Segment(val kind: Kind, val text: String) {
        enum class Kind { MARKDOWN, MATH }
    }

    fun split(text: String): List<Segment> {
        if (text.isEmpty()) return emptyList()
        val lines = lines(text)
        val out = ArrayList<Segment>()
        val buf = StringBuilder()
        var fence: Fence? = null
        var prevBlank = true
        var lastTopLevelWasList = false
        var i = 0

        fun flush() {
            if (buf.isNotEmpty()) {
                out += Segment(Segment.Kind.MARKDOWN, buf.toString())
                buf.setLength(0)
            }
        }

        while (i < lines.size) {
            val line = lines[i]
            val content = line.trimEnd('\n', '\r')
            val f = fence
            if (f != null) {
                buf.append(line)
                if (f.closes(content)) fence = null
                prevBlank = false
                i++
                continue
            }
            val blank = content.isBlank()
            if (!blank) {
                val math = mathBlockAt(lines, i)
                if (math != null) {
                    flush()
                    out += Segment(Segment.Kind.MATH, math.latex)
                    i = math.endLineExclusive
                    prevBlank = true
                    continue
                }
                val opening = Fence.open(content)
                if (prevBlank && buf.isNotEmpty() && startsNewBlock(content, lastTopLevelWasList)) flush()
                if (opening != null) fence = opening
                if (content[0] != ' ' && content[0] != '\t') lastTopLevelWasList = isListMarker(content)
            }
            buf.append(line)
            prevBlank = blank
            i++
        }
        flush()
        return out
    }

    /** Lines including their trailing newline. */
    private fun lines(text: String): List<String> {
        val result = ArrayList<String>()
        var start = 0
        while (start < text.length) {
            val nl = text.indexOf('\n', start)
            if (nl < 0) {
                result += text.substring(start)
                break
            }
            result += text.substring(start, nl + 1)
            start = nl + 1
        }
        return result
    }

    /**
     * A non-indented line after a blank line starts a new segment, except a list marker that
     * could continue a list right above it.
     */
    private fun startsNewBlock(line: String, afterList: Boolean): Boolean {
        if (line.isEmpty()) return false
        val c = line[0]
        if (c == ' ' || c == '\t') return false
        if (afterList && isListMarker(line)) return false
        return true
    }

    private fun isListMarker(line: String): Boolean {
        val c = line[0]
        if ((c == '-' || c == '*' || c == '+') && (line.length == 1 || line[1] == ' ' || line[1] == '\t')) {
            // "---" / "***" are thematic breaks, which do start a new block.
            val stripped = line.filterNot { it == ' ' || it == '\t' }
            return !(stripped.length >= 3 && stripped.all { it == c })
        }
        var j = 0
        while (j < line.length && j < 9 && line[j].isDigit()) j++
        if (j == 0 || j >= line.length) return false
        val d = line[j]
        return (d == '.' || d == ')') && (j + 1 == line.length || line[j + 1] == ' ' || line[j + 1] == '\t')
    }

    private class MathBlock(val latex: String, val endLineExclusive: Int)

    private fun mathBlockAt(lines: List<String>, index: Int): MathBlock? {
        val first = lines[index].trimEnd('\n', '\r')
        val (open, close) = when {
            first.startsWith("$$") -> "$$" to "$$"
            first.startsWith("\\[") -> "\\[" to "\\]"
            else -> return null
        }
        val afterOpen = first.substring(open.length)
        val trimmedFirst = afterOpen.trimEnd()
        // Single line: $$ ... $$
        if (trimmedFirst.endsWith(close) && trimmedFirst.length >= close.length) {
            val inner = trimmedFirst.substring(0, trimmedFirst.length - close.length)
            if (inner.isBlank()) return null
            return MathBlock(inner.trim(), index + 1)
        }
        val sb = StringBuilder(afterOpen.trim())
        var j = index + 1
        while (j < lines.size) {
            val raw = lines[j].trimEnd('\n', '\r')
            if (raw.isBlank()) return null // display math never spans a blank line
            val t = raw.trimEnd()
            if (t.endsWith(close)) {
                val before = t.substring(0, t.length - close.length)
                if (sb.isNotEmpty() && before.isNotBlank()) sb.append('\n')
                sb.append(before.trim())
                val latex = sb.toString().trim()
                return if (latex.isEmpty()) null else MathBlock(latex, j + 1)
            }
            if (sb.isNotEmpty()) sb.append('\n')
            sb.append(raw.trim())
            j++
        }
        return null // unclosed (still streaming)
    }

    /** A fenced code block opener; tracks what closes it. */
    private class Fence(val char: Char, val length: Int) {
        fun closes(line: String): Boolean {
            var i = 0
            while (i < line.length && i < 3 && line[i] == ' ') i++
            var n = 0
            while (i + n < line.length && line[i + n] == char) n++
            if (n < length) return false
            return line.substring(i + n).isBlank()
        }

        companion object {
            fun open(line: String): Fence? {
                var i = 0
                while (i < line.length && i < 3 && line[i] == ' ') i++
                if (i >= line.length) return null
                val c = line[i]
                if (c != '`' && c != '~') return null
                var n = 0
                while (i + n < line.length && line[i + n] == c) n++
                if (n < 3) return null
                if (c == '`' && line.indexOf('`', i + n) >= 0) return null
                return Fence(c, n)
            }
        }
    }
}
