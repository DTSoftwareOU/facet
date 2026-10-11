package io.dtsoftware.facet.ui.chat

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.Dates
import io.dtsoftware.facet.remote.AgentSessionInfo
import io.dtsoftware.facet.remote.CodingAgent
import io.dtsoftware.facet.remote.FolderListing
import io.dtsoftware.facet.remote.FolderRef
import io.dtsoftware.facet.remote.RemoteException
import io.dtsoftware.facet.remote.RemoteHost
import io.dtsoftware.facet.remote.RemoteHosts
import io.dtsoftware.facet.remote.RemotePaths
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.FacetIconButton
import io.dtsoftware.facet.ui.components.FacetSheet
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SettingsRow
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlinx.coroutines.launch

// ---------------- PC chip ----------------

/**
 * Above the composer while a PC is online or the chat works on one: the chat's folder (or PC), muted
 * when that PC is offline or doesn't allow remote use. Tapping opens [PcSheet].
 */
@Composable
fun PcChip(pc: PcState, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = FacetTheme.colors
    val name = pc.name ?: stringResource(R.string.pcview_your_pc)
    val host = pc.host
    val (label, description) = when {
        !pc.usesPc -> stringResource(R.string.pcview_use_a_pc) to stringResource(R.string.pcview_use_a_pc_description)
        host == null -> stringResource(R.string.pcview_pc_offline, name) to stringResource(R.string.pcview_pc_offline_description, name)
        !host.remote -> stringResource(R.string.pcview_access_off, name) to RemoteHosts.turnOnHint(name)
        else -> {
            val folder = pc.workingFolder
            (folder?.let { RemotePaths.name(it) } ?: name) to
                (folder?.let { stringResource(R.string.pcview_working_in, it, name) } ?: stringResource(R.string.pcview_working_in_default, name))
        }
    }
    val chooseLabel = stringResource(R.string.pcview_choose_pc_or_folder)
    val active = pc.ready
    val muted = pc.usesPc && !pc.ready
    val bg by animateColorAsState(if (active) c.primaryContainer else Color.Transparent, label = "pcChipBg")
    val fg by animateColorAsState(
        when {
            active -> c.onPrimaryContainer
            muted -> c.textTertiary
            else -> c.textSecondary
        },
        label = "pcChipFg",
    )
    val border by animateColorAsState(if (active) c.primaryContainer else if (muted) c.outlineVariant else c.outline, label = "pcChipBorder")
    Row(
        modifier
            .height(32.dp)
            .widthIn(max = 260.dp)
            .clip(FacetShapes.chip)
            .background(bg)
            .border(1.dp, border, FacetShapes.chip)
            .clickable(role = Role.Button, onClickLabel = chooseLabel, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = description }
            .padding(start = 10.dp, end = 8.dp)
            .animateContentSize(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FacetIcon(if (pc.bound && host == null) R.drawable.ic_monitor_off else R.drawable.ic_monitor, null, tint = fg, size = 15.dp)
        Spacer(Modifier.width(6.dp))
        Text(label, style = FacetTheme.type.labelM, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Spacer(Modifier.width(2.dp))
        FacetIcon(R.drawable.ic_chevron_down, null, tint = fg, size = 14.dp)
    }
}

// ---------------- PC sheet ----------------

private sealed interface PcPage {
    data object Main : PcPage
    data class Folders(val host: RemoteHost) : PcPage
}

/**
 * Choose the chat's PC and folder, or none. [startWithFolders] opens straight on the folder browser (/folder).
 * [onBind] sets the chat's computerHost and computerFolder ([RemoteHosts.NO_PC] and null for "Don't use a PC").
 */
@Composable
fun PcSheet(
    remote: RemoteHosts,
    pc: PcState,
    modelCanUseTools: Boolean,
    toolsOn: Boolean,
    startWithFolders: Boolean,
    onBind: (hostId: String?, folder: String?) -> Unit,
    onTurnOnTools: () -> Unit,
    onDismiss: () -> Unit,
) {
    val initial = remember { pc.target?.takeIf { startWithFolders }?.let { PcPage.Folders(it) } ?: PcPage.Main }
    var page by remember { mutableStateOf(initial) }
    val reduced = FacetTheme.reducedMotion
    // Pages slide in reading direction: forward comes from the end side (the left in Arabic and Urdu).
    val endSign = if (LocalLayoutDirection.current == LayoutDirection.Rtl) -1 else 1
    FacetSheet(onDismiss) {
        AnimatedContent(
            page,
            transitionSpec = {
                if (reduced) {
                    fadeIn(tween(150)) togetherWith fadeOut(tween(150))
                } else {
                    val forward = targetState is PcPage.Folders
                    (slideInHorizontally(tween(280)) { w -> endSign * (if (forward) w / 4 else -w / 4) } + fadeIn(tween(220))) togetherWith
                        (slideOutHorizontally(tween(280)) { w -> endSign * (if (forward) -w / 4 else w / 4) } + fadeOut(tween(160)))
                }
            },
            label = "pcPage",
        ) { p ->
            when (p) {
                PcPage.Main -> PcMain(pc, modelCanUseTools, toolsOn, onBind, onTurnOnTools, onDismiss) { host -> page = PcPage.Folders(host) }
                is PcPage.Folders -> FolderBrowser(
                    remote = remote,
                    host = p.host,
                    onUse = { path ->
                        onBind(p.host.hostId, path)
                        onDismiss()
                    },
                    onBack = if (initial is PcPage.Main) ({ page = PcPage.Main }) else null,
                )
            }
        }
    }
}

@Composable
private fun PcMain(
    pc: PcState,
    modelCanUseTools: Boolean,
    toolsOn: Boolean,
    onBind: (String?, String?) -> Unit,
    onTurnOnTools: () -> Unit,
    onDismiss: () -> Unit,
    onBrowse: (RemoteHost) -> Unit,
) {
    val c = FacetTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp)
            .navigationBarsPadding()
            .padding(bottom = 20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Column(Modifier.padding(horizontal = 4.dp)) {
            Text(stringResource(R.string.pcview_your_pc), style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(4.dp))
            Text(
                stringResource(R.string.pcview_intro),
                style = FacetTheme.type.body, color = c.textSecondary,
            )
        }
        if (pc.ready && !modelCanUseTools) {
            Notice(stringResource(R.string.pcview_model_cant_use_tools))
        } else if (pc.ready && !toolsOn) {
            Notice(stringResource(R.string.pcview_tools_off), action = stringResource(R.string.pcview_turn_on) to onTurnOnTools)
        }

        // The online PCs, plus the chat's PC when it's offline.
        val offlineBound = pc.hostId?.takeIf { pc.bound && pc.host == null }
        SettingsGroup(title = stringResource(R.string.pcview_pcs)) {
            pc.hosts.forEachIndexed { i, h ->
                if (i > 0) GroupDivider()
                HostRow(
                    name = h.name,
                    status = when {
                        !h.remote -> RemoteHosts.turnOnHint(h.name)
                        h.os.isNotBlank() -> stringResource(R.string.pcview_online_os, h.os)
                        else -> stringResource(R.string.pcview_online)
                    },
                    selected = h.hostId == pc.host?.hostId,
                    online = true,
                    available = h.remote,
                    onClick = if (h.remote && !(pc.bound && h.hostId == pc.hostId)) ({ onBind(h.hostId, h.defaultFolder) }) else null,
                )
            }
            if (offlineBound != null) {
                if (pc.hosts.isNotEmpty()) GroupDivider()
                HostRow(pc.name ?: stringResource(R.string.pcview_your_pc), stringResource(R.string.pcview_offline_until_back), selected = true, online = false, available = false, onClick = null)
            }
        }

        if (pc.usesPc) {
            val folder = pc.workingFolder
            val host = pc.host?.takeIf { it.remote }
            SettingsGroup(title = stringResource(R.string.pcview_folder)) {
                SettingsRow(
                    title = folder?.let { RemotePaths.name(it) } ?: stringResource(R.string.pcview_no_folder),
                    subtitle = folder ?: stringResource(R.string.pcview_choose_where),
                    icon = R.drawable.ic_folder,
                    onClick = host?.let { h -> { onBrowse(h) } },
                    trailing = if (host != null) ({
                        FacetButton(
                            stringResource(R.string.pcview_change_folder), { onBrowse(host) }, style = ButtonStyle.Tonal,
                            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                        )
                    }) else null,
                    showChevron = false,
                )
            }
            SettingsGroup {
                SettingsRow(
                    stringResource(R.string.pcview_dont_use_pc), subtitle = stringResource(R.string.pcview_dont_use_pc_subtitle), icon = R.drawable.ic_monitor_off,
                    onClick = {
                        onBind(RemoteHosts.NO_PC, null)
                        onDismiss()
                    },
                    showChevron = false,
                )
            }
        }
    }
}

@Composable
private fun Notice(text: String, action: Pair<String, () -> Unit>? = null) {
    val c = FacetTheme.colors
    Row(
        Modifier.fillMaxWidth().clip(FacetShapes.group).background(c.warning.copy(alpha = 0.12f)).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FacetIcon(R.drawable.ic_alert, null, tint = c.warning, size = 18.dp)
        Spacer(Modifier.width(10.dp))
        Text(text, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.text, modifier = Modifier.weight(1f))
        action?.let { (label, onClick) ->
            Spacer(Modifier.width(8.dp))
            Text(
                label, style = FacetTheme.type.labelM, color = c.primary,
                modifier = Modifier.clip(FacetShapes.small).clickable(role = Role.Button, onClick = onClick).padding(6.dp),
            )
        }
    }
}

@Composable
private fun HostRow(name: String, status: String, selected: Boolean, online: Boolean, available: Boolean, onClick: (() -> Unit)?) {
    val c = FacetTheme.colors
    SettingsRow(
        title = name,
        subtitle = status,
        titleColor = if (available || selected) c.text else c.textSecondary,
        onClick = onClick,
        showChevron = false,
        leading = {
            Box(
                Modifier.size(36.dp).clip(CircleShape).background(if (selected && available) c.primaryContainer else c.surfaceHigh),
                contentAlignment = Alignment.Center,
            ) {
                FacetIcon(
                    if (online) R.drawable.ic_monitor else R.drawable.ic_monitor_off, null,
                    tint = if (selected && available) c.onPrimaryContainer else c.textSecondary, size = 18.dp,
                )
            }
        },
        trailing = if (selected) ({ FacetIcon(R.drawable.ic_check, stringResource(R.string.pcview_used_by_chat), tint = if (available) c.primary else c.textTertiary, size = 20.dp) }) else null,
    )
}

// ---------------- Folder browser ----------------

private sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Done<T>(val value: T) : Load<T>
    data class Failed(val message: String) : Load<Nothing>
}

