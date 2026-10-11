package io.dtsoftware.facet.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.dtsoftware.facet.R

private fun sansFont(weight: Int, italic: Boolean = false) = Font(
    resId = if (italic) R.font.instrument_sans_italic else R.font.instrument_sans,
    weight = FontWeight(weight),
    style = if (italic) FontStyle.Italic else FontStyle.Normal,
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
)

private fun monoFont(weight: Int) = Font(
    resId = R.font.jetbrains_mono,
    weight = FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
)

val InstrumentSans = FontFamily(
    sansFont(400), sansFont(500), sansFont(600), sansFont(700),
    sansFont(400, italic = true), sansFont(500, italic = true), sansFont(600, italic = true), sansFont(700, italic = true),
)

val InstrumentSerif = FontFamily(
    Font(R.font.instrument_serif, FontWeight.Normal, FontStyle.Normal),
    Font(R.font.instrument_serif_italic, FontWeight.Normal, FontStyle.Italic),
)

val JetBrainsMono = FontFamily(monoFont(400), monoFont(500), monoFont(700))

private val Trim = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.None,
)

/** Type scale. See docs/DESIGN.md. */
@Immutable
data class FacetTypography(
    val display: TextStyle,
    val headline: TextStyle,
    val titleL: TextStyle,
    val titleM: TextStyle,
    val chat: TextStyle,
    val body: TextStyle,
    val labelL: TextStyle,
    val labelM: TextStyle,
    val labelS: TextStyle,
    val code: TextStyle,
)

fun facetTypography(chatScale: Float = 1f): FacetTypography {
    val base = TextStyle(fontFamily = InstrumentSans, lineHeightStyle = Trim)
    return FacetTypography(
        display = TextStyle(
            fontFamily = InstrumentSerif, fontSize = 40.sp, lineHeight = 44.sp,
            letterSpacing = (-0.01).em, lineHeightStyle = Trim,
        ),
        headline = TextStyle(
            fontFamily = InstrumentSerif, fontSize = 30.sp, lineHeight = 36.sp,
            letterSpacing = (-0.005).em, lineHeightStyle = Trim,
        ),
        titleL = base.copy(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.01).em),
        titleM = base.copy(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
        // Messages and the message box follow each text's own direction (Arabic in an English UI and
        // vice versa); interface text follows the layout.
        chat = base.copy(fontSize = (16.5f * chatScale).sp, lineHeight = (26f * chatScale).sp, textDirection = TextDirection.Content),
        body = base.copy(fontSize = 15.sp, lineHeight = 22.sp),
        labelL = base.copy(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
        labelM = base.copy(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.005.em),
        labelS = base.copy(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.01.em),
        code = TextStyle(
            fontFamily = JetBrainsMono, fontSize = (13.5f * chatScale).sp, lineHeight = (21f * chatScale).sp,
            lineHeightStyle = Trim,
        ),
    )
}
