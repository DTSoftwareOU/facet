package io.dtsoftware.facet.ui.markdown

import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.AnnotatedString

/** A LaTeX formula referenced from text via an inline-content placeholder with [id]. */
@Immutable
data class InlineMath(val id: String, val latex: String, val display: Boolean)

/** Text plus the inline formulas it references. */
@Immutable
data class RichText(val text: AnnotatedString, val math: List<InlineMath> = emptyList()) {
    val isBlank: Boolean get() = text.isBlank() && math.isEmpty()
}

enum class CellAlign { START, CENTER, END }

/** Parsed Markdown block. Instances are immutable and reused across recompositions while unchanged. */
@Immutable
sealed interface MdBlock {
    data class Paragraph(val content: RichText) : MdBlock
    data class Heading(val level: Int, val content: RichText) : MdBlock
    data class Code(val language: String?, val code: String, val closed: Boolean) : MdBlock
    data class Math(val latex: String) : MdBlock
    data class Quote(val children: List<MdBlock>) : MdBlock
    data class ListBlock(val ordered: Boolean, val start: Int, val loose: Boolean, val items: List<ListItem>) : MdBlock
    data class Table(val header: List<RichText>, val rows: List<List<RichText>>, val aligns: List<CellAlign>) : MdBlock
    data object Rule : MdBlock
}

/** [task] is null for a plain item, true/false for a checked/unchecked task. */
@Immutable
data class ListItem(val task: Boolean?, val children: List<MdBlock>)

/** A block with a key that stays stable while the block's source is unchanged. */
@Immutable
data class KeyedBlock(val key: String, val block: MdBlock)
