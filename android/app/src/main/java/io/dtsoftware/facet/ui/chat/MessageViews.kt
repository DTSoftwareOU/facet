package io.dtsoftware.facet.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.core.util.Format
import io.dtsoftware.facet.data.AttachmentRef
import io.dtsoftware.facet.data.attachments
import io.dtsoftware.facet.data.citations
import io.dtsoftware.facet.data.db.MessageStatus
import io.dtsoftware.facet.data.error
import io.dtsoftware.facet.data.usage
import io.dtsoftware.facet.llm.Citation
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.FacetIconButton
import io.dtsoftware.facet.ui.components.Gem
import io.dtsoftware.facet.ui.markdown.Markdown
import io.dtsoftware.facet.ui.markdown.rememberSmoothedText
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.ui.theme.GemPalette
import kotlinx.coroutines.delay

/** Callbacks for message actions, grouped to keep item signatures stable. */
class MessageActions(
    val onCopy: (String) -> Unit,
    val onRegenerate: (String) -> Unit,
    val onRegenerateWith: (String) -> Unit,
    val onEdit: (String, String) -> Unit,
    val onSpeak: (String, String) -> Unit,
    val onShare: (String) -> Unit,
    val onMore: (ThreadItem) -> Unit,
    val onSwitchBranch: (String) -> Unit,
    val onContinue: () -> Unit,
    val onUsage: (ThreadItem) -> Unit,
    val onOpenAttachment: (AttachmentRef) -> Unit,
    val thumbnail: suspend (String, Int) -> ImageBitmap?,
)

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun UserMessage(item: ThreadItem, actions: MessageActions, modifier: Modifier = Modifier) {
    val m = item.message
    val c = FacetTheme.colors
    val atts = remember(m.attachmentsJson) { m.attachments() }
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        if (atts.isNotEmpty()) {
            AttachmentStrip(atts, actions, Modifier.padding(bottom = 6.dp))
        }
        if (m.content.isNotBlank()) {
            Box(
                Modifier
                    .fillMaxWidth(0.86f)
                    .widthIn(max = 560.dp),
                contentAlignment = Alignment.CenterEnd,
            ) {
                Text(
                    m.content,
                    style = FacetTheme.type.chat,
                    color = c.text,
                    modifier = Modifier
                        .clip(FacetShapes.userBubble)
                        .background(c.userBubble)
                        .combinedClickable(onClick = {}, onLongClick = { actions.onMore(item) })
                        .padding(horizontal = 16.dp, vertical = 11.dp),
                )
            }
        }
        if (item.siblingIds.size > 1) {
            Spacer(Modifier.height(2.dp))
            BranchSwitcher(item, actions)
        }
    }
}

