package io.dtsoftware.facet.ui.chat

import android.Manifest
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.data.AttachmentRef
import io.dtsoftware.facet.data.db.PromptEntity
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.data.repo.Assistant
import io.dtsoftware.facet.data.repo.BuiltinAssistants
import io.dtsoftware.facet.ui.components.AssemblingGem
import io.dtsoftware.facet.ui.components.AssistantAvatar
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.FacetIconButton
import io.dtsoftware.facet.ui.components.Gem
import io.dtsoftware.facet.ui.components.ProviderBadge
import io.dtsoftware.facet.ui.components.TextInputDialog
import io.dtsoftware.facet.ui.components.ConfirmDialog
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme
import java.io.File
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

private sealed interface Sheet {
    data object ModelPicker : Sheet
    data class RegeneratePicker(val messageId: String) : Sheet
    data object Settings : Sheet
    data object Attach : Sheet
    data class Menu(val item: ThreadItem) : Sheet
    data class Usage(val item: ThreadItem) : Sheet
    data class Edit(val messageId: String, val text: String) : Sheet
    data class Select(val text: String) : Sheet
}

@Composable
fun ChatScreen(
    container: AppContainer,
    vm: ChatViewModel,
    showMenuButton: Boolean,
    onMenu: () -> Unit,
    onManageProviders: () -> Unit,
    onOpenAttachment: (AttachmentRef) -> Unit,
    prefill: PrefillRequest?,
    onPrefillConsumed: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val drafts by vm.attachments.collectAsStateWithLifecycle()
    val prefs by container.settings.local.collectAsStateWithLifecycle()
    val prompts by container.prompts.observeAll().collectAsStateWithLifecycle(emptyList())
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val speaker = rememberSpeaker()
    val voice = rememberVoiceInput()
    var input by remember { mutableStateOf(TextFieldValue("")) }
    var sheet by remember { mutableStateOf<Sheet?>(null) }
    var renameOpen by remember { mutableStateOf(false) }
    var deleteOpen by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    var anchorId by remember { mutableStateOf<String?>(null) }

    fun toast(text: String) = scope.launch { snackbar.currentSnackbarData?.dismiss(); snackbar.showSnackbar(text) }

    fun copy(text: String) {
        scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Facet", text))) }
        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        if (Build.VERSION.SDK_INT < 33) toast("Copied")
    }

    fun share(text: String) {
        val intent = Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, text) }
        context.startActivity(Intent.createChooser(intent, null))
    }

    // ---- launchers ----
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(6)) { uris ->
        if (uris.isNotEmpty()) vm.addAttachments(uris)
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) vm.addAttachments(uris)
    }
    var cameraUri by remember { mutableStateOf<Uri?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val uri = cameraUri
        if (ok && uri != null) vm.addAttachments(listOf(uri))
    }
    val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startVoice(voice, { input = appendText(input, it) }, { toast(it) }) else toast("Allow microphone access to dictate.")
    }

    fun onMic() {
        if (voice.listening) { voice.stop(); return }
        if (!voice.available) { toast("Speech recognition isn't available on this device."); return }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            startVoice(voice, { input = appendText(input, it) }, { toast(it) })
        } else {
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    // ---- events ----
    LaunchedEffect(vm) {
        vm.events.collect { e ->
            when (e) {
                is ChatEvent.Message -> toast(e.text)
                ChatEvent.Sent -> Unit
            }
        }
    }

    // Ask for notification permission once, after the first reply finishes, not mid-conversation start.
    var wasGenerating by remember { mutableStateOf(false) }
    LaunchedEffect(state.generating) {
        if (wasGenerating && !state.generating && Build.VERSION.SDK_INT >= 33 && !prefs.notificationsAsked && prefs.notifyOnComplete &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            container.settings.updateLocal { it.copy(notificationsAsked = true) }
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        wasGenerating = state.generating
    }

    LaunchedEffect(prefill) {
        val p = prefill ?: return@LaunchedEffect
        if (!p.text.isNullOrBlank()) input = TextFieldValue(p.text, TextRange(p.text.length))
        if (p.uris.isNotEmpty()) vm.addAttachments(p.uris)
        if (p.voice) onMic()
        onPrefillConsumed()
    }

    // When a conversation opens, jump to its end.
    val conversationId = state.conversation?.id
    LaunchedEffect(conversationId, state.loaded) {
        anchorId = null
        if (state.thread.isNotEmpty()) listState.scrollToItem(state.thread.lastIndex)
    }

    fun send() {
        val text = input.text
        if (vm.send(text)) {
            input = TextFieldValue("")
            speaker.stop()
        }
    }

    // After sending, anchor the new user message at the top of the viewport.
    val lastUserId = state.thread.lastOrNull { it.message.role == "user" }?.message?.id
    LaunchedEffect(vm) {
        vm.events.collectLatest { e -> if (e == ChatEvent.Sent) anchorId = "pending" }
    }
    LaunchedEffect(lastUserId, anchorId) {
        if (anchorId == "pending" && lastUserId != null) {
            anchorId = lastUserId
            val index = state.thread.indexOfFirst { it.message.id == lastUserId }
            if (index >= 0) listState.animateScrollToItem(index)
        }
    }

    Box(Modifier.fillMaxSize().background(FacetTheme.colors.background)) {
        Column(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars).only(WindowInsetsSides.Bottom)),
        ) {
            ChatTopBar(
                state = state,
                showMenuButton = showMenuButton,
                onMenu = onMenu,
                onModel = { sheet = Sheet.ModelPicker },
                onNewChat = { vm.newChat(); input = TextFieldValue("") },
                onSettings = { sheet = Sheet.Settings },
                onRename = { renameOpen = true },
                onPin = { vm.togglePin() },
                onExport = { vm.exportMarkdown()?.let(::share) },
                onDelete = { deleteOpen = true },
            )
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (state.thread.isEmpty()) {
                    if (state.loaded) {
                        EmptyChat(
                            state = state,
                            assistants = container.assistants.observeAll().collectAsStateWithLifecycle(BuiltinAssistants.all).value,
                            onPickAssistant = { vm.newChat(it) },
                            onStarter = { text -> input = TextFieldValue(text, TextRange(text.length)); send() },
                            onAddKey = onManageProviders,
                        )
                    }
                } else {
                    MessageList(
                        state = state,
                        listState = listState,
                        anchorId = anchorId,
                        prefsShowUsage = prefs.showUsage,
                        prefsShowCost = prefs.showCost,
                        expandThinking = prefs.expandThinking,
                        actions = MessageActions(
                            onCopy = ::copy,
                            onRegenerate = { vm.regenerate(it) },
                            onRegenerateWith = { sheet = Sheet.RegeneratePicker(it) },
                            onEdit = { id, text -> vm.edit(id, text) },
                            onSpeak = { id, text -> speaker.toggle(id, text) },
                            onShare = ::share,
                            onMore = { sheet = Sheet.Menu(it) },
                            onSwitchBranch = { vm.switchBranch(it) },
                            onContinue = { vm.continueReply() },
                            onUsage = { sheet = Sheet.Usage(it) },
                            onOpenAttachment = onOpenAttachment,
                            thumbnail = { id, px -> vm.thumbnail(id, px) },
                        ),
                    )
                    ScrollToBottom(listState, Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp)) {
                        scope.launch { listState.animateScrollToItem(listState.layoutInfo.totalItemsCount - 1) }
                    }
                }
                SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(horizontal = 16.dp, vertical = 8.dp)) { data ->
                    Snackbar(
                        data,
                        containerColor = FacetTheme.colors.surfaceHighest,
                        contentColor = FacetTheme.colors.text,
                        actionColor = FacetTheme.colors.primary,
                        shape = RoundedCornerShape(16.dp),
                    )
                }
            }
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Composer(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = if (state.assistant.id == BuiltinAssistants.DEFAULT_ID) "Ask anything" else "Message ${state.assistant.name}",
                    attachments = drafts,
                    onRemoveAttachment = vm::removeAttachment,
                    thumbnail = { id, px -> vm.thumbnail(id, px) },
                    caps = state.model?.model?.caps,
                    params = state.params,
                    onParams = vm::updateParams,
                    generating = state.generating,
                    onSend = ::send,
                    onStop = vm::stop,
                    onAttach = { sheet = Sheet.Attach },
                    voice = voice,
                    onMic = ::onMic,
                    prompts = prompts,
                    sendOnEnter = prefs.sendOnEnter,
                    modifier = Modifier.widthIn(max = 800.dp).padding(horizontal = 10.dp).padding(bottom = 8.dp),
                )
            }
        }
    }

    // ---- sheets & dialogs ----
    when (val s = sheet) {
        Sheet.ModelPicker, is Sheet.RegeneratePicker -> ModelPickerSheet(
            catalog = state.catalog,
            selected = state.model?.let { ModelRef(it.providerId, it.model.id) },
            onSelect = { ref ->
                if (s is Sheet.RegeneratePicker) vm.regenerate(s.messageId, ref) else vm.selectModel(ref)
                sheet = null
            },
            onToggleFavorite = { pid, mid -> scope.launch { container.providers.toggleFavorite(pid, mid) } },
            onManageProviders = { sheet = null; onManageProviders() },
            onRefresh = { pid ->
                scope.launch {
                    container.providers.refreshModels(pid).onFailure { toast(it.message ?: "Couldn't load models.") }
                }
            },
            onDismiss = { sheet = null },
        )
        Sheet.Settings -> ChatSettingsSheet(
            model = state.model,
            params = state.params,
            systemPrompt = state.conversation?.systemPrompt,
            canEditInstructions = state.conversation != null,
            onParams = vm::updateParams,
            onSystemPrompt = vm::setSystemPrompt,
            onChangeModel = { sheet = Sheet.ModelPicker },
            onMakeDefault = {
                val m = state.model
                container.settings.updateSynced {
                    it.copy(defaultParams = state.params, defaultModel = m?.let { c -> ModelRef(c.providerId, c.model.id) } ?: it.defaultModel)
                }
                toast("New chats will use these settings.")
            },
            onDismiss = { sheet = null },
        )
        Sheet.Attach -> MenuSheet(
            title = null,
            entries = listOf(
                MenuEntry(R.drawable.ic_camera, "Camera") {
                    val dir = File(context.cacheDir, "camera").apply { mkdirs() }
                    val file = File(dir, "photo-${System.currentTimeMillis()}.jpg")
                    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                    cameraUri = uri
                    camera.launch(uri)
                },
                MenuEntry(R.drawable.ic_image, "Photos") {
                    photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
                MenuEntry(R.drawable.ic_files, "Files") {
                    filePicker.launch(arrayOf("image/*", "application/pdf", "text/*", "application/json", "application/xml", "application/javascript"))
                },
            ),
            onDismiss = { sheet = null },
        )
        is Sheet.Menu -> {
            val m = s.item.message
            val entries = buildList {
                if (m.content.isNotBlank()) add(MenuEntry(R.drawable.ic_copy, "Copy") { copy(m.content) })
                if (m.content.isNotBlank()) add(MenuEntry(R.drawable.ic_select_text, "Select text") { sheet = Sheet.Select(m.content) })
                if (m.role == "user") {
                    add(MenuEntry(R.drawable.ic_edit, "Edit and resend") { sheet = Sheet.Edit(m.id, m.content) })
                } else {
                    add(MenuEntry(R.drawable.ic_regenerate, "Regenerate with another model") { sheet = Sheet.RegeneratePicker(m.id) })
                    if (m.content.isNotBlank()) {
                        add(MenuEntry(R.drawable.ic_speak, if (speaker.speakingId == m.id) "Stop reading" else "Read aloud") { speaker.toggle(m.id, m.content) })
                        add(MenuEntry(R.drawable.ic_share, "Share") { share(m.content) })
                    }
                    add(MenuEntry(R.drawable.ic_coins, "Usage and cost") { sheet = Sheet.Usage(s.item) })
                }
                add(MenuEntry(R.drawable.ic_delete, "Delete message", danger = true) { vm.deleteMessage(m) })
            }
            if (sheet is Sheet.Menu) MenuSheet(null, entries, onDismiss = { if (sheet is Sheet.Menu) sheet = null })
        }
        is Sheet.Usage -> UsageSheet(s.item) { sheet = null }
        is Sheet.Edit -> EditMessageSheet(s.text, onSave = { vm.edit(s.messageId, it) }, onDismiss = { sheet = null })
        is Sheet.Select -> SelectTextSheet(s.text) { sheet = null }
        null -> Unit
    }
    if (renameOpen) {
        TextInputDialog("Rename chat", state.conversation?.title.orEmpty(), "Rename", { vm.rename(it) }, { renameOpen = false })
    }
    if (deleteOpen) {
        ConfirmDialog(
            "Delete this chat?", "It will be removed from all your devices.", "Delete",
            onConfirm = { vm.deleteConversation() }, onDismiss = { deleteOpen = false }, danger = true,
        )
    }
}

