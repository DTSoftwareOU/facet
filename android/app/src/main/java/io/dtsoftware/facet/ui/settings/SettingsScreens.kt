package io.dtsoftware.facet.ui.settings

import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.BuildConfig
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.util.Format
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.sync.AccountState
import io.dtsoftware.facet.sync.shownName
import io.dtsoftware.facet.ui.Routes
import io.dtsoftware.facet.ui.chat.ModelPickerSheet
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.ConfirmDialog
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.FacetTextField
import io.dtsoftware.facet.ui.components.FacetTopBar
import io.dtsoftware.facet.ui.components.Gem
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SettingsRow
import io.dtsoftware.facet.ui.components.SwitchRow
import io.dtsoftware.facet.ui.components.UserAvatar
import io.dtsoftware.facet.ui.lock.DeviceAuth
import io.dtsoftware.facet.ui.theme.BasaltColors
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.ui.theme.ObsidianColors
import io.dtsoftware.facet.ui.theme.QuartzColors
import io.dtsoftware.facet.ui.theme.ThemeMode
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Scrollable settings page with a top bar. */
@Composable
fun SettingsPage(title: String, onBack: () -> Unit, subtitle: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().background(FacetTheme.colors.background)) {
        FacetTopBar(title, subtitle = subtitle, onNav = onBack)
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier
                    .widthIn(max = 720.dp)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp)
                    .padding(top = 4.dp, bottom = 32.dp)
                    .navigationBarsPadding()
                    .imePadding(),
                verticalArrangement = Arrangement.spacedBy(20.dp),
                content = content,
            )
        }
    }
}

@Composable
fun SettingsScreen(container: AppContainer, onBack: () -> Unit, navigate: (Any) -> Unit) {
    val account by container.auth.state.collectAsStateWithLifecycle()
    val providers by container.providers.observeAll().collectAsStateWithLifecycle(emptyList())
    val synced by container.settings.synced.collectAsStateWithLifecycle()
    val c = FacetTheme.colors
    SettingsPage("Settings", onBack) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(FacetShapes.group)
                .background(c.surface)
                .clickable { navigate(Routes.Account) }
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when (val a = account) {
                is AccountState.SignedIn -> {
                    UserAvatar(a.shownName(synced.profileName), size = 48.dp)
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(a.shownName(synced.profileName), style = FacetTheme.type.titleM, color = c.text)
                        Text(a.email, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary)
                    }
                    FacetIcon(R.drawable.ic_shield, "End-to-end encrypted", tint = c.primary, size = 20.dp)
                }
                else -> {
                    Box(Modifier.size(48.dp).clip(CircleShape).background(c.primaryContainer), contentAlignment = Alignment.Center) {
                        FacetIcon(R.drawable.ic_cloud, null, tint = c.onPrimaryContainer, size = 22.dp)
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(if (a is AccountState.Expired) "Sign in again" else "Sync across devices", style = FacetTheme.type.titleM, color = c.text)
                        Text(
                            "End-to-end encrypted. Free and open source.",
                            style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary,
                        )
                    }
                    FacetIcon(R.drawable.ic_chevron_right, null, tint = c.textTertiary, size = 18.dp)
                }
            }
        }
        SettingsGroup {
            SettingsRow(
                "Providers and keys", subtitle = if (providers.isEmpty()) "Add your first API key" else "${providers.size} connected",
                icon = R.drawable.ic_key, onClick = { navigate(Routes.Providers) },
            )
            GroupDivider()
            SettingsRow("Assistants", subtitle = "Personas with their own instructions and model", icon = R.drawable.ic_bot, onClick = { navigate(Routes.Assistants) })
            GroupDivider()
            SettingsRow("Prompt library", subtitle = "Type / in a message to insert", icon = R.drawable.ic_library, onClick = { navigate(Routes.Prompts) })
            GroupDivider()
            SettingsRow("Chat", subtitle = "Custom instructions, defaults, titles", icon = R.drawable.ic_message, onClick = { navigate(Routes.ChatPrefs) })
        }
        SettingsGroup {
            SettingsRow("Appearance", icon = R.drawable.ic_palette, onClick = { navigate(Routes.Appearance) })
            GroupDivider()
            SettingsRow("Privacy and security", icon = R.drawable.ic_shield, onClick = { navigate(Routes.Privacy) })
            GroupDivider()
            SettingsRow("Data and storage", icon = R.drawable.ic_server, onClick = { navigate(Routes.Data) })
        }
        SettingsGroup {
            SettingsRow("About Facet", subtitle = "Version ${BuildConfig.VERSION_NAME}", icon = R.drawable.ic_info, onClick = { navigate(Routes.About) })
        }
    }
}

