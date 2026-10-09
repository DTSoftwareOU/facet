package io.dtsoftware.facet.ui.markdown

import android.content.ClipData
import androidx.compose.animation.Crossfade
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.R
import io.dtsoftware.facet.ui.theme.FacetShapes
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Lines per independently laid-out chunk, so a streaming code block only re-lays its tail. */
private const val CHUNK_LINES = 24

@Composable
internal fun CodeBlockView(block: MdBlock.Code, env: MdEnv, cursor: Boolean, modifier: Modifier = Modifier) {
    val colors = env.colors
    var wrap by rememberSaveable { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }

    val codeStyle = env.code.copy(color = colors.syntax.plain)
    val highlighted = remember(block.code, block.language, colors.syntax) {
        SyntaxHighlighter.highlight(block.code, block.language, colors.syntax)
    }
    val chunks = remember(highlighted) { chunkLines(highlighted) }

    Column(
        modifier
            .fillMaxWidth()
            .clip(FacetShapes.code)
            .background(colors.codeBackground)
            .border(1.dp, colors.outlineVariant, FacetShapes.code),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(38.dp)
                .background(colors.codeHeader)
                .padding(start = 14.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = SyntaxHighlighter.displayName(block.language),
                style = FacetThemeLabel(env),
                maxLines = 1,
            )
            Spacer(Modifier.weight(1f))
            HeaderButton(
                icon = R.drawable.ic_wrap,
                description = if (wrap) "Turn off line wrap" else "Wrap lines",
                tint = if (wrap) colors.primary else colors.textSecondary,
                onClick = { wrap = !wrap },
            )
            Crossfade(targetState = copied, label = "copy") { done ->
                HeaderButton(
                    icon = if (done) R.drawable.ic_check else R.drawable.ic_copy,
                    description = if (done) "Copied" else "Copy code",
                    tint = if (done) colors.success else colors.textSecondary,
                    onClick = {
                        scope.launch {
                            clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("code", block.code)))
                        }
                        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                        copied = true
                        env.onCopyCode?.invoke(block.code)
                    },
                )
            }
        }
        val contentPadding = Modifier.padding(horizontal = 14.dp, vertical = 12.dp)
        if (wrap) {
            Column(contentPadding) {
                chunks.forEachIndexed { i, chunk ->
                    Text(
                        text = if (cursor && i == chunks.lastIndex) withCursor(chunk) else chunk,
                        style = codeStyle,
                        softWrap = true,
                        inlineContent = if (cursor && i == chunks.lastIndex) cursorInline() else emptyMap(),
                    )
                }
                if (chunks.isEmpty() && cursor) StreamingCursor()
            }
        } else {
            Box(
                Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
            ) {
                Column(contentPadding) {
                    chunks.forEachIndexed { i, chunk ->
                        Text(
                            text = if (cursor && i == chunks.lastIndex) withCursor(chunk) else chunk,
                            style = codeStyle,
                            softWrap = false,
                            inlineContent = if (cursor && i == chunks.lastIndex) cursorInline() else emptyMap(),
                        )
                    }
                    if (chunks.isEmpty() && cursor) StreamingCursor()
                }
            }
        }
    }
}

@Composable
private fun FacetThemeLabel(env: MdEnv) =
    io.dtsoftware.facet.ui.theme.FacetTheme.type.labelS.copy(color = env.colors.textSecondary)

@Composable
private fun HeaderButton(icon: Int, description: String, tint: Color, onClick: () -> Unit) {
    Box(
        Modifier
            .size(34.dp)
            .clip(CircleShape)
            .clickable(
                interactionSource = null,
                indication = ripple(bounded = true),
                role = Role.Button,
                onClickLabel = description,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(painterResource(icon), contentDescription = description, tint = tint, modifier = Modifier.size(17.dp))
    }
}

private const val CODE_CURSOR_ID = "facet.code.cursor"

private fun withCursor(chunk: AnnotatedString): AnnotatedString = buildAnnotatedString {
    append(chunk)
    appendInlineContent(CODE_CURSOR_ID, "█")
}

@Composable
private fun cursorInline() = mapOf(
    CODE_CURSOR_ID to androidx.compose.foundation.text.InlineTextContent(
        androidx.compose.ui.text.Placeholder(
            width = androidx.compose.ui.unit.TextUnit(1.1f, androidx.compose.ui.unit.TextUnitType.Em),
            height = androidx.compose.ui.unit.TextUnit(0.7f, androidx.compose.ui.unit.TextUnitType.Em),
            placeholderVerticalAlign = androidx.compose.ui.text.PlaceholderVerticalAlign.TextCenter,
        ),
    ) {
        Box(contentAlignment = Alignment.CenterEnd) {
            Spacer(Modifier.width(2.dp))
            StreamingCursor()
        }
    },
)

/** Splits highlighted code into chunks of [CHUNK_LINES] lines (no trailing newline per chunk). */
internal fun chunkLines(code: AnnotatedString): List<AnnotatedString> {
    val text = code.text
    if (text.isEmpty()) return emptyList()
    val out = ArrayList<AnnotatedString>()
    var start = 0
    var lines = 0
    var i = 0
    while (i < text.length) {
        if (text[i] == '\n') {
            lines++
            if (lines == CHUNK_LINES) {
                out += code.subSequence(start, i)
                start = i + 1
                lines = 0
            }
        }
        i++
    }
    if (start <= text.length) out += code.subSequence(start, text.length)
    return out
}