data class PrefillRequest(val text: String?, val uris: List<Uri>, val voice: Boolean)

private fun appendText(current: TextFieldValue, addition: String): TextFieldValue {
    val base = current.text
    val sep = if (base.isEmpty() || base.endsWith(" ") || base.endsWith("\n")) "" else " "
    val next = base + sep + addition
    return TextFieldValue(next, TextRange(next.length))
}

private fun startVoice(voice: VoiceInput, onText: (String) -> Unit, onError: (String) -> Unit) = voice.start(onText, onError)

@Composable
private fun ChatTopBar(
    state: ChatUiState,
    showMenuButton: Boolean,
    onMenu: () -> Unit,
    onModel: () -> Unit,
    onNewChat: () -> Unit,
    onSettings: () -> Unit,
    onRename: () -> Unit,
    onPin: () -> Unit,
    onExport: () -> Unit,
    onDelete: () -> Unit,
) {
    val c = FacetTheme.colors
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.statusBars)
            .height(58.dp)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (showMenuButton) FacetIconButton(R.drawable.ic_menu, "Open chats", onMenu) else Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
        Row(
            Modifier
                .clip(RoundedCornerShape(14.dp))
                .clickable(onClick = onModel)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f, fill = false)) {
                Text(
                    state.model?.model?.displayName ?: "Choose a model",
                    style = FacetTheme.type.titleM, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                val sub = when {
                    state.assistant.id != BuiltinAssistants.DEFAULT_ID -> state.assistant.name + (state.model?.let { " · " + it.providerLabel } ?: "")
                    state.model != null -> state.model.providerLabel
                    else -> null
                }
                if (sub != null) Text(sub, style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(4.dp))
            FacetIcon(R.drawable.ic_chevron_down, null, tint = c.textSecondary, size = 18.dp)
        }
        }
        if (state.conversation != null) FacetIconButton(R.drawable.ic_new_chat, "New chat", onNewChat)
        FacetIconButton(R.drawable.ic_sliders, "Chat settings", onSettings)
        if (state.conversation != null) {
            Box {
                FacetIconButton(R.drawable.ic_more, "More", { menu = true })
                DropdownMenu(menu, { menu = false }, containerColor = c.surface, shape = RoundedCornerShape(16.dp)) {
                    MenuItem(R.drawable.ic_edit, "Rename") { menu = false; onRename() }
                    MenuItem(if (state.conversation.pinned) R.drawable.ic_pin_off else R.drawable.ic_pin, if (state.conversation.pinned) "Unpin" else "Pin") { menu = false; onPin() }
                    MenuItem(R.drawable.ic_share, "Share as Markdown") { menu = false; onExport() }
                    MenuItem(R.drawable.ic_delete, "Delete", danger = true) { menu = false; onDelete() }
                }
            }
        }
    }
}