// ---------------- Appearance ----------------

@Composable
fun AppearanceScreen(container: AppContainer, onBack: () -> Unit) {
    val prefs by container.settings.local.collectAsStateWithLifecycle()
    val c = FacetTheme.colors
    SettingsPage("Appearance", onBack) {
        Column {
            Text("Theme", style = FacetTheme.type.labelM, color = c.textTertiary, modifier = Modifier.padding(start = 12.dp, bottom = 10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ThemeMode.entries.forEach { mode ->
                    ThemeTile(mode, prefs.theme == mode, Modifier.weight(1f)) { container.settings.updateLocal { it.copy(theme = mode) } }
                }
            }
        }
        SettingsGroup {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                SwitchRow(
                    "Wallpaper colors", prefs.dynamicColor, { v -> container.settings.updateLocal { it.copy(dynamicColor = v) } },
                    subtitle = "Tint accents with your Material You palette.", icon = R.drawable.ic_palette,
                )
                GroupDivider()
            }
            SwitchRow(
                "Reduce motion", prefs.reducedMotion, { v -> container.settings.updateLocal { it.copy(reducedMotion = v) } },
                subtitle = "Replace movement with simple fades.", icon = R.drawable.ic_activity,
            )
            GroupDivider()
            SwitchRow("Haptics", prefs.haptics, { v -> container.settings.updateLocal { it.copy(haptics = v) } }, icon = R.drawable.ic_phone)
        }
        Column {
            Text("Chat text size", style = FacetTheme.type.labelM, color = c.textTertiary, modifier = Modifier.padding(start = 12.dp, bottom = 10.dp))
            Column(Modifier.fillMaxWidth().clip(FacetShapes.group).background(c.surface).padding(16.dp)) {
                var scale by remember { mutableFloatStateOf(prefs.chatTextScale) }
                Text(
                    "The quick brown fox explains quantum tunneling in plain words.",
                    style = FacetTheme.type.chat.copy(fontSize = FacetTheme.type.chat.fontSize * (scale / prefs.chatTextScale), lineHeight = FacetTheme.type.chat.lineHeight * (scale / prefs.chatTextScale)),
                    color = c.text,
                )
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("A", style = FacetTheme.type.labelM, color = c.textSecondary)
                    Slider(
                        value = scale,
                        onValueChange = { scale = it },
                        onValueChangeFinished = { container.settings.updateLocal { p -> p.copy(chatTextScale = scale) } },
                        valueRange = 0.85f..1.3f,
                        steps = 8,
                        modifier = Modifier.weight(1f).padding(horizontal = 12.dp),
                        colors = SliderDefaults.colors(thumbColor = c.primary, activeTrackColor = c.primary, inactiveTrackColor = c.surfaceHighest),
                    )
                    Text("A", style = FacetTheme.type.titleL, color = c.textSecondary)
                }
            }
        }
    }
}

