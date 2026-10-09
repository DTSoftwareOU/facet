package io.dtsoftware.facet.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.data.db.PromptEntity
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.data.repo.Assistant
import io.dtsoftware.facet.ui.chat.ModelPickerSheet
import io.dtsoftware.facet.ui.components.AccentChoices
import io.dtsoftware.facet.ui.components.AssistantAvatar
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.ConfirmDialog
import io.dtsoftware.facet.ui.components.EmptyState
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIconButton
import io.dtsoftware.facet.ui.components.FacetSheet
import io.dtsoftware.facet.ui.components.FacetTextField
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SettingsRow
import io.dtsoftware.facet.ui.components.accent
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlinx.coroutines.launch

// ---------------- Assistants ----------------

@Composable
fun AssistantsScreen(container: AppContainer, onBack: () -> Unit, onEdit: (String?) -> Unit) {
    val assistants by container.assistants.observeAll().collectAsStateWithLifecycle(emptyList())
    val c = FacetTheme.colors
    SettingsPage("Assistants", onBack) {
        Text(
            "Assistants are reusable personas: instructions, a default model and conversation starters. Pick one when you start a chat.",
            style = FacetTheme.type.body, color = c.textSecondary, modifier = Modifier.padding(horizontal = 4.dp),
        )
        FacetButton("Create an assistant", { onEdit(null) }, icon = R.drawable.ic_plus, modifier = Modifier.fillMaxWidth())
        val custom = assistants.filterNot { it.builtin }
        if (custom.isNotEmpty()) {
            SettingsGroup(title = "Yours") {
                custom.forEachIndexed { i, a ->
                    if (i > 0) GroupDivider()
                    AssistantRow(a) { onEdit(a.id) }
                }
            }
        }
        SettingsGroup(title = "Built in") {
            assistants.filter { it.builtin }.forEachIndexed { i, a ->
                if (i > 0) GroupDivider()
                AssistantRow(a, null)
            }
        }
    }
}

@Composable
private fun AssistantRow(a: Assistant, onClick: (() -> Unit)?) {
    SettingsRow(
        a.name,
        subtitle = a.instructions.lineSequence().firstOrNull()?.take(90)?.ifBlank { null } ?: "General-purpose assistant",
        leading = { AssistantAvatar(a, size = 36.dp) },
        onClick = onClick,
    )
}

private val EmojiChoices = listOf("✨", "🧠", "💻", "✍️", "📚", "🌍", "📈", "🎨", "🔬", "🩺", "⚖️", "🍳", "🎵", "🧭", "🛠️", "🤝")

@Composable
fun AssistantEditScreen(container: AppContainer, assistantId: String?, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    val catalog by container.providers.observeCatalog().collectAsStateWithLifecycle(emptyList())
    var loaded by remember { mutableStateOf(assistantId == null) }
    var name by remember { mutableStateOf("") }
    var emoji by remember { mutableStateOf("✨") }
    var color by remember { mutableStateOf(0) }
    var instructions by remember { mutableStateOf("") }
    var model by remember { mutableStateOf<ModelRef?>(null) }
    val starters = remember { mutableStateListOf("", "", "") }
    var picker by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    val c = FacetTheme.colors

    LaunchedEffect(assistantId) {
        if (assistantId == null) return@LaunchedEffect
        container.assistants.get(assistantId)?.let { a ->
            name = a.name
            emoji = a.emoji ?: "✨"
            color = a.colorIndex
            instructions = a.instructions
            model = a.model
            starters.clear()
            starters.addAll((a.starters + listOf("", "", "")).take(maxOf(3, a.starters.size)))
        }
        loaded = true
    }

    SettingsPage(if (assistantId == null) "New assistant" else "Edit assistant", onDone) {
        if (!loaded) return@SettingsPage
        val preview = Assistant("preview", name.ifBlank { "Assistant" }, emoji, null, color, instructions, model, null, emptyList(), false)
        Row(verticalAlignment = Alignment.CenterVertically) {
            AssistantAvatar(preview, size = 64.dp)
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AccentChoices.indices.forEach { i ->
                        Box(
                            Modifier.size(24.dp).clip(CircleShape).background(accent(i)).clickable { color = i },
                            contentAlignment = Alignment.Center,
                        ) { if (i == color) Box(Modifier.size(8.dp).clip(CircleShape).background(Color.White)) }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            EmojiChoices.take(8).forEach { e -> EmojiCell(e, e == emoji) { emoji = e } }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            EmojiChoices.drop(8).forEach { e -> EmojiCell(e, e == emoji) { emoji = e } }
        }
        FacetTextField(name, { name = it }, label = "Name", placeholder = "e.g. Travel planner")
        FacetTextField(
            instructions, { instructions = it }, label = "Instructions",
            placeholder = "Describe the role, tone, and anything it should always or never do.",
            singleLine = false, minLines = 5, maxLines = 14,
        )
        SettingsGroup(title = "Default model") {
            val label = model?.let { ref ->
                val pm = catalog.firstOrNull { it.provider.id == ref.providerId }
                (pm?.models?.firstOrNull { it.id == ref.modelId }?.displayName ?: ref.modelId) + (pm?.let { " · " + it.provider.label } ?: "")
            } ?: "Use the chat's current model"
            SettingsRow(label, icon = R.drawable.ic_cpu, onClick = { picker = true }, trailing = if (model != null) {
                { FacetIconButton(R.drawable.ic_close, "Clear", { model = null }, tint = c.textTertiary, size = 16.dp) }
            } else null)
        }
        Column {
            Text("Conversation starters", style = FacetTheme.type.labelM, color = c.textTertiary, modifier = Modifier.padding(start = 12.dp, bottom = 8.dp))
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                starters.forEachIndexed { i, s ->
                    FacetTextField(s, { starters[i] = it }, placeholder = "Starter ${i + 1}")
                }
            }
            if (starters.size < 6) {
                Text(
                    "Add another", style = FacetTheme.type.labelM, color = c.primary,
                    modifier = Modifier.padding(top = 6.dp).clip(FacetShapes.small).clickable { starters.add("") }.padding(8.dp),
                )
            }
        }
        FacetButton(
            "Save assistant",
            {
                scope.launch {
                    container.assistants.save(assistantId, name, emoji, color, instructions, model, null, starters.toList())
                    onDone()
                }
            },
            enabled = name.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        )
        if (assistantId != null) {
            FacetButton("Delete assistant", { confirmDelete = true }, style = ButtonStyle.Danger, modifier = Modifier.fillMaxWidth())
        }
    }
    if (picker) {
        ModelPickerSheet(
            catalog = catalog, selected = model,
            onSelect = { model = it; picker = false },
            onToggleFavorite = { pid, mid -> scope.launch { container.providers.toggleFavorite(pid, mid) } },
            onManageProviders = { picker = false },
            onRefresh = { pid -> scope.launch { container.providers.refreshModels(pid) } },
            onDismiss = { picker = false },
        )
    }
    if (confirmDelete && assistantId != null) {
        ConfirmDialog(
            "Delete this assistant?", "Existing chats keep working with their instructions removed.", "Delete",
            onConfirm = { scope.launch { container.assistants.delete(assistantId); onDone() } },
            onDismiss = { confirmDelete = false }, danger = true,
        )
    }
}

