package io.dtsoftware.facet.ui.settings

import android.content.ClipDescription
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.Dates
import io.dtsoftware.facet.data.db.ProviderEntity
import io.dtsoftware.facet.llm.ApiStyle
import io.dtsoftware.facet.llm.ErrorKind
import io.dtsoftware.facet.llm.LlmException
import io.dtsoftware.facet.llm.ModelCatalog
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.ui.chat.MenuItem
import io.dtsoftware.facet.ui.chat.SearchField
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.ConfirmDialog
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.FacetIconButton
import io.dtsoftware.facet.ui.components.FacetTextField
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.ProviderBadge
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SettingsRow
import io.dtsoftware.facet.ui.components.SwitchRow
import io.dtsoftware.facet.ui.components.TextInputDialog
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlinx.coroutines.launch

/** Presets in the order they're offered. */
/** Providers with chat models, in the order the pickers show them. */
val ProviderOrder = listOf(
    ProviderKind.OPENAI, ProviderKind.ANTHROPIC, ProviderKind.GOOGLE, ProviderKind.OPENROUTER,
    ProviderKind.XAI, ProviderKind.DEEPSEEK, ProviderKind.MISTRAL, ProviderKind.GROQ, ProviderKind.CEREBRAS,
    ProviderKind.TOGETHER, ProviderKind.FIREWORKS, ProviderKind.PERPLEXITY, ProviderKind.HUGGINGFACE,
    ProviderKind.MOONSHOT, ProviderKind.ZAI, ProviderKind.QWEN, ProviderKind.MINIMAX, ProviderKind.COHERE,
    ProviderKind.NVIDIA, ProviderKind.DEEPINFRA, ProviderKind.NEBIUS, ProviderKind.SAMBANOVA, ProviderKind.HYPERBOLIC,
    ProviderKind.NOVITA, ProviderKind.VENICE, ProviderKind.VERCEL, ProviderKind.INCEPTION,
    ProviderKind.OLLAMA, ProviderKind.LMSTUDIO, ProviderKind.CUSTOM,
)

/** Providers that only make media (images, video, speech, music, transcripts). */
val MediaProviderOrder = listOf(ProviderKind.ELEVENLABS, ProviderKind.STABILITY, ProviderKind.BFL, ProviderKind.DEEPGRAM)

@Composable
fun ProvidersScreen(container: AppContainer, onBack: () -> Unit, onEdit: (String) -> Unit, onAdd: (String) -> Unit) {
    val allProviders by container.providers.observeAll().collectAsStateWithLifecycle(emptyList())
    val providers = allProviders.filterNot { io.dtsoftware.facet.domain.tools.SearchKind.isSearch(it.kind) }
    val c = FacetTheme.colors
    SettingsPage(stringResource(R.string.providers_title), onBack) {
        if (providers.isEmpty()) {
            Text(
                stringResource(R.string.providers_intro),
                style = FacetTheme.type.body, color = c.textSecondary, modifier = Modifier.padding(horizontal = 4.dp),
            )
        } else {
            val off = stringResource(R.string.common_off)
            SettingsGroup(title = stringResource(R.string.providers_connected)) {
                providers.forEachIndexed { i, p ->
                    if (i > 0) GroupDivider()
                    val kind = ProviderKind.fromId(p.kind)
                    val count = remember(p.modelsJson, p.customModelsJson) { container.providers.models(p).size }
                    val countText = pluralStringResource(R.plurals.providers_model_count, count, count)
                    SettingsRow(
                        p.label,
                        subtitle = buildString {
                            if (p.label != kind.displayName) append(kind.displayName).append(" · ")
                            append(countText)
                            if (!p.enabled) append(" · ").append(off)
                        },
                        leading = { ProviderBadge(kind, size = 34.dp) },
                        onClick = { onEdit(p.id) },
                    )
                }
            }
        }
        SettingsGroup(title = stringResource(if (providers.isEmpty()) R.string.providers_section_chat else R.string.providers_section_add_chat)) {
            ProviderOrder.forEachIndexed { i, kind ->
                if (i > 0) GroupDivider()
                SettingsRow(
                    kind.displayName, subtitle = kind.blurb,
                    leading = { ProviderBadge(kind, size = 34.dp) },
                    onClick = { onAdd(kind.id) },
                    trailing = { FacetIcon(R.drawable.ic_plus, null, tint = c.textTertiary, size = 18.dp) },
                )
            }
        }
        SettingsGroup(title = stringResource(R.string.providers_section_media_only)) {
            MediaProviderOrder.forEachIndexed { i, kind ->
                if (i > 0) GroupDivider()
                SettingsRow(
                    kind.displayName, subtitle = kind.blurb,
                    leading = { ProviderBadge(kind, size = 34.dp) },
                    onClick = { onAdd(kind.id) },
                    trailing = { FacetIcon(R.drawable.ic_plus, null, tint = c.textTertiary, size = 18.dp) },
                )
            }
        }
    }
}