@Composable
private fun ThemeTile(mode: ThemeMode, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = FacetTheme.colors
    val (bg, fg) = when (mode) {
        ThemeMode.SYSTEM -> null to null
        ThemeMode.LIGHT -> QuartzColors.background to QuartzColors.userBubble
        ThemeMode.DARK -> BasaltColors.background to BasaltColors.userBubble
        ThemeMode.BLACK -> ObsidianColors.background to ObsidianColors.userBubble
    }
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(84.dp)
                .clip(RoundedCornerShape(16.dp))
                .border(if (selected) 2.dp else 1.dp, if (selected) c.primary else c.outline, RoundedCornerShape(16.dp))
                .clickable(onClick = onClick),
        ) {
            if (bg == null) {
                Row(Modifier.fillMaxSize()) {
                    Box(Modifier.weight(1f).fillMaxSize().background(QuartzColors.background))
                    Box(Modifier.weight(1f).fillMaxSize().background(BasaltColors.background))
                }
            } else {
                Box(Modifier.fillMaxSize().background(bg)) {
                    Box(Modifier.align(Alignment.TopEnd).padding(10.dp).size(width = 30.dp, height = 12.dp).clip(RoundedCornerShape(6.dp)).background(fg!!))
                    Box(Modifier.align(Alignment.CenterStart).padding(start = 10.dp, top = 10.dp).size(width = 40.dp, height = 6.dp).clip(RoundedCornerShape(3.dp)).background(fg.copy(alpha = 0.9f)))
                }
            }
            Gem(Modifier.align(Alignment.BottomStart).padding(8.dp), size = 14.dp)
        }
        Spacer(Modifier.height(8.dp))
        Text(
            when (mode) { ThemeMode.SYSTEM -> "System"; ThemeMode.LIGHT -> "Light"; ThemeMode.DARK -> "Dark"; ThemeMode.BLACK -> "Black" },
            style = FacetTheme.type.labelM, color = if (selected) c.text else c.textSecondary,
        )
    }
}

// ---------------- Chat preferences ----------------

