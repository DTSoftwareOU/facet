package io.dtsoftware.facet.ui.chat

import androidx.annotation.StringRes
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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
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
                Text(stringResource(R.string.sheet_model_picker_title), style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.weight(1f))
                FacetIconButton(R.drawable.ic_key, stringResource(R.string.sheet_manage_providers), onManageProviders, tint = c.textSecondary)
            }
            SearchField(query, { query = it }, stringResource(R.string.sheet_search_models), Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            if (catalog.isEmpty()) {
                Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.sheet_no_providers_title), style = FacetTheme.type.titleM, color = c.text)
                    Spacer(Modifier.height(6.dp))
                    Text(stringResource(R.string.sheet_no_providers_body), style = FacetTheme.type.body, color = c.textSecondary)
                    Spacer(Modifier.height(16.dp))
                    FacetButton(stringResource(R.string.sheet_add_provider), onManageProviders, icon = R.drawable.ic_plus)
                }
                return@Column
            }
            val q = query.trim().lowercase()
            LazyColumn(Modifier.weight(1f), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp)) {
                val favorites = catalog.flatMap { pm -> pm.models.filter { it.id in pm.favorites && it.id !in pm.hidden }.map { pm to it } }
                    .filter { (_, m) -> q.isEmpty() || m.displayName.lowercase().contains(q) || m.id.lowercase().contains(q) }
                if (favorites.isNotEmpty()) {
                    item(key = "fav-header") { SectionLabel(stringResource(R.string.sheet_favorites), Modifier.padding(start = 20.dp, top = 12.dp)) }
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
                            FacetIconButton(R.drawable.ic_sync, stringResource(R.string.sheet_refresh_models), { onRefresh(pm.provider.id) }, tint = c.textTertiary, size = 16.dp)
                        }
                    }
                    if (models.isEmpty() && hiddenMatches.isEmpty()) {
                        item(key = "empty/${pm.provider.id}") {
                            Text(
                                stringResource(if (q.isEmpty()) R.string.sheet_no_models_loaded else R.string.sheet_no_matches),
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
                                pluralStringResource(
                                    if (showHidden) R.plurals.sheet_hide_hidden_models else R.plurals.sheet_show_hidden_models,
                                    hiddenMatches.size, hiddenMatches.size,
                                ),
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
            .combinedClickable(onClick = onSelect, onLongClick = onLongClick, onLongClickLabel = if (onLongClick != null) stringResource(R.string.sheet_edit_model) else null)
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
            val contextLabel = m.contextWindow?.let { stringResource(R.string.sheet_model_context, Format.contextWindow(it)) }
            val pricing = m.pricing?.let { stringResource(R.string.sheet_model_price, price(it.input), price(it.output)) }
            val details = listOfNotNull(pm.provider.label.takeIf { showProvider }, contextLabel, pricing)
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
            R.drawable.ic_star, stringResource(if (favorite) R.string.sheet_remove_favorite else R.string.sheet_add_favorite), onFavorite,
            tint = if (favorite) io.dtsoftware.facet.ui.theme.GemPalette.Gold else c.textTertiary, size = 18.dp,
        )
    }
}

/** A price in US dollars per million tokens, in the app's language: "$3", "$2.50", "$0.075". */
private fun price(usd: Double): String = java.text.NumberFormat.getCurrencyInstance(Strings.locale).apply {
    currency = java.util.Currency.getInstance("USD")
    val whole = usd >= 1 && Math.round(usd * 100) % 100 == 0L
    minimumFractionDigits = if (usd >= 1 && !whole) 2 else 0
    maximumFractionDigits = if (usd >= 1) (if (whole) 0 else 2) else 3
    roundingMode = java.math.RoundingMode.HALF_UP
}.format(usd)

/** A temperature with two decimals, in the app's language ("0.70"). */
private fun temperature(t: Float): String = java.text.NumberFormat.getNumberInstance(Strings.locale).apply {
    minimumFractionDigits = 2
    maximumFractionDigits = 2
    roundingMode = java.math.RoundingMode.HALF_UP
}.format(t.toDouble())

