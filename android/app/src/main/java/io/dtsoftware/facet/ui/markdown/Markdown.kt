package io.dtsoftware.facet.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.isSpecified
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.isSpecified
import androidx.compose.ui.unit.sp
import io.dtsoftware.facet.R
import io.dtsoftware.facet.ui.theme.FacetColors
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlin.math.roundToInt

/**
 * Renders GitHub-flavored Markdown (plus LaTeX math) natively.
 *
 * @param streaming the text is still growing: incomplete syntax is tolerated and a breathing
 *   cursor follows the last block. Pair with [rememberSmoothedText] for even pacing.
 * @param onLinkClick overrides opening links with the system URI handler.
 * @param onCopyCode called after a code block's copy button copied its contents.
 */
@Composable
fun Markdown(
    text: String,
    modifier: Modifier = Modifier,
    streaming: Boolean = false,
    textStyle: TextStyle = FacetTheme.type.chat,
    onLinkClick: ((String) -> Unit)? = null,
    onCopyCode: ((String) -> Unit)? = null,
) {
    val colors = FacetTheme.colors
    val inlineColors = remember(colors) {
        InlineColors(link = colors.primary, codeBackground = colors.inlineCodeBackground, codeText = colors.text)
    }
    val links = remember { LinkHandler() }
    val uriHandler = LocalUriHandler.current
    links.onClick = onLinkClick ?: { url -> runCatching { uriHandler.openUri(url) } }

    val doc = remember(inlineColors) { MdDocument(inlineColors, links) }
    val blocks = remember(doc, text) { doc.update(text) }

    // Show code characters literally: no `->` arrows or other ligatures.
    val codeStyle = FacetTheme.type.code.copy(fontFeatureSettings = NO_LIGATURES)
    val density = LocalDensity.current
    val env = remember(textStyle, colors, codeStyle, density) {
        val base = textStyle.copy(color = if (textStyle.color.isSpecified) textStyle.color else colors.text)
        MdEnv(base, codeStyle, colors, density, onCopyCode)
    }.also { it.onCopyCode = onCopyCode }

    Column(modifier) {
        blocks.forEachIndexed { i, kb ->
            key(kb.key) {
                val top = if (i == 0) 0.dp else spacingBefore(blocks[i - 1].block, kb.block, nested = false)
                RenderBlock(
                    block = kb.block,
                    env = env,
                    color = env.base.color,
                    modifier = if (top > 0.dp) Modifier.padding(top = top) else Modifier,
                    cursor = streaming && i == blocks.lastIndex,
                    depth = 0,
                )
            }
        }
        if (streaming && blocks.isEmpty()) {
            Box(Modifier.height(env.lineHeight), contentAlignment = Alignment.CenterStart) { StreamingCursor() }
        }
    }
}

/** Resolved rendering inputs shared by all blocks of one document. */
internal class MdEnv(
    val base: TextStyle,
    val code: TextStyle,
    val colors: FacetColors,
    val density: Density,
    var onCopyCode: ((String) -> Unit)?,
) {
    val fontSize: TextUnit = if (base.fontSize.isSpecified) base.fontSize else 16.sp
    val lineHeightSp: TextUnit = if (base.lineHeight.isSpecified) base.lineHeight else (fontSize.value * 1.55f).sp
    val lineHeight: Dp = with(density) { lineHeightSp.toDp() }

    private val headings = Array(6) { level -> headingStyle(level + 1) }
    fun heading(level: Int): TextStyle = headings[(level - 1).coerceIn(0, 5)]

    val tableText: TextStyle = base.copy(fontSize = fontSize * 0.94f, lineHeight = lineHeightSp * 0.9f)

    private fun headingStyle(level: Int): TextStyle {
        val scale = when (level) {
            1 -> 1.42f; 2 -> 1.24f; 3 -> 1.1f; 4 -> 1.0f; else -> 0.94f
        }
        val size = fontSize * scale
        return base.copy(
            fontSize = size,
            lineHeight = size * if (level <= 2) 1.3f else 1.42f,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = if (level <= 2) (-0.01).em else 0.em,
            color = if (level >= 5) colors.textSecondary else base.color,
        )
    }
}

internal fun spacingBefore(prev: MdBlock, current: MdBlock, nested: Boolean): Dp {
    if (nested) {
        return when {
            current is MdBlock.Heading -> 12.dp
            prev is MdBlock.Heading -> 4.dp
            current is MdBlock.ListBlock || prev is MdBlock.ListBlock -> 6.dp
            else -> 8.dp
        }
    }
    return when {
        current is MdBlock.Heading -> if (current.level <= 2) 26.dp else 20.dp
        prev is MdBlock.Heading -> 8.dp
        current is MdBlock.Rule || prev is MdBlock.Rule -> 14.dp
        current is MdBlock.ListBlock && prev is MdBlock.Paragraph -> 8.dp
        else -> 12.dp
    }
}

