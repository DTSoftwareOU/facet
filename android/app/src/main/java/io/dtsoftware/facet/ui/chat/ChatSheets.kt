package io.dtsoftware.facet.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.util.Format
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.data.repo.ProviderModels
import io.dtsoftware.facet.data.usage
import io.dtsoftware.facet.llm.Effort
import io.dtsoftware.facet.llm.GenParams
import io.dtsoftware.facet.llm.ModelCaps
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ReasoningKind
import io.dtsoftware.facet.llm.Verbosity
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.FacetIconButton
import io.dtsoftware.facet.ui.components.FacetSheet
import io.dtsoftware.facet.ui.components.FacetTextField
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.ProviderBadge
import io.dtsoftware.facet.ui.components.SectionLabel
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SwitchRow
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme

// ---------------- Model picker ----------------

@Composable
fun ModelPickerSheet(
    catalog: List<ProviderModels>,
    selected: ModelRef?,
    onSelect: (ModelRef) -> Unit,
    onToggleFavorite: (String, String) -> Unit,
    onManageProviders: () -> Unit,
    onRefresh: (String) -> Unit,
    onDismiss: () -> Unit,
    /** Long-press on a model opens its settings (provider id, model id). */
    onCustomize: ((String, String) -> Unit)? = null,
) {
    var query by remember { mutableStateOf("") }
    var revealed by remember { mutableStateOf(emptySet<String>()) }
    val c = FacetTheme.colors
    FacetSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f).imePadding()) {
            Row(Modifier.padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Choose a model", style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.weight(1f))
                FacetIconButton(R.drawable.ic_key, "Manage providers", onManageProviders, tint = c.textSecondary)
            }
            SearchField(query, { query = it }, "Search models", Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            if (catalog.isEmpty()) {
                Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("No providers yet", style = FacetTheme.type.titleM, color = c.text)
                    Spacer(Modifier.height(6.dp))
                    Text("Add an API key to see its models here.", style = FacetTheme.type.body, color = c.textSecondary)
                    Spacer(Modifier.height(16.dp))
                    FacetButton("Add a provider", onManageProviders, icon = R.drawable.ic_plus)
                }
                return@Column
            }
            val q = query.trim().lowercase()
            LazyColumn(Modifier.weight(1f), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp)) {
                val favorites = catalog.flatMap { pm -> pm.models.filter { it.id in pm.favorites && it.id !in pm.hidden }.map { pm to it } }
                    .filter { (_, m) -> q.isEmpty() || m.displayName.lowercase().contains(q) || m.id.lowercase().contains(q) }
                if (favorites.isNotEmpty()) {
                    item(key = "fav-header") { SectionLabel("Favorites", Modifier.padding(start = 20.dp, top = 12.dp)) }
                    items(favorites, key = { (pm, m) -> "fav/${pm.provider.id}/${m.id}" }) { (pm, m) ->
                        ModelRow(
                            pm, m, selected, true, showProvider = true, onSelect = { onSelect(ModelRef(pm.provider.id, m.id)) },
                            onLongClick = onCustomize?.let { f -> { f(pm.provider.id, m.id) } },
                        ) { onToggleFavorite(pm.provider.id, m.id) }
                    }
                }
                catalog.forEach { pm ->
                    val matching = pm.models.filter { q.isEmpty() || it.displayName.lowercase().contains(q) || it.id.lowercase().contains(q) }
                    val hiddenMatches = matching.filter { it.id in pm.hidden }
                    val showHidden = pm.provider.id in revealed
                    val models = if (showHidden) matching else matching.filter { it.id !in pm.hidden }
                    item(key = "hdr/${pm.provider.id}") {
                        Row(
                            Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 16.dp, bottom = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            ProviderBadge(pm.kind, size = 22.dp)
                            Spacer(Modifier.width(10.dp))
                            Text(pm.provider.label, style = FacetTheme.type.labelM, color = c.textSecondary, modifier = Modifier.weight(1f))
                            FacetIconButton(R.drawable.ic_sync, "Refresh models", { onRefresh(pm.provider.id) }, tint = c.textTertiary, size = 16.dp)
                        }
                    }
                    if (models.isEmpty() && hiddenMatches.isEmpty()) {
                        item(key = "empty/${pm.provider.id}") {
                            Text(
                                if (q.isEmpty()) "No models loaded. Tap refresh, or add a model ID in Providers." else "No matches.",
                                style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal),
                                color = c.textTertiary,
                                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                            )
                        }
                    }
                    items(models, key = { "${pm.provider.id}/${it.id}" }) { m ->
                        ModelRow(
                            pm, m, selected, m.id in pm.favorites, showProvider = false, onSelect = { onSelect(ModelRef(pm.provider.id, m.id)) },
                            dimmed = m.id in pm.hidden,
                            onLongClick = onCustomize?.let { f -> { f(pm.provider.id, m.id) } },
                        ) { onToggleFavorite(pm.provider.id, m.id) }
                    }
                    if (hiddenMatches.isNotEmpty()) {
                        item(key = "hidden/${pm.provider.id}") {
                            Text(
                                if (showHidden) "Hide ${hiddenMatches.size} hidden" else "${hiddenMatches.size} hidden · Show",
                                style = FacetTheme.type.labelM, color = c.textTertiary,
                                modifier = Modifier
                                    .padding(horizontal = 12.dp)
                                    .clip(RoundedCornerShape(10.dp))
                                    .clickable { revealed = if (showHidden) revealed - pm.provider.id else revealed + pm.provider.id }
                                    .padding(horizontal = 8.dp, vertical = 8.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ModelRow(
    pm: ProviderModels,
    m: ModelInfo,
    selected: ModelRef?,
    favorite: Boolean,
    showProvider: Boolean,
    onSelect: () -> Unit,
    dimmed: Boolean = false,
    onLongClick: (() -> Unit)? = null,
    onFavorite: () -> Unit,
) {
    val c = FacetTheme.colors
    val isSelected = selected?.providerId == pm.provider.id && selected.modelId == m.id
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (isSelected) c.primaryContainer else androidx.compose.ui.graphics.Color.Transparent)
            .combinedClickable(onClick = onSelect, onLongClick = onLongClick, onLongClickLabel = if (onLongClick != null) "Edit model" else null)
            .alpha(if (dimmed) 0.5f else 1f)
            .padding(start = 12.dp, end = 2.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    m.displayName, style = FacetTheme.type.labelL, color = if (isSelected) c.onPrimaryContainer else c.text,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.width(8.dp))
                CapIcons(m.caps)
            }
            val details = buildList {
                if (showProvider) add(pm.provider.label)
                m.contextWindow?.let { add("${Format.contextWindow(it)} context") }
                m.pricing?.let { add("\$${trimPrice(it.input)} / \$${trimPrice(it.output)} per 1M") }
            }
            if (details.isNotEmpty()) {
                Text(
                    details.joinToString(" · "),
                    style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal),
                    color = if (isSelected) c.onPrimaryContainer.copy(alpha = 0.75f) else c.textTertiary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        FacetIconButton(
            R.drawable.ic_star, if (favorite) "Remove from favorites" else "Add to favorites", onFavorite,
            tint = if (favorite) io.dtsoftware.facet.ui.theme.GemPalette.Gold else c.textTertiary, size = 18.dp,
        )
    }
}

private fun trimPrice(v: Double): String = if (v >= 1) String.format(java.util.Locale.US, "%.2f", v).removeSuffix(".00") else
    String.format(java.util.Locale.US, "%.3f", v).trimEnd('0').trimEnd('.')

@Composable
private fun CapIcons(caps: ModelCaps) {
    val c = FacetTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (caps.vision) FacetIcon(R.drawable.ic_eye, "Sees images", tint = c.textTertiary, size = 14.dp)
        if (caps.reasoning.kind != ReasoningKind.NONE) FacetIcon(R.drawable.ic_brain, "Reasoning", tint = c.textTertiary, size = 14.dp)
        if (caps.webSearch) FacetIcon(R.drawable.ic_globe, "Web search", tint = c.textTertiary, size = 14.dp)
        if (caps.pdf) FacetIcon(R.drawable.ic_file_text, "Reads PDFs", tint = c.textTertiary, size = 14.dp)
    }
}

@Composable
fun SearchField(value: String, onChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier) {
    val c = FacetTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .height(46.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(c.surfaceHigh)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FacetIcon(R.drawable.ic_search, null, tint = c.textTertiary, size = 18.dp)
        Spacer(Modifier.width(10.dp))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) Text(placeholder, style = FacetTheme.type.body, color = c.textTertiary)
            BasicTextField(
                value, onChange, singleLine = true,
                textStyle = FacetTheme.type.body.copy(color = c.text),
                cursorBrush = SolidColor(c.primary),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (value.isNotEmpty()) FacetIconButton(R.drawable.ic_close, "Clear", { onChange("") }, tint = c.textTertiary, size = 16.dp, modifier = Modifier.size(36.dp))
    }
}

// ---------------- Chat settings (parameters) ----------------

@Composable
fun ChatSettingsSheet(
    searchAvailable: Boolean,
    mcpServers: List<io.dtsoftware.facet.data.db.McpServerEntity>,
    skillCount: Int,
    mcpToolCount: (io.dtsoftware.facet.data.db.McpServerEntity) -> Int,
    yolo: Boolean,
    onYolo: (Boolean) -> Unit,
    model: ModelChoice?,
    params: GenParams,
    systemPrompt: String?,
    canEditInstructions: Boolean,
    onParams: (GenParams) -> Unit,
    onSystemPrompt: (String) -> Unit,
    onChangeModel: () -> Unit,
    onMakeDefault: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = FacetTheme.colors
    val caps = model?.model?.caps ?: ModelCaps()
    var instructions by remember { mutableStateOf(systemPrompt.orEmpty()) }
    FacetSheet({ if (canEditInstructions && instructions != systemPrompt.orEmpty()) onSystemPrompt(instructions); onDismiss() }) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .navigationBarsPadding()
                .imePadding(),
        ) {
            Text("Chat settings", style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(start = 4.dp, top = 4.dp, bottom = 14.dp))
            SettingsGroup {
                io.dtsoftware.facet.ui.components.SettingsRow(
                    title = model?.model?.displayName ?: "No model selected",
                    subtitle = model?.providerLabel,
                    leading = { model?.let { ProviderBadge(it.kind, size = 30.dp) } },
                    onClick = {
                        if (canEditInstructions && instructions != systemPrompt.orEmpty()) onSystemPrompt(instructions)
                        onChangeModel()
                    },
                )
            }
            Spacer(Modifier.height(16.dp))

            if (caps.reasoning.kind != ReasoningKind.NONE) {
                SectionLabel("Reasoning", Modifier.padding(start = 12.dp))
                Segmented(
                    options = listOf<Effort?>(null) + caps.reasoning.efforts,
                    selected = params.effort,
                    label = { it?.label ?: "Auto" },
                    onSelect = { onParams(params.copy(effort = it)) },
                )
                Text(
                    effortHint(params.effort),
                    style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
                    modifier = Modifier.padding(start = 12.dp, top = 8.dp, bottom = 10.dp),
                )
                SettingsGroup {
                    SwitchRow(
                        "Show reasoning", params.showThinking, { onParams(params.copy(showThinking = it)) },
                        subtitle = "Stream the model's reasoning summary while it thinks.", icon = R.drawable.ic_brain,
                    )
                    if (caps.proMode) {
                        GroupDivider()
                        SwitchRow(
                            "Pro mode", params.proMode, { onParams(params.copy(proMode = it)) },
                            subtitle = "Does more work per answer. Slower and costs more.", icon = R.drawable.ic_gem,
                        )
                    }
                }
                Spacer(Modifier.height(16.dp))
            }

            if (caps.verbosity) {
                SectionLabel("Length", Modifier.padding(start = 12.dp))
                Segmented(
                    options = listOf<Verbosity?>(null) + Verbosity.entries,
                    selected = params.verbosity,
                    label = { it?.label ?: "Auto" },
                    onSelect = { onParams(params.copy(verbosity = it)) },
                )
                Spacer(Modifier.height(16.dp))
            }

            val canSearch = caps.webSearch || (caps.tools && searchAvailable)
            SettingsGroup(title = "Tools and speed") {
                SwitchRow(
                    "Web search", params.webSearch && canSearch, { onParams(params.copy(webSearch = it)) },
                    subtitle = when {
                        caps.webSearch -> "Let the model search the web and cite sources."
                        canSearch -> "Uses your search key, then reads pages as needed."
                        caps.tools -> "Add a search key in Settings → Web search to let this model search."
                        else -> "This model can't use tools or search the web."
                    },
                    icon = R.drawable.ic_globe, enabled = canSearch,
                )
                if (caps.tools && (mcpServers.isNotEmpty() || skillCount > 0)) {
                    GroupDivider()
                    SwitchRow(
                        "MCP tools and skills", params.tools, { onParams(params.copy(tools = it)) },
                        subtitle = buildString {
                            val parts = buildList {
                                if (mcpServers.isNotEmpty()) add("${mcpServers.size} server" + if (mcpServers.size == 1) "" else "s")
                                if (skillCount > 0) add("$skillCount skill" + if (skillCount == 1) "" else "s")
                            }
                            append(parts.joinToString(" and ")).append(" available in this chat.")
                        },
                        icon = R.drawable.ic_wand,
                    )
                    if (params.tools) {
                        mcpServers.forEach { server ->
                            GroupDivider()
                            val on = server.id !in params.disabledMcpServers
                            SwitchRow(
                                server.name, on,
                                { v ->
                                    val set = params.disabledMcpServers.toMutableSet().apply { if (v) remove(server.id) else add(server.id) }
                                    onParams(params.copy(disabledMcpServers = set.toList()))
                                },
                                subtitle = server.status ?: "${mcpToolCount(server)} tools",
                                icon = R.drawable.ic_server,
                            )
                        }
                    }
                }
                if (caps.tools) {
                    GroupDivider()
                    SwitchRow(
                        "YOLO mode", yolo, onYolo,
                        subtitle = "Run tools without asking, in every chat.",
                        icon = R.drawable.ic_rocket,
                    )
                }
                if (caps.fastMode) {
                    GroupDivider()
                    SwitchRow(
                        "Fast mode", params.fastMode, { onParams(params.copy(fastMode = it)) },
                        subtitle = "Up to 2.5× faster output at premium pricing.", icon = R.drawable.ic_zap,
                    )
                }
            }
            Spacer(Modifier.height(16.dp))

            if (caps.sampling) {
                SectionLabel("Temperature", Modifier.padding(start = 12.dp))
                val temp = params.temperature
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 8.dp)) {
                    Slider(
                        value = temp ?: 1f,
                        onValueChange = { onParams(params.copy(temperature = (it * 20).toInt() / 20f)) },
                        valueRange = 0f..2f,
                        modifier = Modifier.weight(1f),
                        colors = SliderDefaults.colors(thumbColor = c.primary, activeTrackColor = c.primary, inactiveTrackColor = c.surfaceHighest),
                    )
                    Spacer(Modifier.width(12.dp))
                    Text(
                        temp?.let { String.format(java.util.Locale.US, "%.2f", it) } ?: "Auto",
                        style = FacetTheme.type.labelM, color = c.textSecondary,
                        modifier = Modifier.clip(FacetShapes.small).clickable { onParams(params.copy(temperature = null)) }.padding(6.dp),
                    )
                }
                Spacer(Modifier.height(8.dp))
            }

            SectionLabel("Maximum reply length", Modifier.padding(start = 12.dp))
            val maxOptions = listOf<Int?>(null, 2_000, 8_000, 16_000, 32_000, 64_000)
            Segmented(
                options = maxOptions,
                selected = params.maxOutputTokens,
                label = { it?.let { n -> Format.tokens(n.toLong()) } ?: "Auto" },
                onSelect = { onParams(params.copy(maxOutputTokens = it)) },
            )
            Spacer(Modifier.height(16.dp))

            if (canEditInstructions) {
                FacetTextField(
                    instructions, { instructions = it },
                    label = "Instructions for this chat",
                    placeholder = "e.g. Answer in Spanish. Keep replies under 150 words.",
                    singleLine = false, minLines = 3, maxLines = 8,
                    supporting = "Added to the assistant's instructions for this chat only.",
                )
                Spacer(Modifier.height(16.dp))
            }
            FacetButton("Use these settings for new chats", onMakeDefault, style = ButtonStyle.Tonal, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(20.dp))
        }
    }
}