@Composable
fun MenuItem(icon: Int, label: String, danger: Boolean = false, onClick: () -> Unit) {
    val c = FacetTheme.colors
    DropdownMenuItem(
        text = { Text(label, style = FacetTheme.type.labelL, color = if (danger) c.error else c.text) },
        leadingIcon = { FacetIcon(icon, null, tint = if (danger) c.error else c.textSecondary, size = 19.dp) },
        onClick = onClick,
    )
}

@Composable
private fun MessageList(
    state: ChatUiState,
    listState: LazyListState,
    anchorId: String?,
    prefsShowUsage: Boolean,
    prefsShowCost: Boolean,
    expandThinking: Boolean,
    actions: MessageActions,
) {
    val density = LocalDensity.current
    var viewport by remember { mutableIntStateOf(0) }
    val heights = remember { mutableStateMapOf<String, Int>() }
    val anchorIndex = state.thread.indexOfFirst { it.message.id == anchorId }
    val spacerPx by remember(anchorIndex, viewport) {
        derivedStateOf {
            if (anchorIndex < 0) 0 else {
                val used = state.thread.drop(anchorIndex).sumOf { heights[it.message.id] ?: 0 }
                (viewport - used - with(density) { 24.dp.roundToPx() }).coerceAtLeast(0)
            }
        }
    }
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().onSizeChanged { viewport = it.height },
        contentPadding = PaddingValues(top = 8.dp, bottom = 12.dp),
    ) {
        itemsIndexed(state.thread, key = { _, it -> it.message.id }, contentType = { _, it -> it.message.role }) { index, item ->
            val next = state.thread.getOrNull(index + 1)
            Box(
                Modifier
                    .fillMaxWidth()
                    .animateItem(fadeInSpec = tween(260), placementSpec = null, fadeOutSpec = null)
                    .onSizeChanged { heights[item.message.id] = it.height },
                contentAlignment = Alignment.TopCenter,
            ) {
                Box(Modifier.widthIn(max = 780.dp).fillMaxWidth().padding(horizontal = 18.dp)) {
                    if (item.message.role == "user") {
                        UserMessage(item, actions, Modifier.padding(top = if (index == 0) 4.dp else 6.dp, bottom = 18.dp))
                    } else {
                        AssistantMessage(
                            item, actions, prefsShowUsage, prefsShowCost, expandThinking,
                            isLast = next == null,
                            modifier = Modifier.padding(bottom = if (next == null) 4.dp else 22.dp),
                        )
                    }
                }
            }
        }
        item(key = "spacer") { Spacer(Modifier.height(with(density) { spacerPx.toDp() })) }
    }
}

