package io.dtsoftware.facet.ui.settings

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.domain.tools.ToolApproval
import io.dtsoftware.facet.remote.RemoteHosts
import io.dtsoftware.facet.sync.AccountState
import io.dtsoftware.facet.ui.chat.Segmented
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SettingsRow
import io.dtsoftware.facet.ui.theme.FacetTheme

/** How "Your PC → Ask before" reads for each choice. */
internal fun ToolApproval.pcLabel(): String = Strings.get(
    when (this) {
        ToolApproval.ALWAYS -> R.string.pcsettings_ask_every_action
        ToolApproval.WRITES -> R.string.pcsettings_ask_changes
        ToolApproval.NEVER -> R.string.pcsettings_ask_never
    },
)

@StringRes
private fun ToolApproval.pcBlurb(): Int = when (this) {
    ToolApproval.ALWAYS -> R.string.pcsettings_blurb_always
    ToolApproval.WRITES -> R.string.pcsettings_blurb_writes
    ToolApproval.NEVER -> R.string.pcsettings_blurb_never
}

/** The "Your PC" row's subtitle in Settings: which PCs are online. */
@Composable
internal fun pcSubtitle(container: AppContainer): String {
    val hosts by container.remote.hosts.collectAsStateWithLifecycle()
    val list = hosts.values.toList()
    return when (list.size) {
        0 -> stringResource(R.string.pcsettings_subtitle_none)
        1 -> stringResource(R.string.pcsettings_subtitle_one, list[0].name)
        else -> pluralStringResource(R.plurals.pcsettings_subtitle_many, list.size, list.size)
    }
}

/** Settings → Your PC: the account's online PCs and when to ask before acting on them (this device only). */
@Composable
fun PcSettingsScreen(container: AppContainer, onBack: () -> Unit) {
    val hosts by container.remote.hosts.collectAsStateWithLifecycle()
    val local by container.settings.local.collectAsStateWithLifecycle()
    val synced by container.settings.synced.collectAsStateWithLifecycle()
    val account by container.auth.state.collectAsStateWithLifecycle()
    val c = FacetTheme.colors
    SettingsPage(stringResource(R.string.pcsettings_title), onBack) {
        Intro(stringResource(R.string.pcsettings_intro))
        SettingsGroup(title = stringResource(R.string.pcsettings_online_now)) {
            val list = hosts.values.sortedBy { it.name.lowercase() }
            val ready = stringResource(R.string.pcsettings_ready)
            when {
                account !is AccountState.SignedIn -> SettingsRow(
                    stringResource(R.string.pcsettings_sign_in), subtitle = stringResource(R.string.pcsettings_sign_in_subtitle),
                    icon = R.drawable.ic_monitor, showChevron = false,
                )
                list.isEmpty() -> SettingsRow(
                    stringResource(R.string.pcsettings_none_online), subtitle = stringResource(R.string.pcsettings_none_online_subtitle),
                    icon = R.drawable.ic_monitor_off, showChevron = false,
                )
                else -> list.forEachIndexed { i, h ->
                    if (i > 0) GroupDivider()
                    SettingsRow(
                        h.name,
                        subtitle = if (h.remote) listOf(ready, h.os).filter { it.isNotBlank() }.joinToString(" · ") else RemoteHosts.turnOnHint(h.name),
                        showChevron = false,
                        leading = {
                            Box(
                                Modifier.size(36.dp).clip(CircleShape).background(if (h.remote) c.primaryContainer else c.surfaceHigh),
                                contentAlignment = Alignment.Center,
                            ) {
                                FacetIcon(R.drawable.ic_monitor, null, tint = if (h.remote) c.onPrimaryContainer else c.textSecondary, size = 18.dp)
                            }
                        },
                    )
                }
            }
        }
        Column {
            Text(stringResource(R.string.pcsettings_ask_before), style = FacetTheme.type.labelM, color = c.textTertiary, modifier = Modifier.padding(start = 12.dp, bottom = 8.dp))
            Segmented(
                ToolApproval.entries, local.pcApproval, { it.pcLabel() },
                { a -> container.settings.updateLocal { it.copy(pcApproval = a) } },
            )
            Text(
                stringResource(if (synced.yoloMode) R.string.pcsettings_yolo_on else local.pcApproval.pcBlurb()),
                style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal),
                color = if (synced.yoloMode) c.warning else c.textTertiary,
                modifier = Modifier.padding(start = 12.dp, top = 6.dp),
            )
        }
        Text(
            stringResource(R.string.pcsettings_how_to_pick),
            style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
            modifier = Modifier.padding(horizontal = 12.dp),
        )
    }
}
