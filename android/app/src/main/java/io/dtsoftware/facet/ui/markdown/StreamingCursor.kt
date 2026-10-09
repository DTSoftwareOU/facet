package io.dtsoftware.facet.ui.markdown

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.ui.theme.GemPalette

private val CursorBrush = Brush.linearGradient(listOf(GemPalette.Flash, GemPalette.Glint))
private val CursorShape = RoundedCornerShape(2.5.dp)

/** The breathing gem-colored cursor shown at the end of a streaming reply. */
@Composable
fun StreamingCursor(modifier: Modifier = Modifier) {
    if (FacetTheme.reducedMotion) {
        Box(modifier.size(9.dp).clip(CursorShape).background(CursorBrush))
        return
    }
    val transition = rememberInfiniteTransition(label = "cursor")
    val alpha by transition.animateFloat(
        initialValue = 0.35f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "cursorAlpha",
    )
    Box(
        modifier
            .size(9.dp)
            .graphicsLayer { this.alpha = alpha }
            .clip(CursorShape)
            .background(CursorBrush),
    )
}
