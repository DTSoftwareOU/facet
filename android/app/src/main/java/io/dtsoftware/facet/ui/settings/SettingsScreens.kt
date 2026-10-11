package io.dtsoftware.facet.ui.settings

import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
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
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.BuildConfig
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.AppLanguage
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.i18n.findActivity
import io.dtsoftware.facet.ui.components.FacetSheet
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
import io.dtsoftware.facet.domain.tools.ToolRegistry
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
    SettingsPage(stringResource(R.string.settings_title), onBack) {
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
                    FacetIcon(R.drawable.ic_shield, stringResource(R.string.settings_e2e_encrypted), tint = c.primary, size = 20.dp)
                }
                else -> {
                    Box(Modifier.size(48.dp).clip(CircleShape).background(c.primaryContainer), contentAlignment = Alignment.Center) {
                        FacetIcon(R.drawable.ic_cloud, null, tint = c.onPrimaryContainer, size = 22.dp)
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            stringResource(if (a is AccountState.Expired) R.string.settings_sign_in_again else R.string.settings_sync_across_devices),
                            style = FacetTheme.type.titleM, color = c.text,
                        )
                        Text(
                            stringResource(R.string.settings_account_promo),
                            style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary,
                        )
                    }
                    FacetIcon(R.drawable.ic_chevron_right, null, tint = c.textTertiary, size = 18.dp)
                }
            }
        }
        SettingsGroup {
            SettingsRow(
                stringResource(R.string.settings_providers),
                subtitle = if (providers.isEmpty()) stringResource(R.string.settings_providers_empty)
                else pluralStringResource(R.plurals.settings_providers_connected, providers.size, providers.size),
                icon = R.drawable.ic_key, onClick = { navigate(Routes.Providers) },
            )
            GroupDivider()
            SettingsRow(stringResource(R.string.settings_assistants), subtitle = stringResource(R.string.settings_assistants_subtitle), icon = R.drawable.ic_bot, onClick = { navigate(Routes.Assistants) })
            GroupDivider()
            SettingsRow(stringResource(R.string.settings_prompts), subtitle = stringResource(R.string.settings_prompts_subtitle), icon = R.drawable.ic_library, onClick = { navigate(Routes.Prompts) })
            GroupDivider()
            SettingsRow(stringResource(R.string.settings_chat), subtitle = stringResource(R.string.settings_chat_subtitle), icon = R.drawable.ic_message, onClick = { navigate(Routes.ChatPrefs) })
        }
        SettingsGroup(title = stringResource(R.string.settings_tools)) {
            SettingsRow(stringResource(R.string.settings_web_search), subtitle = stringResource(R.string.settings_web_search_subtitle), icon = R.drawable.ic_globe, onClick = { navigate(Routes.WebSearch) })
            GroupDivider()
            SettingsRow(stringResource(R.string.settings_mcp_servers), subtitle = stringResource(R.string.settings_mcp_servers_subtitle), icon = R.drawable.ic_server, onClick = { navigate(Routes.McpServers) })
            GroupDivider()
            SettingsRow(stringResource(R.string.settings_skills), subtitle = stringResource(R.string.settings_skills_subtitle), icon = R.drawable.ic_wand, onClick = { navigate(Routes.Skills) })
            GroupDivider()
            SettingsRow(stringResource(R.string.settings_media_models), subtitle = stringResource(R.string.settings_media_models_subtitle), icon = R.drawable.ic_sparkles, onClick = { navigate(Routes.MediaModels) })
            GroupDivider()
            if (account is AccountState.SignedIn) {
                SettingsRow(stringResource(R.string.pcsettings_title), subtitle = pcSubtitle(container), icon = R.drawable.ic_monitor, onClick = { navigate(Routes.YourPc) })
                GroupDivider()
            }
            SwitchRow(
                stringResource(R.string.settings_yolo_mode), synced.yoloMode, { on -> container.settings.updateSynced { it.copy(yoloMode = on) } },
                subtitle = pluralStringResource(R.plurals.settings_yolo_mode_subtitle, ToolRegistry.YOLO_TOOL_ROUNDS, ToolRegistry.YOLO_TOOL_ROUNDS),
                icon = R.drawable.ic_rocket,
            )
        }
        SettingsGroup {
            SettingsRow(stringResource(R.string.settings_appearance), icon = R.drawable.ic_palette, onClick = { navigate(Routes.Appearance) })
            GroupDivider()
            SettingsRow(stringResource(R.string.settings_privacy), icon = R.drawable.ic_shield, onClick = { navigate(Routes.Privacy) })
            GroupDivider()
            SettingsRow(stringResource(R.string.settings_data), icon = R.drawable.ic_server, onClick = { navigate(Routes.Data) })
        }
        SettingsGroup {
            val update by container.updates.state.collectAsStateWithLifecycle()
            SettingsRow(stringResource(R.string.settings_about_facet), subtitle = io.dtsoftware.facet.ui.update.aboutSubtitle(update), icon = R.drawable.ic_info, onClick = { navigate(Routes.About) })
        }
    }
}