@Composable
private fun EmojiCell(e: String, selected: Boolean, onClick: () -> Unit) {
    val c = FacetTheme.colors
    Box(
        Modifier
            .size(38.dp)
            .clip(FacetShapes.chip)
            .background(if (selected) c.surfaceHighest else c.surface)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(e, style = FacetTheme.type.titleM) }
}

// ---------------- Prompt library ----------------

@Composable
fun PromptsScreen(container: AppContainer, onBack: () -> Unit) {
    val prompts by container.prompts.observeAll().collectAsStateWithLifecycle(emptyList())
    var editing by remember { mutableStateOf<PromptEntity?>(null) }
    var creating by remember { mutableStateOf(false) }
    val c = FacetTheme.colors
    SettingsPage("Prompt library", onBack) {
        Text(
            "Save prompts you use often. In any chat, type / to search and insert one.",
            style = FacetTheme.type.body, color = c.textSecondary, modifier = Modifier.padding(horizontal = 4.dp),
        )
        FacetButton("New prompt", { creating = true }, icon = R.drawable.ic_plus, modifier = Modifier.fillMaxWidth())
        if (prompts.isEmpty()) {
            EmptyState("No saved prompts", "Try one like “Summarize this in five bullet points”.", icon = R.drawable.ic_library, modifier = Modifier.fillMaxWidth())
        } else {
            SettingsGroup {
                prompts.forEachIndexed { i, p ->
                    if (i > 0) GroupDivider()
                    Column(Modifier.fillMaxWidth().clickable { editing = p }.padding(horizontal = 16.dp, vertical = 12.dp)) {
                        Text(p.title, style = FacetTheme.type.labelL, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Spacer(Modifier.height(2.dp))
                        Text(p.body, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
    if (creating || editing != null) {
        PromptSheet(container, editing) { creating = false; editing = null }
    }
}

@Composable
private fun PromptSheet(container: AppContainer, prompt: PromptEntity?, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf(prompt?.title.orEmpty()) }
    var body by remember { mutableStateOf(prompt?.body.orEmpty()) }
    FacetSheet(onDismiss) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).navigationBarsPadding().imePadding().padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(if (prompt == null) "New prompt" else "Edit prompt", style = FacetTheme.type.titleL, color = FacetTheme.colors.text)
            FacetTextField(title, { title = it }, label = "Title", placeholder = "e.g. Five-bullet summary")
            FacetTextField(body, { body = it }, label = "Prompt", placeholder = "Summarize the following in five bullet points:", singleLine = false, minLines = 4, maxLines = 12)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (prompt != null) {
                    FacetButton("Delete", { scope.launch { container.prompts.delete(prompt.id); onDismiss() } }, style = ButtonStyle.Danger, modifier = Modifier.weight(1f))
                }
                FacetButton(
                    "Save", { scope.launch { container.prompts.save(prompt?.id, title, body); onDismiss() } },
                    enabled = body.isNotBlank(), modifier = Modifier.weight(1f),
                )
            }
        }
    }
}
