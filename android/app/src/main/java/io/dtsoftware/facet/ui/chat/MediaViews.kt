package io.dtsoftware.facet.ui.chat

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.data.AttachmentRef
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Images, videos and audio a tool created for this reply. */
@Composable
fun MediaAttachments(atts: List<AttachmentRef>, actions: MessageActions, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        atts.forEach { a ->
            when (a.kind) {
                "image" -> MediaFrame(a, actions, isVideo = false)
                "video" -> MediaFrame(a, actions, isVideo = true)
                "audio" -> AudioCard(a, actions)
                else -> FileChip(a, onClick = { actions.onOpenAttachment(a) })
            }
        }
    }
}

@Composable
private fun MediaFrame(a: AttachmentRef, actions: MessageActions, isVideo: Boolean) {
    val c = FacetTheme.colors
    val px = with(LocalDensity.current) { 420.dp.roundToPx() }
    val bmp by produceState<ImageBitmap?>(null, a.id) { value = actions.thumbnail(a.id, px) }
    val duration by produceState<Long?>(null, a.id) { if (isVideo) value = actions.mediaDuration(a.id) }
    val ratio = if (a.width != null && a.height != null && a.width > 0 && a.height > 0) a.width.toFloat() / a.height else if (isVideo) 16f / 9 else 1f
    Box(
        Modifier
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .aspectRatio(ratio.coerceIn(0.5f, 2.2f))
            .clip(RoundedCornerShape(18.dp))
            .background(c.surfaceHigh)
            .clickable(onClickLabel = stringResource(if (isVideo) R.string.chat_media_play_video else R.string.chat_media_open_image)) { actions.onOpenAttachment(a) },
    ) {
        bmp?.let { Image(it, a.name, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
            ?: FacetIcon(if (isVideo) R.drawable.ic_film else R.drawable.ic_image, null, tint = c.textTertiary, size = 28.dp, modifier = Modifier.align(Alignment.Center))
        if (isVideo) {
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.45f)))))
            Box(
                Modifier.align(Alignment.Center).size(56.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f)),
                contentAlignment = Alignment.Center,
            ) {
                FacetIcon(R.drawable.ic_play, null, tint = Color.White, size = 26.dp)
            }
            duration?.let {
                Text(
                    clock(it), style = FacetTheme.type.labelS, color = Color.White,
                    modifier = Modifier.align(Alignment.BottomStart).padding(12.dp),
                )
            }
        }
    }
}

@Composable
private fun AudioCard(a: AttachmentRef, actions: MessageActions) {
    val c = FacetTheme.colors
    val scope = rememberCoroutineScope()
    val active = AudioPlayback.currentId == a.id
    val playing = active && AudioPlayback.playing
    val total by produceState(0L, a.id) { value = actions.mediaDuration(a.id) ?: 0L }
    val duration = if (active && AudioPlayback.durationMs > 0) AudioPlayback.durationMs else total
    val position = if (active) AudioPlayback.positionMs else 0L
    LaunchedEffect(playing) {
        while (playing) {
            AudioPlayback.tick()
            delay(200)
        }
    }
    Row(
        Modifier
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(c.surfaceHigh)
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(c.primary)
                .clickable(onClickLabel = stringResource(if (playing) R.string.chat_media_pause else R.string.chat_media_play)) {
                    scope.launch { actions.mediaFile(a.id)?.let { AudioPlayback.toggle(a.id, it) } }
                },
            contentAlignment = Alignment.Center,
        ) {
            FacetIcon(if (playing) R.drawable.ic_pause else R.drawable.ic_play, null, tint = c.onPrimary, size = 20.dp)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                FacetIcon(R.drawable.ic_music, null, tint = c.textTertiary, size = 13.dp)
                Spacer(Modifier.width(6.dp))
                Text(a.name, style = FacetTheme.type.labelM, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Text(
                    if (duration > 0) "${clock(position)} / ${clock(duration)}" else clock(position),
                    style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
                )
            }
            Spacer(Modifier.height(8.dp))
            val fraction = if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
            // The bar fills from the start edge, which is the right in Arabic and Urdu.
            val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(18.dp)
                    .pointerInput(a.id, active, rtl) {
                        detectTapGestures { o ->
                            val x = o.x / size.width
                            if (active) AudioPlayback.seekTo(if (rtl) 1f - x else x)
                        }
                    },
                contentAlignment = Alignment.CenterStart,
            ) {
                Box(Modifier.fillMaxWidth().height(4.dp).clip(CircleShape).background(c.outline))
                Box(Modifier.fillMaxWidth(fraction).height(4.dp).clip(CircleShape).background(c.primary))
            }
        }
    }
}

/** "m:ss", with the app language's digits. */
private fun clock(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return String.format(Strings.locale, "%d:%02d", s / 60, s % 60)
}
