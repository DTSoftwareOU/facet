package io.dtsoftware.facet.ui.home

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.data.AttachmentRef
import io.dtsoftware.facet.data.db.ConversationEntity
import io.dtsoftware.facet.data.db.FolderEntity
import io.dtsoftware.facet.ui.LaunchRequest
import io.dtsoftware.facet.ui.chat.ChatScreen
import io.dtsoftware.facet.ui.chat.ChatViewModel
import io.dtsoftware.facet.ui.chat.MenuEntry
import io.dtsoftware.facet.ui.chat.MenuSheet
import io.dtsoftware.facet.ui.chat.PrefillRequest
import io.dtsoftware.facet.ui.components.AccentChoices
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.ConfirmDialog
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIconButton
import io.dtsoftware.facet.ui.components.FacetSheet
import io.dtsoftware.facet.ui.components.FacetTextField
import io.dtsoftware.facet.ui.components.TextInputDialog
import io.dtsoftware.facet.ui.components.accent
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

@Composable
fun HomeScreen(
    container: AppContainer,
    launchRequests: MutableStateFlow<LaunchRequest?>,
    onSearch: () -> Unit,
    onSettings: () -> Unit,
    onAccount: () -> Unit,
    onArchive: () -> Unit,
    onProviders: () -> Unit,
) {
    val vm: ChatViewModel = viewModel { ChatViewModel(container) }
    val drawerVm: DrawerViewModel = viewModel { DrawerViewModel(container) }
    val drawerState by drawerVm.state.collectAsStateWithLifecycle()
    val account by container.auth.state.collectAsStateWithLifecycle()
    val sync by container.sync.state.collectAsStateWithLifecycle()
    val synced by container.settings.synced.collectAsStateWithLifecycle()
    val currentId by vm.currentId.collectAsStateWithLifecycle()
    val wide = LocalConfiguration.current.screenWidthDp >= 840
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val context = LocalContext.current

    var prefill by remember { mutableStateOf<PrefillRequest?>(null) }
    var renameTarget by remember { mutableStateOf<ConversationEntity?>(null) }
    var moveTarget by remember { mutableStateOf<ConversationEntity?>(null) }
    var newFolder by remember { mutableStateOf(false) }
    var folderMenu by remember { mutableStateOf<FolderEntity?>(null) }
    var deleteFolder by remember { mutableStateOf<FolderEntity?>(null) }
    var viewer by remember { mutableStateOf<AttachmentRef?>(null) }

    val pending by launchRequests.collectAsStateWithLifecycle()
    LaunchedEffect(pending) {
        when (val r = pending) {
            is LaunchRequest.OpenConversation -> vm.open(r.id)
            is LaunchRequest.NewChat -> { vm.newChat(); prefill = PrefillRequest(null, emptyList(), r.voice) }
            is LaunchRequest.Share -> { vm.newChat(); prefill = PrefillRequest(r.text, r.uris, false) }
            is LaunchRequest.McpOAuth, null -> Unit
        }
        if (pending != null && pending !is LaunchRequest.McpOAuth) {
            launchRequests.value = null
            drawer.close()
        }
    }

    fun closeDrawer() = scope.launch { drawer.close() }

    fun openAttachment(ref: AttachmentRef) {
        scope.launch {
            if (!container.sync.ensureLocal(ref.id)) {
                snackbar.showSnackbar("This file isn't on this device yet.")
                return@launch
            }
            if (ref.kind == "image") {
                viewer = ref
            } else {
                val a = container.attachments.get(ref.id) ?: return@launch
                val file = container.attachments.file(a) ?: return@launch
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, a.mimeType)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                runCatching { context.startActivity(Intent.createChooser(intent, a.name)) }
            }
        }
    }

    val callbacks = DrawerCallbacks(
        onOpen = { vm.open(it); closeDrawer() },
        onNewChat = { vm.newChat(it); closeDrawer() },
        onSearch = { closeDrawer(); onSearch() },
        onSettings = { closeDrawer(); onSettings() },
        onAccount = { closeDrawer(); onAccount() },
        onArchive = { closeDrawer(); onArchive() },
        onRename = { renameTarget = it },
        onMove = { moveTarget = it },
        onDelete = { conv ->
            drawerVm.hide(conv.id)
            if (conv.id == currentId) vm.newChat()
            scope.launch {
                val result = snackbar.showSnackbar("Chat deleted", actionLabel = "Undo", duration = SnackbarDuration.Short)
                if (result == SnackbarResult.ActionPerformed) drawerVm.unhide(conv.id) else drawerVm.commitDelete(conv.id)
            }
        },
        onNewFolder = { newFolder = true },
        onFolderMenu = { folderMenu = it },
    )

    val drawerContent: @Composable () -> Unit = {
        DrawerContent(drawerState, drawerVm, currentId, account, sync, callbacks, profileName = synced.profileName)
    }
    val chat: @Composable () -> Unit = {
        ChatScreen(
            container = container,
            vm = vm,
            showMenuButton = !wide,
            onMenu = { scope.launch { drawer.open() } },
            onManageProviders = onProviders,
            onOpenAttachment = ::openAttachment,
            prefill = prefill,
            onPrefillConsumed = { prefill = null },
        )
    }

    Box(Modifier.fillMaxSize()) {
        if (wide) {
            Row(Modifier.fillMaxSize()) {
                Box(Modifier.width(320.dp)) { drawerContent() }
                Box(Modifier.weight(1f)) { chat() }
            }
        } else {
            BackHandler(drawer.isOpen) { closeDrawer() }
            ModalNavigationDrawer(
                drawerState = drawer,
                scrimColor = FacetTheme.colors.scrim,
                drawerContent = {
                    ModalDrawerSheet(
                        drawerContainerColor = FacetTheme.colors.surface,
                        drawerShape = androidx.compose.foundation.shape.RoundedCornerShape(topEnd = 24.dp, bottomEnd = 24.dp),
                        modifier = Modifier.width(318.dp),
                        windowInsets = androidx.compose.foundation.layout.WindowInsets(0),
                    ) { drawerContent() }
                },
            ) { chat() }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(16.dp)) { data ->
            Snackbar(
                data,
                containerColor = FacetTheme.colors.surfaceHighest,
                contentColor = FacetTheme.colors.text,
                actionColor = FacetTheme.colors.primary,
                shape = androidx.compose.foundation.shape.RoundedCornerShape(16.dp),
            )
        }
    }

    renameTarget?.let { conv ->
        TextInputDialog("Rename chat", conv.title, "Rename", { drawerVm.rename(conv.id, it) }, { renameTarget = null })
    }
    moveTarget?.let { conv ->
        MenuSheet(
            title = "Move “${conv.title}” to",
            entries = buildList {
                add(MenuEntry(R.drawable.ic_messages, "No folder") { drawerVm.moveToFolder(conv.id, null) })
                drawerState.folders.forEach { f -> add(MenuEntry(R.drawable.ic_folder, f.name) { drawerVm.moveToFolder(conv.id, f.id) }) }
                add(MenuEntry(R.drawable.ic_folder_plus, "New folder…") { newFolder = true })
            },
            onDismiss = { moveTarget = null },
        )
    }
    if (newFolder) {
        NewFolderSheet(onCreate = { name, color -> drawerVm.createFolder(name, color) }, onDismiss = { newFolder = false })
    }
    folderMenu?.let { f ->
        MenuSheet(
            title = f.name,
            entries = listOf(MenuEntry(R.drawable.ic_delete, "Delete folder", danger = true) { deleteFolder = f }),
            onDismiss = { folderMenu = null },
        )
    }
    deleteFolder?.let { f ->
        ConfirmDialog(
            "Delete “${f.name}”?", "Chats in this folder are kept and move to All chats.", "Delete folder",
            onConfirm = { drawerVm.deleteFolder(f.id) }, onDismiss = { deleteFolder = null }, danger = true,
        )
    }
    viewer?.let { ref -> ImageViewer(container, ref) { viewer = null } }
}

