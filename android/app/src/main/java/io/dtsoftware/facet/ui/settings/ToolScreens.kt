package io.dtsoftware.facet.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.data.db.McpServerEntity
import io.dtsoftware.facet.domain.tools.McpCategory
import io.dtsoftware.facet.domain.tools.McpDirectory
import io.dtsoftware.facet.domain.tools.McpDirectoryEntry
import io.dtsoftware.facet.domain.tools.McpManager
import io.dtsoftware.facet.domain.tools.SearchConfig
import io.dtsoftware.facet.domain.tools.SearchKind
import io.dtsoftware.facet.domain.tools.SkillRepository
import io.dtsoftware.facet.domain.tools.ToolApproval
import io.dtsoftware.facet.mcp.McpAuthMode
import io.dtsoftware.facet.ui.chat.MenuEntry
import io.dtsoftware.facet.ui.chat.MenuSheet
import io.dtsoftware.facet.ui.chat.SearchField
import io.dtsoftware.facet.ui.chat.Segmented
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.ConfirmDialog
import io.dtsoftware.facet.ui.components.EmptyState
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetChip
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.FacetSheet
import io.dtsoftware.facet.ui.components.FacetTextField
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SettingsRow
import io.dtsoftware.facet.ui.components.SwitchRow
import io.dtsoftware.facet.ui.components.TextInputDialog
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlinx.coroutines.launch

@Composable
private fun StatusBanner(ok: Boolean, text: String) {
    val c = FacetTheme.colors
    Row(
        Modifier.fillMaxWidth().clip(FacetShapes.group).background(if (ok) c.primaryContainer else c.errorContainer).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FacetIcon(if (ok) R.drawable.ic_circle_check else R.drawable.ic_alert, null, tint = if (ok) c.onPrimaryContainer else c.error, size = 18.dp)
        Spacer(Modifier.width(10.dp))
        Text(text, style = FacetTheme.type.body, color = if (ok) c.onPrimaryContainer else c.text)
    }
}

@Composable
internal fun Intro(text: String) {
    Text(text, style = FacetTheme.type.body, color = FacetTheme.colors.textSecondary, modifier = Modifier.padding(horizontal = 4.dp))
}

// ---------------- Web search ----------------

@Composable
fun WebSearchScreen(container: AppContainer, onBack: () -> Unit) {
    val providers by container.providers.observeAll().collectAsStateWithLifecycle(emptyList())
    val synced by container.settings.synced.collectAsStateWithLifecycle()
    val current = providers.firstOrNull { SearchKind.isSearch(it.kind) }
    var editing by remember { mutableStateOf<SearchKind?>(null) }
    var confirmRemove by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    SettingsPage("Web search", onBack) {
        Intro(
            "Claude, GPT and Gemini models can search on their own. For every other model, add a search key here and Facet gives the model " +
                "a search tool and a page reader. Searches go straight from your phone to the service you pick.",
        )
        if (current != null) {
            val kind = SearchKind.fromId(current.kind)
            SettingsGroup(title = "In use") {
                SettingsRow(
                    kind?.displayName ?: current.label,
                    subtitle = if (current.enabled) "Ready" else "Off",
                    icon = R.drawable.ic_globe,
                    onClick = { editing = kind },
                )
                GroupDivider()
                SettingsRow("Remove", icon = R.drawable.ic_delete, iconTint = FacetTheme.colors.error, titleColor = FacetTheme.colors.error, onClick = { confirmRemove = true })
            }
        }
        SettingsGroup(title = if (current == null) "Choose a search service" else "Switch service") {
            SearchKind.entries.forEachIndexed { i, k ->
                if (i > 0) GroupDivider()
                SettingsRow(k.displayName, subtitle = k.blurb, icon = R.drawable.ic_search, onClick = { editing = k })
            }
        }
        SettingsGroup {
            SwitchRow(
                "Prefer built-in search", synced.preferNativeSearch,
                { v -> container.settings.updateSynced { it.copy(preferNativeSearch = v) } },
                subtitle = "When a model can search on its own, let it. Turn off to always use your search service.",
                icon = R.drawable.ic_sparkles,
            )
        }
    }
    editing?.let { kind ->
        SearchSetupSheet(container, kind, existing = current?.takeIf { it.kind == kind.id }) { editing = null }
    }
    if (confirmRemove && current != null) {
        ConfirmDialog(
            "Remove web search?", "Models without built-in search won't be able to search the web.", "Remove",
            onConfirm = { scope.launch { container.providers.delete(current.id) } }, onDismiss = { confirmRemove = false }, danger = true,
        )
    }
}