@Composable
internal fun RenderBlock(
    block: MdBlock,
    env: MdEnv,
    color: Color,
    modifier: Modifier,
    cursor: Boolean,
    depth: Int,
) {
    when (block) {
        is MdBlock.Paragraph -> MdText(block.content, env.base.copy(color = color), env, cursor, modifier)
        is MdBlock.Heading -> {
            val style = env.heading(block.level).let { if (color != env.base.color && block.level < 5) it.copy(color = color) else it }
            MdText(block.content, style, env, cursor, modifier)
        }
        is MdBlock.Code -> CodeBlockView(block, env, cursor, modifier)
        is MdBlock.Math -> Column(modifier) {
            MathBlockView(block.latex, env, color)
            if (cursor) StreamingCursor(Modifier.padding(top = 4.dp))
        }
        is MdBlock.Quote -> QuoteView(block, env, cursor, modifier, depth)
        is MdBlock.ListBlock -> ListView(block, env, color, cursor, modifier, depth)
        is MdBlock.Table -> Column(modifier) {
            TableView(block, env)
            if (cursor) StreamingCursor(Modifier.padding(top = 8.dp))
        }
        MdBlock.Rule -> Column(modifier) {
            Box(
                Modifier
                    .padding(vertical = 6.dp)
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(env.colors.outline),
            )
            if (cursor) StreamingCursor()
        }
    }
}

/** Renders a nested block list (list items, quotes) with tight spacing. */
@Composable
internal fun NestedBlocks(blocks: List<MdBlock>, env: MdEnv, color: Color, cursor: Boolean, depth: Int, loose: Boolean = false) {
    blocks.forEachIndexed { i, b ->
        val top = if (i == 0) 0.dp else spacingBefore(blocks[i - 1], b, nested = true) + if (loose) 4.dp else 0.dp
        RenderBlock(
            block = b,
            env = env,
            color = color,
            modifier = if (top > 0.dp) Modifier.padding(top = top) else Modifier,
            cursor = cursor && i == blocks.lastIndex,
            depth = depth,
        )
    }
    if (cursor && blocks.isEmpty()) StreamingCursor()
}

private const val CURSOR_ID = "facet.cursor"
internal const val NO_LIGATURES = "liga 0, calt 0"

@Composable
internal fun MdText(content: RichText, style: TextStyle, env: MdEnv, cursor: Boolean, modifier: Modifier = Modifier) {
    val text = if (cursor) {
        remember(content.text) {
            buildAnnotatedString {
                append(content.text)
                appendInlineContent(CURSOR_ID, "█")
            }
        }
    } else content.text
    val inline = inlineContentFor(content.math, style, env, cursor)
    Text(text = text, modifier = modifier, style = style, inlineContent = inline)
}

@Composable
private fun inlineContentFor(
    math: List<InlineMath>,
    style: TextStyle,
    env: MdEnv,
    cursor: Boolean,
): Map<String, InlineTextContent> {
    if (math.isEmpty() && !cursor) return emptyMap()
    val density = LocalDensity.current
    val map = HashMap<String, InlineTextContent>(math.size + 1)
    val fontSize = if (style.fontSize.isSpecified) style.fontSize else env.fontSize
    val colorArgb = style.color.toArgb()
    val measurer = rememberTextMeasurer(cacheSize = 8)
    for (m in math) {
        key(m.id, m.latex) {
            val sizePx = with(density) { (fontSize * if (m.display) 1.12f else 1.0f).toPx() }.roundToInt().coerceAtLeast(8)
            val rendered = rememberMath(MathRenderer.Key(m.latex, sizePx, colorArgb, m.display))
            map[m.id] = when {
                rendered == null -> {
                    // Still rendering: reserve a modest space.
                    val w = with(density) { (sizePx * (0.55f * m.latex.length.coerceAtMost(24))).toSp() }
                    InlineTextContent(Placeholder(w, fontSize, PlaceholderVerticalAlign.TextCenter)) {}
                }
                rendered.failed -> {
                    val codeStyle = env.code.copy(fontSize = fontSize * 0.88f, color = env.colors.text)
                    val measured = measurer.measure(AnnotatedString(m.latex), codeStyle, softWrap = false)
                    val w = with(density) { (measured.size.width + 8.dp.toPx()).toSp() }
                    val h = with(density) { (measured.size.height + 2.dp.toPx()).toSp() }
                    InlineTextContent(Placeholder(w, h, PlaceholderVerticalAlign.TextCenter)) {
                        Box(
                            Modifier
                                .fillMaxSize()
                                .clip(RoundedCornerShape(4.dp))
                                .background(env.colors.inlineCodeBackground),
                            contentAlignment = Alignment.Center,
                        ) { Text(m.latex, style = codeStyle, softWrap = false, maxLines = 1) }
                    }
                }
                else -> {
                    val w = with(density) { rendered.width.toSp() }
                    val h = with(density) { rendered.height.toSp() }
                    InlineTextContent(Placeholder(w, h, PlaceholderVerticalAlign.TextCenter)) {
                        MathImage(rendered)
                    }
                }
            }
        }
    }
    if (cursor) {
        val w = with(density) { 15.dp.toSp() }
        val h = with(density) { 10.dp.toSp() }
        map[CURSOR_ID] = InlineTextContent(Placeholder(w, h, PlaceholderVerticalAlign.TextCenter)) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.CenterEnd) { StreamingCursor() }
        }
    }
    return map
}