/**
 * Browses folders on [host] with `files.list`: its places first (home, Desktop, drives, recent folders),
 * then breadcrumbs, the folders in the current one, and "Use this folder".
 */
@Composable
fun FolderBrowser(remote: RemoteHosts, host: RemoteHost, onUse: (String) -> Unit, onBack: (() -> Unit)?) {
    val c = FacetTheme.colors
    var path by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    var state by remember { mutableStateOf<Load<FolderListing>>(Load.Loading) }
    LaunchedEffect(path, retry) {
        state = Load.Loading
        state = try {
            Load.Done(remote.listFolders(host.hostId, path))
        } catch (e: RemoteException) {
            Load.Failed(if (e.code == RemoteException.NOT_FOUND) Strings.get(R.string.pcview_folder_gone) else e.message ?: Strings.get(R.string.pcview_folders_failed))
        }
    }
    Column(Modifier.fillMaxWidth().heightIn(min = 420.dp).navigationBarsPadding().padding(bottom = 12.dp)) {
        Row(Modifier.fillMaxWidth().padding(start = if (onBack != null) 4.dp else 20.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) FacetIconButton(R.drawable.ic_arrow_left, stringResource(R.string.action_back), onBack)
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.pcview_choose_folder), style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.semantics { heading() })
                Text(stringResource(R.string.pcview_on_pc, host.name), style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary)
            }
        }
        Spacer(Modifier.height(10.dp))
        Breadcrumbs(path, onNavigate = { path = it })
        Spacer(Modifier.height(6.dp))
        Box(Modifier.fillMaxWidth().height(340.dp)) {
            when (val s = state) {
                Load.Loading -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(Modifier.size(24.dp), color = c.primary, strokeWidth = 2.dp)
                    Spacer(Modifier.height(10.dp))
                    Text(stringResource(R.string.pcview_loading_folders), style = FacetTheme.type.labelM, color = c.textTertiary)
                }
                is Load.Failed -> ErrorState(s.message, Modifier.align(Alignment.Center)) { retry++ }
                is Load.Done -> {
                    val listing = s.value
                    val entries = if (path == null) listing.places else listing.folders
                    if (entries.isEmpty()) {
                        Text(
                            if (path == null) stringResource(R.string.pcview_no_places, host.name) else stringResource(R.string.pcview_no_folders),
                            style = FacetTheme.type.body, color = c.textTertiary, textAlign = TextAlign.Center,
                            modifier = Modifier.align(Alignment.Center).padding(24.dp),
                        )
                    } else {
                        LazyColumn(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
                            items(entries, key = { it.path }) { f ->
                                FolderRow(f, if (path == null) placeIcon(f, host) else R.drawable.ic_folder) { path = f.path }
                            }
                        }
                    }
                }
            }
        }
        val current = path
        if (current != null) {
            FacetButton(
                stringResource(R.string.pcview_use_folder), { onUse(current) }, icon = R.drawable.ic_check,
                enabled = state is Load.Done,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
        } else {
            Text(
                stringResource(R.string.pcview_pick_place),
                style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            )
        }
    }
}

