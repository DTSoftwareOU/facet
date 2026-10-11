package io.dtsoftware.facet.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.util.Format
import io.dtsoftware.facet.data.db.ProviderEntity
import io.dtsoftware.facet.data.repo.ModelPrefs
import io.dtsoftware.facet.llm.ApiStyle
import io.dtsoftware.facet.llm.Effort
import io.dtsoftware.facet.llm.ModelCaps
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ModelOutput
import io.dtsoftware.facet.llm.ModelPricing
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.llm.ReasoningKind
import io.dtsoftware.facet.ui.chat.Segmented
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.ConfirmDialog
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetChip
import io.dtsoftware.facet.ui.components.FacetSheet
import io.dtsoftware.facet.ui.components.FacetTextField
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.SectionLabel
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SettingsRow
import io.dtsoftware.facet.ui.components.SwitchRow
import io.dtsoftware.facet.ui.theme.FacetTheme
import java.util.Locale
import kotlinx.coroutines.launch

/** Edit one model of a provider: name, visibility, capabilities, limits and pricing. */
@Composable
fun ModelEditSheet(container: AppContainer, providerId: String, modelId: String, onDismiss: () -> Unit) {
    val provider by produceState<ProviderEntity?>(null, providerId) { value = container.providers.get(providerId) }
    // Open only once the provider is loaded: an empty bottom sheet can dismiss itself.
    val p = provider ?: return
    // Changes save when the sheet closes (Done, Back or swipe), like every other setting.
    var pending by remember { mutableStateOf<ModelPrefs?>(null) }
    fun close() {
        pending?.let { prefs -> container.scope.launch { container.providers.setModelPrefs(p.id, modelId, prefs) } }
        pending = null
        onDismiss()
    }
    FacetSheet(::close) {
        ModelEditForm(container, p, modelId, onDraft = { pending = it }, onDone = ::close, onRemoved = { pending = null; onDismiss() })
    }
}

