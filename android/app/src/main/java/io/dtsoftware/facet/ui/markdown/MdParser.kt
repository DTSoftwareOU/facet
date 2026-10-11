package io.dtsoftware.facet.ui.markdown

import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.em
import io.dtsoftware.facet.ui.theme.JetBrainsMono
import org.intellij.markdown.IElementType
import org.intellij.markdown.MarkdownElementTypes as E
import org.intellij.markdown.MarkdownTokenTypes as T
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.flavours.gfm.GFMElementTypes as GE
import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor
import org.intellij.markdown.flavours.gfm.GFMTokenTypes as GT
import org.intellij.markdown.parser.CancellationToken
import org.intellij.markdown.parser.MarkdownParser

/** Colors baked into parsed inline text. Part of the parse cache key. */
@Immutable
data class InlineColors(val link: Color, val codeBackground: Color, val codeText: Color)

/** Delegating link handler so cached annotations can reach the current click callback. */
class LinkHandler {
    var onClick: (String) -> Unit = {}
}

/** Parses one Markdown segment into blocks. Not thread-safe; create one per document. */
internal class MdParser(private val colors: InlineColors, private val links: LinkHandler) {

    private val parser = MarkdownParser(GFMFlavourDescriptor(), false, CancellationToken.NonCancellable)

    private val linkStyles = TextLinkStyles(
        style = SpanStyle(color = colors.link, textDecoration = TextDecoration.Underline),
        pressedStyle = SpanStyle(color = colors.link, background = colors.link.copy(alpha = 0.16f)),
    )
    private val codeStyle = SpanStyle(
        fontFamily = JetBrainsMono,
        fontFeatureSettings = NO_LIGATURES,
        fontSize = 0.88.em,
        background = colors.codeBackground,
        color = colors.codeText,
    )

    fun parse(markdown: String): List<MdBlock> {
        val prepass = MathPrepass.protect(markdown)
        val src = prepass.text
        val root = parser.buildMarkdownTreeFromString(src as CharSequence)
        val ctx = Ctx(src, prepass.formulas, collectDefinitions(root, src))
        return blocks(root.children, ctx)
    }

    private class Ctx(val src: String, val formulas: List<InlineMath>, val defs: Map<String, String>) {
        fun text(n: ASTNode): String = src.substring(n.startOffset, n.endOffset)
    }

    // ---------------------------------------------------------------- blocks

    private fun blocks(nodes: List<ASTNode>, ctx: Ctx): List<MdBlock> {
        val out = ArrayList<MdBlock>()
        for (n in nodes) block(n, ctx)?.let(out::add)
        return out
    }

    private fun block(n: ASTNode, ctx: Ctx): MdBlock? = when (n.type) {
        E.PARAGRAPH -> paragraph(n.children, ctx)
        E.ATX_1, E.ATX_2, E.ATX_3, E.ATX_4, E.ATX_5, E.ATX_6 -> {
            val level = atxLevel(n.type)
            val content = n.children.firstOrNull { it.type == T.ATX_CONTENT }
            MdBlock.Heading(level, rich(content?.children.orEmpty(), ctx, trim = true))
        }
        E.SETEXT_1, E.SETEXT_2 -> {
            val content = n.children.firstOrNull { it.type == T.SETEXT_CONTENT }
            MdBlock.Heading(if (n.type == E.SETEXT_1) 1 else 2, rich(content?.children.orEmpty(), ctx, trim = true))
        }
        E.CODE_FENCE -> codeFence(n, ctx)
        E.CODE_BLOCK -> MdBlock.Code(null, indentedCode(n, ctx), closed = true)
        E.BLOCK_QUOTE -> MdBlock.Quote(blocks(n.children.filter { it.type != T.BLOCK_QUOTE }, ctx))
        E.UNORDERED_LIST, E.ORDERED_LIST -> list(n, ctx)
        GE.TABLE -> table(n, ctx)
        T.HORIZONTAL_RULE -> MdBlock.Rule
        E.HTML_BLOCK -> plainParagraph(restoreMath(ctx.text(n), ctx))
        E.LINK_DEFINITION, T.EOL, T.WHITE_SPACE -> null
        else -> if (n.children.isEmpty() && ctx.text(n).isBlank()) null else paragraph(listOf(n), ctx)
    }