// ---------------- Appearance ----------------

@Composable
fun AppearanceScreen(container: AppContainer, onBack: () -> Unit) {
    val prefs by container.settings.local.collectAsStateWithLifecycle()
    val c = FacetTheme.colors
    SettingsPage(stringResource(R.string.settings_appearance), onBack) {
        Column {
            Text(stringResource(R.string.settings_theme), style = FacetTheme.type.labelM, color = c.textTertiary, modifier = Modifier.padding(start = 12.dp, bottom = 10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ThemeMode.entries.forEach { mode ->
                    ThemeTile(mode, prefs.theme == mode, Modifier.weight(1f)) { container.settings.updateLocal { it.copy(theme = mode) } }
                }
            }
        }
        LanguageRow()
        SettingsGroup {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                SwitchRow(
                    stringResource(R.string.settings_wallpaper_colors), prefs.dynamicColor, { v -> container.settings.updateLocal { it.copy(dynamicColor = v) } },
                    subtitle = stringResource(R.string.settings_wallpaper_colors_subtitle), icon = R.drawable.ic_palette,
                )
                GroupDivider()
            }
            SwitchRow(
                stringResource(R.string.settings_reduce_motion), prefs.reducedMotion, { v -> container.settings.updateLocal { it.copy(reducedMotion = v) } },
                subtitle = stringResource(R.string.settings_reduce_motion_subtitle), icon = R.drawable.ic_activity,
            )
            GroupDivider()
            SwitchRow(stringResource(R.string.settings_haptics), prefs.haptics, { v -> container.settings.updateLocal { it.copy(haptics = v) } }, icon = R.drawable.ic_phone)
        }
        Column {
            Text(stringResource(R.string.settings_text_size), style = FacetTheme.type.labelM, color = c.textTertiary, modifier = Modifier.padding(start = 12.dp, bottom = 10.dp))
            Column(Modifier.fillMaxWidth().clip(FacetShapes.group).background(c.surface).padding(16.dp)) {
                var scale by remember { mutableFloatStateOf(prefs.chatTextScale) }
                Text(
                    stringResource(R.string.settings_text_size_preview),
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

/** Settings → Appearance → Language: follow the system, or one of [AppLanguage.all] by its own name. */
@Composable
private fun LanguageRow() {
    val context = LocalContext.current
    val c = FacetTheme.colors
    val selected = remember { AppLanguage.selected(context) }
    var open by remember { mutableStateOf(false) }
    SettingsGroup {
        SettingsRow(
            stringResource(R.string.language_title),
            subtitle = AppLanguage.nativeName(selected) ?: stringResource(R.string.language_system),
            icon = R.drawable.ic_globe,
            onClick = { open = true },
        )
    }
    if (!open) return
    FacetSheet({ open = false }) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = 16.dp)) {
            Text(
                stringResource(R.string.language_title), style = FacetTheme.type.titleL, color = c.text,
                modifier = Modifier.padding(horizontal = 24.dp).padding(bottom = 8.dp),
            )
            val choices = listOf<Pair<String?, String>>(null to stringResource(R.string.language_system)) +
                AppLanguage.all.map { it.tag to it.nativeName }
            val listDirection = if (LocalLayoutDirection.current == LayoutDirection.Rtl) TextDirection.Rtl else TextDirection.Ltr
            choices.forEach { (tag, name) ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(role = androidx.compose.ui.semantics.Role.RadioButton) {
                            open = false
                            if (tag != selected) context.findActivity()?.let { AppLanguage.select(it, tag) }
                        }
                        .padding(horizontal = 24.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Names line up at the start edge of the list, also the right-to-left ones in a left-to-right list.
                    Text(name, style = FacetTheme.type.labelL.copy(textDirection = listDirection), color = c.text, modifier = Modifier.weight(1f))
                    if (tag == selected) FacetIcon(R.drawable.ic_check, null, tint = c.primary, size = 20.dp)
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
            stringResource(
                when (mode) {
                    ThemeMode.SYSTEM -> R.string.settings_theme_system
                    ThemeMode.LIGHT -> R.string.settings_theme_light
                    ThemeMode.DARK -> R.string.settings_theme_dark
                    ThemeMode.BLACK -> R.string.settings_theme_black
                },
            ),
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
    val notSet = stringResource(R.string.common_not_set)
    val unavailable = stringResource(R.string.settings_model_unavailable)

    fun modelLabel(ref: ModelRef?): String {
        ref ?: return notSet
        val pm = catalog.firstOrNull { it.provider.id == ref.providerId } ?: return unavailable
        return (pm.models.firstOrNull { it.id == ref.modelId }?.displayName ?: ref.modelId) + " · " + pm.provider.label
    }

    fun saveInstructions() {
        if (aboutMe != synced.aboutMe || style != synced.responseStyle) {
            container.settings.updateSynced { it.copy(aboutMe = aboutMe.trim(), responseStyle = style.trim()) }
        }
    }

    SettingsPage(stringResource(R.string.settings_chat), { saveInstructions(); onBack() }) {
        SettingsGroup(title = stringResource(R.string.settings_custom_instructions)) {
            SwitchRow(
                stringResource(R.string.settings_use_custom_instructions), synced.customInstructionsEnabled,
                { v -> container.settings.updateSynced { it.copy(customInstructionsEnabled = v) } },
                subtitle = stringResource(R.string.settings_use_custom_instructions_subtitle), icon = R.drawable.ic_wand,
            )
        }
        if (synced.customInstructionsEnabled) {
            FacetTextField(
                aboutMe, { aboutMe = it }, label = stringResource(R.string.settings_about_me_label),
                placeholder = stringResource(R.string.settings_about_me_placeholder),
                singleLine = false, minLines = 3, maxLines = 8,
            )
            FacetTextField(
                style, { style = it }, label = stringResource(R.string.settings_response_style_label),
                placeholder = stringResource(R.string.settings_response_style_placeholder),
                singleLine = false, minLines = 3, maxLines = 8,
                supporting = stringResource(R.string.settings_instructions_supporting),
            )
            FacetButton(stringResource(R.string.settings_save_instructions), { saveInstructions() }, style = ButtonStyle.Tonal, enabled = aboutMe != synced.aboutMe || style != synced.responseStyle)
        }
        SettingsGroup(title = stringResource(R.string.settings_models)) {
            SettingsRow(stringResource(R.string.settings_default_model), subtitle = modelLabel(synced.defaultModel), icon = R.drawable.ic_cpu, onClick = { picker = "default" })
            GroupDivider()
            SettingsRow(
                stringResource(R.string.settings_title_model),
                subtitle = synced.titleModel?.let { modelLabel(it) } ?: stringResource(R.string.settings_title_model_same),
                icon = R.drawable.ic_text_size, onClick = { picker = "title" },
            )
            GroupDivider()
            SwitchRow(stringResource(R.string.settings_auto_title), synced.autoTitle, { v -> container.settings.updateSynced { it.copy(autoTitle = v) } }, icon = R.drawable.ic_sparkles)
        }
        SettingsGroup(title = stringResource(R.string.settings_behavior)) {
            SwitchRow(
                stringResource(R.string.settings_send_with_enter), local.sendOnEnter, { v -> container.settings.updateLocal { it.copy(sendOnEnter = v) } },
                subtitle = stringResource(R.string.settings_send_with_enter_subtitle), icon = R.drawable.ic_arrow_right,
            )
            GroupDivider()
            SwitchRow(
                stringResource(R.string.settings_expand_reasoning), local.expandThinking, { v -> container.settings.updateLocal { it.copy(expandThinking = v) } },
                subtitle = stringResource(R.string.settings_expand_reasoning_subtitle), icon = R.drawable.ic_brain,
            )
            GroupDivider()
            SwitchRow(stringResource(R.string.settings_show_tokens), local.showUsage, { v -> container.settings.updateLocal { it.copy(showUsage = v) } }, icon = R.drawable.ic_hash)
            GroupDivider()
            SwitchRow(stringResource(R.string.settings_show_cost), local.showCost, { v -> container.settings.updateLocal { it.copy(showCost = v) } }, icon = R.drawable.ic_coins)
            GroupDivider()
            SwitchRow(
                stringResource(R.string.settings_pricing_feed), local.pricingFeed,
                { v ->
                    container.settings.updateLocal { it.copy(pricingFeed = v) }
                    if (v) scope.launch { runCatching { container.pricing.refreshIfStale(0) } }
                },
                subtitle = stringResource(R.string.settings_pricing_feed_subtitle),
                icon = R.drawable.ic_gauge,
            )
            GroupDivider()
            SwitchRow(
                stringResource(R.string.settings_notify), local.notifyOnComplete, { v -> container.settings.updateLocal { it.copy(notifyOnComplete = v) } },
                subtitle = stringResource(R.string.settings_notify_subtitle), icon = R.drawable.ic_info,
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
    val promptTitle = stringResource(R.string.settings_app_lock_prompt)
    SettingsPage(stringResource(R.string.settings_privacy), onBack) {
        SettingsGroup {
            SwitchRow(
                stringResource(R.string.settings_app_lock), prefs.appLock,
                { enable ->
                    if (!enable) {
                        container.settings.updateLocal { it.copy(appLock = false) }
                    } else if (!DeviceAuth.isAvailable(context)) {
                        error = Strings.get(R.string.settings_app_lock_no_screen_lock)
                    } else {
                        DeviceAuth.authenticate(context, promptTitle) { ok -> if (ok) container.settings.updateLocal { it.copy(appLock = true) } }
                    }
                },
                subtitle = stringResource(R.string.settings_app_lock_subtitle), icon = R.drawable.ic_fingerprint,
            )
            GroupDivider()
            SwitchRow(
                stringResource(R.string.settings_hide_recents), prefs.secureScreen, { v -> container.settings.updateLocal { it.copy(secureScreen = v) } },
                subtitle = stringResource(R.string.settings_hide_recents_subtitle), icon = R.drawable.ic_eye_off,
            )
        }
        error?.let { Text(it, style = FacetTheme.type.labelM, color = c.error, modifier = Modifier.padding(start = 12.dp)) }
        Column(Modifier.fillMaxWidth().clip(FacetShapes.group).background(c.surface).padding(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                FacetIcon(R.drawable.ic_shield, null, tint = c.primary, size = 20.dp)
                Spacer(Modifier.width(10.dp))
                Text(stringResource(R.string.settings_protection_title), style = FacetTheme.type.titleM, color = c.text)
            }
            Spacer(Modifier.height(12.dp))
            listOf(
                stringResource(R.string.settings_protection_direct),
                stringResource(R.string.settings_protection_encrypted),
                stringResource(R.string.settings_protection_password),
                stringResource(R.string.settings_protection_keystore),
                stringResource(R.string.settings_protection_no_tracking),
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
    var confirmDeleteAll by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val c = FacetTheme.colors
    val exporter = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if (uri != null) scope.launch {
            val ok = runCatching { DataExport.writeAll(container, context, uri) }.isSuccess
            message = Strings.get(if (ok) R.string.settings_export_saved else R.string.settings_export_failed)
        }
    }
    SettingsPage(stringResource(R.string.settings_data), onBack) {
        StorageSection(container)
        SettingsGroup(title = stringResource(R.string.settings_export)) {
            SettingsRow(
                stringResource(R.string.settings_export_all), subtitle = stringResource(R.string.settings_export_all_subtitle),
                icon = R.drawable.ic_download, onClick = { exporter.launch("facet-export-${java.time.LocalDate.now()}.json") },
            )
        }
        SettingsGroup(title = stringResource(R.string.settings_maintenance)) {
            SettingsRow(
                stringResource(R.string.settings_reset_quirks),
                subtitle = stringResource(R.string.settings_reset_quirks_subtitle),
                icon = R.drawable.ic_undo, onClick = { container.quirks.clear(); message = Strings.get(R.string.settings_quirks_reset_done) },
            )
            GroupDivider()
            SettingsRow(
                stringResource(R.string.settings_delete_all_chats), subtitle = stringResource(R.string.settings_delete_all_chats_subtitle),
                icon = R.drawable.ic_delete, iconTint = c.error, titleColor = c.error, onClick = { confirmDeleteAll = true },
            )
        }
        message?.let { Text(it, style = FacetTheme.type.labelM, color = c.textSecondary, modifier = Modifier.padding(start = 12.dp)) }
    }
    if (confirmDeleteAll) {
        ConfirmDialog(
            stringResource(R.string.settings_delete_all_chats_title),
            stringResource(R.string.settings_delete_all_chats_body),
            stringResource(R.string.settings_delete_everything),
            onConfirm = {
                scope.launch {
                    container.db.conversations().all().forEach { container.conversations.delete(it.id) }
                    message = Strings.get(R.string.settings_all_chats_deleted)
                }
            },
            onDismiss = { confirmDeleteAll = false }, danger = true,
        )
    }
}

// ---------------- About ----------------

@Composable
fun AboutScreen(container: AppContainer, onBack: () -> Unit) {
    val uri = LocalUriHandler.current
    val c = FacetTheme.colors
    var licenses by remember { mutableStateOf(false) }
    SettingsPage(stringResource(R.string.settings_about), onBack) {
        Column(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            io.dtsoftware.facet.ui.components.AssemblingGem(size = 72.dp)
            Spacer(Modifier.height(16.dp))
            Text("Facet AI", style = FacetTheme.type.headline, color = c.text)
            Text(stringResource(R.string.settings_version, BuildConfig.VERSION_NAME), style = FacetTheme.type.labelM, color = c.textTertiary)
            Spacer(Modifier.height(10.dp))
            Text(
                stringResource(R.string.settings_about_tagline),
                style = FacetTheme.type.body, color = c.textSecondary, textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                stringResource(R.string.settings_about_disclaimer),
                style = FacetTheme.type.labelS, color = c.textTertiary, textAlign = TextAlign.Center,
            )
        }
        io.dtsoftware.facet.ui.update.UpdateSection(container)
        SettingsGroup {
            SettingsRow(stringResource(R.string.settings_website), subtitle = BuildConfig.WEBSITE_URL.removePrefix("https://"), icon = R.drawable.ic_globe, onClick = { uri.openUri(BuildConfig.WEBSITE_URL) })
            GroupDivider()
            SettingsRow(stringResource(R.string.settings_source_code), subtitle = "Apache License 2.0", icon = R.drawable.ic_code, onClick = { uri.openUri(BuildConfig.SOURCE_URL) })
            GroupDivider()
            SettingsRow(stringResource(R.string.settings_privacy_policy), icon = R.drawable.ic_shield, onClick = { uri.openUri(BuildConfig.WEBSITE_URL + "/privacy.html") })
            GroupDivider()
            SettingsRow(stringResource(R.string.settings_terms), icon = R.drawable.ic_scale, onClick = { uri.openUri(BuildConfig.WEBSITE_URL + "/terms.html") })
            GroupDivider()
            SettingsRow(stringResource(R.string.settings_licenses), icon = R.drawable.ic_library, onClick = { licenses = true })
        }
    }
    if (licenses) {
        io.dtsoftware.facet.ui.components.FacetSheet({ licenses = false }) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).navigationBarsPadding().padding(bottom = 24.dp)) {
                Text(stringResource(R.string.settings_licenses), style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(bottom = 12.dp))
                OSS_NOTICES.forEach { notice ->
                    val license = notice.note?.let { stringResource(it, notice.license) } ?: notice.license
                    Column(Modifier.padding(vertical = 8.dp)) {
                        Text(notice.name, style = FacetTheme.type.labelL, color = c.text)
                        Text(license, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary)
                    }
                }
            }
        }
    }
}

/** A project, its license and copyright holder (names, kept in English) and an optional translated [note] around the license. */
private class OssNotice(val name: String, val license: String, @StringRes val note: Int? = null)

private val OSS_NOTICES = listOf(
    OssNotice("AndroidX, Jetpack Compose, Room, WorkManager", "Apache License 2.0 · The Android Open Source Project"),
    OssNotice("Kotlin, kotlinx.coroutines, kotlinx.serialization", "Apache License 2.0 · JetBrains"),
    OssNotice("JetBrains Markdown", "Apache License 2.0 · JetBrains"),
    OssNotice("OkHttp, Okio", "Apache License 2.0 · Square, Inc."),
    OssNotice("JLaTeXMath for Android", "GPL 2.0 with linking exception · github.com/noties/jlatexmath-android", R.string.settings_license_math_fonts),
    OssNotice("Lucide icons", "ISC License · lucide.dev"),
    OssNotice("Instrument Sans, Instrument Serif", "SIL Open Font License 1.1 · The Instrument Sans Project Authors"),
    OssNotice("JetBrains Mono", "SIL Open Font License 1.1 · JetBrains"),
)
