package io.dtsoftware.facet.ui.markdown

/**
 * Replaces inline math (`$…$`, `\(…\)`, and in-paragraph `$$…$$` / `\[…\]`) with private-use
 * placeholders before Markdown parsing, so the parser can't mangle `_`, `*` or `\` inside
 * formulas. Code spans and fenced code are left untouched.
 */
internal object MathPrepass {

    const val OPEN = ''
    const val CLOSE = ''

    class Result(val text: String, val formulas: List<InlineMath>)

    private val EMPTY = emptyList<InlineMath>()

    fun protect(src: String): Result {
        if (src.indexOf('$') < 0 && src.indexOf('\\') < 0) return Result(src, EMPTY)
        val out = StringBuilder(src.length)
        val formulas = ArrayList<InlineMath>()
        var i = 0
        var lineStart = true
        var fence: Pair<Char, Int>? = null
        val n = src.length

        fun emit(latex: String, display: Boolean) {
            val id = "m${formulas.size}"
            formulas += InlineMath(id, latex.trim(), display)
            out.append(OPEN).append(formulas.size - 1).append(CLOSE)
        }

        while (i < n) {
            // Fenced code: copy whole lines verbatim.
            if (lineStart) {
                val lineEnd = src.indexOf('\n', i).let { if (it < 0) n else it + 1 }
                val line = src.substring(i, lineEnd)
                val f = fence
                if (f != null) {
                    out.append(line)
                    if (closesFence(line, f)) fence = null
                    i = lineEnd
                    continue
                }
                val opened = opensFence(line)
                if (opened != null) {
                    fence = opened
                    out.append(line)
                    i = lineEnd
                    continue
                }
                // Indented code (4+ spaces) is left alone unless it's inside a list; keeping it
                // verbatim is the safe choice either way.
                if (line.startsWith("    ") || line.startsWith("\t")) {
                    val trimmed = line.trimStart()
                    if (!trimmed.startsWith("- ") && !trimmed.startsWith("* ") && !startsWithDigitMarker(trimmed)) {
                        // Still allow math in list continuation paragraphs: only skip if it looks like code.
                        if (looksLikeCode(trimmed)) {
                            out.append(line)
                            i = lineEnd
                            continue
                        }
                    }
                }
            }
            val c = src[i]
            lineStart = false
            when {
                c == '\n' -> {
                    out.append(c); i++; lineStart = true
                }
                c == '`' -> {
                    val end = codeSpanEnd(src, i)
                    out.append(src, i, end)
                    i = end
                }
                c == '\\' && i + 1 < n -> {
                    val next = src[i + 1]
                    when (next) {
                        '(' -> {
                            val close = src.indexOf("\\)", i + 2)
                            val nl = src.indexOf('\n', i + 2)
                            if (close > i + 2 && (nl < 0 || close < nl)) {
                                emit(src.substring(i + 2, close), display = false)
                                i = close + 2
                            } else {
                                out.append("\\("); i += 2
                            }
                        }
                        '[' -> {
                            val close = src.indexOf("\\]", i + 2)
                            if (close > i + 2 && !src.substring(i + 2, close).contains("\n\n")) {
                                emit(src.substring(i + 2, close), display = true)
                                i = close + 2
                            } else {
                                out.append("\\["); i += 2
                            }
                        }
                        else -> {
                            out.append(c).append(next); i += 2
                        }
                    }
                }
                c == '$' -> {
                    if (i + 1 < n && src[i + 1] == '$') {
                        val close = src.indexOf("$$", i + 2)
                        if (close > i + 2 && !src.substring(i + 2, close).contains("\n\n") &&
                            src.substring(i + 2, close).isNotBlank()
                        ) {
                            emit(src.substring(i + 2, close), display = true)
                            i = close + 2
                        } else {
                            out.append("$$"); i += 2
                        }
                    } else {
                        val close = inlineDollarClose(src, i)
                        if (close > 0) {
                            emit(src.substring(i + 1, close), display = false)
                            i = close + 1
                        } else {
                            out.append(c); i++
                        }
                    }
                }
                else -> {
                    out.append(c); i++
                }
            }
        }
        return if (formulas.isEmpty()) Result(src, EMPTY) else Result(out.toString(), formulas)
    }

    /**
     * Pandoc-style `$…$` rules so currency isn't mistaken for math: the opening `$` must be
     * followed by a non-space, the closing `$` preceded by a non-space and not followed by a
     * digit, no newline inside, and the body can't be just a number.
     * Returns the index of the closing `$`, or -1.
     */
    fun inlineDollarClose(src: String, open: Int): Int {
        val n = src.length
        if (open > 0 && src[open - 1] == '\\') return -1
        if (open + 1 >= n) return -1
        val first = src[open + 1]
        if (first.isWhitespace() || first == '$') return -1
        var j = open + 1
        val limit = minOf(n, open + 1 + 400)
        while (j < limit) {
            val ch = src[j]
            if (ch == '\n') return -1
            if (ch == '\\') {
                j += 2; continue
            }
            if (ch == '$') {
                val prev = src[j - 1]
                val nextIsDigit = j + 1 < n && src[j + 1].isDigit()
                if (j > open + 1 && !prev.isWhitespace() && !nextIsDigit) {
                    val body = src.substring(open + 1, j)
                    if (isPlainNumber(body)) return -1
                    return j
                }
                return -1
            }
            j++
        }
        return -1
    }

    private fun isPlainNumber(body: String): Boolean =
        body.all { it.isDigit() || it == '.' || it == ',' || it == ' ' } && body.any { it.isDigit() }

    private fun codeSpanEnd(src: String, start: Int): Int {
        var run = 0
        while (start + run < src.length && src[start + run] == '`') run++
        var j = start + run
        val limit = minOf(src.length, start + 4000)
        while (j < limit) {
            if (src[j] == '\n' && j + 1 < src.length && src[j + 1] == '\n') break
            if (src[j] == '`') {
                var r = 0
                while (j + r < src.length && src[j + r] == '`') r++
                if (r == run) return j + r
                j += r
                continue
            }
            j++
        }
        return start + run // unmatched: literal backticks
    }

    private fun opensFence(line: String): Pair<Char, Int>? {
        var i = 0
        while (i < line.length && i < 3 && line[i] == ' ') i++
        if (i >= line.length) return null
        val c = line[i]
        if (c != '`' && c != '~') return null
        var k = 0
        while (i + k < line.length && line[i + k] == c) k++
        if (k < 3) return null
        if (c == '`' && line.indexOf('`', i + k) >= 0) return null
        return c to k
    }

    private fun closesFence(line: String, f: Pair<Char, Int>): Boolean {
        val t = line.trim()
        return t.length >= f.second && t.all { it == f.first }
    }

    private fun startsWithDigitMarker(s: String): Boolean {
        var j = 0
        while (j < s.length && s[j].isDigit()) j++
        return j > 0 && j < s.length && (s[j] == '.' || s[j] == ')')
    }

    private fun looksLikeCode(s: String): Boolean =
        s.contains('{') || s.contains(';') || s.contains("=") || s.contains("()")
}
