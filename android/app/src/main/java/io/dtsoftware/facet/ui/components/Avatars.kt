package io.dtsoftware.facet.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.dtsoftware.facet.data.repo.Assistant
import io.dtsoftware.facet.data.repo.BuiltinAssistants
import io.dtsoftware.facet.ui.theme.FacetTheme

@Composable
fun AssistantAvatar(assistant: Assistant, modifier: Modifier = Modifier, size: Dp = 32.dp) {
    if (assistant.id == BuiltinAssistants.DEFAULT_ID) {
        Box(modifier.size(size), contentAlignment = Alignment.Center) { Gem(size = size * 0.78f) }
        return
    }
    val tint = accent(assistant.colorIndex)
    Box(
        modifier
            .size(size)
            .clip(RoundedCornerShape(size * 0.32f))
            .background(tint.copy(alpha = if (FacetTheme.colors.isDark) 0.2f else 0.16f)),
        contentAlignment = Alignment.Center,
    ) {
        when {
            assistant.iconRes != null -> FacetIcon(assistant.iconRes, null, tint = tint, size = size * 0.55f)
            !assistant.emoji.isNullOrBlank() -> Text(assistant.emoji, fontSize = (size.value * 0.5f).sp)
        }
    }
}

/** Circular initial avatar for the signed-in user. */
@Composable
fun UserAvatar(name: String, modifier: Modifier = Modifier, size: Dp = 36.dp) {
    val initial = name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"
    Box(
        modifier
            .size(size)
            .clip(CircleShape)
            .background(FacetTheme.colors.primaryContainer),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            initial,
            color = FacetTheme.colors.onPrimaryContainer,
            style = FacetTheme.type.labelL.copy(fontSize = (size.value * 0.42f).sp, fontWeight = FontWeight.SemiBold),
        )
    }
}
