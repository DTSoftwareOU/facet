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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.Dates
import io.dtsoftware.facet.core.util.Format
import io.dtsoftware.facet.data.db.AttachmentEntity
import io.dtsoftware.facet.sync.AccountState
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SettingsRow
import io.dtsoftware.facet.ui.components.SwitchRow
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.ui.theme.GemPalette
import java.io.File
import java.text.NumberFormat
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
    val synced by container.settings.synced.collectAsStateWithLifecycle()
    val autoFreed by container.sync.autoFreed.collectAsStateWithLifecycle()
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
        SettingsGroup(title = stringResource(R.string.storage_sync_title)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.Bottom) {
                    // "14.2 MB of 1 GB" is one sentence (translations may reorder it); the used amount is set large.
                    val used = Format.bytes(a.usedBytes)
                    val marker = Char(0xE000).toString() // a private-use character that marks where the used amount goes
                    val template = stringResource(R.string.storage_used_of_total, marker, Format.bytes(a.quotaBytes))
                    val large = FacetTheme.type.titleL.toSpanStyle().copy(color = c.text)
                    Text(
                        buildAnnotatedString {
                            val at = template.indexOf(marker)
                            if (at < 0) {
                                append(template)
                            } else {
                                append(template.substring(0, at))
                                withStyle(large) { append(used) }
                                append(template.substring(at + marker.length))
                            }
                        },
                        style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal, lineHeight = FacetTheme.type.titleL.lineHeight),
                        color = c.textSecondary, modifier = Modifier.weight(1f).alignByBaseline(),
                    )
                    if (a.quotaBytes > 0) {
                        val percent = (a.usedBytes * 100 / a.quotaBytes).coerceIn(0, 100)
                        Text(
                            NumberFormat.getPercentInstance(Strings.locale).format(percent / 100.0),
                            style = FacetTheme.type.labelM, color = if (full) c.warning else c.textSecondary,
                            modifier = Modifier.alignByBaseline(),
                        )
                    }
                }
                UsageBar(a.recordBytes, a.blobBytes, a.quotaBytes)
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Legend(c.primary, stringResource(R.string.storage_chats_settings), a.recordBytes)
                    Legend(GemPalette.Flash, stringResource(R.string.storage_files), a.blobBytes)
                }
                Text(
                    stringResource(
                        when {
                            !full -> R.string.storage_note_ok
                            synced.autoFreeSpace -> R.string.storage_note_full_auto
                            else -> R.string.storage_note_full
                        },
                    ),
                    style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal),
                    color = if (full) c.warning else c.textTertiary,
                )
            }
            GroupDivider()
            SwitchRow(
                stringResource(R.string.storage_auto_free),
                synced.autoFreeSpace,
                { on -> container.settings.updateSynced { it.copy(autoFreeSpace = on) } },
                subtitle = stringResource(R.string.storage_auto_free_subtitle),
                icon = R.drawable.ic_cloud_off,
            )
            autoFreed?.let { f ->
                val size = Format.bytes(f.bytes)
                Text(
                    if (Dates.justNow(f.at)) pluralStringResource(R.plurals.storage_cleanup_just_now, f.files, f.files, size)
                    else pluralStringResource(R.plurals.storage_cleanup, f.files, f.files, size, Dates.relative(f.at)),
                    style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal),
                    color = c.textTertiary,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 14.dp),
                )
            }
        }
    }

    SettingsGroup(title = stringResource(R.string.storage_device_title)) {
        SettingsRow(
            stringResource(R.string.storage_device_used), subtitle = deviceBytes?.let { Format.bytes(it) } ?: stringResource(R.string.storage_calculating),
            icon = R.drawable.ic_phone, showChevron = false,
        )
        if (signedIn != null) {
            GroupDivider()
            SettingsRow(
                stringResource(R.string.storage_remove_copies),
                subtitle = stringResource(R.string.storage_remove_copies_subtitle),
                icon = R.drawable.ic_download,
                onClick = {
                    scope.launch {
                        val freed = container.sync.clearDownloadedCopies()
                        note = if (freed > 0) Strings.get(R.string.storage_freed, Format.bytes(freed)) else Strings.get(R.string.storage_nothing_to_remove)
                        refresh++
                    }
                },
            )
        }
        if (deviceOnly > 0) {
            GroupDivider()
            SettingsRow(
                pluralStringResource(R.plurals.storage_device_only, deviceOnly, deviceOnly),
                // "it" or "them": exactly one file or several (plural categories can't tell 1 from 21).
                subtitle = stringResource(if (deviceOnly == 1) R.string.storage_device_only_subtitle_one else R.string.storage_device_only_subtitle_many),
                icon = R.drawable.ic_cloud_off,
                onClick = { scope.launch { container.sync.retryDeviceOnlyFiles(); note = Strings.get(R.string.storage_retrying) } },
            )
        }
    }

    if (largest.isNotEmpty()) {
        SettingsGroup(title = stringResource(R.string.storage_largest)) {
            largest.forEachIndexed { i, f ->
                if (i > 0) GroupDivider()
                SettingsRow(
                    f.name,
                    subtitle = Format.bytes(f.sizeBytes) + " · " + stringResource(
                        when {
                            f.localOnly -> R.string.storage_status_device_only
                            f.uploaded -> R.string.storage_status_synced
                            else -> R.string.storage_status_waiting
                        },
                    ),
                    icon = kindIcon(f),
                    showChevron = false,
                    trailing = if (signedIn != null && f.uploaded && !f.localOnly) ({
                        FacetButton(stringResource(R.string.storage_free_up), {
                            scope.launch {
                                runCatching { container.sync.keepOnDeviceOnly(f.id) }
                                    .onSuccess { note = Strings.get(R.string.storage_kept_on_device, f.name) }
                                    .onFailure { note = Strings.get(R.string.storage_free_failed) }
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
