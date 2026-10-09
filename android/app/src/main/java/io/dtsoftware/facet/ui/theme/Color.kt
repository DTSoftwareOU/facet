package io.dtsoftware.facet.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/** Semantic color tokens. See docs/DESIGN.md. */
@Immutable
data class FacetColors(
    val background: Color,
    val surface: Color,
    val surfaceHigh: Color,
    val surfaceHighest: Color,
    val outline: Color,
    val outlineVariant: Color,
    val text: Color,
    val textSecondary: Color,
    val textTertiary: Color,
    val primary: Color,
    val onPrimary: Color,
    val primaryContainer: Color,
    val onPrimaryContainer: Color,
    val error: Color,
    val errorContainer: Color,
    val success: Color,
    val warning: Color,
    val userBubble: Color,
    val codeBackground: Color,
    val codeHeader: Color,
    val inlineCodeBackground: Color,
    val scrim: Color,
    val syntax: SyntaxColors,
    val isDark: Boolean,
)

/** Code highlighting colors, tuned per theme. */
@Immutable
data class SyntaxColors(
    val plain: Color,
    val keyword: Color,
    val string: Color,
    val number: Color,
    val comment: Color,
    val function: Color,
    val type: Color,
    val annotation: Color,
    val punctuation: Color,
    val tag: Color,
    val attribute: Color,
)

/** The labradorite palette. Reserved for the gem and brand moments only. */
object GemPalette {
    val Gold = Color(0xFFF2C66D)
    val Flash = Color(0xFF6E9BFF)
    val Deep = Color(0xFF3A5BD9)
    val Glint = Color(0xFF49D3C1)
    val Table = Color(0xFFF4F7FB)
    val facets = listOf(Gold, Flash, Deep, Glint)
}

private val DarkSyntax = SyntaxColors(
    plain = Color(0xFFDDE3EC),
    keyword = Color(0xFFC79BFF),
    string = Color(0xFF8FD9A8),
    number = Color(0xFFF2C66D),
    comment = Color(0xFF6F7A8A),
    function = Color(0xFF7FB2FF),
    type = Color(0xFF5FD7C7),
    annotation = Color(0xFFF0A27A),
    punctuation = Color(0xFF9AA4B3),
    tag = Color(0xFFFF8F8F),
    attribute = Color(0xFFF2C66D),
)

private val LightSyntax = SyntaxColors(
    plain = Color(0xFF1D232B),
    keyword = Color(0xFF7A3FC7),
    string = Color(0xFF1E7A43),
    number = Color(0xFF9A6200),
    comment = Color(0xFF7D8796),
    function = Color(0xFF2257C9),
    type = Color(0xFF0B7C6E),
    annotation = Color(0xFFB4531F),
    punctuation = Color(0xFF55606F),
    tag = Color(0xFFC0392B),
    attribute = Color(0xFF9A6200),
)

val BasaltColors = FacetColors(
    background = Color(0xFF11151B),
    surface = Color(0xFF171C24),
    surfaceHigh = Color(0xFF1E242E),
    surfaceHighest = Color(0xFF262D39),
    outline = Color(0xFF2C3441),
    outlineVariant = Color(0xFF222833),
    text = Color(0xFFE8ECF2),
    textSecondary = Color(0xFFA3ACBA),
    textTertiary = Color(0xFF6F7A8A),
    primary = Color(0xFF49D3C1),
    onPrimary = Color(0xFF04201C),
    primaryContainer = Color(0xFF12352F),
    onPrimaryContainer = Color(0xFFA6F0E5),
    error = Color(0xFFFF7A7A),
    errorContainer = Color(0xFF3A1D22),
    success = Color(0xFF5BD69B),
    warning = Color(0xFFF2C66D),
    userBubble = Color(0xFF1E242E),
    codeBackground = Color(0xFF0D1117),
    codeHeader = Color(0xFF161B23),
    inlineCodeBackground = Color(0xFF232A35),
    scrim = Color(0x99050709),
    syntax = DarkSyntax,
    isDark = true,
)

val ObsidianColors = BasaltColors.copy(
    background = Color(0xFF000000),
    surface = Color(0xFF0A0C10),
    surfaceHigh = Color(0xFF13171D),
    surfaceHighest = Color(0xFF1B2028),
    outline = Color(0xFF232A34),
    outlineVariant = Color(0xFF171B22),
    userBubble = Color(0xFF14181F),
    codeBackground = Color(0xFF07090C),
    codeHeader = Color(0xFF0F1318),
    inlineCodeBackground = Color(0xFF1A1F27),
)

val QuartzColors = FacetColors(
    background = Color(0xFFF5F6F8),
    surface = Color(0xFFFFFFFF),
    surfaceHigh = Color(0xFFECEFF3),
    surfaceHighest = Color(0xFFE2E6EC),
    outline = Color(0xFFD3D8DF),
    outlineVariant = Color(0xFFE3E6EB),
    text = Color(0xFF12161C),
    textSecondary = Color(0xFF4F5968),
    textTertiary = Color(0xFF8590A0),
    primary = Color(0xFF087A6C),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFD5F2EC),
    onPrimaryContainer = Color(0xFF043B34),
    error = Color(0xFFC93636),
    errorContainer = Color(0xFFFBE4E4),
    success = Color(0xFF1F8A55),
    warning = Color(0xFFA87412),
    userBubble = Color(0xFFE7EBF0),
    codeBackground = Color(0xFFF0F2F5),
    codeHeader = Color(0xFFE6E9EE),
    inlineCodeBackground = Color(0xFFE6E9EE),
    scrim = Color(0x66101418),
    syntax = LightSyntax,
    isDark = false,
)