@Composable
private fun ScrollToBottom(listState: LazyListState, modifier: Modifier, onClick: () -> Unit) {
    val show by remember { derivedStateOf { listState.canScrollForward && listState.layoutInfo.totalItemsCount > 0 && !nearBottom(listState) } }
    AnimatedVisibility(show, modifier = modifier, enter = fadeIn() + scaleIn(initialScale = 0.8f), exit = fadeOut() + scaleOut(targetScale = 0.8f)) {
        Box(
            Modifier
                .size(40.dp)
                .shadow(6.dp, CircleShape)
                .clip(CircleShape)
                .background(FacetTheme.colors.surfaceHighest)
                .border(1.dp, FacetTheme.colors.outline, CircleShape)
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            FacetIcon(R.drawable.ic_arrow_down, "Scroll to bottom", tint = FacetTheme.colors.text, size = 19.dp)
        }
    }
}

private fun nearBottom(state: LazyListState): Boolean {
    val info = state.layoutInfo
    val last = info.visibleItemsInfo.lastOrNull() ?: return true
    if (last.index < info.totalItemsCount - 2) return false
    // Visible through the last real message (the trailing spacer may extend further).
    val lastMessage = info.visibleItemsInfo.lastOrNull { it.key != "spacer" } ?: return true
    return lastMessage.index >= info.totalItemsCount - 2 && lastMessage.offset + lastMessage.size <= info.viewportEndOffset + 40
}