    private fun paragraph(children: List<ASTNode>, ctx: Ctx): MdBlock? {
        val content = rich(children, ctx, trim = true)
        if (content.isBlank) return null
        // A paragraph that is only a display formula renders as a centered math block.
        if (content.math.size == 1 && content.math[0].display && content.text.text.trim() == content.math[0].latex) {
            return MdBlock.Math(content.math[0].latex)
        }
        return MdBlock.Paragraph(content)
    }

    private fun plainParagraph(text: String): MdBlock? =
        if (text.isBlank()) null else MdBlock.Paragraph(RichText(AnnotatedString(text.trim())))

    private fun atxLevel(t: IElementType) = when (t) {
        E.ATX_1 -> 1; E.ATX_2 -> 2; E.ATX_3 -> 3; E.ATX_4 -> 4; E.ATX_5 -> 5; else -> 6
    }

    private fun codeFence(n: ASTNode, ctx: Ctx): MdBlock {
        val lang = n.children.firstOrNull { it.type == T.FENCE_LANG }?.let { ctx.text(it).trim() }
            ?.split(' ', '\t', '{')?.firstOrNull()?.takeIf { it.isNotEmpty() }
        val closed = n.children.any { it.type == T.CODE_FENCE_END }
        val start = n.children.firstOrNull { it.type == T.CODE_FENCE_START }
        val startCol = start?.let { column(ctx.src, it.startOffset) } ?: 0
        // Content = everything after the opening line up to the closing fence line.
        val firstEol = n.children.indexOfFirst { it.type == T.EOL }
        if (firstEol < 0) return MdBlock.Code(lang, "", closed)
        val contentStart = n.children[firstEol].endOffset
        val end = n.children.lastOrNull { it.type == T.CODE_FENCE_END }
        var contentEnd = end?.let { lineStartOf(ctx.src, it.startOffset) } ?: n.endOffset
        if (contentEnd < contentStart) contentEnd = contentStart
        var code = ctx.src.substring(contentStart, contentEnd)
        if (code.endsWith("\n")) code = code.dropLast(1)
        if (startCol > 0) code = code.lines().joinToString("\n") { stripIndent(it, startCol) }
        code = cleanContinuationMarkers(code, n, ctx)
        return MdBlock.Code(lang, restoreMath(code, ctx), closed)
    }

    /** Fences inside block quotes carry `>` markers on each content line; drop them. */
    private fun cleanContinuationMarkers(code: String, n: ASTNode, ctx: Ctx): String {
        val hasQuote = n.children.any { it.type == T.BLOCK_QUOTE }
        if (!hasQuote) return code
        return code.lines().joinToString("\n") { line ->
            val t = line.trimStart()
            if (t.startsWith(">")) t.removePrefix(">").removePrefix(" ") else line
        }
    }

    private fun indentedCode(n: ASTNode, ctx: Ctx): String {
        val raw = ctx.text(n)
        return restoreMath(raw.lines().joinToString("\n") { stripIndent(it, 4) }.trimEnd('\n'), ctx)
    }

    private fun stripIndent(line: String, count: Int): String {
        var i = 0
        var col = 0
        while (i < line.length && col < count) {
            when (line[i]) {
                ' ' -> col++
                '\t' -> col += 4
                else -> break
            }
            i++
        }
        return line.substring(i)
    }

    private fun column(src: String, offset: Int): Int = offset - lineStartOf(src, offset)

    private fun lineStartOf(src: String, offset: Int): Int {
        val nl = src.lastIndexOf('\n', offset - 1)
        return if (nl < 0) 0 else nl + 1
    }