private fun effortHint(e: Effort?): String = when (e) {
    null -> "The model decides how long to think."
    Effort.NONE -> "Answers immediately without extended reasoning."
    Effort.MINIMAL, Effort.LOW -> "Quick answers for simple questions. Cheapest."
    Effort.MEDIUM -> "Balanced depth, speed and cost."
    Effort.HIGH -> "Thinks longer for harder problems."
    Effort.XHIGH, Effort.MAX -> "Maximum depth for the hardest problems. Slowest and most expensive."
}

@Composable
fun <T> Segmented(options: List<T>, selected: T, label: (T) -> String, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
    val c = FacetTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .clip(RoundedCornerShape(14.dp))
            .background(c.surfaceHigh)
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        options.forEach { o ->
            val sel = o == selected
            Box(
                Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (sel) c.surface else androidx.compose.ui.graphics.Color.Transparent)
                    .then(if (sel) Modifier.border(1.dp, c.outline, RoundedCornerShape(10.dp)) else Modifier)
                    .clickable { onSelect(o) }
                    .padding(horizontal = 14.dp, vertical = 9.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label(o), style = FacetTheme.type.labelM, color = if (sel) c.text else c.textSecondary, maxLines = 1)
            }
        }
    }
}

// ---------------- Message menu ----------------