@Composable
private fun EmptyChat(
    state: ChatUiState,
    assistants: List<Assistant>,
    onPickAssistant: (String) -> Unit,
    onStarter: (String) -> Unit,
    onAddKey: () -> Unit,
) {
    val c = FacetTheme.colors
    Column(
        Modifier.fillMaxSize().padding(horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (state.catalog.isEmpty()) {
            AssemblingGem(size = 64.dp)
            Spacer(Modifier.height(24.dp))
            Text("Bring your own keys", style = FacetTheme.type.headline, color = c.text, textAlign = TextAlign.Center)
            Spacer(Modifier.height(10.dp))
            Text(
                "Add an API key from OpenAI, Anthropic, Google, OpenRouter or any OpenAI-compatible service. Your keys stay encrypted on your devices.",
                style = FacetTheme.type.body, color = c.textSecondary, textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 420.dp),
            )
            Spacer(Modifier.height(24.dp))
            FacetButton("Add an API key", onAddKey, icon = R.drawable.ic_key)
            return@Column
        }
        val a = state.assistant
        if (a.id == BuiltinAssistants.DEFAULT_ID) {
            Gem(size = 44.dp)
        } else {
            AssistantAvatar(a, size = 52.dp)
        }
        Spacer(Modifier.height(18.dp))
        Text(
            if (a.id == BuiltinAssistants.DEFAULT_ID) "What can I help with?" else a.name,
            style = FacetTheme.type.headline, color = c.text, textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        Column(Modifier.widthIn(max = 460.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            a.starters.take(4).forEach { s ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(FacetShapes.group)
                        .border(1.dp, c.outlineVariant, FacetShapes.group)
                        .clickable { onStarter(s) }
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(s, style = FacetTheme.type.body, color = c.text, modifier = Modifier.weight(1f))
                    FacetIcon(R.drawable.ic_arrow_up, null, tint = c.textTertiary, size = 16.dp)
                }
            }
        }
        Spacer(Modifier.height(22.dp))
        androidx.compose.foundation.lazy.LazyRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(horizontal = 4.dp),
        ) {
            items(assistants.size) { i ->
                val asst = assistants[i]
                val selected = asst.id == a.id
                Row(
                    Modifier
                        .clip(FacetShapes.pill)
                        .background(if (selected) c.surfaceHighest else androidx.compose.ui.graphics.Color.Transparent)
                        .border(1.dp, if (selected) c.surfaceHighest else c.outlineVariant, FacetShapes.pill)
                        .clickable { onPickAssistant(asst.id) }
                        .padding(start = 6.dp, end = 14.dp, top = 6.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AssistantAvatar(asst, size = 24.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(asst.name, style = FacetTheme.type.labelM, color = if (selected) c.text else c.textSecondary)
                }
            }
        }
        state.model?.let { m ->
            Spacer(Modifier.height(14.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                ProviderBadge(m.kind, size = 18.dp)
                Spacer(Modifier.width(6.dp))
                Text(m.model.displayName, style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary)
            }
        }
    }
}