    private fun list(n: ASTNode, ctx: Ctx): MdBlock {
        val ordered = n.type == E.ORDERED_LIST
        val items = n.children.filter { it.type == E.LIST_ITEM }
        var start = 1
        if (ordered) {
            items.firstOrNull()?.children?.firstOrNull { it.type == T.LIST_NUMBER }?.let { num ->
                start = ctx.text(num).trim().trimEnd('.', ')').toIntOrNull() ?: 1
            }
        }
        var loose = false
        var eolRun = 0
        for (c in n.children) {
            if (c.type == T.EOL) {
                eolRun++
                if (eolRun >= 2) loose = true
            } else if (c.type != T.WHITE_SPACE) {
                eolRun = 0
            }
        }
        val parsed = items.map { item ->
            var task: Boolean? = null
            val content = ArrayList<ASTNode>()
            for (c in item.children) {
                when (c.type) {
                    T.LIST_BULLET, T.LIST_NUMBER -> Unit
                    GT.CHECK_BOX -> task = ctx.text(c).contains('x', ignoreCase = true)
                    else -> content += c
                }
            }
            if (!loose) {
                var run = 0
                for (c in item.children) {
                    if (c.type == T.EOL) {
                        run++
                        if (run >= 2) loose = true
                    } else if (c.type != T.WHITE_SPACE) run = 0
                }
            }
            ListItem(task, blocks(content, ctx))
        }
        return MdBlock.ListBlock(ordered, start, loose, parsed)
    }

    private fun table(n: ASTNode, ctx: Ctx): MdBlock {
        val header = n.children.firstOrNull { it.type == GE.HEADER }
        val headerCells = header?.children?.filter { it.type == GT.CELL }.orEmpty().map { rich(it.children, ctx, trim = true) }
        val sep = n.children.firstOrNull { it.type == GT.TABLE_SEPARATOR }?.let { ctx.text(it) }
        val cols = headerCells.size.coerceAtLeast(1)
        val aligns = parseAligns(sep, cols)
        val rows = n.children.filter { it.type == GE.ROW }.map { row ->
            val cells = row.children.filter { it.type == GT.CELL }.map { rich(it.children, ctx, trim = true) }
            when {
                cells.size == cols -> cells
                cells.size > cols -> cells.take(cols)
                else -> cells + List(cols - cells.size) { RichText(AnnotatedString("")) }
            }
        }
        return MdBlock.Table(headerCells, rows, aligns)
    }

    private fun parseAligns(sep: String?, cols: Int): List<CellAlign> {
        if (sep == null) return List(cols) { CellAlign.START }
        val parts = sep.trim().trim('|').split('|').map { it.trim() }
        return List(cols) { i ->
            val p = parts.getOrNull(i) ?: ""
            when {
                p.startsWith(":") && p.endsWith(":") && p.length > 1 -> CellAlign.CENTER
                p.endsWith(":") -> CellAlign.END
                else -> CellAlign.START
            }
        }
    }

    private fun collectDefinitions(root: ASTNode, src: String): Map<String, String> {
        val defs = HashMap<String, String>()
        for (c in root.children) {
            if (c.type != E.LINK_DEFINITION) continue
            val label = c.children.firstOrNull { it.type == E.LINK_LABEL } ?: continue
            val dest = c.children.firstOrNull { it.type == E.LINK_DESTINATION } ?: continue
            defs[normalizeLabel(src.substring(label.startOffset, label.endOffset))] =
                src.substring(dest.startOffset, dest.endOffset).trim().removePrefix("<").removeSuffix(">")
        }
        return defs
    }

    private fun normalizeLabel(label: String) = label.trim().removePrefix("[").removeSuffix("]").trim().lowercase()

    // ---------------------------------------------------------------- inline

