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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.util.Dates
import io.dtsoftware.facet.data.db.ProviderEntity
import io.dtsoftware.facet.llm.ApiStyle
import io.dtsoftware.facet.llm.ModelCatalog
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ProviderKind
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
val ProviderOrder = listOf(
    ProviderKind.OPENAI, ProviderKind.ANTHROPIC, ProviderKind.GOOGLE, ProviderKind.OPENROUTER,
    ProviderKind.XAI, ProviderKind.DEEPSEEK, ProviderKind.MISTRAL, ProviderKind.GROQ, ProviderKind.CEREBRAS,
    ProviderKind.TOGETHER, ProviderKind.FIREWORKS, ProviderKind.PERPLEXITY, ProviderKind.OLLAMA,
    ProviderKind.LMSTUDIO, ProviderKind.CUSTOM,
)

@Composable
fun ProvidersScreen(container: AppContainer, onBack: () -> Unit, onEdit: (String) -> Unit, onAdd: (String) -> Unit) {
    val providers by container.providers.observeAll().collectAsStateWithLifecycle(emptyList())
    val c = FacetTheme.colors
    SettingsPage("Providers and keys", onBack) {
        if (providers.isEmpty()) {
            Text(
                "Facet talks to AI providers directly with your own API keys. Pick one to get started; you can add as many as you like.",
                style = FacetTheme.type.body, color = c.textSecondary, modifier = Modifier.padding(horizontal = 4.dp),
            )
        } else {
            SettingsGroup(title = "Connected") {
                providers.forEachIndexed { i, p ->
                    if (i > 0) GroupDivider()
                    val kind = ProviderKind.fromId(p.kind)
                    val count = remember(p.modelsJson, p.customModelsJson) { container.providers.models(p).size }
                    SettingsRow(
                        p.label,
                        subtitle = buildString {
                            if (p.label != kind.displayName) append(kind.displayName).append(" · ")
                            append(if (count == 1) "1 model" else "$count models")
                            if (!p.enabled) append(" · Off")
                        },
                        leading = { ProviderBadge(kind, size = 34.dp) },
                        onClick = { onEdit(p.id) },
                    )
                }
            }
        }
        SettingsGroup(title = if (providers.isEmpty()) null else "Add another") {
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
                status = false to ((result.exceptionOrNull()?.message ?: "Couldn't load models.") + " The provider was saved; you can add model IDs manually.")
            }
        }
    }

    SettingsPage(if (existing == null) "Add ${kind.displayName}" else existing!!.label, onDone) {
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
            label = if (needsKey) "API key" else "API key (optional)",
            placeholder = kind.keyHint,
            password = true,
            mono = true,
            supporting = "Encrypted on this device and synced end-to-end. Facet's server can't read it.",
            trailing = {
                FacetIconButton(R.drawable.ic_clipboard, "Paste", {
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
                Text(if (kind.requiresKey) "Get a ${kind.displayName} key" else "About ${kind.displayName}", style = FacetTheme.type.labelM, color = c.primary)
                Spacer(Modifier.width(4.dp))
                FacetIcon(R.drawable.ic_external, null, tint = c.primary, size = 14.dp)
            }
        }
        FacetTextField(label, { label = it }, label = "Name", placeholder = kind.displayName, supporting = "Useful when you add more than one key, e.g. Work or Personal.")

        if (!advanced) {
            Text(
                "Advanced settings", style = FacetTheme.type.labelM, color = c.textSecondary,
                modifier = Modifier.clip(FacetShapes.small).clickable { advanced = true }.padding(4.dp),
            )
        } else {
            FacetTextField(
                baseUrl, { baseUrl = it.trim() }, label = "Base URL", mono = true, keyboardType = KeyboardType.Uri,
                supporting = when (kind) {
                    ProviderKind.OLLAMA, ProviderKind.LMSTUDIO -> "Your computer's address on the local network, e.g. http://192.168.1.20:11434/v1"
                    ProviderKind.CUSTOM -> "Any OpenAI-compatible endpoint, ending before /chat/completions."
                    else -> "Change only for a proxy or a compatible gateway."
                },
            )
            FacetTextField(
                headers, { headers = it }, label = "Extra headers", placeholder = "Header-Name: value",
                singleLine = false, minLines = 2, maxLines = 6, mono = true, imeAction = ImeAction.Default,
                supporting = "One per line. Sent with every request to this provider.",
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
                "Test", {
                    testing = true
                    status = null
                    scope.launch {
                        val r = container.providers.verify(kind, baseUrl, key, parsedHeaders())
                        testing = false
                        status = if (r.isSuccess) true to "Connected. This key works." else false to (r.exceptionOrNull()?.message ?: "That didn't work.")
                    }
                },
                style = ButtonStyle.Tonal, loading = testing, enabled = canSave, modifier = Modifier.weight(1f),
            )
            FacetButton(if (existing == null) "Save" else "Save changes", ::save, loading = saving, enabled = canSave, modifier = Modifier.weight(1f))
        }

        existing?.let { p ->
            SettingsGroup {
                SwitchRow("Enabled", enabled, { v -> enabled = v; scope.launch { container.providers.update(p.id, label, baseUrl, null, parsedHeaders(), v) } }, subtitle = "Turn off to hide its models without deleting the key.", icon = R.drawable.ic_activity)
            }
            ModelsSection(container, p, onAdd = { addModel = true })
            SettingsGroup {
                SettingsRow(
                    "Remove provider", subtitle = "Deletes this key from all your devices.",
                    icon = R.drawable.ic_delete, iconTint = c.error, titleColor = c.error, onClick = { confirmDelete = true },
                )
            }
        }
    }

    if (confirmDelete) {
        ConfirmDialog(
            "Remove ${existing?.label}?", "The key is deleted from all your devices. Chats that used it stay, but need another model to continue.",
            "Remove", onConfirm = { existing?.let { p -> scope.launch { container.providers.delete(p.id); onDone() } } },
            onDismiss = { confirmDelete = false }, danger = true,
        )
    }
    if (addModel) {
        TextInputDialog(
            "Add a model ID", "", "Add",
            onConfirm = { id ->
                val p = existing ?: return@TextInputDialog
                val mid = id.trim()
                val caps = when (kind.style) {
                    ApiStyle.ANTHROPIC -> ModelCatalog.claudeCaps(mid)
                    ApiStyle.OPENAI_RESPONSES -> ModelCatalog.openAiCaps(mid)
                    ApiStyle.OPENAI_CHAT -> ModelCatalog.compatCaps(kind, mid)
                }
                scope.launch { container.providers.addCustomModel(p.id, ModelInfo(mid, ModelCatalog.displayName(kind, mid), caps = caps)) }
            },
            onDismiss = { addModel = false },
            placeholder = "e.g. gpt-5.5 or claude-opus-5-5",
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
    val models = remember(p.modelsJson, p.customModelsJson, p.capsOverridesJson) { container.providers.models(p) }
    val favorites = remember(p.favoritesJson) { container.providers.favorites(p) }
    val filtered = models.filter { query.isBlank() || it.displayName.contains(query, true) || it.id.contains(query, true) }
    val shown = if (showAll || query.isNotBlank()) filtered else filtered.take(12)

    Column {
        Row(Modifier.padding(start = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Models", style = FacetTheme.type.labelM, color = c.textTertiary, modifier = Modifier.weight(1f))
            if (p.modelsFetchedAt > 0) Text("Updated " + Dates.relative(p.modelsFetchedAt).replaceFirstChar { it.lowercase() }, style = FacetTheme.type.labelS, color = c.textTertiary)
        }
        Column(Modifier.fillMaxWidth().clip(FacetShapes.group).background(c.surface).padding(vertical = 8.dp)) {
            Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FacetButton(
                    "Refresh", {
                        refreshing = true
                        error = null
                        scope.launch {
                            container.providers.refreshModels(p.id).onFailure { error = it.message }
                            refreshing = false
                        }
                    },
                    style = ButtonStyle.Tonal, icon = R.drawable.ic_sync, loading = refreshing, modifier = Modifier.weight(1f),
                )
                FacetButton("Add model ID", onAdd, style = ButtonStyle.Tonal, icon = R.drawable.ic_plus, modifier = Modifier.weight(1f))
            }
            error?.let { Text(it, style = FacetTheme.type.labelM, color = c.error, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
            if (models.size > 8) SearchField(query, { query = it }, "Filter models", Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
            if (models.isEmpty()) {
                Text("No models yet. Refresh, or add a model ID.", style = FacetTheme.type.body, color = c.textTertiary, modifier = Modifier.padding(16.dp))
            }
            shown.forEach { m ->
                Row(
                    Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(m.displayName, style = FacetTheme.type.labelL, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(m.id, style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    FacetIconButton(
                        R.drawable.ic_star, if (m.id in favorites) "Unfavorite" else "Favorite",
                        { scope.launch { container.providers.toggleFavorite(p.id, m.id) } },
                        tint = if (m.id in favorites) io.dtsoftware.facet.ui.theme.GemPalette.Gold else c.textTertiary, size = 18.dp,
                    )
                }
            }
            if (!showAll && query.isBlank() && filtered.size > shown.size) {
                Text(
                    "Show all ${filtered.size}", style = FacetTheme.type.labelM, color = c.primary,
                    modifier = Modifier.clip(FacetShapes.small).clickable { showAll = true }.padding(horizontal = 16.dp, vertical = 10.dp),
                )
            }
        }
    }
}