@Composable
private fun NewFolderSheet(onCreate: (String, Int) -> Unit, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var color by remember { mutableStateOf(0) }
    FacetSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).navigationBarsPadding().padding(bottom = 16.dp)) {
            Text("New folder", style = FacetTheme.type.titleL, color = FacetTheme.colors.text, modifier = Modifier.padding(bottom = 16.dp))
            FacetTextField(name, { name = it }, placeholder = "Folder name")
            Spacer(Modifier.height(16.dp))
            Row {
                AccentChoices.indices.forEach { i ->
                    Box(
                        Modifier.padding(end = 10.dp).size(30.dp).clip(CircleShape).background(accent(i)).clickable { color = i },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (color == i) Box(Modifier.size(10.dp).clip(CircleShape).background(Color.White))
                    }
                }
            }
            Spacer(Modifier.height(20.dp))
            Row {
                FacetButton("Cancel", onDismiss, style = ButtonStyle.Tonal, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(10.dp))
                FacetButton("Create folder", { onCreate(name, color); onDismiss() }, enabled = name.isNotBlank(), modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun ImageViewer(container: AppContainer, ref: AttachmentRef, onDismiss: () -> Unit) {
    val bmp by produceState<ImageBitmap?>(null, ref.id) { value = container.attachments.thumbnail(ref.id, 2400) }
    var scale by remember { mutableFloatStateOf(1f) }
    var ox by remember { mutableFloatStateOf(0f) }
    var oy by remember { mutableFloatStateOf(0f) }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        scale = (scale * zoom).coerceIn(1f, 6f)
                        if (scale > 1f) { ox += pan.x; oy += pan.y } else { ox = 0f; oy = 0f }
                    }
                },
        ) {
            bmp?.let {
                Image(
                    it, ref.name, contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().graphicsLayer(scaleX = scale, scaleY = scale, translationX = ox, translationY = oy),
                )
            }
            FacetIconButton(
                R.drawable.ic_close, "Close", onDismiss, tint = Color.White,
                modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(8.dp),
                background = Color(0x66000000),
            )
        }
    }
}