    private fun rich(children: List<ASTNode>, ctx: Ctx, trim: Boolean): RichText {
        val b = AnnotatedString.Builder()
        val state = InlineState()
        for (c in children) inline(c, ctx, b, state)
        var built = b.toAnnotatedString()
        if (trim) built = trimAnnotated(built)
        return resolveMath(built, ctx)
    }

    private class InlineState {
        /** True right after a line break: swallow indentation and quote markers. */
        var atLineStart = false
    }

    private fun inline(n: ASTNode, ctx: Ctx, b: AnnotatedString.Builder, st: InlineState) {
        val type = n.type
        if (st.atLineStart) {
            if (type == T.WHITE_SPACE || type == T.BLOCK_QUOTE) return
            st.atLineStart = false
        }
        when (type) {
            T.EOL, T.HARD_LINE_BREAK -> {
                b.append('\n')
                st.atLineStart = true
            }
            T.TEXT, T.WHITE_SPACE -> b.append(decode(ctx.text(n)))
            E.EMPH -> styled(n, ctx, b, st, SpanStyle(fontStyle = FontStyle.Italic)) { it == T.EMPH }
            E.STRONG -> styled(n, ctx, b, st, SpanStyle(fontWeight = FontWeight.SemiBold)) { it == T.EMPH }
            GE.STRIKETHROUGH -> styled(n, ctx, b, st, SpanStyle(textDecoration = TextDecoration.LineThrough)) { it == GT.TILDE }
            E.CODE_SPAN -> {
                val raw = ctx.text(n)
                val ticks = raw.takeWhile { it == '`' }.length
                var inner = if (raw.length >= ticks * 2) raw.substring(ticks, raw.length - ticks) else raw
                inner = inner.replace('\n', ' ')
                if (inner.length >= 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.isNotBlank()) {
                    inner = inner.substring(1, inner.length - 1)
                }
                b.pushStyle(codeStyle)
                b.append(inner)
                b.pop()
            }
            E.INLINE_LINK -> {
                val text = n.children.firstOrNull { it.type == E.LINK_TEXT }
                val dest = n.children.firstOrNull { it.type == E.LINK_DESTINATION }
                    ?.let { ctx.text(it).trim().removePrefix("<").removeSuffix(">") }
                link(text, dest, ctx, b, st, n)
            }
            E.FULL_REFERENCE_LINK -> {
                val text = n.children.firstOrNull { it.type == E.LINK_TEXT }
                val label = n.children.firstOrNull { it.type == E.LINK_LABEL }
                val dest = label?.let { ctx.defs[normalizeLabel(ctx.text(it))] }
                link(text, dest, ctx, b, st, n)
            }
            E.SHORT_REFERENCE_LINK -> {
                val label = n.children.firstOrNull { it.type == E.LINK_LABEL }
                val dest = label?.let { ctx.defs[normalizeLabel(ctx.text(it))] }
                if (dest != null) {
                    val inner = label.children.filter { it.type != T.LBRACKET && it.type != T.RBRACKET }
                    withLink(dest, b) { inner.forEach { inline(it, ctx, b, st) } }
                } else {
                    b.append(decode(ctx.text(n)))
                }
            }
            E.AUTOLINK -> {
                val url = n.children.firstOrNull { it.type == T.AUTOLINK }?.let { ctx.text(it) } ?: ctx.text(n).trim('<', '>')
                withLink(url, b) { b.append(url) }
            }
            GT.GFM_AUTOLINK -> {
                val raw = ctx.text(n)
                val (urlText, trailing) = splitTrailingPunctuation(raw)
                val url = if (urlText.startsWith("www.", ignoreCase = true)) "https://$urlText" else urlText
                withLink(url, b) { b.append(urlText) }
                b.append(trailing)
            }
            E.IMAGE -> {
                val linkNode = n.children.firstOrNull { it.type == E.INLINE_LINK || it.type == E.FULL_REFERENCE_LINK || it.type == E.SHORT_REFERENCE_LINK }
                val textNode = linkNode?.children?.firstOrNull { it.type == E.LINK_TEXT || it.type == E.LINK_LABEL }
                val alt = textNode?.let { decode(ctx.text(it).trim('[', ']')) }?.takeIf { it.isNotBlank() } ?: "image"
                val dest = when (linkNode?.type) {
                    E.INLINE_LINK -> linkNode.children.firstOrNull { it.type == E.LINK_DESTINATION }
                        ?.let { ctx.text(it).trim().removePrefix("<").removeSuffix(">") }
                    null -> null
                    else -> linkNode.children.firstOrNull { it.type == E.LINK_LABEL }?.let { ctx.defs[normalizeLabel(ctx.text(it))] }
                }
                if (dest != null && isSafeUrl(dest)) withLink(dest, b) { b.append(alt) } else b.append(alt)
            }
            T.HTML_TAG -> b.append(ctx.text(n))
            else -> {
                if (n.children.isEmpty()) b.append(decode(ctx.text(n)))
                else n.children.forEach { inline(it, ctx, b, st) }
            }
        }
    }