data class MenuEntry(val icon: Int, val label: String, val danger: Boolean = false, val onClick: () -> Unit)

@Composable
fun MenuSheet(title: String?, entries: List<MenuEntry>, onDismiss: () -> Unit) {
    val c = FacetTheme.colors
    FacetSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            if (title != null) {
                Text(
                    title, style = FacetTheme.type.labelM, color = c.textTertiary, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
                )
            }
            entries.forEach { e ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { e.onClick(); onDismiss() }
                        .padding(horizontal = 24.dp, vertical = 15.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    FacetIcon(e.icon, null, tint = if (e.danger) c.error else c.textSecondary, size = 20.dp)
                    Spacer(Modifier.width(18.dp))
                    Text(e.label, style = FacetTheme.type.labelL, color = if (e.danger) c.error else c.text)
                }
            }
        }
    }
}

@Composable
fun UsageSheet(item: ThreadItem, onDismiss: () -> Unit) {
    val m = item.message
    val u = remember(m.usageJson) { m.usage() }
    val c = FacetTheme.colors
    FacetSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 24.dp).padding(bottom = 24.dp)) {
            Text("Usage", style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(bottom = 4.dp))
            Text(m.modelName ?: m.modelId.orEmpty(), style = FacetTheme.type.labelM, color = c.textSecondary, modifier = Modifier.padding(bottom = 16.dp))
            fun row(label: String, value: String) = label to value
            val rows = buildList {
                if (u != null) {
                    add(row("Input tokens", "%,d".format(u.inputTokens)))
                    if (u.cacheReadTokens > 0) add(row("  of which read from cache", "%,d".format(u.cacheReadTokens)))
                    if (u.cacheWriteTokens > 0) add(row("  of which written to cache", "%,d".format(u.cacheWriteTokens)))
                    add(row("Output tokens", "%,d".format(u.outputTokens)))
                    if (u.reasoningTokens > 0) add(row("Reasoning tokens (in output)", "%,d".format(u.reasoningTokens)))
                }
                add(row("Estimated cost", m.costUsd?.let { Format.cost(it) } ?: "Unknown price"))
                m.thinkingMs?.let { add(row("Thinking time", Format.seconds(it))) }
            }
            rows.forEach { (k, v) ->
                Row(Modifier.fillMaxWidth().padding(vertical = 9.dp)) {
                    Text(k, style = FacetTheme.type.body, color = c.textSecondary, modifier = Modifier.weight(1f))
                    Text(v, style = FacetTheme.type.labelL, color = c.text)
                }
            }
            Spacer(Modifier.height(8.dp))
            Text(
                "Costs are estimates from public price lists. Your provider's bill is the source of truth.",
                style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
            )
        }
    }
}