@Composable
fun ChatPrefsScreen(container: AppContainer, onBack: () -> Unit) {
    val local by container.settings.local.collectAsStateWithLifecycle()
    val synced by container.settings.synced.collectAsStateWithLifecycle()
    val catalog by container.providers.observeCatalog().collectAsStateWithLifecycle(emptyList())
    val scope = rememberCoroutineScope()
    var aboutMe by remember { mutableStateOf(synced.aboutMe) }
    var style by remember { mutableStateOf(synced.responseStyle) }
    var picker by remember { mutableStateOf<String?>(null) }
    val c = FacetTheme.colors

    fun modelLabel(ref: ModelRef?): String {
        ref ?: return "Not set"
        val pm = catalog.firstOrNull { it.provider.id == ref.providerId } ?: return "Unavailable"
        return (pm.models.firstOrNull { it.id == ref.modelId }?.displayName ?: ref.modelId) + " · " + pm.provider.label
    }

    fun saveInstructions() {
        if (aboutMe != synced.aboutMe || style != synced.responseStyle) {
            container.settings.updateSynced { it.copy(aboutMe = aboutMe.trim(), responseStyle = style.trim()) }
        }
    }

    SettingsPage("Chat", { saveInstructions(); onBack() }) {
        SettingsGroup(title = "Custom instructions") {
            SwitchRow(
                "Use custom instructions", synced.customInstructionsEnabled,
                { v -> container.settings.updateSynced { it.copy(customInstructionsEnabled = v) } },
                subtitle = "Applied to every new message, with any assistant.", icon = R.drawable.ic_wand,
            )
        }
        if (synced.customInstructionsEnabled) {
            FacetTextField(
                aboutMe, { aboutMe = it }, label = "What should Facet know about you?",
                placeholder = "e.g. I'm a backend developer in Lisbon. I prefer metric units.",
                singleLine = false, minLines = 3, maxLines = 8,
            )
            FacetTextField(
                style, { style = it }, label = "How should Facet respond?",
                placeholder = "e.g. Be direct. Skip the preamble. Use tables for comparisons.",
                singleLine = false, minLines = 3, maxLines = 8,
                supporting = "Synced across your devices and end-to-end encrypted.",
            )
            FacetButton("Save instructions", { saveInstructions() }, style = ButtonStyle.Tonal, enabled = aboutMe != synced.aboutMe || style != synced.responseStyle)
        }
        SettingsGroup(title = "Models") {
            SettingsRow("Default model for new chats", subtitle = modelLabel(synced.defaultModel), icon = R.drawable.ic_cpu, onClick = { picker = "default" })
            GroupDivider()
            SettingsRow("Model for chat titles", subtitle = synced.titleModel?.let { modelLabel(it) } ?: "Same as the chat", icon = R.drawable.ic_text_size, onClick = { picker = "title" })
            GroupDivider()
            SwitchRow("Name chats automatically", synced.autoTitle, { v -> container.settings.updateSynced { it.copy(autoTitle = v) } }, icon = R.drawable.ic_sparkles)
        }
        SettingsGroup(title = "Behavior") {
            SwitchRow("Send with Enter", local.sendOnEnter, { v -> container.settings.updateLocal { it.copy(sendOnEnter = v) } }, subtitle = "Use Shift+Enter or the keyboard's newline key for line breaks.", icon = R.drawable.ic_arrow_right)
            GroupDivider()
            SwitchRow("Expand reasoning", local.expandThinking, { v -> container.settings.updateLocal { it.copy(expandThinking = v) } }, subtitle = "Show the model's reasoning open by default.", icon = R.drawable.ic_brain)
            GroupDivider()
            SwitchRow("Show token counts", local.showUsage, { v -> container.settings.updateLocal { it.copy(showUsage = v) } }, icon = R.drawable.ic_hash)
            GroupDivider()
            SwitchRow("Show estimated cost", local.showCost, { v -> container.settings.updateLocal { it.copy(showCost = v) } }, icon = R.drawable.ic_coins)
            GroupDivider()
            SwitchRow(
                "Live pricing data", local.pricingFeed,
                { v ->
                    container.settings.updateLocal { it.copy(pricingFeed = v) }
                    if (v) scope.launch { runCatching { container.pricing.refreshIfStale(0) } }
                },
                subtitle = "Daily public price list from openrouter.ai, used for cost estimates. No personal data is sent.",
                icon = R.drawable.ic_gauge,
            )
            GroupDivider()
            SwitchRow(
                "Notify when a reply finishes", local.notifyOnComplete, { v -> container.settings.updateLocal { it.copy(notifyOnComplete = v) } },
                subtitle = "Only while Facet is in the background.", icon = R.drawable.ic_info,
            )
        }
    }
    picker?.let { which ->
        ModelPickerSheet(
            catalog = catalog,
            selected = if (which == "default") synced.defaultModel else synced.titleModel,
            onSelect = { ref ->
                container.settings.updateSynced { if (which == "default") it.copy(defaultModel = ref) else it.copy(titleModel = ref) }
                picker = null
            },
            onToggleFavorite = { pid, mid -> scope.launch { container.providers.toggleFavorite(pid, mid) } },
            onManageProviders = { picker = null },
            onRefresh = { pid -> scope.launch { container.providers.refreshModels(pid) } },
            onDismiss = { picker = null },
        )
    }
}

// ---------------- Privacy ----------------

