package io.dtsoftware.facet.ui.home

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.Dates
import io.dtsoftware.facet.data.db.ConversationEntity
import io.dtsoftware.facet.data.db.FolderEntity
import io.dtsoftware.facet.data.repo.Assistant
import io.dtsoftware.facet.sync.AccountState
import io.dtsoftware.facet.sync.SyncPhase
import io.dtsoftware.facet.sync.SyncState
import io.dtsoftware.facet.sync.shownName
import io.dtsoftware.facet.ui.chat.MenuItem
import io.dtsoftware.facet.ui.components.AssistantAvatar
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.FacetIconButton
import io.dtsoftware.facet.ui.components.Gem
import io.dtsoftware.facet.ui.components.Hairline
import io.dtsoftware.facet.ui.components.UserAvatar
import io.dtsoftware.facet.ui.components.accent
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class DrawerState(
    val sections: List<Pair<String, List<ConversationEntity>>> = emptyList(),
    val folders: List<FolderEntity> = emptyList(),
    val folderFilter: String? = null,
    val active: Set<String> = emptySet(),
    val assistants: List<Assistant> = emptyList(),
    val isEmpty: Boolean = true,
)

class DrawerViewModel(private val c: AppContainer) : ViewModel() {
    private val folderFilter = MutableStateFlow<String?>(null)
    private val hidden = MutableStateFlow<Set<String>>(emptySet())

    val state: StateFlow<DrawerState> = combine(
        c.conversations.observeConversations(false),
        c.folders.observeAll(),
        folderFilter,
        // Section labels ("Today", "Pinned") are text: rebuild them when the language changes.
        combine(c.chat.active, hidden, Strings.language) { a, h, _ -> a to h },
        c.assistants.observeAll(),
    ) { convs, folders, filter, (active, hiddenIds), assistants ->
        val visible = convs.filter { it.id !in hiddenIds && (filter == null || it.folderId == filter) }
        val pinned = visible.filter { it.pinned }
        val rest = visible.filterNot { it.pinned }
        val sections = buildList {
            if (pinned.isNotEmpty()) add(Strings.get(R.string.drawer_section_pinned) to pinned)
            rest.groupBy { Dates.bucketLabel(it.lastActivityAt) }.forEach { (label, list) -> add(label to list) }
        }
        DrawerState(sections, folders, filter, active, assistants, convs.isEmpty())
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), DrawerState())

    fun setFolderFilter(id: String?) { folderFilter.value = id }

    fun hide(id: String) { hidden.value = hidden.value + id }
    fun unhide(id: String) { hidden.value = hidden.value - id }

    fun commitDelete(id: String) = viewModelScope.launch {
        c.chat.stop(id)
        c.conversations.delete(id)
        hidden.value = hidden.value - id
    }

    fun rename(id: String, title: String) = viewModelScope.launch { c.conversations.rename(id, title) }
    fun setPinned(id: String, pinned: Boolean) = viewModelScope.launch { c.conversations.setPinned(id, pinned) }
    fun archive(id: String) = viewModelScope.launch { c.conversations.setArchived(id, true) }
    fun moveToFolder(id: String, folderId: String?) = viewModelScope.launch { c.conversations.moveToFolder(id, folderId) }
    fun createFolder(name: String, colorIndex: Int) = viewModelScope.launch { c.folders.save(null, name, colorIndex) }
    fun deleteFolder(id: String) = viewModelScope.launch {
        if (folderFilter.value == id) folderFilter.value = null
        c.folders.delete(id)
    }
}

class DrawerCallbacks(
    val onOpen: (String) -> Unit,
    val onNewChat: (assistantId: String?) -> Unit,
    val onSearch: () -> Unit,
    val onSettings: () -> Unit,
    val onAccount: () -> Unit,
    val onArchive: () -> Unit,
    val onRename: (ConversationEntity) -> Unit,
    val onMove: (ConversationEntity) -> Unit,
    val onDelete: (ConversationEntity) -> Unit,
    val onNewFolder: () -> Unit,
    val onFolderMenu: (FolderEntity) -> Unit,
)