@Composable
fun EditMessageSheet(initial: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf(initial) }
    val c = FacetTheme.colors
    FacetSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).navigationBarsPadding().imePadding().padding(bottom = 16.dp)) {
            Text("Edit message", style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(start = 4.dp, bottom = 4.dp))
            Text(
                "Sending creates a new branch. The original stays one tap away.",
                style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary,
                modifier = Modifier.padding(start = 4.dp, bottom = 14.dp),
            )
            FacetTextField(text, { text = it }, singleLine = false, minLines = 3, maxLines = 12)
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FacetButton("Cancel", onDismiss, style = ButtonStyle.Tonal, modifier = Modifier.weight(1f))
                FacetButton("Send", { onSave(text); onDismiss() }, enabled = text.isNotBlank(), modifier = Modifier.weight(1f))
            }
        }
    }
}

/** Full-screen-ish selectable text for copying part of a message. */
@Composable
fun SelectTextSheet(text: String, onDismiss: () -> Unit) {
    val c = FacetTheme.colors
    FacetSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.9f).padding(horizontal = 20.dp).navigationBarsPadding()) {
            Text("Select text", style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(bottom = 12.dp))
            androidx.compose.foundation.text.selection.SelectionContainer(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                Text(text, style = FacetTheme.type.chat, color = c.text, modifier = Modifier.heightIn(min = 100.dp).padding(bottom = 24.dp))
            }
        }
    }
}