@Composable
fun ProviderEditScreen(container: AppContainer, providerId: String?, kindId: String?, onDone: () -> Unit) {
    val existing by (if (providerId != null) container.providers.observe(providerId) else kotlinx.coroutines.flow.flowOf(null))
        .collectAsStateWithLifecycle(null)
    val kind = existing?.let { ProviderKind.fromId(it.kind) } ?: ProviderKind.fromId(kindId ?: "custom")
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    val clipboard = LocalClipboard.current
    val c = FacetTheme.colors

    var loaded by remember { mutableStateOf(providerId == null) }
    var label by remember { mutableStateOf(kind.displayName) }
    var key by remember { mutableStateOf("") }
    var keyChanged by remember { mutableStateOf(false) }
    var baseUrl by remember { mutableStateOf(kind.defaultBaseUrl) }
    var headers by remember { mutableStateOf("") }
    var enabled by remember { mutableStateOf(true) }
    var advanced by remember { mutableStateOf(kind == ProviderKind.CUSTOM || kind == ProviderKind.OLLAMA || kind == ProviderKind.LMSTUDIO) }
    var testing by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<Pair<Boolean, String>?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var addModel by remember { mutableStateOf(false) }

    LaunchedEffect(existing?.id) {
        val p = existing ?: return@LaunchedEffect
        if (loaded) return@LaunchedEffect
        label = p.label
        baseUrl = p.baseUrl
        enabled = p.enabled
        headers = container.providers.headers(p).entries.joinToString("\n") { "${it.key}: ${it.value}" }
        key = container.providers.apiKey(p)
        loaded = true
    }

    fun parsedHeaders(): Map<String, String> = headers.lines().mapNotNull { line ->
        val idx = line.indexOf(':')
        if (idx <= 0) null else line.substring(0, idx).trim() to line.substring(idx + 1).trim()
    }.filter { it.first.isNotEmpty() }.toMap()

    val needsKey = kind.requiresKey
    val canSave = (!needsKey || key.isNotBlank()) && baseUrl.startsWith("http") && !saving

    fun save() {
        saving = true
        status = null
        scope.launch {
            val id = if (existing == null) {
                container.providers.add(kind, label, baseUrl, key, parsedHeaders()).id
            } else {
                container.providers.update(existing!!.id, label, baseUrl, if (keyChanged) key else null, parsedHeaders(), enabled)
                existing!!.id
            }
            val result = container.providers.refreshModels(id)
            saving = false
            if (result.isSuccess) {
                onDone()
            } else {
                val reason = result.exceptionOrNull()?.message ?: Strings.get(R.string.providers_models_load_failed)
                status = false to Strings.get(R.string.providers_saved_add_manually, reason)
            }
        }
    }

    SettingsPage(if (existing == null) stringResource(R.string.providers_add_title, kind.displayName) else existing!!.label, onDone) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 4.dp)) {
            ProviderBadge(kind, size = 44.dp)
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(kind.displayName, style = FacetTheme.type.titleM, color = c.text)
                Text(kind.blurb, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary)
            }
        }
        if (!loaded) return@SettingsPage

        FacetTextField(
            key, { key = it.trim(); keyChanged = true; status = null },
            label = stringResource(if (needsKey) R.string.providers_api_key else R.string.providers_api_key_optional),
            // Key hints like "sk-…" stay as they are; providers without a required key get a translated word instead.
            placeholder = when {
                needsKey -> kind.keyHint
                kind == ProviderKind.CUSTOM -> stringResource(R.string.providers_key_optional)
                else -> stringResource(R.string.providers_key_not_needed)
            },
            password = true,
            mono = true,
            supporting = stringResource(R.string.providers_api_key_supporting),
            trailing = {
                FacetIconButton(R.drawable.ic_clipboard, stringResource(R.string.providers_paste), {
                    scope.launch {
                        val clip = clipboard.getClipEntry()?.clipData
                        val text = clip?.takeIf { it.description.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN) || it.itemCount > 0 }
                            ?.getItemAt(0)?.text?.toString()
                        if (!text.isNullOrBlank()) { key = text.trim(); keyChanged = true }
                    }
                }, tint = c.textSecondary, size = 18.dp)
            },
        )
        kind.keyUrl?.let { url ->
            Row(
                Modifier.clip(FacetShapes.small).clickable { uri.openUri(url) }.padding(horizontal = 4.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (kind.requiresKey) stringResource(R.string.providers_get_key, kind.displayName) else stringResource(R.string.providers_about, kind.displayName),
                    style = FacetTheme.type.labelM, color = c.primary,
                )
                Spacer(Modifier.width(4.dp))
                FacetIcon(R.drawable.ic_external, null, tint = c.primary, size = 14.dp)
            }
        }
        FacetTextField(
            label, { label = it }, label = stringResource(R.string.common_name), placeholder = kind.displayName,
            supporting = stringResource(R.string.providers_name_supporting),
        )

        if (!advanced) {
            Text(
                stringResource(R.string.providers_advanced), style = FacetTheme.type.labelM, color = c.textSecondary,
                modifier = Modifier.clip(FacetShapes.small).clickable { advanced = true }.padding(4.dp),
            )
        } else {
            FacetTextField(
                baseUrl, { baseUrl = it.trim() }, label = stringResource(R.string.providers_base_url), mono = true, keyboardType = KeyboardType.Uri,
                supporting = stringResource(
                    when (kind) {
                        ProviderKind.OLLAMA, ProviderKind.LMSTUDIO -> R.string.providers_base_url_local
                        ProviderKind.CUSTOM -> R.string.providers_base_url_custom
                        else -> R.string.providers_base_url_default
                    },
                ),
            )
            FacetTextField(
                headers, { headers = it }, label = stringResource(R.string.providers_headers), placeholder = "Header-Name: value",
                singleLine = false, minLines = 2, maxLines = 6, mono = true, imeAction = ImeAction.Default,
                supporting = stringResource(R.string.providers_headers_supporting),
            )
        }

        status?.let { (ok, text) ->
            Row(
                Modifier.fillMaxWidth().clip(FacetShapes.group).background(if (ok) c.primaryContainer else c.errorContainer).padding(14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FacetIcon(if (ok) R.drawable.ic_circle_check else R.drawable.ic_alert, null, tint = if (ok) c.onPrimaryContainer else c.error, size = 18.dp)
                Spacer(Modifier.width(10.dp))
                Text(text, style = FacetTheme.type.body, color = if (ok) c.onPrimaryContainer else c.text)
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FacetButton(
                stringResource(R.string.providers_test), {
                    testing = true
                    status = null
                    scope.launch {
                        val r = container.providers.verify(kind, baseUrl, key, parsedHeaders())
                        testing = false
                        status = if (r.isSuccess) {
                            true to Strings.get(if (key.isBlank()) R.string.providers_test_connected else R.string.providers_test_key_works)
                        } else {
                            val e = r.exceptionOrNull()
                            // This page is Providers already, so the rejected-key message drops its "Check it in Providers." advice.
                            val message = if (e is LlmException && e.error.kind == ErrorKind.AUTH) Strings.get(R.string.providers_key_rejected, kind.displayName)
                            else (e?.message ?: Strings.get(R.string.providers_test_failed))
                            false to message
                        }
                    }
                },
                style = ButtonStyle.Tonal, loading = testing, enabled = canSave, modifier = Modifier.weight(1f),
            )
            FacetButton(
                stringResource(if (existing == null) R.string.action_save else R.string.providers_save_changes), ::save,
                loading = saving, enabled = canSave, modifier = Modifier.weight(1f),
            )
        }

        existing?.let { p ->
            SettingsGroup {
                SwitchRow(
                    stringResource(R.string.providers_enabled), enabled,
                    { v -> enabled = v; scope.launch { container.providers.update(p.id, label, baseUrl, null, parsedHeaders(), v) } },
                    subtitle = stringResource(R.string.providers_enabled_subtitle), icon = R.drawable.ic_activity,
                )
            }
            ModelsSection(container, p, onAdd = { addModel = true })
            SettingsGroup {
                SettingsRow(
                    stringResource(R.string.providers_remove), subtitle = stringResource(R.string.providers_remove_subtitle),
                    icon = R.drawable.ic_delete, iconTint = c.error, titleColor = c.error, onClick = { confirmDelete = true },
                )
            }
        }
    }

    if (confirmDelete) {
        ConfirmDialog(
            stringResource(R.string.providers_remove_title, existing?.label.orEmpty()), stringResource(R.string.providers_remove_body),
            stringResource(R.string.action_remove), onConfirm = { existing?.let { p -> scope.launch { container.providers.delete(p.id); onDone() } } },
            onDismiss = { confirmDelete = false }, danger = true,
        )
    }
    if (addModel) {
        TextInputDialog(
            stringResource(R.string.providers_add_model_title), "", stringResource(R.string.providers_add_model_confirm),
            onConfirm = { id ->
                val p = existing ?: return@TextInputDialog
                val mid = id.trim()
                // Media-looking IDs (gpt-image-…, …-tts, flux-…) go to their media kind; you can correct it in the model's settings.
                val output = ModelCatalog.mediaOutput(kind, mid)?.takeIf { ModelCatalog.canRun(kind, it) }
                    ?: if (kind.style == ApiStyle.MEDIA) io.dtsoftware.facet.llm.ModelOutput.IMAGE else io.dtsoftware.facet.llm.ModelOutput.TEXT
                val caps = when {
                    output != io.dtsoftware.facet.llm.ModelOutput.TEXT -> io.dtsoftware.facet.llm.ModelCaps(tools = false)
                    kind.style == ApiStyle.ANTHROPIC -> ModelCatalog.claudeCaps(mid)
                    kind.style == ApiStyle.OPENAI_RESPONSES -> ModelCatalog.openAiCaps(mid)
                    else -> ModelCatalog.compatCaps(kind, mid)
                }
                scope.launch { container.providers.addCustomModel(p.id, ModelInfo(mid, ModelCatalog.displayName(kind, mid), caps = caps, output = output)) }
            },
            onDismiss = { addModel = false },
            placeholder = stringResource(R.string.providers_add_model_placeholder, "gpt-5.5", "claude-opus-5-5"),
        )
    }
}