@Composable
internal fun ModelEditForm(
    container: AppContainer,
    p: ProviderEntity,
    modelId: String,
    onDraft: (ModelPrefs?) -> Unit = {},
    onDone: () -> Unit = {},
    onRemoved: () -> Unit = onDone,
) {
    val c = FacetTheme.colors
    val scope = rememberCoroutineScope()
    val kind = ProviderKind.fromId(p.kind)
    val base = remember(p) { container.providers.baseModels(p).firstOrNull { it.id == modelId } ?: ModelInfo(modelId, modelId) }
    val current = remember(p) { container.providers.modelInfo(p, modelId) }
    val saved = remember(p) { container.providers.modelPrefs(p)[modelId] ?: ModelPrefs() }
    val isCustom = remember(p) { container.providers.customModels(p).any { it.id == modelId } }

    var name by remember { mutableStateOf(saved.name.orEmpty()) }
    var hidden by remember { mutableStateOf(saved.hidden) }
    var caps by remember { mutableStateOf(current.caps) }
    var output by remember { mutableStateOf(current.output) }
    var context by remember { mutableStateOf(saved.contextWindow?.toString().orEmpty()) }
    var maxOutput by remember { mutableStateOf(saved.maxOutput?.toString().orEmpty()) }
    var priceIn by remember { mutableStateOf(saved.pricing?.input?.let(::plain).orEmpty()) }
    var priceOut by remember { mutableStateOf(saved.pricing?.output?.let(::plain).orEmpty()) }
    var confirmRemove by remember { mutableStateOf(false) }

    val contextValue = parseTokens(context)
    val maxOutputValue = parseTokens(maxOutput)
    val priceInValue = parsePrice(priceIn)
    val priceOutValue = parsePrice(priceOut)
    // A field with an unreadable number keeps its saved value instead of dropping the whole edit.
    val contextFinal = if (context.isNotBlank() && contextValue == null) saved.contextWindow else contextValue?.takeIf { it != base.contextWindow }
    val maxOutputFinal = if (maxOutput.isNotBlank() && maxOutputValue == null) saved.maxOutput else maxOutputValue?.takeIf { it != base.maxOutput }
    val pricesUnreadable = (priceIn.isNotBlank() && priceInValue == null) || (priceOut.isNotBlank() && priceOutValue == null)

    fun draft() = ModelPrefs(
        name = name.trim().takeIf { it.isNotEmpty() && it != base.displayName },
        hidden = hidden,
        output = output.takeIf { it != base.output },
        caps = caps.takeIf { it != base.caps },
        contextWindow = contextFinal,
        maxOutput = maxOutputFinal,
        pricing = when {
            pricesUnreadable -> saved.pricing
            priceInValue == null && priceOutValue == null -> null
            else -> ModelPricing(
                input = priceInValue ?: base.pricing?.input ?: 0.0,
                output = priceOutValue ?: base.pricing?.output ?: 0.0,
                cacheRead = base.pricing?.cacheRead,
                cacheWrite = base.pricing?.cacheWrite,
            ).takeIf { it != base.pricing }
        },
    )
    val draft = draft()
    SideEffect { onDraft(draft.takeIf { it != saved }) }

    fun resetDraft() {
        name = ""; hidden = false; caps = base.caps; output = base.output
        context = ""; maxOutput = ""; priceIn = ""; priceOut = ""
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp)
            .navigationBarsPadding()
            .imePadding()
            .padding(bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column {
            Text(name.trim().ifEmpty { base.displayName }, style = FacetTheme.type.titleL, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                "$modelId · ${p.label}", style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }

        FacetTextField(name, { name = it }, label = stringResource(R.string.common_name), placeholder = base.displayName)
        SettingsGroup {
            SwitchRow(
                stringResource(R.string.modeledit_show_in_picker), !hidden, { hidden = !it },
                subtitle = stringResource(if (hidden) R.string.modeledit_hidden_subtitle else R.string.modeledit_listed_subtitle),
                icon = if (hidden) R.drawable.ic_eye_off else R.drawable.ic_eye,
            )
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionLabel(stringResource(R.string.modeledit_makes), Modifier.padding(start = 12.dp))
            Segmented(
                ModelOutput.entries.filter { it == output || io.dtsoftware.facet.llm.ModelCatalog.canRun(kind, it) },
                output, { it.label }, { output = it },
            )
            if (output != base.output) {
                Text(
                    stringResource(R.string.modeledit_sorted_as, base.output.label, output.label),
                    style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary, modifier = Modifier.padding(start = 12.dp),
                )
            }
        }

        if (output == ModelOutput.TEXT) {
            SettingsGroup(title = stringResource(R.string.modeledit_capabilities)) {
                SwitchRow(
                    stringResource(R.string.modeledit_cap_images), caps.vision, { caps = caps.copy(vision = it) },
                    subtitle = stringResource(R.string.modeledit_cap_images_subtitle), icon = R.drawable.ic_image,
                )
                GroupDivider()
                SwitchRow(
                    stringResource(R.string.modeledit_cap_pdfs), caps.pdf, { caps = caps.copy(pdf = it) },
                    subtitle = stringResource(R.string.modeledit_cap_pdfs_subtitle), icon = R.drawable.ic_file_text,
                )
                GroupDivider()
                SwitchRow(
                    stringResource(R.string.modeledit_cap_tools), caps.tools, { caps = caps.copy(tools = it) },
                    subtitle = stringResource(R.string.modeledit_cap_tools_subtitle), icon = R.drawable.ic_wand,
                )
                GroupDivider()
                SwitchRow(
                    stringResource(R.string.modeledit_cap_web_search), caps.webSearch, { caps = caps.copy(webSearch = it) },
                    subtitle = stringResource(R.string.modeledit_cap_web_search_subtitle), icon = R.drawable.ic_globe,
                )
                GroupDivider()
                SwitchRow(
                    stringResource(R.string.modeledit_cap_temperature), caps.sampling, { caps = caps.copy(sampling = it) },
                    subtitle = stringResource(R.string.modeledit_cap_temperature_subtitle), icon = R.drawable.ic_gauge,
                )
                when (kind.style) {
                    ApiStyle.OPENAI_RESPONSES -> {
                        GroupDivider()
                        SwitchRow(
                            stringResource(R.string.modeledit_cap_verbosity), caps.verbosity, { caps = caps.copy(verbosity = it) },
                            subtitle = stringResource(R.string.modeledit_cap_verbosity_subtitle), icon = R.drawable.ic_text_size,
                        )
                        GroupDivider()
                        SwitchRow(
                            stringResource(R.string.modeledit_cap_pro_mode), caps.proMode, { caps = caps.copy(proMode = it) },
                            subtitle = stringResource(R.string.modeledit_cap_pro_mode_subtitle), icon = R.drawable.ic_gem,
                        )
                    }
                    ApiStyle.ANTHROPIC -> {
                        GroupDivider()
                        SwitchRow(
                            stringResource(R.string.modeledit_cap_fast_mode), caps.fastMode, { caps = caps.copy(fastMode = it) },
                            subtitle = stringResource(R.string.modeledit_cap_fast_mode_subtitle), icon = R.drawable.ic_zap,
                        )
                    }
                    ApiStyle.OPENAI_CHAT, ApiStyle.MEDIA -> Unit
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionLabel(stringResource(R.string.modeledit_reasoning), Modifier.padding(start = 12.dp))
                val r = caps.reasoning
                val noneLabel = stringResource(R.string.common_none)
                val effortLabel = stringResource(R.string.modeledit_reasoning_effort)
                val budgetLabel = stringResource(R.string.modeledit_reasoning_budget)
                Segmented(
                    options = ReasoningKind.entries.toList(),
                    selected = r.kind,
                    label = {
                        when (it) {
                            ReasoningKind.NONE -> noneLabel
                            ReasoningKind.EFFORT -> effortLabel
                            ReasoningKind.BUDGET -> budgetLabel
                        }
                    },
                    onSelect = { k ->
                        caps = caps.copy(
                            reasoning = if (k == ReasoningKind.NONE) r.copy(kind = k, efforts = emptyList(), defaultEffort = null)
                            else r.copy(kind = k, efforts = r.efforts.ifEmpty { listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH) }),
                        )
                    },
                )
                if (r.kind != ReasoningKind.NONE) {
                    Text(stringResource(R.string.modeledit_levels_accepted), style = FacetTheme.type.labelS, color = c.textTertiary, modifier = Modifier.padding(start = 12.dp, top = 4.dp))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Effort.entries.forEach { e ->
                            FacetChip(e.label, e in r.efforts, {
                                val next = if (e in r.efforts) r.efforts - e else (r.efforts + e).sortedBy { it.ordinal }
                                caps = caps.copy(reasoning = r.copy(efforts = next, defaultEffort = r.defaultEffort?.takeIf { it in next }))
                            })
                        }
                    }
                    if (r.efforts.isNotEmpty()) {
                        Text(stringResource(R.string.modeledit_default_level), style = FacetTheme.type.labelS, color = c.textTertiary, modifier = Modifier.padding(start = 12.dp, top = 4.dp))
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            r.efforts.forEach { e ->
                                FacetChip(e.label, r.defaultEffort == e, {
                                    caps = caps.copy(reasoning = r.copy(defaultEffort = if (r.defaultEffort == e) null else e))
                                })
                            }
                        }
                    }
                    SettingsGroup {
                        SwitchRow(
                            stringResource(R.string.modeledit_shows_thinking), r.summaries, { caps = caps.copy(reasoning = r.copy(summaries = it)) },
                            subtitle = stringResource(R.string.modeledit_shows_thinking_subtitle), icon = R.drawable.ic_brain,
                        )
                    }
                }
            }

            SettingsGroup(title = stringResource(R.string.modeledit_limits)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    FacetTextField(
                        context, { context = it }, label = stringResource(R.string.modeledit_context_window),
                        placeholder = base.contextWindow?.let { Format.contextWindow(it) } ?: stringResource(R.string.common_unknown),
                        keyboardType = KeyboardType.Number, isError = context.isNotBlank() && contextValue == null,
                    )
                    FacetTextField(
                        maxOutput, { maxOutput = it }, label = stringResource(R.string.modeledit_max_output),
                        placeholder = base.maxOutput?.let { Format.tokens(it.toLong()) } ?: stringResource(R.string.modeledit_provider_default),
                        keyboardType = KeyboardType.Number, isError = maxOutput.isNotBlank() && maxOutputValue == null,
                        supporting = stringResource(R.string.modeledit_max_output_supporting),
                    )
                }
            }

        }

        if (output == ModelOutput.TEXT) SettingsGroup(title = stringResource(R.string.modeledit_price_title)) {
            Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                FacetTextField(
                    priceIn, { priceIn = it }, label = stringResource(R.string.modeledit_price_input),
                    placeholder = base.pricing?.input?.let(::plain) ?: stringResource(R.string.common_unknown),
                    keyboardType = KeyboardType.Decimal, isError = priceIn.isNotBlank() && priceInValue == null,
                    modifier = Modifier.weight(1f),
                )
                FacetTextField(
                    priceOut, { priceOut = it }, label = stringResource(R.string.modeledit_price_output),
                    placeholder = base.pricing?.output?.let(::plain) ?: stringResource(R.string.common_unknown),
                    keyboardType = KeyboardType.Decimal, isError = priceOut.isNotBlank() && priceOutValue == null,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FacetButton(stringResource(R.string.modeledit_reset), ::resetDraft, style = ButtonStyle.Tonal, modifier = Modifier.weight(1f))
            FacetButton(stringResource(R.string.action_done), onDone, modifier = Modifier.weight(1f))
        }
        Text(
            stringResource(R.string.modeledit_saves_on_close),
            style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
            modifier = Modifier.fillMaxWidth().padding(top = 2.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        if (isCustom) {
            SettingsGroup {
                SettingsRow(
                    stringResource(R.string.modeledit_remove), subtitle = stringResource(R.string.modeledit_remove_subtitle), icon = R.drawable.ic_delete,
                    iconTint = c.error, titleColor = c.error, onClick = { confirmRemove = true },
                )
            }
        }
        Spacer(Modifier.height(4.dp))
    }

    if (confirmRemove) {
        ConfirmDialog(
            stringResource(R.string.modeledit_remove_title, current.displayName), stringResource(R.string.modeledit_remove_body),
            stringResource(R.string.action_remove), onConfirm = { scope.launch { container.providers.removeCustomModel(p.id, modelId); onRemoved() } },
            onDismiss = { confirmRemove = false }, danger = true,
        )
    }
}

/** "128000", "128k", "1.5m" → tokens; null when not a positive number. */
internal fun parseTokens(s: String): Int? {
    val t = s.trim().lowercase(Locale.US).replace(",", "").replace("_", "").replace(" ", "")
    if (t.isEmpty()) return null
    val mult = when (t.last()) { 'k' -> 1_000.0; 'm' -> 1_000_000.0; else -> 1.0 }
    val num = (if (mult == 1.0) t else t.dropLast(1)).toDoubleOrNull() ?: return null
    val v = num * mult
    return if (v >= 1 && v <= Int.MAX_VALUE) v.toInt() else null
}

/** "2.5", "2,5", "$2.50" → 2.5; null when not a non-negative number. */
internal fun parsePrice(s: String): Double? =
    s.trim().removePrefix("$").replace(',', '.').toDoubleOrNull()?.takeIf { it >= 0 && it.isFinite() }

private fun plain(v: Double): String = java.math.BigDecimal.valueOf(v).stripTrailingZeros().toPlainString()