@Composable
private fun Breadcrumbs(path: String?, onNavigate: (String?) -> Unit) {
    val c = FacetTheme.colors
    val crumbs = path?.let { RemotePaths.crumbs(it) }.orEmpty()
    val scroll = rememberScrollState()
    LaunchedEffect(path) { scroll.animateScrollTo(scroll.maxValue) }
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        val up = crumbs.dropLast(1).lastOrNull()?.second
        FacetIconButton(
            R.drawable.ic_corner_left_up, stringResource(R.string.pcview_up_one_folder), { onNavigate(up) },
            enabled = path != null, tint = c.textSecondary, size = 18.dp,
        )
        Row(Modifier.weight(1f).horizontalScroll(scroll), verticalAlignment = Alignment.CenterVertically) {
            Crumb(stringResource(R.string.pcview_places), current = path == null) { onNavigate(null) }
            crumbs.forEachIndexed { i, (label, p) ->
                FacetIcon(R.drawable.ic_chevron_right, null, tint = c.textTertiary, size = 14.dp)
                Crumb(label, current = i == crumbs.lastIndex) { onNavigate(p) }
            }
        }
    }
}

@Composable
private fun Crumb(label: String, current: Boolean, onClick: () -> Unit) {
    val c = FacetTheme.colors
    Text(
        label,
        style = FacetTheme.type.labelM,
        color = if (current) c.text else c.primary,
        maxLines = 1,
        modifier = Modifier
            .clip(FacetShapes.small)
            .clickable(enabled = !current, role = Role.Button, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 8.dp),
    )
}