@Composable
fun DrawerContent(
    state: DrawerState,
    vm: DrawerViewModel,
    selectedId: String?,
    account: AccountState,
    sync: SyncState,
    callbacks: DrawerCallbacks,
    modifier: Modifier = Modifier,
    profileName: String = "",
) {
    val c = FacetTheme.colors
    Column(
        modifier
            .fillMaxHeight()
            .background(c.surface)
            .windowInsetsPadding(WindowInsets.statusBars)
            .windowInsetsPadding(WindowInsets.navigationBars),
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 10.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Gem(size = 24.dp)
            Spacer(Modifier.width(10.dp))
            Text("facet", style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.weight(1f))
            FacetIconButton(R.drawable.ic_new_chat, stringResource(R.string.shortcut_new_chat), { callbacks.onNewChat(null) })
        }
        Row(
            Modifier
                .padding(horizontal = 14.dp, vertical = 6.dp)
                .fillMaxWidth()
                .height(44.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(c.surfaceHigh)
                .clickable(onClick = callbacks.onSearch)
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FacetIcon(R.drawable.ic_search, null, tint = c.textTertiary, size = 18.dp)
            Spacer(Modifier.width(10.dp))
            Text(stringResource(R.string.drawer_search_chats), style = FacetTheme.type.body, color = c.textTertiary)
        }
        // Assistants: start a new chat with a persona.
        LazyRow(
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(state.assistants, key = { it.id }) { a ->
                Column(
                    Modifier
                        .width(62.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .clickable { callbacks.onNewChat(a.id) }
                        .padding(vertical = 6.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    AssistantAvatar(a, size = 38.dp)
                    Spacer(Modifier.height(5.dp))
                    Text(a.name, style = FacetTheme.type.labelS, color = c.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        if (state.folders.isNotEmpty() || !state.isEmpty) {
            val allChats = stringResource(R.string.drawer_all_chats)
            val newFolder = stringResource(R.string.drawer_new_folder)
            LazyRow(
                contentPadding = PaddingValues(horizontal = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.padding(bottom = 4.dp),
            ) {
                item(key = "all") { FolderChip(allChats, null, state.folderFilter == null, { vm.setFolderFilter(null) }, {}) }
                items(state.folders, key = { it.id }) { f ->
                    FolderChip(f.name, accent(f.colorIndex), state.folderFilter == f.id, { vm.setFolderFilter(if (state.folderFilter == f.id) null else f.id) }) {
                        callbacks.onFolderMenu(f)
                    }
                }
                item(key = "add") {
                    Box(
                        Modifier.height(32.dp).clip(FacetShapes.chip).border(1.dp, c.outlineVariant, FacetShapes.chip)
                            .clickable(onClick = callbacks.onNewFolder).padding(horizontal = 9.dp),
                        contentAlignment = Alignment.Center,
                    ) { FacetIcon(R.drawable.ic_folder_plus, newFolder, tint = c.textSecondary, size = 16.dp) }
                }
            }
        }

        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 12.dp)) {
            if (state.isEmpty) {
                item {
                    Text(
                        stringResource(R.string.drawer_empty),
                        style = FacetTheme.type.body, color = c.textTertiary,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 16.dp),
                    )
                }
            }
            state.sections.forEach { (label, list) ->
                item(key = "h/$label") {
                    Text(
                        label, style = FacetTheme.type.labelS, color = c.textTertiary,
                        modifier = Modifier.padding(start = 14.dp, top = 16.dp, bottom = 6.dp),
                    )
                }
                items(list, key = { it.id }) { conv ->
                    ConversationRow(
                        conv, selected = conv.id == selectedId, generating = conv.id in state.active,
                        onClick = { callbacks.onOpen(conv.id) },
                        onRename = { callbacks.onRename(conv) },
                        onPin = { vm.setPinned(conv.id, !conv.pinned) },
                        onMove = { callbacks.onMove(conv) },
                        onArchive = { vm.archive(conv.id) },
                        onDelete = { callbacks.onDelete(conv) },
                        modifier = Modifier.animateItem(),
                    )
                }
            }
            item(key = "archive") {
                Row(
                    Modifier.fillMaxWidth().padding(top = 12.dp).clip(RoundedCornerShape(12.dp)).clickable(onClick = callbacks.onArchive)
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    FacetIcon(R.drawable.ic_archive, null, tint = c.textTertiary, size = 17.dp)
                    Spacer(Modifier.width(12.dp))
                    Text(stringResource(R.string.drawer_archived_chats), style = FacetTheme.type.labelM, color = c.textSecondary)
                }
            }
        }
        Hairline(Modifier.fillMaxWidth())
        AccountFooter(account, sync, callbacks, profileName)
    }
}

@Composable
private fun FolderChip(name: String, color: Color?, selected: Boolean, onClick: () -> Unit, onLong: () -> Unit) {
    val c = FacetTheme.colors
    val bg by animateColorAsState(if (selected) c.surfaceHighest else Color.Transparent, label = "folderBg")
    Row(
        Modifier
            .height(32.dp)
            .clip(FacetShapes.chip)
            .background(bg)
            .border(1.dp, if (selected) c.surfaceHighest else c.outlineVariant, FacetShapes.chip)
            .combinedClickable(onClick = onClick, onLongClick = onLong)
            .padding(horizontal = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (color != null) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(color))
            Spacer(Modifier.width(7.dp))
        }
        Text(name, style = FacetTheme.type.labelM, color = if (selected) c.text else c.textSecondary, maxLines = 1)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConversationRow(
    conv: ConversationEntity,
    selected: Boolean,
    generating: Boolean,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onPin: () -> Unit,
    onMove: () -> Unit,
    onArchive: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = FacetTheme.colors
    val haptics = LocalHapticFeedback.current
    var menu by remember { mutableStateOf(false) }
    Box(modifier) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(if (selected) c.surfaceHigh else Color.Transparent)
                .combinedClickable(
                    onClick = onClick,
                    onLongClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        menu = true
                    },
                )
                .padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                conv.title.ifBlank { stringResource(R.string.common_untitled) },
                style = FacetTheme.type.body.copy(fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal),
                color = if (selected) c.text else c.text.copy(alpha = 0.88f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (generating) {
                Spacer(Modifier.width(8.dp))
                Gem(size = 14.dp, thinking = true)
            } else if (conv.pinned) {
                Spacer(Modifier.width(8.dp))
                FacetIcon(R.drawable.ic_pin, stringResource(R.string.drawer_pinned_icon), tint = c.textTertiary, size = 13.dp)
            }
        }
        DropdownMenu(menu, { menu = false }, containerColor = c.surfaceHigh, shape = RoundedCornerShape(16.dp)) {
            MenuItem(R.drawable.ic_edit, stringResource(R.string.action_rename)) { menu = false; onRename() }
            MenuItem(if (conv.pinned) R.drawable.ic_pin_off else R.drawable.ic_pin, stringResource(if (conv.pinned) R.string.action_unpin else R.string.action_pin)) { menu = false; onPin() }
            MenuItem(R.drawable.ic_folder, stringResource(R.string.drawer_move_to_folder)) { menu = false; onMove() }
            MenuItem(R.drawable.ic_archive, stringResource(R.string.drawer_archive)) { menu = false; onArchive() }
            MenuItem(R.drawable.ic_delete, stringResource(R.string.action_delete), danger = true) { menu = false; onDelete() }
        }
    }
}

@Composable
private fun AccountFooter(account: AccountState, sync: SyncState, callbacks: DrawerCallbacks, profileName: String) {
    val c = FacetTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.weight(1f).clip(RoundedCornerShape(14.dp)).clickable(onClick = callbacks.onAccount).padding(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when (account) {
                is AccountState.SignedIn -> {
                    UserAvatar(account.shownName(profileName), size = 34.dp)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(account.shownName(profileName), style = FacetTheme.type.labelL, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        SyncLine(sync)
                    }
                }
                else -> {
                    Box(Modifier.size(34.dp).clip(CircleShape).background(c.surfaceHigh), contentAlignment = Alignment.Center) {
                        FacetIcon(if (account is AccountState.Expired) R.drawable.ic_cloud_off else R.drawable.ic_user, null, tint = c.textSecondary, size = 18.dp)
                    }
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(if (account is AccountState.Expired) R.string.drawer_sign_in_again else R.string.drawer_sign_in_to_sync), style = FacetTheme.type.labelL, color = c.text)
                        Text(
                            stringResource(if (account is AccountState.Expired) R.string.drawer_sync_is_paused else R.string.drawer_local_only),
                            style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
                        )
                    }
                }
            }
        }
        FacetIconButton(R.drawable.ic_settings, stringResource(R.string.drawer_settings), callbacks.onSettings, tint = c.textSecondary)
    }
}

@Composable
private fun SyncLine(sync: SyncState) {
    val c = FacetTheme.colors
    val (dot, text) = when (sync.phase) {
        SyncPhase.SYNCING -> c.primary to stringResource(R.string.drawer_syncing)
        SyncPhase.IDLE -> c.success to when {
            sync.lastSyncAt <= 0 -> stringResource(R.string.drawer_synced)
            Dates.justNow(sync.lastSyncAt) -> stringResource(R.string.drawer_synced_just_now)
            else -> stringResource(R.string.drawer_synced_time, Dates.relative(sync.lastSyncAt))
        }
        SyncPhase.OFFLINE -> c.warning to stringResource(R.string.drawer_offline)
        SyncPhase.ERROR -> c.error to stringResource(R.string.drawer_sync_problem)
        SyncPhase.PAUSED -> c.warning to stringResource(R.string.drawer_sync_paused)
        SyncPhase.OFF -> c.textTertiary to stringResource(R.string.drawer_not_syncing)
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(dot))
        Spacer(Modifier.width(6.dp))
        Text(text, style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary, maxLines = 1)
    }
}