@Composable
private fun ModelsSection(container: AppContainer, p: ProviderEntity, onAdd: () -> Unit) {
    val c = FacetTheme.colors
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showAll by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<String?>(null) }
    val models = remember(p.modelsJson, p.customModelsJson, p.capsOverridesJson, p.modelPrefsJson) { container.providers.models(p) }
    val favorites = remember(p.favoritesJson) { container.providers.favorites(p) }
    val prefs = remember(p.modelPrefsJson) { container.providers.modelPrefs(p) }
    val hidden = prefs.filterValues { it.hidden }.keys
    val filtered = models.filter { query.isBlank() || it.displayName.contains(query, true) || it.id.contains(query, true) }
    val shown = if (showAll || query.isNotBlank()) filtered else filtered.take(12)

    fun setHidden(ids: Collection<String>, value: Boolean) {
        menu = false
        scope.launch { container.providers.setHidden(p.id, ids, value) }
    }

    Column {
        Row(Modifier.padding(start = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (hidden.isEmpty()) stringResource(R.string.providers_models)
                else pluralStringResource(R.plurals.providers_models_hidden, hidden.size, hidden.size),
                style = FacetTheme.type.labelM, color = c.textTertiary, modifier = Modifier.weight(1f),
            )
            if (p.modelsFetchedAt > 0) {
                Text(
                    if (Dates.justNow(p.modelsFetchedAt)) stringResource(R.string.providers_updated_just_now)
                    else stringResource(R.string.providers_updated, Dates.relative(p.modelsFetchedAt)),
                    style = FacetTheme.type.labelS, color = c.textTertiary,
                )
            }
            if (models.isNotEmpty()) {
                Box {
                    FacetIconButton(R.drawable.ic_more_horiz, stringResource(R.string.providers_models_menu), { menu = true }, tint = c.textTertiary, size = 18.dp)
                    DropdownMenu(menu, { menu = false }, containerColor = c.surface, shape = RoundedCornerShape(16.dp)) {
                        val ids = filtered.map { it.id }
                        val showLabel = if (query.isBlank()) stringResource(R.string.providers_show_all)
                        else pluralStringResource(R.plurals.providers_show_matching, ids.size, ids.size)
                        val hideLabel = if (query.isBlank()) stringResource(R.string.providers_hide_all)
                        else pluralStringResource(R.plurals.providers_hide_matching, ids.size, ids.size)
                        MenuItem(R.drawable.ic_eye, showLabel) { setHidden(ids, false) }
                        MenuItem(R.drawable.ic_eye_off, hideLabel) { setHidden(ids, true) }
                        if (query.isBlank() && favorites.isNotEmpty()) {
                            MenuItem(R.drawable.ic_star, stringResource(R.string.providers_show_favorites)) {
                                menu = false
                                scope.launch {
                                    container.providers.setHidden(p.id, models.map { it.id }.filter { it !in favorites }, true)
                                    container.providers.setHidden(p.id, favorites, false)
                                }
                            }
                        }
                    }
                }
            }
        }
        Text(
            stringResource(R.string.providers_models_hint),
            style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
            modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
        )
        Column(Modifier.fillMaxWidth().clip(FacetShapes.group).background(c.surface).padding(vertical = 8.dp)) {
            Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FacetButton(
                    stringResource(R.string.providers_refresh), {
                        refreshing = true
                        error = null
                        scope.launch {
                            container.providers.refreshModels(p.id).onFailure { error = it.message }
                            refreshing = false
                        }
                    },
                    style = ButtonStyle.Tonal, icon = R.drawable.ic_sync, loading = refreshing, modifier = Modifier.weight(1f),
                )
                FacetButton(stringResource(R.string.providers_add_model), onAdd, style = ButtonStyle.Tonal, icon = R.drawable.ic_plus, modifier = Modifier.weight(1f))
            }
            error?.let { Text(it, style = FacetTheme.type.labelM, color = c.error, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
            if (models.size > 8) SearchField(query, { query = it }, stringResource(R.string.providers_filter_models), Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
            if (models.isEmpty()) {
                Text(stringResource(R.string.providers_models_empty), style = FacetTheme.type.body, color = c.textTertiary, modifier = Modifier.padding(16.dp))
            }
            val hiddenLabel = stringResource(R.string.providers_model_hidden)
            val editedLabel = stringResource(R.string.providers_model_edited)
            shown.forEach { m ->
                val isHidden = m.id in hidden
                val edited = prefs[m.id]?.customized == true
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { editing = m.id }
                        .padding(start = 16.dp, end = 4.dp, top = 2.dp, bottom = 2.dp)
                        .alpha(if (isHidden) 0.5f else 1f),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(m.displayName, style = FacetTheme.type.labelL, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            listOfNotNull(
                                if (isHidden) hiddenLabel else null, if (edited) editedLabel else null,
                                m.output.takeIf { it != io.dtsoftware.facet.llm.ModelOutput.TEXT }?.label, m.id,
                            ).joinToString(" · "),
                            style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    FacetIconButton(
                        if (isHidden) R.drawable.ic_eye_off else R.drawable.ic_eye,
                        stringResource(if (isHidden) R.string.providers_show_model else R.string.providers_hide_model, m.displayName),
                        { setHidden(listOf(m.id), !isHidden) },
                        tint = c.textTertiary, size = 18.dp,
                    )
                    FacetIconButton(
                        R.drawable.ic_star, stringResource(if (m.id in favorites) R.string.providers_unfavorite else R.string.providers_favorite),
                        { scope.launch { container.providers.toggleFavorite(p.id, m.id) } },
                        tint = if (m.id in favorites) io.dtsoftware.facet.ui.theme.GemPalette.Gold else c.textTertiary, size = 18.dp,
                    )
                }
            }
            if (!showAll && query.isBlank() && filtered.size > shown.size) {
                Text(
                    pluralStringResource(R.plurals.providers_show_all_count, filtered.size, filtered.size), style = FacetTheme.type.labelM, color = c.primary,
                    modifier = Modifier.clip(FacetShapes.small).clickable { showAll = true }.padding(horizontal = 16.dp, vertical = 10.dp),
                )
            }
        }
    }
    editing?.let { id -> ModelEditSheet(container, p.id, id) { editing = null } }
}