@Composable
private fun FolderRow(f: FolderRef, icon: Int, onClick: () -> Unit) {
    val c = FacetTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(FacetShapes.chip)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FacetIcon(icon, null, tint = c.textSecondary, size = 20.dp)
        Spacer(Modifier.width(14.dp))
        Text(f.name.ifBlank { f.path }, style = FacetTheme.type.labelL, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        FacetIcon(R.drawable.ic_chevron_right, null, tint = c.textTertiary, size = 16.dp)
    }
}

private val drivePath = Regex("^[A-Za-z]:[\\\\/]?$")

/** Icons for places: home, Desktop, Documents, Downloads, drives and recent chat folders. */
private fun placeIcon(f: FolderRef, host: RemoteHost): Int {
    val name = f.name.lowercase()
    return when {
        drivePath.matches(f.path) -> R.drawable.ic_hard_drive
        host.home != null && f.path.trimEnd('\\', '/').equals(host.home.trimEnd('\\', '/'), ignoreCase = true) -> R.drawable.ic_home
        name == "desktop" -> R.drawable.ic_monitor
        name == "documents" -> R.drawable.ic_file_text
        name == "downloads" -> R.drawable.ic_download
        host.recentFolders.any { it.equals(f.path, ignoreCase = true) } -> R.drawable.ic_history
        else -> R.drawable.ic_folder
    }
}