@Composable
fun PrivacyScreen(container: AppContainer, onBack: () -> Unit) {
    val prefs by container.settings.local.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val c = FacetTheme.colors
    var error by remember { mutableStateOf<String?>(null) }
    SettingsPage("Privacy and security", onBack) {
        SettingsGroup {
            SwitchRow(
                "App lock", prefs.appLock,
                { enable ->
                    if (!enable) {
                        container.settings.updateLocal { it.copy(appLock = false) }
                    } else if (!DeviceAuth.isAvailable(context)) {
                        error = "Set up a screen lock on this device first."
                    } else {
                        DeviceAuth.authenticate(context, "Turn on app lock") { ok -> if (ok) container.settings.updateLocal { it.copy(appLock = true) } }
                    }
                },
                subtitle = "Require your fingerprint, face or screen lock to open Facet.", icon = R.drawable.ic_fingerprint,
            )
            GroupDivider()
            SwitchRow(
                "Hide in recent apps", prefs.secureScreen, { v -> container.settings.updateLocal { it.copy(secureScreen = v) } },
                subtitle = "Blanks Facet in the app switcher and blocks screenshots.", icon = R.drawable.ic_eye_off,
            )
        }
        error?.let { Text(it, style = FacetTheme.type.labelM, color = c.error, modifier = Modifier.padding(start = 12.dp)) }
        Column(Modifier.fillMaxWidth().clip(FacetShapes.group).background(c.surface).padding(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                FacetIcon(R.drawable.ic_shield, null, tint = c.primary, size = 20.dp)
                Spacer(Modifier.width(10.dp))
                Text("How Facet protects your data", style = FacetTheme.type.titleM, color = c.text)
            }
            Spacer(Modifier.height(12.dp))
            listOf(
                "Messages go straight from this device to the provider you choose. Facet's servers never see them.",
                "Synced chats, files, assistants and API keys are encrypted on your device with a key only you hold. The sync server stores ciphertext it can't read.",
                "Your password never leaves the device. It's turned into a login key and an encryption key here.",
                "API keys are also sealed with a hardware-backed key in Android's keystore.",
                "No ads, no analytics, no tracking.",
            ).forEach { line ->
                Row(Modifier.padding(vertical = 5.dp)) {
                    Box(Modifier.padding(top = 9.dp).size(5.dp).clip(CircleShape).background(c.textTertiary))
                    Spacer(Modifier.width(10.dp))
                    Text(line, style = FacetTheme.type.body, color = c.textSecondary)
                }
            }
        }
    }
}

// ---------------- Data ----------------

@Composable
fun DataScreen(container: AppContainer, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val account by container.auth.state.collectAsStateWithLifecycle()
    var localSize by remember { mutableStateOf<Long?>(null) }
    var confirmDeleteAll by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val c = FacetTheme.colors
    LaunchedEffect(Unit) {
        localSize = withContext(Dispatchers.IO) {
            val db = context.getDatabasePath("facet.db")
            val files = listOf(db, File(db.path + "-wal"), File(db.path + "-shm"))
            files.sumOf { if (it.exists()) it.length() else 0L } + (container.attachments.dir.listFiles()?.sumOf { it.length() } ?: 0L)
        }
    }
    val exporter = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if (uri != null) scope.launch {
            val ok = runCatching { DataExport.writeAll(container, context, uri) }.isSuccess
            message = if (ok) "Export saved." else "Export failed."
        }
    }
    SettingsPage("Data and storage", onBack) {
        SettingsGroup(title = "Storage") {
            SettingsRow("On this device", subtitle = localSize?.let { Format.bytes(it) } ?: "Calculating…", icon = R.drawable.ic_phone, showChevron = false)
            (account as? AccountState.SignedIn)?.let { a ->
                GroupDivider()
                SettingsRow(
                    "Encrypted files on the sync server",
                    subtitle = "${Format.bytes(a.usedBytes)} of ${Format.bytes(a.quotaBytes)}",
                    icon = R.drawable.ic_cloud, showChevron = false,
                )
            }
        }
        SettingsGroup(title = "Export") {
            SettingsRow(
                "Export all data", subtitle = "Chats, assistants, prompts and settings as JSON. API keys are not included.",
                icon = R.drawable.ic_download, onClick = { exporter.launch("facet-export-${java.time.LocalDate.now()}.json") },
            )
        }
        SettingsGroup(title = "Maintenance") {
            SettingsRow(
                "Reset learned model quirks",
                subtitle = "Facet remembers parameters a model rejected. Reset if a provider changed its API.",
                icon = R.drawable.ic_undo, onClick = { container.quirks.clear(); message = "Model quirks reset." },
            )
            GroupDivider()
            SettingsRow(
                "Delete all chats", subtitle = "Removes every chat from all your devices.",
                icon = R.drawable.ic_delete, iconTint = c.error, titleColor = c.error, onClick = { confirmDeleteAll = true },
            )
        }
        message?.let { Text(it, style = FacetTheme.type.labelM, color = c.textSecondary, modifier = Modifier.padding(start = 12.dp)) }
    }
    if (confirmDeleteAll) {
        ConfirmDialog(
            "Delete all chats?", "Every chat will be removed from all your devices. This can't be undone.", "Delete everything",
            onConfirm = {
                scope.launch {
                    container.db.conversations().all().forEach { container.conversations.delete(it.id) }
                    message = "All chats deleted."
                }
            },
            onDismiss = { confirmDeleteAll = false }, danger = true,
        )
    }
}

