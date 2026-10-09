package io.dtsoftware.facet.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.util.Format
import io.dtsoftware.facet.data.db.AttachmentEntity
import io.dtsoftware.facet.sync.AccountState
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SettingsRow
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.ui.theme.GemPalette
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Sync storage (quota and what uses it), this device's storage, and ways to free space. */
@Composable
fun StorageSection(container: AppContainer) {
    val c = FacetTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val account by container.auth.state.collectAsStateWithLifecycle()
    val sync by container.sync.state.collectAsStateWithLifecycle()
    val largest by container.db.attachments().observeLargest(8).collectAsStateWithLifecycle(emptyList())
    val deviceOnly by container.db.attachments().observeLocalOnlyCount().collectAsStateWithLifecycle(0)
    var deviceBytes by remember { mutableStateOf<Long?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    var note by remember { mutableStateOf<String?>(null) }
    val signedIn = account as? AccountState.SignedIn

    LaunchedEffect(Unit) { runCatching { container.auth.refreshAccount() } }
    LaunchedEffect(refresh) {
        deviceBytes = withContext(Dispatchers.IO) {
            val db = context.getDatabasePath("facet.db")
            listOf(db, File(db.path + "-wal"), File(db.path + "-shm")).sumOf { if (it.exists()) it.length() else 0L } +
                (container.attachments.dir.listFiles()?.sumOf { it.length() } ?: 0L)
        }
    }

    signedIn?.let { a ->
        val full = sync.storageFull || (a.quotaBytes > 0 && a.usedBytes >= a.quotaBytes)
        SettingsGroup(title = "Sync storage") {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(Format.bytes(a.usedBytes), style = FacetTheme.type.titleL, color = c.text)
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "of ${Format.bytes(a.quotaBytes)}", style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal),
                        color = c.textSecondary, modifier = Modifier.weight(1f).padding(bottom = 3.dp),
                    )
                    if (a.quotaBytes > 0) {
                        Text("${(a.usedBytes * 100 / a.quotaBytes).coerceIn(0, 100)}%", style = FacetTheme.type.labelM, color = if (full) c.warning else c.textSecondary)
                    }
                }
                UsageBar(a.recordBytes, a.blobBytes, a.quotaBytes)
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Legend(c.primary, "Chats & settings", a.recordBytes)
                    Legend(GemPalette.Flash, "Files", a.blobBytes)
                }
                Text(
                    if (full) "Storage is full. New changes and files wait on this device until you free up space below or delete old chats."
                    else "Everything here is end-to-end encrypted. Chats are compressed before upload; files sync until the space is used.",
                    style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal),
                    color = if (full) c.warning else c.textTertiary,
                )
            }
        }
    }

    SettingsGroup(title = "On this device") {
        SettingsRow("Used on this phone", subtitle = deviceBytes?.let { Format.bytes(it) } ?: "Calculating…", icon = R.drawable.ic_phone, showChevron = false)
        if (signedIn != null) {
            GroupDivider()
            SettingsRow(
                "Remove downloaded copies",
                subtitle = "Files already in your sync storage download again when you open them.",
                icon = R.drawable.ic_download,
                onClick = {
                    scope.launch {
                        val freed = container.sync.clearDownloadedCopies()
                        note = if (freed > 0) "Freed ${Format.bytes(freed)} on this device." else "Nothing to remove."
                        refresh++
                    }
                },
            )
        }
        if (deviceOnly > 0) {
            GroupDivider()
            SettingsRow(
                if (deviceOnly == 1) "1 file is only on this device" else "$deviceOnly files are only on this device",
                subtitle = "Not synced because storage was full, or you freed it up. Tap to try uploading again.",
                icon = R.drawable.ic_cloud_off,
                onClick = { scope.launch { container.sync.retryDeviceOnlyFiles(); note = "Trying again. Files upload while there's space." } },
            )
        }
    }

    if (largest.isNotEmpty()) {
        SettingsGroup(title = "Largest files") {
            largest.forEachIndexed { i, f ->
                if (i > 0) GroupDivider()
                SettingsRow(
                    f.name,
                    subtitle = Format.bytes(f.sizeBytes) + " · " + when {
                        f.localOnly -> "This device only"
                        f.uploaded -> "Synced"
                        else -> "Waiting to sync"
                    },
                    icon = kindIcon(f),
                    showChevron = false,
                    trailing = if (signedIn != null && f.uploaded && !f.localOnly) ({
                        FacetButton("Free up", {
                            scope.launch {
                                runCatching { container.sync.keepOnDeviceOnly(f.id) }
                                    .onSuccess { note = "${f.name} is now kept on this device only." }
                                    .onFailure { note = "Couldn't free that file. Check your connection." }
                            }
                        }, style = ButtonStyle.Tonal)
                    }) else null,
                )
            }
        }
    }
    note?.let { Text(it, style = FacetTheme.type.labelM, color = c.textSecondary, modifier = Modifier.padding(start = 12.dp)) }
}

@Composable
private fun UsageBar(records: Long, blobs: Long, quota: Long) {
    val c = FacetTheme.colors
    val total = quota.coerceAtLeast(1).toFloat()
    val r = (records / total).coerceIn(0f, 1f)
    val b = (blobs / total).coerceIn(0f, 1f - r)
    Box(Modifier.fillMaxWidth().height(10.dp).clip(CircleShape).background(c.surfaceHighest)) {
        Row(Modifier.fillMaxWidth().fillMaxHeight()) {
            if (r > 0f) Box(Modifier.fillMaxHeight().weight(r).background(c.primary))
            if (b > 0f) Box(Modifier.fillMaxHeight().weight(b).background(GemPalette.Flash))
            if (1f - r - b > 0.0001f) Spacer(Modifier.weight(1f - r - b))
        }
    }
}

@Composable
private fun Legend(color: Color, label: String, bytes: Long) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(6.dp))
        Text("$label · ${Format.bytes(bytes)}", style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = FacetTheme.colors.textSecondary)
    }
}

private fun kindIcon(a: AttachmentEntity): Int = when (a.kind) {
    "image" -> R.drawable.ic_image
    "video" -> R.drawable.ic_film
    "audio" -> R.drawable.ic_music
    "pdf" -> R.drawable.ic_file_text
    else -> R.drawable.ic_file
}