@Composable
private fun ErrorState(message: String, modifier: Modifier = Modifier, onRetry: () -> Unit) {
    val c = FacetTheme.colors
    Column(modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        FacetIcon(R.drawable.ic_alert, null, tint = c.error, size = 22.dp)
        Spacer(Modifier.height(10.dp))
        Text(message, style = FacetTheme.type.body, color = c.textSecondary, textAlign = TextAlign.Center)
        Spacer(Modifier.height(14.dp))
        FacetButton(stringResource(R.string.action_try_again), onRetry, style = ButtonStyle.Tonal)
    }
}

// ---------------- Continue a Claude Code or Codex session ----------------

private sealed interface ResumePage {
    data object Sessions : ResumePage
    data object Folders : ResumePage
}

/**
 * Lists [agent]'s sessions in [folder] on [host] (`agents.list`); picking one continues it in a new chat
 * ([onContinue] reads it and opens the chat). "Change" picks another folder for this chat first.
 */
@Composable
fun ResumeSheet(
    remote: RemoteHosts,
    agent: CodingAgent,
    host: RemoteHost,
    folder: String?,
    onFolder: (String) -> Unit,
    onContinue: suspend (AgentSessionInfo, String) -> Unit,
    onDismiss: () -> Unit,
) {
    var page by remember { mutableStateOf<ResumePage>(if (folder == null) ResumePage.Folders else ResumePage.Sessions) }
    // The folder being listed; picking another one also becomes the chat's folder.
    var current by remember { mutableStateOf(folder) }
    val reduced = FacetTheme.reducedMotion
    // Pages slide in reading direction: forward comes from the end side (the left in Arabic and Urdu).
    val endSign = if (LocalLayoutDirection.current == LayoutDirection.Rtl) -1 else 1
    FacetSheet(onDismiss) {
        AnimatedContent(
            page,
            transitionSpec = {
                if (reduced) fadeIn(tween(150)) togetherWith fadeOut(tween(150))
                else {
                    val forward = targetState is ResumePage.Folders
                    (slideInHorizontally(tween(280)) { w -> endSign * (if (forward) w / 4 else -w / 4) } + fadeIn(tween(220))) togetherWith
                        (slideOutHorizontally(tween(280)) { w -> endSign * (if (forward) -w / 4 else w / 4) } + fadeOut(tween(160)))
                }
            },
            label = "resumePage",
        ) { p ->
            when (p) {
                ResumePage.Folders -> FolderBrowser(
                    remote, host,
                    onUse = { path ->
                        current = path
                        onFolder(path)
                        page = ResumePage.Sessions
                    },
                    onBack = if (current != null) ({ page = ResumePage.Sessions }) else null,
                )
                ResumePage.Sessions -> current?.let { f ->
                    SessionList(remote, agent, host, f, onChangeFolder = { page = ResumePage.Folders }, onContinue = onContinue)
                }
            }
        }
    }
}

