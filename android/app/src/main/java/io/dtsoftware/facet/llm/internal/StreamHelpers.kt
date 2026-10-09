package io.dtsoftware.facet.llm.internal

import io.dtsoftware.facet.llm.Citation
import io.dtsoftware.facet.llm.Usage

/**
 * Splits a content stream into visible text and reasoning when a model inlines its reasoning as
 * `<think>…</think>` (or Gemini's `<thought>…</thought>`). An opening tag is only recognized at
 * the very start of the response (ignoring whitespace), so literal tags inside answers survive.
 */
internal class ThinkTagSplitter {
    data class Segment(val thinking: Boolean, val text: String)

    private val buf = StringBuilder()
    private var inThink = false
    private var startDecided = false
    private var trimLeading = false

    fun feed(chunk: String): List<Segment> {
        if (chunk.isEmpty()) return emptyList()
        buf.append(chunk)
        return drain(final = false)
    }

    fun flush(): List<Segment> = drain(final = true)

    private fun drain(final: Boolean): List<Segment> {
        val out = ArrayList<Segment>(2)
        while (buf.isNotEmpty()) {
            if (!inThink) {
                if (!startDecided) {
                    val firstNonWs = buf.indexOfFirst { !it.isWhitespace() }
                    if (firstNonWs < 0) {
                        if (final) emit(out, false, buf.toString())
                        if (final) buf.setLength(0)
                        break
                    }
                    val rest = buf.substring(firstNonWs)
                    val open = OPEN_TAGS.firstOrNull { rest.startsWith(it) }
                    if (open != null) {
                        buf.delete(0, firstNonWs + open.length)
                        inThink = true
                        startDecided = true
                        continue
                    }
                    if (!final && OPEN_TAGS.any { it.startsWith(rest) }) break // partial tag, wait
                    startDecided = true
                }
                var text = buf.toString()
                if (trimLeading) {
                    text = text.trimStart('\n', '\r')
                    if (text.isEmpty() && !final) {
                        buf.setLength(0)
                        break
                    }
                    trimLeading = false
                }
                emit(out, false, text)
                buf.setLength(0)
            } else {
                val s = buf.toString()
                var closeAt = -1
                var closeLen = 0
                for (tag in CLOSE_TAGS) {
                    val i = s.indexOf(tag)
                    if (i >= 0 && (closeAt < 0 || i < closeAt)) {
                        closeAt = i
                        closeLen = tag.length
                    }
                }
                if (closeAt >= 0) {
                    emit(out, true, s.substring(0, closeAt))
                    buf.delete(0, closeAt + closeLen)
                    inThink = false
                    trimLeading = true
                    continue
                }
                // Hold back a possible partial closing tag.
                val hold = if (final) 0 else partialSuffix(s)
                emit(out, true, s.substring(0, s.length - hold))
                buf.delete(0, s.length - hold)
                break
            }
        }
        return out
    }

    private fun partialSuffix(s: String): Int {
        val max = minOf(s.length, CLOSE_TAGS.maxOf { it.length } - 1)
        for (n in max downTo 1) {
            val suffix = s.substring(s.length - n)
            if (CLOSE_TAGS.any { it.startsWith(suffix) }) return n
        }
        return 0
    }

    private fun emit(out: MutableList<Segment>, thinking: Boolean, text: String) {
        if (text.isEmpty()) return
        val last = out.lastOrNull()
        if (last != null && last.thinking == thinking) {
            out[out.lastIndex] = Segment(thinking, last.text + text)
        } else {
            out += Segment(thinking, text)
        }
    }

    private companion object {
        val OPEN_TAGS = listOf("<think>", "<thought>")
        val CLOSE_TAGS = listOf("</think>", "</thought>")
    }
}

/** De-duplicates sources by URL while preserving first-seen order. */
internal class CitationCollector {
    private val byUrl = LinkedHashMap<String, Citation>()

    /** Returns true when the list changed. */
    fun add(url: String?, title: String?, snippet: String? = null): Boolean {
        if (url.isNullOrBlank()) return false
        val existing = byUrl[url]
        if (existing == null) {
            byUrl[url] = Citation(url, title?.takeIf { it.isNotBlank() }, snippet?.takeIf { it.isNotBlank() })
            return true
        }
        val merged = existing.copy(
            title = existing.title ?: title?.takeIf { it.isNotBlank() },
            snippet = existing.snippet ?: snippet?.takeIf { it.isNotBlank() },
        )
        if (merged != existing) {
            byUrl[url] = merged
            return true
        }
        return false
    }

    fun isEmpty(): Boolean = byUrl.isEmpty()
    fun snapshot(): List<Citation> = byUrl.values.toList()
}

internal operator fun Usage.plus(o: Usage) = Usage(
    inputTokens = inputTokens + o.inputTokens,
    outputTokens = outputTokens + o.outputTokens,
    cacheReadTokens = cacheReadTokens + o.cacheReadTokens,
    cacheWriteTokens = cacheWriteTokens + o.cacheWriteTokens,
    reasoningTokens = reasoningTokens + o.reasoningTokens,
)