    private inline fun styled(
        n: ASTNode, ctx: Ctx, b: AnnotatedString.Builder, st: InlineState, style: SpanStyle,
        isDelimiter: (IElementType) -> Boolean,
    ) {
        val kids = n.children
        var from = 0
        var to = kids.size
        while (from < to && isDelimiter(kids[from].type)) from++
        while (to > from && isDelimiter(kids[to - 1].type)) to--
        b.pushStyle(style)
        for (k in from until to) inline(kids[k], ctx, b, st)
        b.pop()
    }

    private fun link(text: ASTNode?, dest: String?, ctx: Ctx, b: AnnotatedString.Builder, st: InlineState, whole: ASTNode) {
        val inner = text?.children?.filter { it.type != T.LBRACKET && it.type != T.RBRACKET }.orEmpty()
        if (dest == null || !isSafeUrl(dest)) {
            if (text != null) inner.forEach { inline(it, ctx, b, st) } else b.append(decode(ctx.text(whole)))
            return
        }
        withLink(dest, b) {
            if (inner.isEmpty()) b.append(dest) else inner.forEach { inline(it, ctx, b, st) }
        }
    }

    private inline fun withLink(url: String, b: AnnotatedString.Builder, content: () -> Unit) {
        if (!isSafeUrl(url)) {
            content(); return
        }
        val handler = links
        b.pushLink(LinkAnnotation.Url(url, linkStyles) { annotation ->
            val target = (annotation as? LinkAnnotation.Url)?.url ?: url
            handler.onClick(target)
        })
        content()
        b.pop()
    }

    private fun isSafeUrl(url: String): Boolean {
        val lower = url.trim().lowercase()
        return lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("mailto:")
    }

    private fun splitTrailingPunctuation(raw: String): Pair<String, String> {
        var end = raw.length
        while (end > 0 && raw[end - 1] in ".,;:!?*_~'\"") end--
        // Balance a trailing ')' only if the URL has a matching '('.
        if (end > 0 && raw[end - 1] == ')' && raw.count { it == '(' } < raw.substring(0, end).count { it == ')' }) end--
        return raw.substring(0, end) to raw.substring(end)
    }

    // ---------------------------------------------------------------- math & text helpers

    /** Replaces placeholder runs with inline-content markers for the formulas they reference. */
    private fun resolveMath(text: AnnotatedString, ctx: Ctx): RichText {
        val s = text.text
        if (s.indexOf(MathPrepass.OPEN) < 0) return RichText(text)
        val b = AnnotatedString.Builder()
        val used = ArrayList<InlineMath>()
        var i = 0
        while (i < s.length) {
            val open = s.indexOf(MathPrepass.OPEN, i)
            if (open < 0) {
                b.append(text.subSequence(i, s.length)); break
            }
            val close = s.indexOf(MathPrepass.CLOSE, open + 1)
            val idx = if (close > open) s.substring(open + 1, close).toIntOrNull() else null
            val formula = idx?.let { ctx.formulas.getOrNull(it) }
            if (formula == null) {
                b.append(text.subSequence(i, open + 1)); i = open + 1; continue
            }
            if (open > i) b.append(text.subSequence(i, open))
            b.appendInlineContent(formula.id, formula.latex)
            used += formula
            i = close + 1
        }
        return RichText(b.toAnnotatedString(), used)
    }

