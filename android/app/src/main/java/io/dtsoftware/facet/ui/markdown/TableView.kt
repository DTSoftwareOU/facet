package io.dtsoftware.facet.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.ui.theme.FacetShapes

/** Row boundaries captured during layout so dividers can be drawn behind the grid. */
private class RowLines {
    var bottoms: IntArray = IntArray(0)
}

@Composable
internal fun TableView(block: MdBlock.Table, env: MdEnv) {
    val colors = env.colors
    val cols = block.header.size.coerceAtLeast(1)
    val headerStyle = env.tableText.copy(fontWeight = FontWeight.SemiBold)
    val bodyStyle = env.tableText
    val lines = remember { RowLines() }
    val divider = colors.outlineVariant
    val minCol = with(env.density) { 64.dp.roundToPx() }
    val maxCol = with(env.density) { 300.dp.roundToPx() }

    Box(
        Modifier
            .fillMaxWidth()
            .clip(FacetShapes.code)
            .border(1.dp, colors.outline, FacetShapes.code),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
        ) {
            Layout(
                modifier = Modifier.drawBehind {
                    val stroke = 1.dp.toPx()
                    val b = lines.bottoms
                    for (r in 0 until b.size - 1) {
                        val y = b[r].toFloat() - stroke / 2
                        drawLine(divider, Offset(0f, y), Offset(size.width, y), stroke)
                    }
                },
                content = {
                    val allRows = listOf(block.header) + block.rows
                    allRows.forEachIndexed { r, row ->
                        for (c in 0 until cols) {
                            val cell = row.getOrNull(c) ?: RichText(androidx.compose.ui.text.AnnotatedString(""))
                            val align = block.aligns.getOrElse(c) { CellAlign.START }
                            Box(
                                Modifier
                                    .then(if (r == 0) Modifier.background(colors.surfaceHigh) else Modifier)
                                    .padding(horizontal = 12.dp, vertical = 9.dp),
                                contentAlignment = when (align) {
                                    CellAlign.START -> Alignment.TopStart
                                    CellAlign.CENTER -> Alignment.TopCenter
                                    CellAlign.END -> Alignment.TopEnd
                                },
                            ) {
                                MdText(
                                    content = cell,
                                    style = (if (r == 0) headerStyle else bodyStyle).copy(textAlign = align.toTextAlign()),
                                    env = env,
                                    cursor = false,
                                )
                            }
                        }
                    }
                },
            ) { measurables, constraints ->
                val rowCount = measurables.size / cols
                val widths = IntArray(cols)
                for (c in 0 until cols) {
                    var w = minCol
                    for (r in 0 until rowCount) {
                        w = maxOf(w, measurables[r * cols + c].maxIntrinsicWidth(Constraints.Infinity))
                    }
                    widths[c] = w.coerceAtMost(maxCol)
                }
                var total = widths.sum()
                if (total < constraints.minWidth && total > 0) {
                    val extra = constraints.minWidth - total
                    var given = 0
                    for (c in 0 until cols) {
                        val add = if (c == cols - 1) extra - given else extra * widths[c] / total
                        widths[c] += add
                        given += add
                    }
                    total = widths.sum()
                }
                val heights = IntArray(rowCount)
                for (r in 0 until rowCount) {
                    var h = 0
                    for (c in 0 until cols) h = maxOf(h, measurables[r * cols + c].maxIntrinsicHeight(widths[c]))
                    heights[r] = h
                }
                val placeables = measurables.mapIndexed { i, m ->
                    val r = i / cols
                    val c = i % cols
                    m.measure(Constraints.fixed(widths[c], heights[r]))
                }
                val bottoms = IntArray(rowCount)
                var acc = 0
                for (r in 0 until rowCount) {
                    acc += heights[r]
                    bottoms[r] = acc
                }
                lines.bottoms = bottoms
                layout(total, acc) {
                    var y = 0
                    for (r in 0 until rowCount) {
                        var x = 0
                        for (c in 0 until cols) {
                            placeables[r * cols + c].place(x, y)
                            x += widths[c]
                        }
                        y += heights[r]
                    }
                }
            }
        }
    }
}
