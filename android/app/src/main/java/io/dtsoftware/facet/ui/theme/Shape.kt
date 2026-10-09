package io.dtsoftware.facet.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp

/** Radii by hierarchy. See docs/DESIGN.md. */
object FacetShapes {
    val composer = RoundedCornerShape(26.dp)
    val sheet = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)
    val userBubble = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp, bottomStart = 22.dp, bottomEnd = 8.dp)
    val group = RoundedCornerShape(18.dp)
    val code = RoundedCornerShape(14.dp)
    val chip = RoundedCornerShape(12.dp)
    val small = RoundedCornerShape(8.dp)
    val pill = RoundedCornerShape(percent = 50)
}

object FacetMotion {
    val Emphasized = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    val EmphasizedDecelerate = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
    val EmphasizedAccelerate = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)
    const val MessageEnterMs = 260
    const val FastMs = 150

    fun <T> spring() = spring<T>(dampingRatio = 0.85f, stiffness = 380f)
    val offsetSpring = spring<IntOffset>(dampingRatio = 0.85f, stiffness = 380f)
    fun <T> gentleSpring() = spring<T>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMediumLow)
}