@Composable
private fun SearchSetupSheet(container: AppContainer, kind: SearchKind, existing: io.dtsoftware.facet.data.db.ProviderEntity?, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var key by remember { mutableStateOf(existing?.let { container.providers.apiKey(it) }.orEmpty()) }
    var url by remember { mutableStateOf(existing?.baseUrl ?: kind.defaultUrl) }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<Pair<Boolean, String>?>(null) }
    val valid = (!kind.needsKey || key.isNotBlank()) && url.startsWith("http") && url.length > 8
    FacetSheet(onDismiss) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).navigationBarsPadding().imePadding().padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(kind.displayName, style = FacetTheme.type.titleL, color = FacetTheme.colors.text)
            Text(kind.blurb, style = FacetTheme.type.body, color = FacetTheme.colors.textSecondary)
            if (kind.needsKey) {
                FacetTextField(key, { key = it.trim(); status = null }, label = "API key", password = true, mono = true)
                kind.keyUrl?.let { link ->
                    Text(
                        "Get an API key from ${kind.displayName}", style = FacetTheme.type.labelM, color = FacetTheme.colors.primary,
                        modifier = Modifier.clip(FacetShapes.small).clickable { uri.openUri(link) }.padding(4.dp),
                    )
                }
            }
            if (kind == SearchKind.SEARXNG) {
                FacetTextField(
                    url, { url = it.trim(); status = null }, label = "Instance URL", mono = true, keyboardType = KeyboardType.Uri,
                    supporting = "Your SearXNG instance with the JSON format enabled in settings.yml.",
                )
            }
            status?.let { (ok, text) -> StatusBanner(ok, text) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FacetButton(
                    "Test", {
                        busy = true
                        scope.launch {
                            val r = runCatching { container.webSearch.search(SearchConfig(kind, key, url), "weather in Lisbon", 3) }
                            status = r.fold({ true to "Working. Found ${it.size} results." }, { false to (it.message ?: "That didn't work.") })
                            busy = false
                        }
                    },
                    style = ButtonStyle.Tonal, loading = busy, enabled = valid, modifier = Modifier.weight(1f),
                )
                FacetButton(
                    "Save", {
                        scope.launch {
                            container.providers.all().filter { SearchKind.isSearch(it.kind) && it.id != existing?.id }.forEach { container.providers.delete(it.id) }
                            if (existing != null) container.providers.update(existing.id, kind.displayName, url, key, emptyMap(), true)
                            else container.providers.addService(kind.id, kind.displayName, url, key)
                            onDismiss()
                        }
                    },
                    enabled = valid, modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

// ---------------- MCP servers ----------------

@Composable
fun McpServersScreen(container: AppContainer, onBack: () -> Unit, onEdit: (String?) -> Unit) {
    val servers by container.mcp.observeAll().collectAsStateWithLifecycle(emptyList())
    val scope = rememberCoroutineScope()
    SettingsPage("MCP servers", onBack) {
        Intro(
            "Connect apps and data sources through the Model Context Protocol. Their tools work with any model that supports tools, in every chat, " +
                "on all your devices. Connection details and sign-ins are end-to-end encrypted.",
        )
        FacetButton("Add a server", { onEdit(null) }, icon = R.drawable.ic_plus, modifier = Modifier.fillMaxWidth())
        if (servers.isNotEmpty()) {
            SettingsGroup(title = "Connected") {
                servers.forEachIndexed { i, s ->
                    if (i > 0) GroupDivider()
                    val tools = container.mcp.tools(s).size
                    SettingsRow(
                        s.name,
                        subtitle = when {
                            !s.enabled -> "Off"
                            s.status != null -> s.status
                            s.toolsFetchedAt == 0L -> "Connecting…"
                            else -> "$tools tool" + (if (tools == 1) "" else "s") + " · " + container.mcp.approval(s).label
                        },
                        icon = R.drawable.ic_server,
                        iconTint = if (s.status != null) FacetTheme.colors.warning else FacetTheme.colors.textSecondary,
                        onClick = { onEdit(s.id) },
                        trailing = {
                            Switch(
                                s.enabled, { v -> scope.launch { container.mcp.setEnabled(s.id, v) } },
                                colors = SwitchDefaults.colors(checkedThumbColor = FacetTheme.colors.onPrimary, checkedTrackColor = FacetTheme.colors.primary),
                            )
                        },
                    )
                }
            }
        }
        McpDirectorySection(servers) { entry ->
            scope.launch {
                val e = container.mcp.add(entry.name, entry.url, entry.auth, emptyMap())
                onEdit(e.id)
            }
        }
        Text(
            "Only remote servers (Streamable HTTP or SSE) can run from a phone. Tools that change things ask before running unless you allow them.",
            style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = FacetTheme.colors.textTertiary,
            modifier = Modifier.padding(horizontal = 12.dp),
        )
    }
}

@Composable
private fun McpDirectorySection(servers: List<io.dtsoftware.facet.data.db.McpServerEntity>, onAdd: (McpDirectoryEntry) -> Unit) {
    val c = FacetTheme.colors
    var query by rememberSaveable { mutableStateOf("") }
    var category by rememberSaveable { mutableStateOf<McpCategory?>(null) }
    val added = servers.map { it.url.trimEnd('/') }.toSet()
    val q = query.trim()
    val list = McpDirectory.entries.filter { it.url.trimEnd('/') !in added }.filter { e ->
        when {
            q.isNotEmpty() -> e.name.contains(q, true) || e.blurb.contains(q, true) || e.category.label.contains(q, true)
            category == null -> e.popular
            else -> e.category == category
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Add from the directory", style = FacetTheme.type.labelM, color = c.textTertiary, modifier = Modifier.padding(start = 12.dp))
        SearchField(query, { query = it }, "Search ${McpDirectory.entries.size} servers")
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FacetChip("Popular", category == null && q.isEmpty(), { category = null; query = "" })
            McpCategory.entries.forEach { cat -> FacetChip(cat.label, category == cat && q.isEmpty(), { category = cat; query = "" }) }
        }
        if (list.isEmpty()) {
            Text(
                if (q.isNotEmpty()) "No matches. You can add any remote server by its address with Add a server." else "You've added everything here.",
                style = FacetTheme.type.body, color = c.textTertiary, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        } else {
            SettingsGroup {
                list.forEachIndexed { i, e ->
                    if (i > 0) GroupDivider()
                    SettingsRow(e.name, subtitle = e.blurb, icon = R.drawable.ic_plus, onClick = { onAdd(e) }, trailing = { AuthTag(e.auth) })
                }
            }
        }
    }
}

@Composable
private fun AuthTag(auth: McpAuthMode) {
    val c = FacetTheme.colors
    val (label, color) = when (auth) {
        McpAuthMode.NONE -> "Open" to c.primary
        McpAuthMode.OAUTH -> "Sign in" to c.textSecondary
        McpAuthMode.HEADERS -> "Token" to c.warning
    }
    Text(
        label, style = FacetTheme.type.labelS, color = color,
        modifier = Modifier.clip(FacetShapes.chip).background(c.surfaceHigh).padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@Composable
fun McpServerEditScreen(container: AppContainer, serverId: String?, onDone: () -> Unit) {
    val existing by (if (serverId != null) container.mcp.observe(serverId) else kotlinx.coroutines.flow.flowOf(null)).collectAsStateWithLifecycle(null)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var loaded by remember { mutableStateOf(serverId == null) }
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("https://") }
    var auth by remember { mutableStateOf(McpAuthMode.NONE) }
    var headers by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<Pair<Boolean, String>?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }

    LaunchedEffect(existing?.id) {
        val e = existing ?: return@LaunchedEffect
        if (loaded) return@LaunchedEffect
        name = e.name
        url = e.url
        auth = runCatching { McpAuthMode.valueOf(e.authMode) }.getOrDefault(McpAuthMode.NONE)
        headers = container.mcp.headers(e).entries.joinToString("\n") { "${it.key}: ${it.value}" }
        loaded = true
    }

    fun parsedHeaders(): Map<String, String> = headers.lines().mapNotNull { line ->
        val i = line.indexOf(':')
        if (i <= 0) null else line.substring(0, i).trim() to line.substring(i + 1).trim()
    }.filter { it.first.isNotEmpty() }.toMap()

    fun openSignIn(id: String) {
        busy = true
        status = null
        scope.launch {
            runCatching { container.mcp.beginSignIn(id) }
                .onSuccess { link -> runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
                .onFailure { status = false to (it.message ?: "Couldn't start sign-in.") }
            busy = false
        }
    }

    val valid = url.startsWith("http") && url.length > 10
    SettingsPage(existing?.name ?: "Add MCP server", onDone) {
        if (!loaded) return@SettingsPage
        FacetTextField(url, { url = it.trim(); status = null }, label = "Server URL", mono = true, keyboardType = KeyboardType.Uri, supporting = "The server's Streamable HTTP or SSE endpoint, e.g. https://example.com/mcp")
        FacetTextField(name, { name = it }, label = "Name", placeholder = McpManager.hostOf(url))
        Column {
            Text("Authentication", style = FacetTheme.type.labelM, color = FacetTheme.colors.textSecondary, modifier = Modifier.padding(start = 4.dp, bottom = 6.dp))
            Segmented(
                listOf(McpAuthMode.NONE, McpAuthMode.HEADERS, McpAuthMode.OAUTH), auth,
                { when (it) { McpAuthMode.NONE -> "None"; McpAuthMode.HEADERS -> "Token"; McpAuthMode.OAUTH -> "Sign in" } },
                { auth = it; status = null },
            )
        }
        if (auth == McpAuthMode.HEADERS) {
            FacetTextField(
                headers, { headers = it }, label = "Headers", placeholder = "Authorization: Bearer …",
                singleLine = false, minLines = 2, maxLines = 6, mono = true, imeAction = ImeAction.Default,
                supporting = "One per line. Stored encrypted.",
            )
        }
        status?.let { (ok, text) -> StatusBanner(ok, text) }
        FacetButton(
            if (existing == null) "Save and connect" else "Save and reconnect",
            {
                busy = true
                status = null
                scope.launch {
                    val id = existing?.let { e ->
                        container.mcp.update(e.id, name, url, auth, if (auth == McpAuthMode.HEADERS) parsedHeaders() else emptyMap())
                        e.id
                    } ?: container.mcp.add(name, url, auth, if (auth == McpAuthMode.HEADERS) parsedHeaders() else emptyMap()).id
                    val r = container.mcp.refreshTools(id)
                    busy = false
                    if (r.isSuccess) {
                        status = true to "Connected. ${r.getOrThrow().size} tools available."
                        if (existing == null) onDone()
                    } else if (r.exceptionOrNull() is io.dtsoftware.facet.mcp.McpAuthRequiredException) {
                        if (auth == McpAuthMode.OAUTH || auth == McpAuthMode.NONE) {
                            if (existing == null) container.mcp.update(id, name, url, McpAuthMode.OAUTH, null)
                            auth = McpAuthMode.OAUTH
                            status = false to "This server needs you to sign in."
                            openSignIn(id)
                        } else {
                            status = false to "The server rejected these headers. Check the token."
                        }
                    } else {
                        status = false to (r.exceptionOrNull()?.message ?: "Couldn't connect.")
                    }
                }
            },
            loading = busy, enabled = valid, modifier = Modifier.fillMaxWidth(),
        )

        existing?.let { e ->
            if (auth == McpAuthMode.OAUTH) {
                SettingsGroup(title = "Account") {
                    if (container.mcp.isSignedIn(e)) {
                        SettingsRow("Signed in", subtitle = "Tokens refresh automatically and sync to your devices.", icon = R.drawable.ic_circle_check, showChevron = false)
                        GroupDivider()
                        SettingsRow("Sign out", icon = R.drawable.ic_log_out, onClick = { scope.launch { container.mcp.signOut(e.id) } })
                    } else {
                        SettingsRow("Sign in to ${e.name}", subtitle = "Opens your browser.", icon = R.drawable.ic_log_in, onClick = { openSignIn(e.id) })
                    }
                }
            }
            Column {
                Text("Approvals", style = FacetTheme.type.labelM, color = FacetTheme.colors.textTertiary, modifier = Modifier.padding(start = 12.dp, bottom = 8.dp))
                val approval = container.mcp.approval(e)
                Segmented(ToolApproval.entries, approval, { it.label }, { a -> scope.launch { container.mcp.setApproval(e.id, a) } })
                val yolo = container.settings.synced.collectAsStateWithLifecycle().value.yoloMode
                Text(
                    if (yolo) "YOLO mode is on, so these tools run without asking. Turn it off in Settings to use approvals." else approval.blurb,
                    style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal),
                    color = if (yolo) FacetTheme.colors.warning else FacetTheme.colors.textTertiary,
                    modifier = Modifier.padding(start = 12.dp, top = 6.dp),
                )
            }
            val tools = container.mcp.tools(e)
            if (tools.isNotEmpty()) {
                val disabled = container.mcp.disabledTools(e)
                val auto = container.mcp.autoApproved(e)
                SettingsGroup(title = "Tools (${tools.size})") {
                    tools.forEachIndexed { i, t ->
                        if (i > 0) GroupDivider()
                        SwitchRow(
                            t.title ?: t.name, t.name !in disabled, { v -> scope.launch { container.mcp.setToolEnabled(e.id, t.name, v) } },
                            subtitle = listOfNotNull(
                                t.description?.lineSequence()?.firstOrNull()?.take(120),
                                when {
                                    t.name in auto -> "Always allowed"
                                    t.readOnlyHint == true -> "Read-only"
                                    t.destructiveHint == true -> "Can delete or overwrite data"
                                    else -> null
                                },
                            ).joinToString(" · ").ifBlank { null },
                        )
                    }
                }
            }
            SettingsGroup {
                SettingsRow("Refresh tools", icon = R.drawable.ic_sync, onClick = {
                    busy = true
                    scope.launch {
                        val r = container.mcp.refreshTools(e.id)
                        status = r.fold({ true to "Found ${it.size} tools." }, { false to (it.message ?: "Couldn't connect.") })
                        busy = false
                    }
                })
                GroupDivider()
                SettingsRow("Remove server", icon = R.drawable.ic_delete, iconTint = FacetTheme.colors.error, titleColor = FacetTheme.colors.error, onClick = { confirmDelete = true })
            }
        }
    }
    if (confirmDelete) {
        ConfirmDialog(
            "Remove ${existing?.name}?", "Its tools and sign-in are removed from all your devices.", "Remove",
            onConfirm = { existing?.let { e -> scope.launch { container.mcp.delete(e.id); onDone() } } },
            onDismiss = { confirmDelete = false }, danger = true,
        )
    }
}

// ---------------- Skills ----------------

@Composable
fun SkillsScreen(container: AppContainer, onBack: () -> Unit, onEdit: (String?) -> Unit) {
    val skills by container.skills.observeAll().collectAsStateWithLifecycle(emptyList())
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var importMenu by remember { mutableStateOf(false) }
    var importUrl by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<Pair<Boolean, String>?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch {
            message = runCatching {
                val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: error("Couldn't read the file.")
                val name = uri.lastPathSegment.orEmpty()
                val s = if (name.endsWith(".zip", true) || (bytes.size > 2 && bytes[0] == 'P'.code.toByte() && bytes[1] == 'K'.code.toByte())) {
                    container.skills.importZip(bytes)
                } else {
                    container.skills.importMarkdown(bytes.toString(Charsets.UTF_8), fallbackName = name.substringAfterLast('/').substringBeforeLast('.'))
                }
                true to "Imported ${s.name}."
            }.getOrElse { false to (it.message ?: "Couldn't import that file.") }
        }
    }
    SettingsPage("Skills", onBack) {
        Intro(
            "Skills are reusable instructions a model loads when a task calls for them, like a checklist for code review or a format for meeting notes. " +
                "They work with any model that supports tools and sync to all your devices. Compatible with SKILL.md files.",
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FacetButton("New skill", { onEdit(null) }, icon = R.drawable.ic_plus, modifier = Modifier.weight(1f))
            FacetButton("Import", { importMenu = true }, style = ButtonStyle.Tonal, icon = R.drawable.ic_download, modifier = Modifier.weight(1f))
        }
        message?.let { (ok, text) -> StatusBanner(ok, text) }
        if (skills.isNotEmpty()) {
            SettingsGroup(title = "Your skills") {
                skills.forEachIndexed { i, s ->
                    if (i > 0) GroupDivider()
                    SettingsRow(
                        s.name,
                        subtitle = (if (s.alwaysOn) "Always on · " else "") + s.description.take(140),
                        icon = R.drawable.ic_wand,
                        onClick = { onEdit(s.id) },
                        trailing = {
                            Switch(
                                s.enabled, { v -> scope.launch { container.skills.setEnabled(s.id, v) } },
                                colors = SwitchDefaults.colors(checkedThumbColor = FacetTheme.colors.onPrimary, checkedTrackColor = FacetTheme.colors.primary),
                            )
                        },
                    )
                }
            }
        }
        val examples = SkillRepository.EXAMPLES.filter { ex -> skills.none { it.name == ex.name } }
        if (examples.isNotEmpty()) {
            SettingsGroup(title = "Examples") {
                examples.forEachIndexed { i, ex ->
                    if (i > 0) GroupDivider()
                    SettingsRow(
                        ex.name, subtitle = ex.description.substringBefore(". Use when").take(120), icon = R.drawable.ic_plus,
                        onClick = { scope.launch { container.skills.save(null, ex.name, ex.description, ex.body) } },
                    )
                }
            }
        }
        if (skills.isEmpty() && examples.isEmpty()) {
            EmptyState("No skills yet", "Create one, or import a SKILL.md or .zip.", icon = R.drawable.ic_wand, modifier = Modifier.fillMaxWidth())
        }
    }
    if (importMenu) {
        MenuSheet(
            "Import a skill",
            listOf(
                MenuEntry(R.drawable.ic_files, "From a file (.md or .zip)") { picker.launch(arrayOf("text/*", "application/zip", "application/octet-stream")) },
                MenuEntry(R.drawable.ic_link, "From a link") { importUrl = true },
            ),
            onDismiss = { importMenu = false },
        )
    }
    if (importUrl) {
        TextInputDialog(
            "Import from a link", "", "Import",
            onConfirm = { link ->
                scope.launch {
                    message = runCatching { container.skills.importUrl(link) }
                        .fold({ true to "Imported ${it.name}." }, { false to (it.message ?: "Couldn't import from that link.") })
                }
            },
            onDismiss = { importUrl = false },
            placeholder = "https://…/SKILL.md or .zip",
        )
    }
}

@Composable
fun SkillEditScreen(container: AppContainer, skillId: String?, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var loaded by remember { mutableStateOf(skillId == null) }
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var instructions by remember { mutableStateOf("") }
    var alwaysOn by remember { mutableStateOf(false) }
    var resources by remember { mutableStateOf(emptyList<io.dtsoftware.facet.domain.tools.SkillResource>()) }
    var sourceUrl by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    LaunchedEffect(skillId) {
        val s = skillId?.let { container.skills.get(it) } ?: return@LaunchedEffect
        name = s.name
        description = s.description
        instructions = s.instructions
        alwaysOn = s.alwaysOn
        resources = container.skills.resources(s)
        sourceUrl = s.sourceUrl
        loaded = true
    }
    SettingsPage(if (skillId == null) "New skill" else "Edit skill", onDone) {
        if (!loaded) return@SettingsPage
        FacetTextField(name, { name = it }, label = "Name", placeholder = "e.g. meeting-notes", supporting = "Lowercase words joined by hyphens. Models refer to the skill by this name.")
        FacetTextField(
            description, { description = it }, label = "When to use it",
            placeholder = "Turn rough notes into structured meeting notes. Use when the user shares notes or a transcript.",
            singleLine = false, minLines = 2, maxLines = 5,
            supporting = "Models read this to decide when to load the skill. Be specific.",
        )
        FacetTextField(
            instructions, { instructions = it }, label = "Instructions",
            placeholder = "Step-by-step instructions, formats, checklists, examples…",
            singleLine = false, minLines = 8, maxLines = 24, imeAction = ImeAction.Default,
        )
        SettingsGroup {
            SwitchRow(
                "Always on", alwaysOn, { alwaysOn = it },
                subtitle = "Include the full instructions in every chat instead of loading them when needed. Uses more tokens.",
                icon = R.drawable.ic_infinity,
            )
        }
        if (resources.isNotEmpty()) {
            SettingsGroup(title = "Bundled files") {
                resources.forEachIndexed { i, r ->
                    if (i > 0) GroupDivider()
                    SettingsRow(r.path, subtitle = "${r.content.length} characters", icon = R.drawable.ic_file_text, showChevron = false, trailing = {
                        io.dtsoftware.facet.ui.components.FacetIconButton(R.drawable.ic_close, "Remove", { resources = resources - r }, tint = FacetTheme.colors.textTertiary, size = 16.dp)
                    })
                }
            }
        }
        sourceUrl?.let {
            Text("Imported from $it", style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = FacetTheme.colors.textTertiary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 12.dp))
        }
        FacetButton(
            "Save skill",
            {
                scope.launch {
                    val existing = skillId?.let { container.skills.get(it) }
                    container.skills.save(skillId, name, description, instructions, resources, existing?.enabled ?: true, alwaysOn, sourceUrl)
                    onDone()
                }
            },
            enabled = name.isNotBlank() && description.isNotBlank() && instructions.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        )
        if (skillId != null) FacetButton("Delete skill", { confirmDelete = true }, style = ButtonStyle.Danger, modifier = Modifier.fillMaxWidth())
    }
    if (confirmDelete && skillId != null) {
        ConfirmDialog(
            "Delete this skill?", "It's removed from all your devices.", "Delete",
            onConfirm = { scope.launch { container.skills.delete(skillId); onDone() } }, onDismiss = { confirmDelete = false }, danger = true,
        )
    }
}
