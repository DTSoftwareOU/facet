package io.dtsoftware.facet.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.ui.theme.GemPalette
import kotlin.math.floor

/*
 * The Facet gem (docs/DESIGN.md): a princess cut seen from above. Four trapezoid facets around a
 * table. "Thinking" rotates the facet colors clockwise (one step per 400 ms, cross-faded) while
 * the table breathes. Geometry is in a 100×100 box.
 */

private val NW = floatArrayOf(4f, 50f, 50f, 4f, 50f, 32f, 32f, 50f)
private val NE = floatArrayOf(50f, 4f, 96f, 50f, 68f, 50f, 50f, 32f)
private val SE = floatArrayOf(96f, 50f, 50f, 96f, 50f, 68f, 68f, 50f)
private val SW = floatArrayOf(50f, 96f, 4f, 50f, 32f, 50f, 50f, 68f)
private val TABLE = floatArrayOf(50f, 32f, 68f, 50f, 50f, 68f, 32f, 50f)
private val FACETS = listOf(NW, NE, SE, SW)

private fun DrawScope.poly(points: FloatArray, scale: Float): Path = Path().apply {
    moveTo(points[0] * scale, points[1] * scale)
    var i = 2
    while (i < points.size) {
        lineTo(points[i] * scale, points[i + 1] * scale)
        i += 2
    }
    close()
}

/**
 * @param phase facet rotation progress in "steps" (0..4 is a full turn); fractional values cross-fade.
 * @param tableAlpha opacity of the center table.
 * @param assemble 0..1 entrance progress (facets fly in from the outside); 1 = at rest.
 */
private fun DrawScope.drawGem(phase: Float, tableAlpha: Float, assemble: Float, tableColor: Color, outline: Color?) {
    val scale = size.minDimension / 100f
    val step = floor(phase).toInt()
    val frac = phase - step
    FACETS.forEachIndexed { i, pts ->
        val from = GemPalette.facets[(i - step).mod(4)]
        val to = GemPalette.facets[(i - step - 1).mod(4)]
        val color = lerp(from, to, frac)
        val path = poly(pts, scale)
        if (assemble < 1f) {
            // Offset each facet outward along its diagonal during the entrance.
            val dx = (if (i == 0 || i == 3) -1f else 1f) * (1f - assemble) * 14f * scale
            val dy = (if (i <= 1) -1f else 1f) * (1f - assemble) * 14f * scale
            path.translate(Offset(dx, dy))
            drawPath(path, color.copy(alpha = assemble.coerceIn(0f, 1f)))
        } else {
            drawPath(path, color)
        }
    }
    val table = poly(TABLE, scale)
    drawPath(table, tableColor.copy(alpha = tableAlpha * assemble.coerceIn(0f, 1f)))
    if (outline != null) drawPath(table, outline.copy(alpha = 0.35f * assemble), style = Stroke(width = 1.2f * scale))
}

/** Static or animated gem. [thinking] runs the facet rotation. */
@Composable
fun Gem(
    modifier: Modifier = Modifier,
    size: Dp = 24.dp,
    thinking: Boolean = false,
) {
    val reduced = FacetTheme.reducedMotion
    val light = !FacetTheme.colors.isDark
    val tableColor = if (light) Color(0xFFFFFFFF) else GemPalette.Table
    val outline = if (light) Color(0xFF8590A0) else null
    if (thinking && !reduced) {
        val t = rememberInfiniteTransition(label = "gem")
        val phase = t.animateFloat(
            initialValue = 0f, targetValue = 4f,
            animationSpec = infiniteRepeatable(tween(1600, easing = LinearEasing)), label = "phase",
        )
        val table = t.animateFloat(
            initialValue = 0.7f, targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(800, easing = LinearEasing), RepeatMode.Reverse), label = "table",
        )
        Canvas(modifier.size(size)) {
            // Snap most of each step, cross-fade near the end, so each facet "catches the light".
            val p = phase.value
            val base = floor(p)
            val f = ((p - base - 0.55f) / 0.45f).coerceIn(0f, 1f)
            drawGem(base + f, table.value, 1f, tableColor, outline)
        }
    } else {
        Canvas(modifier.size(size)) { drawGem(0f, 1f, 1f, tableColor, outline) }
    }
}

/** The gem assembling once (onboarding, splash hand-off), then optionally turning once. */
@Composable
fun AssemblingGem(modifier: Modifier = Modifier, size: Dp = 96.dp, onDone: () -> Unit = {}) {
    val reduced = FacetTheme.reducedMotion
    val light = !FacetTheme.colors.isDark
    val tableColor = if (light) Color(0xFFFFFFFF) else GemPalette.Table
    val outline = if (light) Color(0xFF8590A0) else null
    val assemble = remember { Animatable(if (reduced) 1f else 0f) }
    val turn = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        if (!reduced) {
            assemble.animateTo(1f, tween(700, easing = io.dtsoftware.facet.ui.theme.FacetMotion.EmphasizedDecelerate))
            turn.animateTo(4f, tween(1400, easing = io.dtsoftware.facet.ui.theme.FacetMotion.Emphasized))
        }
        onDone()
    }
    Canvas(modifier.size(size)) { drawGem(turn.value, 1f, assemble.value, tableColor, outline) }
}