@Composable
private fun CapIcons(caps: ModelCaps) {
    val c = FacetTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (caps.vision) FacetIcon(R.drawable.ic_eye, stringResource(R.string.sheet_cap_vision), tint = c.textTertiary, size = 14.dp)
        if (caps.reasoning.kind != ReasoningKind.NONE) FacetIcon(R.drawable.ic_brain, stringResource(R.string.sheet_cap_reasoning), tint = c.textTertiary, size = 14.dp)
        if (caps.webSearch) FacetIcon(R.drawable.ic_globe, stringResource(R.string.sheet_web_search), tint = c.textTertiary, size = 14.dp)
        if (caps.pdf) FacetIcon(R.drawable.ic_file_text, stringResource(R.string.sheet_cap_pdf), tint = c.textTertiary, size = 14.dp)
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
        if (value.isNotEmpty()) FacetIconButton(R.drawable.ic_close, stringResource(R.string.sheet_clear_search), { onChange("") }, tint = c.textTertiary, size = 16.dp, modifier = Modifier.size(36.dp))
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
    val auto = stringResource(R.string.common_auto)
    FacetSheet({ if (canEditInstructions && instructions != systemPrompt.orEmpty()) onSystemPrompt(instructions); onDismiss() }) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp)
                .navigationBarsPadding()
                .imePadding(),
        ) {
            Text(stringResource(R.string.sheet_chat_settings_title), style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(start = 4.dp, top = 4.dp, bottom = 14.dp))
            SettingsGroup {
                io.dtsoftware.facet.ui.components.SettingsRow(
                    title = model?.model?.displayName ?: stringResource(R.string.sheet_no_model_selected),
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
                SectionLabel(stringResource(R.string.sheet_reasoning), Modifier.padding(start = 12.dp))
                Segmented(
                    options = listOf<Effort?>(null) + caps.reasoning.efforts,
                    selected = params.effort,
                    label = { it?.label ?: auto },
                    onSelect = { onParams(params.copy(effort = it)) },
                )
                Text(
                    stringResource(effortHint(params.effort)),
                    style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
                    modifier = Modifier.padding(start = 12.dp, top = 8.dp, bottom = 10.dp),
                )
                SettingsGroup {
                    SwitchRow(
                        stringResource(R.string.sheet_show_reasoning), params.showThinking, { onParams(params.copy(showThinking = it)) },
                        subtitle = stringResource(R.string.sheet_show_reasoning_subtitle), icon = R.drawable.ic_brain,
                    )
                    if (caps.proMode) {
                        GroupDivider()
                        SwitchRow(
                            stringResource(R.string.sheet_pro_mode), params.proMode, { onParams(params.copy(proMode = it)) },
                            subtitle = stringResource(R.string.sheet_pro_mode_subtitle), icon = R.drawable.ic_gem,
                        )
                    }
                }
                Spacer(Modifier.height(16.dp))
            }

            if (caps.verbosity) {
                SectionLabel(stringResource(R.string.sheet_length), Modifier.padding(start = 12.dp))
                Segmented(
                    options = listOf<Verbosity?>(null) + Verbosity.entries,
                    selected = params.verbosity,
                    label = { it?.label ?: auto },
                    onSelect = { onParams(params.copy(verbosity = it)) },
                )
                Spacer(Modifier.height(16.dp))
            }

            val canSearch = caps.webSearch || (caps.tools && searchAvailable)
            SettingsGroup(title = stringResource(R.string.sheet_tools_and_speed)) {
                SwitchRow(
                    stringResource(R.string.sheet_web_search), params.webSearch && canSearch, { onParams(params.copy(webSearch = it)) },
                    subtitle = stringResource(
                        when {
                            caps.webSearch -> R.string.sheet_web_search_builtin
                            canSearch -> R.string.sheet_web_search_with_key
                            caps.tools -> R.string.sheet_web_search_needs_key
                            else -> R.string.sheet_web_search_unsupported
                        },
                    ),
                    icon = R.drawable.ic_globe, enabled = canSearch,
                )
                if (caps.tools && (mcpServers.isNotEmpty() || skillCount > 0)) {
                    GroupDivider()
                    // "2 servers and 3 skills", joined the way the app's language joins lists.
                    val servers = mcpServers.size.takeIf { it > 0 }?.let { pluralStringResource(R.plurals.sheet_mcp_server_count, it, it) }
                    val skills = skillCount.takeIf { it > 0 }?.let { pluralStringResource(R.plurals.sheet_skill_count, it, it) }
                    val available = android.icu.text.ListFormatter.getInstance(Strings.locale).format(listOfNotNull(servers, skills))
                    SwitchRow(
                        stringResource(R.string.sheet_mcp_tools), params.tools, { onParams(params.copy(tools = it)) },
                        subtitle = stringResource(R.string.sheet_tools_available, available),
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
                                subtitle = server.status ?: mcpToolCount(server).let { pluralStringResource(R.plurals.sheet_mcp_tool_count, it, it) },
                                icon = R.drawable.ic_server,
                            )
                        }
                    }
                }
                if (caps.tools) {
                    GroupDivider()
                    SwitchRow(
                        stringResource(R.string.sheet_yolo), yolo, onYolo,
                        subtitle = stringResource(R.string.sheet_yolo_subtitle),
                        icon = R.drawable.ic_rocket,
                    )
                }
                if (caps.fastMode) {
                    GroupDivider()
                    SwitchRow(
                        stringResource(R.string.sheet_fast_mode), params.fastMode, { onParams(params.copy(fastMode = it)) },
                        subtitle = stringResource(R.string.sheet_fast_mode_subtitle), icon = R.drawable.ic_zap,
                    )
                }
            }
            Spacer(Modifier.height(16.dp))

            if (caps.sampling) {
                SectionLabel(stringResource(R.string.sheet_temperature), Modifier.padding(start = 12.dp))
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
                        temp?.let { temperature(it) } ?: auto,
                        style = FacetTheme.type.labelM, color = c.textSecondary,
                        modifier = Modifier.clip(FacetShapes.small).clickable { onParams(params.copy(temperature = null)) }.padding(6.dp),
                    )
                }
                Spacer(Modifier.height(8.dp))
            }

            SectionLabel(stringResource(R.string.sheet_max_reply_length), Modifier.padding(start = 12.dp))
            val maxOptions = listOf<Int?>(null, 2_000, 8_000, 16_000, 32_000, 64_000)
            Segmented(
                options = maxOptions,
                selected = params.maxOutputTokens,
                label = { it?.let { n -> Format.tokens(n.toLong()) } ?: auto },
                onSelect = { onParams(params.copy(maxOutputTokens = it)) },
            )
            Spacer(Modifier.height(16.dp))

            if (canEditInstructions) {
                FacetTextField(
                    instructions, { instructions = it },
                    label = stringResource(R.string.sheet_instructions_label),
                    placeholder = stringResource(R.string.sheet_instructions_placeholder),
                    singleLine = false, minLines = 3, maxLines = 8,
                    supporting = stringResource(R.string.sheet_instructions_supporting),
                )
                Spacer(Modifier.height(16.dp))
            }
            FacetButton(stringResource(R.string.sheet_make_default), onMakeDefault, style = ButtonStyle.Tonal, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(20.dp))
        }
    }
}