@Composable
internal fun MathBlockView(latex: String, env: MdEnv, color: Color) {
    val density = LocalDensity.current
    val sizePx = with(density) { (env.fontSize * 1.14f).toPx() }.roundToInt()
    val rendered = rememberMath(MathRenderer.Key(latex, sizePx, color.toArgb(), display = true))
    Box(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        when {
            rendered == null -> Spacer(Modifier.height(with(density) { (sizePx * 1.8f).toDp() }))
            rendered.failed -> Text(
                text = latex,
                style = env.code.copy(color = env.colors.textSecondary),
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(env.colors.inlineCodeBackground)
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            )
            else -> MathImage(rendered)
        }
    }
}

@Composable
private fun QuoteView(block: MdBlock.Quote, env: MdEnv, cursor: Boolean, modifier: Modifier, depth: Int) {
    val bar = env.colors.primary.copy(alpha = 0.4f)
    Column(
        modifier
            .fillMaxWidth()
            .drawBehind {
                val w = 3.dp.toPx()
                drawRoundRect(bar, Offset.Zero, Size(w, size.height), CornerRadius(w / 2, w / 2))
            }
            .padding(start = 15.dp, top = 2.dp, bottom = 2.dp),
    ) {
        // Quotes don't count toward list depth (which only picks the bullet style).
        NestedBlocks(block.children, env, env.colors.textSecondary, cursor, depth)
    }
}

@Composable
private fun ListView(block: MdBlock.ListBlock, env: MdEnv, color: Color, cursor: Boolean, modifier: Modifier, depth: Int) {
    val measurer = rememberTextMeasurer(cacheSize = 4)
    val markerStyle = env.base.copy(color = env.colors.textSecondary, fontFeatureSettings = "tnum")
    val density = LocalDensity.current
    val hasTasks = block.items.any { it.task != null }
    val markerWidth: Dp = when {
        block.ordered -> {
            val widest = "${block.start + block.items.size - 1}."
            val w = remember(widest, markerStyle) { measurer.measure(widest, markerStyle).size.width }
            with(density) { w.toDp() } + 10.dp
        }
        hasTasks -> 28.dp
        else -> 22.dp
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(if (block.loose) 10.dp else 5.dp)) {
        block.items.forEachIndexed { idx, item ->
            Row(Modifier.fillMaxWidth()) {
                Box(
                    Modifier
                        .width(markerWidth)
                        .height(env.lineHeight),
                    contentAlignment = if (block.ordered) Alignment.TopEnd else Alignment.CenterStart,
                ) {
                    when {
                        item.task != null -> TaskBox(item.task, env)
                        block.ordered -> Text(
                            "${block.start + idx}.",
                            style = markerStyle,
                            modifier = Modifier.padding(end = 9.dp),
                            maxLines = 1,
                        )
                        else -> Bullet(depth, env)
                    }
                }
                Column(Modifier.weight(1f)) {
                    val itemColor = if (item.task == true) env.colors.textSecondary else color
                    NestedBlocks(item.children, env, itemColor, cursor && idx == block.items.lastIndex, depth + 1, block.loose)
                }
            }
        }
    }
}

@Composable
private fun Bullet(depth: Int, env: MdEnv) {
    val c = env.colors.textSecondary
    val shape = CircleShape
    val m = Modifier.padding(start = 6.dp).size(if (depth % 2 == 0) 5.5.dp else 6.dp)
    if (depth % 2 == 0) {
        Box(m.clip(shape).background(c))
    } else {
        Box(m.border(1.3.dp, c, shape))
    }
}

@Composable
private fun TaskBox(checked: Boolean, env: MdEnv) {
    val shape = RoundedCornerShape(5.dp)
    if (checked) {
        Box(
            Modifier
                .padding(start = 2.dp)
                .size(17.dp)
                .clip(shape)
                .background(env.colors.primary),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                painter = painterResource(R.drawable.ic_check),
                contentDescription = "Done",
                tint = env.colors.onPrimary,
                modifier = Modifier.size(13.dp),
            )
        }
    } else {
        Box(
            Modifier
                .padding(start = 2.dp)
                .size(17.dp)
                .border(1.5.dp, env.colors.textTertiary, shape),
        )
    }
}

internal fun CellAlign.toTextAlign() = when (this) {
    CellAlign.START -> TextAlign.Start
    CellAlign.CENTER -> TextAlign.Center
    CellAlign.END -> TextAlign.End
}