@Composable
private fun AttachmentStrip(atts: List<AttachmentRef>, actions: MessageActions, modifier: Modifier = Modifier) {
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        atts.forEach { a ->
            if (a.kind == "image") {
                val density = LocalDensity.current
                val px = with(density) { 220.dp.roundToPx() }
                val bmp by produceState<ImageBitmap?>(null, a.id) { value = actions.thumbnail(a.id, px) }
                val ratio = if (a.width != null && a.height != null && a.height > 0) a.width.toFloat() / a.height else 1f
                val w = if (atts.size == 1) 220.dp else 120.dp
                Box(
                    Modifier
                        .width(w)
                        .height((w.value / ratio.coerceIn(0.5f, 2f)).dp)
                        .clip(RoundedCornerShape(16.dp))
                        .background(FacetTheme.colors.surfaceHigh)
                        .clickable { actions.onOpenAttachment(a) },
                ) {
                    bmp?.let { Image(it, a.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
                }
            } else {
                FileChip(a, onClick = { actions.onOpenAttachment(a) })
            }
        }
    }
}

@Composable
fun FileChip(a: AttachmentRef, onClick: () -> Unit, trailing: (@Composable () -> Unit)? = null) {
    val c = FacetTheme.colors
    Row(
        Modifier
            .clip(RoundedCornerShape(14.dp))
            .background(c.surfaceHigh)
            .clickable(onClick = onClick)
            .padding(start = 10.dp, end = if (trailing != null) 2.dp else 12.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(32.dp).clip(RoundedCornerShape(9.dp)).background(if (a.kind == "pdf") c.errorContainer else c.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            FacetIcon(if (a.kind == "pdf") R.drawable.ic_file_text else R.drawable.ic_file, null, tint = if (a.kind == "pdf") c.error else c.onPrimaryContainer, size = 17.dp)
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.widthIn(max = 180.dp)) {
            Text(a.name, style = FacetTheme.type.labelM, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                (if (a.kind == "pdf") "PDF" else a.name.substringAfterLast('.', "File").uppercase()) + " · " + Format.bytes(a.sizeBytes),
                style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
            )
        }
        trailing?.invoke()
    }
}

@Composable
fun AssistantMessage(
    item: ThreadItem,
    actions: MessageActions,
    showUsage: Boolean,
    showCost: Boolean,
    expandThinkingByDefault: Boolean,
    isLast: Boolean,
    modifier: Modifier = Modifier,
) {
    val m = item.message
    val live = item.live
    val c = FacetTheme.colors
    val streaming = live != null
    val status = remember(m.status) { runCatching { MessageStatus.valueOf(m.status) }.getOrDefault(MessageStatus.DONE) }
    val rawText = live?.text ?: m.content
    val text = rememberSmoothedText(rawText, streaming)
    val thinkingText = live?.thinking?.takeIf { it.isNotEmpty() } ?: m.thinking
    val thinkingActive = live?.thinkingActive == true
    val citations = live?.citations?.takeIf { it.isNotEmpty() } ?: remember(m.citationsJson) { m.citations() }
    val uri = LocalUriHandler.current

    Column(modifier.fillMaxWidth()) {
        // Header: gem + model name
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 8.dp)) {
            Gem(size = 18.dp, thinking = streaming && text.isEmpty())
            Spacer(Modifier.width(8.dp))
            Text(
                m.modelName ?: m.modelId ?: "Assistant",
                style = FacetTheme.type.labelM,
                color = c.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        val hasThinking = thinkingActive || !thinkingText.isNullOrBlank() || (m.thinkingMs ?: 0) > 0 || (live?.thinkingStartedAt != null)
        if (hasThinking) {
            ThinkingPanel(
                text = thinkingText.orEmpty(),
                active = thinkingActive,
                startedAt = live?.thinkingStartedAt,
                durationMs = live?.thinkingMs?.takeIf { it > 0 } ?: m.thinkingMs ?: 0,
                expandedByDefault = expandThinkingByDefault,
            )
            Spacer(Modifier.height(10.dp))
        }

        if (live != null && (live.searching || (live.searchCount > 0 && text.isEmpty()))) {
            SearchStatus(live.searchQuery, live.searching, live.searchCount)
            Spacer(Modifier.height(10.dp))
        }

        if (text.isNotEmpty()) {
            Markdown(text = text, streaming = streaming, onLinkClick = { runCatching { uri.openUri(it) } }, onCopyCode = null)
        } else if (streaming && !thinkingActive && live?.searching != true && !hasThinking) {
            WaitingDots()
        }

        live?.notice?.let { Notice(it) }

        if (citations.isNotEmpty() && (!streaming || text.isNotEmpty())) {
            Spacer(Modifier.height(12.dp))
            CitationRow(citations) { runCatching { uri.openUri(it) } }
        }

        if (!streaming) {
            when (status) {
                MessageStatus.ERROR -> m.error()?.let { err ->
                    Spacer(Modifier.height(8.dp))
                    StatusCard(R.drawable.ic_alert, err.message, c.error, "Retry") { actions.onRegenerate(m.id) }
                }
                MessageStatus.REFUSED -> {
                    Spacer(Modifier.height(8.dp))
                    StatusCard(R.drawable.ic_shield, "The model declined to answer this. You can rephrase, or try another model.", c.warning, "Try another model") {
                        actions.onRegenerateWith(m.id)
                    }
                }
                MessageStatus.TRUNCATED -> if (isLast) {
                    Spacer(Modifier.height(8.dp))
                    StatusCard(R.drawable.ic_timer, "This reply reached the output limit.", c.textSecondary, "Continue") { actions.onContinue() }
                }
                MessageStatus.STOPPED -> {
                    Spacer(Modifier.height(6.dp))
                    Text("Stopped", style = FacetTheme.type.labelS, color = c.textTertiary)
                }
                else -> Unit
            }
            ActionRow(item, actions, showUsage, showCost)
        }
    }
}

@Composable
private fun WaitingDots() {
    val t = rememberInfiniteTransition(label = "dots")
    Row(Modifier.height(26.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(3) { i ->
            val a by t.animateFloat(
                0.25f, 1f,
                infiniteRepeatable(tween(600, delayMillis = i * 160, easing = LinearEasing), androidx.compose.animation.core.RepeatMode.Reverse),
                label = "dot$i",
            )
            Box(Modifier.padding(end = 5.dp).size(7.dp).alpha(a).clip(CircleShape).background(FacetTheme.colors.textSecondary))
        }
    }
}

@Composable
private fun ThinkingPanel(text: String, active: Boolean, startedAt: Long?, durationMs: Long, expandedByDefault: Boolean) {
    val c = FacetTheme.colors
    var expanded by rememberSaveable { mutableStateOf(expandedByDefault) }
    var now by remember { mutableLongStateOf(Clock.now()) }
    LaunchedEffect(active) {
        while (active) {
            now = Clock.now()
            delay(250)
        }
    }
    val rotation by animateFloatAsState(if (expanded) 90f else 0f, label = "chev")
    val label = when {
        active -> "Thinking" + (startedAt?.let { " · " + Format.seconds(now - it) } ?: "")
        durationMs > 0 -> "Thought for ${Format.seconds(durationMs)}"
        else -> "Reasoning"
    }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .animateContentSize(),
    ) {
        Row(
            Modifier
                .clip(RoundedCornerShape(12.dp))
                .clickable(enabled = text.isNotBlank()) { expanded = !expanded }
                .padding(vertical = 4.dp, horizontal = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (active) {
                Gem(size = 15.dp, thinking = true)
                Spacer(Modifier.width(8.dp))
                ShimmerText(label)
            } else {
                FacetIcon(R.drawable.ic_brain, null, tint = c.textTertiary, size = 15.dp)
                Spacer(Modifier.width(8.dp))
                Text(label, style = FacetTheme.type.labelM, color = c.textSecondary)
            }
            if (text.isNotBlank()) {
                Spacer(Modifier.width(4.dp))
                FacetIcon(R.drawable.ic_chevron_right, if (expanded) "Collapse" else "Expand", tint = c.textTertiary, size = 15.dp, modifier = Modifier.rotate(rotation))
            }
        }
        AnimatedVisibility(expanded && text.isNotBlank(), enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            val lineColor = c.outline
            Text(
                text.trim(),
                style = FacetTheme.type.body.copy(fontStyle = FontStyle.Normal),
                color = c.textSecondary,
                modifier = Modifier
                    .padding(top = 6.dp, start = 7.dp)
                    .heightIn(max = 420.dp)
                    .drawBehind { drawLine(lineColor, Offset(0f, 0f), Offset(0f, size.height), strokeWidth = 2.dp.toPx()) }
                    .padding(start = 14.dp, end = 4.dp),
            )
        }
    }
}

@Composable
private fun ShimmerText(text: String) {
    val c = FacetTheme.colors
    if (FacetTheme.reducedMotion) {
        Text(text, style = FacetTheme.type.labelM, color = c.textSecondary)
        return
    }
    val t = rememberInfiniteTransition(label = "shimmer")
    val x by t.animateFloat(-1f, 2f, infiniteRepeatable(tween(1600, easing = LinearEasing)), label = "x")
    Text(
        text,
        style = FacetTheme.type.labelM.copy(
            brush = Brush.linearGradient(
                0f to c.textTertiary,
                (x - 0.3f).coerceIn(0f, 1f) to c.textTertiary,
                x.coerceIn(0f, 1f) to c.text,
                (x + 0.3f).coerceIn(0f, 1f) to c.textTertiary,
                1f to c.textTertiary,
                start = Offset.Zero, end = Offset(400f, 0f),
            ),
        ),
    )
}

@Composable
private fun SearchStatus(query: String?, searching: Boolean, count: Int) {
    val c = FacetTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        FacetIcon(R.drawable.ic_globe, null, tint = if (searching) c.primary else c.textTertiary, size = 15.dp)
        Spacer(Modifier.width(8.dp))
        val label = when {
            searching && !query.isNullOrBlank() -> "Searching “$query”"
            searching -> "Searching the web"
            else -> "Searched the web" + if (count > 1) " $count times" else ""
        }
        if (searching) ShimmerText(label) else Text(label, style = FacetTheme.type.labelM, color = c.textSecondary)
    }
}

@Composable
private fun Notice(text: String) {
    Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        FacetIcon(R.drawable.ic_info, null, tint = FacetTheme.colors.textTertiary, size = 14.dp)
        Spacer(Modifier.width(6.dp))
        Text(text, style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = FacetTheme.colors.textTertiary)
    }
}

@Composable
private fun CitationRow(citations: List<Citation>, onOpen: (String) -> Unit) {
    val c = FacetTheme.colors
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        citations.take(12).forEachIndexed { i, cite ->
            val host = remember(cite.url) { runCatching { java.net.URI(cite.url).host?.removePrefix("www.") }.getOrNull() ?: cite.url }
            Row(
                Modifier
                    .clip(FacetShapes.chip)
                    .border(1.dp, c.outline, FacetShapes.chip)
                    .clickable { onOpen(cite.url) }
                    .padding(horizontal = 10.dp, vertical = 7.dp)
                    .widthIn(max = 220.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier.size(18.dp).clip(CircleShape).background(c.surfaceHigh),
                    contentAlignment = Alignment.Center,
                ) { Text("${i + 1}", style = FacetTheme.type.labelS, color = c.textSecondary) }
                Spacer(Modifier.width(7.dp))
                Column {
                    Text(cite.title?.takeIf { it.isNotBlank() } ?: host, style = FacetTheme.type.labelM, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(host, style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun StatusCard(icon: Int, text: String, tint: androidx.compose.ui.graphics.Color, action: String?, onAction: () -> Unit) {
    val c = FacetTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(c.surface)
            .border(1.dp, c.outlineVariant, RoundedCornerShape(14.dp))
            .padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FacetIcon(icon, null, tint = tint, size = 18.dp)
        Spacer(Modifier.width(10.dp))
        Text(text, style = FacetTheme.type.body, color = c.text, modifier = Modifier.weight(1f).padding(vertical = 8.dp))
        if (action != null) {
            Text(
                action,
                style = FacetTheme.type.labelM,
                color = c.primary,
                modifier = Modifier.clip(FacetShapes.pill).clickable(onClick = onAction).padding(horizontal = 12.dp, vertical = 10.dp),
            )
        }
    }
}

@Composable
private fun ActionRow(item: ThreadItem, actions: MessageActions, showUsage: Boolean, showCost: Boolean) {
    val m = item.message
    val c = FacetTheme.colors
    val usage = remember(m.usageJson) { m.usage() }
    Row(Modifier.fillMaxWidth().padding(top = 4.dp).height(40.dp), verticalAlignment = Alignment.CenterVertically) {
        if (m.content.isNotBlank()) {
            SmallAction(R.drawable.ic_copy, "Copy") { actions.onCopy(m.content) }
        }
        SmallAction(R.drawable.ic_regenerate, "Regenerate") { actions.onRegenerate(m.id) }
        if (m.content.isNotBlank()) {
            SmallAction(R.drawable.ic_speak, "Read aloud") { actions.onSpeak(m.id, m.content) }
            SmallAction(R.drawable.ic_share, "Share") { actions.onShare(m.content) }
        }
        SmallAction(R.drawable.ic_more_horiz, "More") { actions.onMore(item) }
        if (item.siblingIds.size > 1) BranchSwitcher(item, actions)
        Spacer(Modifier.weight(1f))
        val parts = buildList {
            if (showUsage && usage != null && (usage.inputTokens + usage.outputTokens) > 0) {
                add("${Format.tokens(usage.inputTokens)} in · ${Format.tokens(usage.outputTokens)} out")
            }
            if (showCost && m.costUsd != null) add(Format.cost(m.costUsd))
        }
        if (parts.isNotEmpty()) {
            Text(
                parts.joinToString(" · "),
                style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal),
                color = c.textTertiary,
                modifier = Modifier.clip(FacetShapes.small).clickable { actions.onUsage(item) }.padding(horizontal = 6.dp, vertical = 6.dp),
            )
        }
    }
}

@Composable
private fun SmallAction(icon: Int, label: String, onClick: () -> Unit) {
    FacetIconButton(icon, label, onClick, tint = FacetTheme.colors.textTertiary, size = 18.dp, modifier = Modifier.size(38.dp))
}

@Composable
private fun BranchSwitcher(item: ThreadItem, actions: MessageActions) {
    val c = FacetTheme.colors
    val idx = item.siblingIndex
    val count = item.siblingIds.size
    Row(verticalAlignment = Alignment.CenterVertically) {
        FacetIconButton(
            R.drawable.ic_chevron_left, "Previous version", { if (idx > 0) actions.onSwitchBranch(item.siblingIds[idx - 1]) },
            enabled = idx > 0, tint = c.textSecondary, size = 16.dp, modifier = Modifier.size(32.dp),
        )
        Text("${idx + 1} / $count", style = FacetTheme.type.labelS, color = c.textSecondary)
        FacetIconButton(
            R.drawable.ic_chevron_right, "Next version", { if (idx < count - 1) actions.onSwitchBranch(item.siblingIds[idx + 1]) },
            enabled = idx < count - 1, tint = c.textSecondary, size = 16.dp, modifier = Modifier.size(32.dp),
        )
    }
}

/** Gradient caret shown inside the composer placeholder area while dictating, etc. */
@Composable
fun GemCaret(modifier: Modifier = Modifier) {
    Box(modifier.size(9.dp).clip(RoundedCornerShape(3.dp)).background(Brush.linearGradient(listOf(GemPalette.Flash, GemPalette.Glint))))
}