@Composable
private fun SessionList(
    remote: RemoteHosts,
    agent: CodingAgent,
    host: RemoteHost,
    folder: String,
    onChangeFolder: () -> Unit,
    onContinue: suspend (AgentSessionInfo, String) -> Unit,
) {
    val c = FacetTheme.colors
    val scope = rememberCoroutineScope()
    var retry by remember { mutableIntStateOf(0) }
    var state by remember { mutableStateOf<Load<List<AgentSessionInfo>>>(Load.Loading) }
    var opening by remember { mutableStateOf<String?>(null) }
    var openError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(folder, retry) {
        state = Load.Loading
        state = try {
            Load.Done(remote.listAgentSessions(host.hostId, agent.id, folder))
        } catch (e: RemoteException) {
            Load.Failed(e.message ?: Strings.get(R.string.pcview_sessions_failed))
        }
    }
    Column(Modifier.fillMaxWidth().heightIn(min = 420.dp).navigationBarsPadding().padding(bottom = 16.dp)) {
        Column(Modifier.padding(horizontal = 20.dp)) {
            Text(stringResource(R.string.pcview_continue_session_title, agent.displayName), style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.semantics { heading() })
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                FacetIcon(R.drawable.ic_folder, null, tint = c.textSecondary, size = 16.dp)
                Spacer(Modifier.width(8.dp))
                Text(
                    stringResource(R.string.pcview_folder_on_pc, RemotePaths.name(folder), host.name),
                    style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                Text(
                    stringResource(R.string.pcview_change), style = FacetTheme.type.labelM, color = c.primary,
                    modifier = Modifier.clip(FacetShapes.small)
                        .clickable(role = Role.Button, onClickLabel = stringResource(R.string.pcview_change_folder), onClick = onChangeFolder)
                        .padding(8.dp),
                )
            }
        }
        openError?.let {
            Text(
                it, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.error,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
            )
        }
        Box(Modifier.fillMaxWidth().height(380.dp)) {
            when (val s = state) {
                Load.Loading -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(Modifier.size(24.dp), color = c.primary, strokeWidth = 2.dp)
                    Spacer(Modifier.height(10.dp))
                    Text(stringResource(R.string.pcview_looking_for_sessions), style = FacetTheme.type.labelM, color = c.textTertiary)
                }
                is Load.Failed -> ErrorState(s.message, Modifier.align(Alignment.Center)) { retry++ }
                is Load.Done -> if (s.value.isEmpty()) {
                    Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        FacetIcon(R.drawable.ic_terminal, null, tint = c.textTertiary, size = 24.dp)
                        Spacer(Modifier.height(10.dp))
                        Text(
                            stringResource(R.string.pcview_no_sessions, agent.displayName, RemotePaths.name(folder)),
                            style = FacetTheme.type.body, color = c.textSecondary, textAlign = TextAlign.Center,
                        )
                        Spacer(Modifier.height(14.dp))
                        FacetButton(stringResource(R.string.pcview_choose_another_folder), onChangeFolder, style = ButtonStyle.Tonal)
                    }
                } else {
                    LazyColumn(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 6.dp)) {
                        items(s.value, key = { it.id }) { session ->
                            SessionRow(session, busy = opening == session.id, enabled = opening == null) {
                                opening = session.id
                                openError = null
                                scope.launch {
                                    try {
                                        onContinue(session, folder)
                                    } catch (e: RemoteException) {
                                        openError = e.message ?: Strings.get(R.string.pcview_session_read_failed)
                                    } catch (e: IllegalArgumentException) {
                                        openError = e.message ?: Strings.get(R.string.pcview_session_read_failed)
                                    } finally {
                                        opening = null
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionRow(s: AgentSessionInfo, busy: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = FacetTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(FacetShapes.chip)
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = stringResource(R.string.pcview_continue_this_session), onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(s.title.ifBlank { stringResource(R.string.pcview_untitled_session) }, style = FacetTheme.type.labelL, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(2.dp))
            val count = pluralStringResource(R.plurals.pcview_message_count, s.messageCount, s.messageCount)
            Text(
                listOfNotNull(s.updatedAt.takeIf { it > 0 }?.let { Dates.relative(it) }, count).joinToString(" · "),
                style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
            )
        }
        Spacer(Modifier.width(10.dp))
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), color = c.primary, strokeWidth = 2.dp)
        } else {
            FacetIcon(R.drawable.ic_chevron_right, null, tint = c.textTertiary, size = 16.dp)
        }
    }
}