// ---------------- About ----------------

@Composable
fun AboutScreen(onBack: () -> Unit) {
    val uri = LocalUriHandler.current
    val c = FacetTheme.colors
    var licenses by remember { mutableStateOf(false) }
    SettingsPage("About", onBack) {
        Column(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            io.dtsoftware.facet.ui.components.AssemblingGem(size = 72.dp)
            Spacer(Modifier.height(16.dp))
            Text("Facet", style = FacetTheme.type.headline, color = c.text)
            Text("Version ${BuildConfig.VERSION_NAME}", style = FacetTheme.type.labelM, color = c.textTertiary)
            Spacer(Modifier.height(10.dp))
            Text(
                "Every model, one home. Open source and end-to-end encrypted.\nMade by DT Software.",
                style = FacetTheme.type.body, color = c.textSecondary, textAlign = TextAlign.Center,
            )
        }
        SettingsGroup {
            SettingsRow("Website", subtitle = BuildConfig.WEBSITE_URL.removePrefix("https://"), icon = R.drawable.ic_globe, onClick = { uri.openUri(BuildConfig.WEBSITE_URL) })
            GroupDivider()
            SettingsRow("Source code", subtitle = "Apache License 2.0", icon = R.drawable.ic_code, onClick = { uri.openUri(BuildConfig.SOURCE_URL) })
            GroupDivider()
            SettingsRow("Privacy policy", icon = R.drawable.ic_shield, onClick = { uri.openUri(BuildConfig.WEBSITE_URL + "/privacy.html") })
            GroupDivider()
            SettingsRow("Terms", icon = R.drawable.ic_scale, onClick = { uri.openUri(BuildConfig.WEBSITE_URL + "/terms.html") })
            GroupDivider()
            SettingsRow("Open-source licenses", icon = R.drawable.ic_library, onClick = { licenses = true })
        }
    }
    if (licenses) {
        io.dtsoftware.facet.ui.components.FacetSheet({ licenses = false }) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).navigationBarsPadding().padding(bottom = 24.dp)) {
                Text("Open-source licenses", style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(bottom = 12.dp))
                OSS_NOTICES.forEach { (name, license) ->
                    Column(Modifier.padding(vertical = 8.dp)) {
                        Text(name, style = FacetTheme.type.labelL, color = c.text)
                        Text(license, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary)
                    }
                }
            }
        }
    }
}

private val OSS_NOTICES = listOf(
    "AndroidX, Jetpack Compose, Room, WorkManager" to "Apache License 2.0 · The Android Open Source Project",
    "Kotlin, kotlinx.coroutines, kotlinx.serialization" to "Apache License 2.0 · JetBrains",
    "JetBrains Markdown" to "Apache License 2.0 · JetBrains",
    "OkHttp, Okio" to "Apache License 2.0 · Square, Inc.",
    "JLaTeXMath for Android" to "GPL 2.0 with linking exception · github.com/noties/jlatexmath-android (math fonts under OFL)",
    "Lucide icons" to "ISC License · lucide.dev",
    "Instrument Sans, Instrument Serif" to "SIL Open Font License 1.1 · The Instrument Sans Project Authors",
    "JetBrains Mono" to "SIL Open Font License 1.1 · JetBrains",
)
