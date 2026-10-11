package io.dtsoftware.facet.ui.settings

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
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
internal fun ToolApproval.pcLabel() = when (this) {
    ToolApproval.ALWAYS -> "Every action"
    ToolApproval.WRITES -> "Changes"
    ToolApproval.NEVER -> "Never"
}

private fun ToolApproval.pcBlurb() = when (this) {
    ToolApproval.ALWAYS -> "Ask before every command and every file the model reads or changes."
    ToolApproval.WRITES -> "Ask before commands and file changes. Reading and searching files runs without asking."
    ToolApproval.NEVER -> "Run everything on your PC without asking."
}

/** The "Your PC" row's subtitle in Settings: which PCs are online. */
@Composable
internal fun pcSubtitle(container: AppContainer): String {
    val hosts by container.remote.hosts.collectAsStateWithLifecycle()
    val list = hosts.values.toList()
    return when (list.size) {
        0 -> "Use Facet for Windows from this device"
        1 -> "${list[0].name} is online"
        else -> "${list.size} PCs online"
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
    SettingsPage("Your PC", onBack) {
        Intro(
            "While Facet for Windows runs on your PC, chats here can run commands and edit files in a folder there, and continue " +
                "Claude Code and Codex sessions. Messages between your devices are end-to-end encrypted.",
        )
        SettingsGroup(title = "Online now") {
            val list = hosts.values.sortedBy { it.name.lowercase() }
            when {
                account !is AccountState.SignedIn -> SettingsRow(
                    "Sign in to use your PC", subtitle = "Your PC and this device need the same Facet account.",
                    icon = R.drawable.ic_monitor, showChevron = false,
                )
                list.isEmpty() -> SettingsRow(
                    "No PC is online", subtitle = "Open Facet on your PC and sign in with this account.",
                    icon = R.drawable.ic_monitor_off, showChevron = false,
                )
                else -> list.forEachIndexed { i, h ->
                    if (i > 0) GroupDivider()
                    SettingsRow(
                        h.name,
                        subtitle = if (h.remote) listOf("Ready", h.os).filter { it.isNotBlank() }.joinToString(" · ") else RemoteHosts.turnOnHint(h.name),
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
            Text("Ask before", style = FacetTheme.type.labelM, color = c.textTertiary, modifier = Modifier.padding(start = 12.dp, bottom = 8.dp))
            Segmented(
                ToolApproval.entries, local.pcApproval, { it.pcLabel() },
                { a -> container.settings.updateLocal { it.copy(pcApproval = a) } },
            )
            Text(
                if (synced.yoloMode) "YOLO mode is on, so actions on your PC run without asking. Turn it off in Settings to use this." else local.pcApproval.pcBlurb(),
                style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal),
                color = if (synced.yoloMode) c.warning else c.textTertiary,
                modifier = Modifier.padding(start = 12.dp, top = 6.dp),
            )
        }
        Text(
            "To pick a PC and folder for a chat, tap the PC chip above the message box, or type /pc.",
            style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
            modifier = Modifier.padding(horizontal = 12.dp),
        )
    }
}