@StringRes
private fun effortHint(e: Effort?): Int = when (e) {
    null -> R.string.sheet_effort_auto
    Effort.NONE -> R.string.sheet_effort_none
    Effort.MINIMAL, Effort.LOW -> R.string.sheet_effort_low
    Effort.MEDIUM -> R.string.sheet_effort_medium
    Effort.HIGH -> R.string.sheet_effort_high
    Effort.XHIGH, Effort.MAX -> R.string.sheet_effort_max
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
            Text(stringResource(R.string.sheet_usage_title), style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(bottom = 4.dp))
            Text(m.modelName ?: m.modelId.orEmpty(), style = FacetTheme.type.labelM, color = c.textSecondary, modifier = Modifier.padding(bottom = 16.dp))
            val unknownPrice = stringResource(R.string.sheet_usage_unknown_price)
            // Label, value, and whether the row is indented under the one above it.
            val rows = buildList {
                if (u != null) {
                    add(Triple(R.string.sheet_usage_input, Format.number(u.inputTokens), false))
                    if (u.cacheReadTokens > 0) add(Triple(R.string.sheet_usage_cache_read, Format.number(u.cacheReadTokens), true))
                    if (u.cacheWriteTokens > 0) add(Triple(R.string.sheet_usage_cache_write, Format.number(u.cacheWriteTokens), true))
                    add(Triple(R.string.sheet_usage_output, Format.number(u.outputTokens), false))
                    if (u.reasoningTokens > 0) add(Triple(R.string.sheet_usage_reasoning, Format.number(u.reasoningTokens), false))
                }
                add(Triple(R.string.sheet_usage_cost, m.costUsd?.let { Format.cost(it) } ?: unknownPrice, false))
                m.thinkingMs?.let { add(Triple(R.string.sheet_usage_thinking_time, Format.seconds(it), false)) }
            }
            rows.forEach { (label, value, indented) ->
                Row(Modifier.fillMaxWidth().padding(vertical = 9.dp)) {
                    Text(
                        stringResource(label), style = FacetTheme.type.body, color = c.textSecondary,
                        modifier = Modifier.weight(1f).padding(start = if (indented) 14.dp else 0.dp),
                    )
                    Text(value, style = FacetTheme.type.labelL, color = c.text)
                }
            }
            Spacer(Modifier.height(8.dp))
            Text(
                stringResource(R.string.sheet_usage_note),
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
            Text(stringResource(R.string.sheet_edit_message_title), style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(start = 4.dp, bottom = 4.dp))
            Text(
                stringResource(R.string.sheet_edit_message_body),
                style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary,
                modifier = Modifier.padding(start = 4.dp, bottom = 14.dp),
            )
            FacetTextField(text, { text = it }, singleLine = false, minLines = 3, maxLines = 12)
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FacetButton(stringResource(R.string.action_cancel), onDismiss, style = ButtonStyle.Tonal, modifier = Modifier.weight(1f))
                FacetButton(stringResource(R.string.action_send), { onSave(text); onDismiss() }, enabled = text.isNotBlank(), modifier = Modifier.weight(1f))
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
            Text(stringResource(R.string.sheet_select_text_title), style = FacetTheme.type.titleL, color = c.text, modifier = Modifier.padding(bottom = 12.dp))
            androidx.compose.foundation.text.selection.SelectionContainer(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                Text(text, style = FacetTheme.type.chat, color = c.text, modifier = Modifier.heightIn(min = 100.dp).padding(bottom = 24.dp))
            }
        }
    }
}
