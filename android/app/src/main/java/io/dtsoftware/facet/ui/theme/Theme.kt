package io.dtsoftware.facet.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext

enum class ThemeMode { SYSTEM, LIGHT, DARK, BLACK }

val LocalFacetColors = staticCompositionLocalOf { BasaltColors }
val LocalFacetType = staticCompositionLocalOf { facetTypography() }
val LocalReducedMotion = staticCompositionLocalOf { false }

/** Accessors for the Facet design tokens. */
object FacetTheme {
    val colors: FacetColors
        @Composable @ReadOnlyComposable get() = LocalFacetColors.current
    val type: FacetTypography
        @Composable @ReadOnlyComposable get() = LocalFacetType.current
    val reducedMotion: Boolean
        @Composable @ReadOnlyComposable get() = LocalReducedMotion.current
}

@Composable
fun resolveDark(mode: ThemeMode): Boolean = when (mode) {
    ThemeMode.SYSTEM -> isSystemInDarkTheme()
    ThemeMode.LIGHT -> false
    ThemeMode.DARK, ThemeMode.BLACK -> true
}

@Composable
fun FacetTheme(
    mode: ThemeMode = ThemeMode.SYSTEM,
    dynamicColor: Boolean = false,
    chatScale: Float = 1f,
    reducedMotion: Boolean = false,
    content: @Composable () -> Unit,
) {
    val dark = resolveDark(mode)
    val context = LocalContext.current
    val base = when {
        !dark -> QuartzColors
        mode == ThemeMode.BLACK -> ObsidianColors
        else -> BasaltColors
    }
    val colors = if (dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val dyn = if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        base.copy(
            primary = dyn.primary,
            onPrimary = dyn.onPrimary,
            primaryContainer = dyn.primaryContainer,
            onPrimaryContainer = dyn.onPrimaryContainer,
        )
    } else {
        base
    }
    val type = remember(chatScale) { facetTypography(chatScale) }
    val scheme = remember(colors) { colors.toMaterialScheme() }
    val materialType = remember(type) {
        Typography(
            displayLarge = type.display, displayMedium = type.display, displaySmall = type.headline,
            headlineLarge = type.headline, headlineMedium = type.titleL, headlineSmall = type.titleL,
            titleLarge = type.titleL, titleMedium = type.titleM, titleSmall = type.labelL,
            bodyLarge = type.body.copy(fontSize = type.chat.fontSize), bodyMedium = type.body, bodySmall = type.labelM,
            labelLarge = type.labelL, labelMedium = type.labelM, labelSmall = type.labelS,
        )
    }
    val selection = remember(colors) {
        TextSelectionColors(handleColor = colors.primary, backgroundColor = colors.primary.copy(alpha = 0.32f))
    }
    CompositionLocalProvider(
        LocalFacetColors provides colors,
        LocalFacetType provides type,
        LocalReducedMotion provides reducedMotion,
    ) {
        MaterialTheme(colorScheme = scheme, typography = materialType) {
            CompositionLocalProvider(LocalTextSelectionColors provides selection, content = content)
        }
    }
}

private fun FacetColors.toMaterialScheme(): ColorScheme {
    val scheme = if (isDark) darkColorScheme() else lightColorScheme()
    return scheme.copy(
        primary = primary, onPrimary = onPrimary,
        primaryContainer = primaryContainer, onPrimaryContainer = onPrimaryContainer,
        inversePrimary = primary,
        secondary = primary, onSecondary = onPrimary,
        secondaryContainer = primaryContainer, onSecondaryContainer = onPrimaryContainer,
        tertiary = primary, onTertiary = onPrimary,
        tertiaryContainer = primaryContainer, onTertiaryContainer = onPrimaryContainer,
        background = background, onBackground = text,
        surface = surface, onSurface = text,
        surfaceVariant = surfaceHigh, onSurfaceVariant = textSecondary,
        surfaceTint = primary,
        inverseSurface = text, inverseOnSurface = background,
        error = error, onError = onPrimary, errorContainer = errorContainer, onErrorContainer = text,
        outline = outline, outlineVariant = outlineVariant, scrim = scrim,
        surfaceBright = surfaceHighest, surfaceDim = background,
        surfaceContainer = surface, surfaceContainerHigh = surfaceHigh, surfaceContainerHighest = surfaceHighest,
        surfaceContainerLow = background, surfaceContainerLowest = background,
    )
}