    /** Puts placeholders back as source text (`$…$`) where math can't be rendered (code). */
    private fun restoreMath(text: String, ctx: Ctx): String {
        if (text.indexOf(MathPrepass.OPEN) < 0) return text
        val sb = StringBuilder()
        var i = 0
        while (i < text.length) {
            val open = text.indexOf(MathPrepass.OPEN, i)
            if (open < 0) {
                sb.append(text, i, text.length); break
            }
            val close = text.indexOf(MathPrepass.CLOSE, open + 1)
            val f = if (close > open) text.substring(open + 1, close).toIntOrNull()?.let { ctx.formulas.getOrNull(it) } else null
            sb.append(text, i, open)
            if (f == null) {
                sb.append(text[open]); i = open + 1
            } else {
                sb.append(if (f.display) "$$" else "$").append(f.latex).append(if (f.display) "$$" else "$")
                i = close + 1
            }
        }
        return sb.toString()
    }

    private fun trimAnnotated(s: AnnotatedString): AnnotatedString {
        val text = s.text
        var start = 0
        var end = text.length
        while (start < end && text[start].isWhitespace()) start++
        while (end > start && text[end - 1].isWhitespace()) end--
        return if (start == 0 && end == text.length) s else s.subSequence(start, end)
    }

    companion object {
        private val ENTITIES = mapOf(
            "amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to " ",
            "copy" to "©", "reg" to "®", "trade" to "™", "mdash" to "\u2014", "ndash" to "–", "hellip" to "…",
            "rarr" to "→", "larr" to "←", "uarr" to "↑", "darr" to "↓", "harr" to "↔", "rArr" to "⇒", "lArr" to "⇐",
            "times" to "×", "divide" to "÷", "deg" to "°", "plusmn" to "±", "middot" to "·", "bull" to "•",
            "laquo" to "«", "raquo" to "»", "lsquo" to "‘", "rsquo" to "’", "ldquo" to "“", "rdquo" to "”",
            "euro" to "€", "pound" to "£", "yen" to "¥", "cent" to "¢", "sect" to "§", "para" to "¶",
            "le" to "≤", "ge" to "≥", "ne" to "≠", "asymp" to "≈", "infin" to "∞", "check" to "✓",
        )
        private const val PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"

        /** Removes backslash escapes and decodes HTML entities. */
        fun decode(s: String): String {
            if (s.indexOf('\\') < 0 && s.indexOf('&') < 0) return s
            val sb = StringBuilder(s.length)
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c == '\\' && i + 1 < s.length && PUNCT.indexOf(s[i + 1]) >= 0) {
                    sb.append(s[i + 1]); i += 2; continue
                }
                if (c == '&') {
                    val semi = s.indexOf(';', i + 1)
                    if (semi in (i + 2)..(i + 10)) {
                        val name = s.substring(i + 1, semi)
                        val decoded = when {
                            name.startsWith("#x") || name.startsWith("#X") ->
                                name.substring(2).toIntOrNull(16)?.let { codePointString(it) }
                            name.startsWith("#") -> name.substring(1).toIntOrNull()?.let { codePointString(it) }
                            else -> ENTITIES[name]
                        }
                        if (decoded != null) {
                            sb.append(decoded); i = semi + 1; continue
                        }
                    }
                }
                sb.append(c); i++
            }
            return sb.toString()
        }

        private fun codePointString(cp: Int): String? =
            if (cp in 1..0x10FFFF && cp !in 0xD800..0xDFFF) String(Character.toChars(cp)) else null
    }
}
