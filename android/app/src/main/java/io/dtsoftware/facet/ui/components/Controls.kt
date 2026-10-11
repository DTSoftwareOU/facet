package io.dtsoftware.facet.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.R
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.ui.theme.GemPalette

@Composable
fun FacetIcon(
    @DrawableRes res: Int,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    tint: Color = FacetTheme.colors.text,
    size: Dp = 22.dp,
) {
    Icon(painterResource(res), contentDescription, modifier.size(size), tint = tint)
}

/** A 48dp touch target with a circular pressed state. */
@Composable
fun FacetIconButton(
    @DrawableRes icon: Int,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = FacetTheme.colors.text,
    enabled: Boolean = true,
    size: Dp = 22.dp,
    background: Color = Color.Transparent,
) {
    Box(
        modifier
            .size(44.dp)
            .clip(CircleShape)
            .background(background)
            .clickable(
                enabled = enabled,
                role = Role.Button,
                onClickLabel = contentDescription,
                interactionSource = remember { MutableInteractionSource() },
                indication = ripple(bounded = true),
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        FacetIcon(icon, contentDescription, tint = if (enabled) tint else tint.copy(alpha = 0.38f), size = size)
    }
}

enum class ButtonStyle { Primary, Tonal, Outline, Text, Danger }

@Composable
fun FacetButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    style: ButtonStyle = ButtonStyle.Primary,
    @DrawableRes icon: Int? = null,
    enabled: Boolean = true,
    loading: Boolean = false,
    contentPadding: PaddingValues = PaddingValues(horizontal = 22.dp, vertical = 13.dp),
) {
    val c = FacetTheme.colors
    val haptics = LocalHapticFeedback.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.97f else 1f, label = "btnScale")
    val (bg, fg, border) = when (style) {
        ButtonStyle.Primary -> Triple(c.primary, c.onPrimary, null)
        ButtonStyle.Tonal -> Triple(c.surfaceHigh, c.text, null)
        ButtonStyle.Outline -> Triple(Color.Transparent, c.text, c.outline)
        ButtonStyle.Text -> Triple(Color.Transparent, c.primary, null)
        ButtonStyle.Danger -> Triple(c.errorContainer, c.error, null)
    }
    val alpha = if (enabled) 1f else 0.45f
    Row(
        modifier
            .scale(scale)
            .defaultMinSize(minHeight = 48.dp)
            .clip(FacetShapes.pill)
            .background(bg.copy(alpha = bg.alpha * alpha))
            .then(if (border != null) Modifier.border(1.dp, border, FacetShapes.pill) else Modifier)
            .clickable(
                enabled = enabled && !loading,
                role = Role.Button,
                interactionSource = interaction,
                indication = ripple(),
            ) {
                haptics.performHapticFeedback(HapticFeedbackType.ContextClick)
                onClick()
            }
            .padding(contentPadding),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(18.dp), color = fg, strokeWidth = 2.dp)
            Spacer(Modifier.width(10.dp))
        } else if (icon != null) {
            FacetIcon(icon, null, tint = fg.copy(alpha = alpha), size = 18.dp)
            Spacer(Modifier.width(8.dp))
        }
        Text(text, style = FacetTheme.type.labelL, color = fg.copy(alpha = alpha), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Small selectable pill used in the composer and filters. */
@Composable
fun FacetChip(
    text: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    @DrawableRes icon: Int? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    val c = FacetTheme.colors
    val bg by animateColorAsState(if (selected) c.primaryContainer else Color.Transparent, label = "chipBg")
    val fg by animateColorAsState(if (selected) c.onPrimaryContainer else c.textSecondary, label = "chipFg")
    val border by animateColorAsState(if (selected) c.primaryContainer else c.outline, label = "chipBorder")
    Row(
        modifier
            .height(34.dp)
            .clip(FacetShapes.chip)
            .background(bg)
            .border(1.dp, border, FacetShapes.chip)
            .clickable(role = Role.Checkbox, onClick = onClick)
            .padding(horizontal = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            FacetIcon(icon, null, tint = fg, size = 16.dp)
            Spacer(Modifier.width(6.dp))
        }
        Text(text, style = FacetTheme.type.labelM, color = fg, maxLines = 1)
        trailing?.invoke(this)
    }
}

/** The send button: the gem gradient, or a stop square while generating. */
@Composable
fun SendButton(
    enabled: Boolean,
    generating: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = FacetTheme.colors
    val haptics = LocalHapticFeedback.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.9f else 1f, label = "sendScale")
    val active = enabled || generating
    val stopLabel = stringResource(R.string.action_stop)
    val sendLabel = stringResource(R.string.action_send)
    val brush = when {
        generating -> Brush.linearGradient(listOf(c.text, c.text))
        enabled -> Brush.linearGradient(listOf(GemPalette.Flash, GemPalette.Glint))
        else -> Brush.linearGradient(listOf(c.surfaceHighest, c.surfaceHighest))
    }
    Box(
        modifier
            .scale(scale)
            .size(40.dp)
            .clip(CircleShape)
            .background(brush)
            .clickable(
                enabled = active,
                role = Role.Button,
                onClickLabel = if (generating) stopLabel else sendLabel,
                interactionSource = interaction,
                indication = ripple(color = Color.White),
            ) {
                haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                if (generating) onStop() else onSend()
            },
        contentAlignment = Alignment.Center,
    ) {
        if (generating) {
            Box(Modifier.size(13.dp).clip(androidx.compose.foundation.shape.RoundedCornerShape(3.dp)).background(c.background))
        } else {
            FacetIcon(
                R.drawable.ic_arrow_up, sendLabel,
                tint = if (enabled) Color(0xFF071318) else c.textTertiary, size = 20.dp,
            )
        }
    }
}

@Composable
fun Hairline(modifier: Modifier = Modifier, color: Color = FacetTheme.colors.outlineVariant) {
    Box(modifier.height(1.dp).background(color))
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = FacetTheme.type.labelM,
        color = FacetTheme.colors.textTertiary,
        modifier = modifier.padding(start = 4.dp, bottom = 8.dp, top = 4.dp),
    )
}
