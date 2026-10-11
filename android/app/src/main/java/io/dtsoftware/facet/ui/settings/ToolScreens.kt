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
import io.dtsoftware.facet.core.util.Format
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
    SettingsPage(stringResource(R.string.tools_web_search_title), onBack) {
        Intro(stringResource(R.string.tools_web_search_intro))
        if (current != null) {
            val kind = SearchKind.fromId(current.kind)
            SettingsGroup(title = stringResource(R.string.tools_web_search_in_use)) {
                SettingsRow(
                    kind?.displayName ?: current.label,
                    subtitle = stringResource(if (current.enabled) R.string.tools_web_search_ready else R.string.common_off),
                    icon = R.drawable.ic_globe,
                    onClick = { editing = kind },
                )
                GroupDivider()
                SettingsRow(stringResource(R.string.action_remove), icon = R.drawable.ic_delete, iconTint = FacetTheme.colors.error, titleColor = FacetTheme.colors.error, onClick = { confirmRemove = true })
            }
        }
        SettingsGroup(title = stringResource(if (current == null) R.string.tools_web_search_choose else R.string.tools_web_search_switch)) {
            SearchKind.entries.forEachIndexed { i, k ->
                if (i > 0) GroupDivider()
                SettingsRow(k.displayName, subtitle = k.blurb, icon = R.drawable.ic_search, onClick = { editing = k })
            }
        }
        SettingsGroup {
            SwitchRow(
                stringResource(R.string.tools_web_search_prefer_native), synced.preferNativeSearch,
                { v -> container.settings.updateSynced { it.copy(preferNativeSearch = v) } },
                subtitle = stringResource(R.string.tools_web_search_prefer_native_subtitle),
                icon = R.drawable.ic_sparkles,
            )
        }
    }
    editing?.let { kind ->
        SearchSetupSheet(container, kind, existing = current?.takeIf { it.kind == kind.id }) { editing = null }
    }
    if (confirmRemove && current != null) {
        ConfirmDialog(
            stringResource(R.string.tools_web_search_remove_title), stringResource(R.string.tools_web_search_remove_body), stringResource(R.string.action_remove),
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
                FacetTextField(key, { key = it.trim(); status = null }, label = stringResource(R.string.tools_api_key), password = true, mono = true)
                kind.keyUrl?.let { link ->
                    Text(
                        stringResource(R.string.tools_get_api_key, kind.displayName), style = FacetTheme.type.labelM, color = FacetTheme.colors.primary,
                        modifier = Modifier.clip(FacetShapes.small).clickable { uri.openUri(link) }.padding(4.dp),
                    )
                }
            }
            if (kind == SearchKind.SEARXNG) {
                FacetTextField(
                    url, { url = it.trim(); status = null }, label = stringResource(R.string.tools_searxng_url), mono = true, keyboardType = KeyboardType.Uri,
                    supporting = stringResource(R.string.tools_searxng_url_supporting),
                )
            }
            status?.let { (ok, text) -> StatusBanner(ok, text) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FacetButton(
                    stringResource(R.string.tools_test), {
                        busy = true
                        scope.launch {
                            val r = runCatching { container.webSearch.search(SearchConfig(kind, key, url), "weather in Lisbon", 3) }
                            status = r.fold(
                                { true to Strings.plural(R.plurals.tools_web_search_test_ok, it.size, it.size) },
                                { false to (it.message ?: Strings.get(R.string.tools_test_failed)) },
                            )
                            busy = false
                        }
                    },
                    style = ButtonStyle.Tonal, loading = busy, enabled = valid, modifier = Modifier.weight(1f),
                )
                FacetButton(
                    stringResource(R.string.action_save), {
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
    SettingsPage(stringResource(R.string.tools_mcp_title), onBack) {
        Intro(stringResource(R.string.tools_mcp_intro))
        FacetButton(stringResource(R.string.tools_mcp_add), { onEdit(null) }, icon = R.drawable.ic_plus, modifier = Modifier.fillMaxWidth())
        if (servers.isNotEmpty()) {
            SettingsGroup(title = stringResource(R.string.tools_mcp_connected)) {
                servers.forEachIndexed { i, s ->
                    if (i > 0) GroupDivider()
                    val tools = container.mcp.tools(s).size
                    SettingsRow(
                        s.name,
                        subtitle = when {
                            !s.enabled -> stringResource(R.string.common_off)
                            s.status != null -> s.status
                            s.toolsFetchedAt == 0L -> stringResource(R.string.tools_mcp_connecting)
                            else -> pluralStringResource(R.plurals.tools_mcp_tool_count, tools, tools) + " · " + container.mcp.approval(s).label
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
            stringResource(R.string.tools_mcp_footer),
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
        Text(stringResource(R.string.tools_mcp_directory_title), style = FacetTheme.type.labelM, color = c.textTertiary, modifier = Modifier.padding(start = 12.dp))
        val total = McpDirectory.entries.size
        SearchField(query, { query = it }, pluralStringResource(R.plurals.tools_mcp_directory_search, total, total))
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FacetChip(stringResource(R.string.tools_mcp_popular), category == null && q.isEmpty(), { category = null; query = "" })
            McpCategory.entries.forEach { cat -> FacetChip(cat.label, category == cat && q.isEmpty(), { category = cat; query = "" }) }
        }
        if (list.isEmpty()) {
            Text(
                stringResource(if (q.isNotEmpty()) R.string.tools_mcp_directory_no_matches else R.string.tools_mcp_directory_all_added),
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
        McpAuthMode.NONE -> stringResource(R.string.tools_mcp_auth_open) to c.primary
        McpAuthMode.OAUTH -> stringResource(R.string.tools_mcp_auth_sign_in) to c.textSecondary
        McpAuthMode.HEADERS -> stringResource(R.string.tools_mcp_auth_token) to c.warning
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
                .onFailure { status = false to (it.message ?: Strings.get(R.string.tools_mcp_sign_in_failed)) }
            busy = false
        }
    }

    val valid = url.startsWith("http") && url.length > 10
    SettingsPage(existing?.name ?: stringResource(R.string.tools_mcp_add_title), onDone) {
        if (!loaded) return@SettingsPage
        FacetTextField(
            url, { url = it.trim(); status = null }, label = stringResource(R.string.tools_mcp_url), mono = true, keyboardType = KeyboardType.Uri,
            supporting = stringResource(R.string.tools_mcp_url_supporting),
        )
        FacetTextField(name, { name = it }, label = stringResource(R.string.common_name), placeholder = McpManager.hostOf(url))
        Column {
            Text(stringResource(R.string.tools_mcp_authentication), style = FacetTheme.type.labelM, color = FacetTheme.colors.textSecondary, modifier = Modifier.padding(start = 4.dp, bottom = 6.dp))
            val noneLabel = stringResource(R.string.common_none)
            val tokenLabel = stringResource(R.string.tools_mcp_auth_token)
            val signInLabel = stringResource(R.string.tools_mcp_auth_sign_in)
            Segmented(
                listOf(McpAuthMode.NONE, McpAuthMode.HEADERS, McpAuthMode.OAUTH), auth,
                { when (it) { McpAuthMode.NONE -> noneLabel; McpAuthMode.HEADERS -> tokenLabel; McpAuthMode.OAUTH -> signInLabel } },
                { auth = it; status = null },
            )
        }
        if (auth == McpAuthMode.HEADERS) {
            FacetTextField(
                headers, { headers = it }, label = stringResource(R.string.tools_mcp_headers), placeholder = "Authorization: Bearer …",
                singleLine = false, minLines = 2, maxLines = 6, mono = true, imeAction = ImeAction.Default,
                supporting = stringResource(R.string.tools_mcp_headers_supporting),
            )
        }
        status?.let { (ok, text) -> StatusBanner(ok, text) }
        FacetButton(
            stringResource(if (existing == null) R.string.tools_mcp_save_connect else R.string.tools_mcp_save_reconnect),
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
                        val count = r.getOrThrow().size
                        status = true to Strings.plural(R.plurals.tools_mcp_connected_tools, count, count)
                        if (existing == null) onDone()
                    } else if (r.exceptionOrNull() is io.dtsoftware.facet.mcp.McpAuthRequiredException) {
                        if (auth == McpAuthMode.OAUTH || auth == McpAuthMode.NONE) {
                            if (existing == null) container.mcp.update(id, name, url, McpAuthMode.OAUTH, null)
                            auth = McpAuthMode.OAUTH
                            status = false to Strings.get(R.string.tools_mcp_needs_sign_in)
                            openSignIn(id)
                        } else {
                            status = false to Strings.get(R.string.tools_mcp_headers_rejected)
                        }
                    } else {
                        status = false to (r.exceptionOrNull()?.message ?: Strings.get(R.string.tools_mcp_connect_failed))
                    }
                }
            },
            loading = busy, enabled = valid, modifier = Modifier.fillMaxWidth(),
        )

        existing?.let { e ->
            if (auth == McpAuthMode.OAUTH) {
                SettingsGroup(title = stringResource(R.string.tools_mcp_account)) {
                    if (container.mcp.isSignedIn(e)) {
                        SettingsRow(
                            stringResource(R.string.tools_mcp_signed_in), subtitle = stringResource(R.string.tools_mcp_signed_in_subtitle),
                            icon = R.drawable.ic_circle_check, showChevron = false,
                        )
                        GroupDivider()
                        SettingsRow(stringResource(R.string.action_sign_out), icon = R.drawable.ic_log_out, onClick = { scope.launch { container.mcp.signOut(e.id) } })
                    } else {
                        SettingsRow(
                            stringResource(R.string.tools_mcp_sign_in_to, e.name), subtitle = stringResource(R.string.tools_mcp_opens_browser),
                            icon = R.drawable.ic_log_in, onClick = { openSignIn(e.id) },
                        )
                    }
                }
            }
            Column {
                Text(stringResource(R.string.tools_mcp_approvals), style = FacetTheme.type.labelM, color = FacetTheme.colors.textTertiary, modifier = Modifier.padding(start = 12.dp, bottom = 8.dp))
                val approval = container.mcp.approval(e)
                Segmented(ToolApproval.entries, approval, { it.label }, { a -> scope.launch { container.mcp.setApproval(e.id, a) } })
                val yolo = container.settings.synced.collectAsStateWithLifecycle().value.yoloMode
                Text(
                    if (yolo) stringResource(R.string.tools_mcp_yolo_on) else approval.blurb,
                    style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal),
                    color = if (yolo) FacetTheme.colors.warning else FacetTheme.colors.textTertiary,
                    modifier = Modifier.padding(start = 12.dp, top = 6.dp),
                )
            }
            val tools = container.mcp.tools(e)
            if (tools.isNotEmpty()) {
                val disabled = container.mcp.disabledTools(e)
                val auto = container.mcp.autoApproved(e)
                SettingsGroup(title = stringResource(R.string.tools_mcp_tools_count, tools.size)) {
                    tools.forEachIndexed { i, t ->
                        if (i > 0) GroupDivider()
                        val hint = when {
                            t.name in auto -> stringResource(R.string.tools_mcp_tool_always_allowed)
                            t.readOnlyHint == true -> stringResource(R.string.tools_mcp_tool_read_only)
                            t.destructiveHint == true -> stringResource(R.string.tools_mcp_tool_destructive)
                            else -> null
                        }
                        SwitchRow(
                            t.title ?: t.name, t.name !in disabled, { v -> scope.launch { container.mcp.setToolEnabled(e.id, t.name, v) } },
                            subtitle = listOfNotNull(t.description?.lineSequence()?.firstOrNull()?.take(120), hint).joinToString(" · ").ifBlank { null },
                        )
                    }
                }
            }
            SettingsGroup {
                SettingsRow(stringResource(R.string.tools_mcp_refresh), icon = R.drawable.ic_sync, onClick = {
                    busy = true
                    scope.launch {
                        val r = container.mcp.refreshTools(e.id)
                        status = r.fold(
                            { true to Strings.plural(R.plurals.tools_mcp_found_tools, it.size, it.size) },
                            { false to (it.message ?: Strings.get(R.string.tools_mcp_connect_failed)) },
                        )
                        busy = false
                    }
                })
                GroupDivider()
                SettingsRow(
                    stringResource(R.string.tools_mcp_remove), icon = R.drawable.ic_delete, iconTint = FacetTheme.colors.error,
                    titleColor = FacetTheme.colors.error, onClick = { confirmDelete = true },
                )
            }
        }
    }
    if (confirmDelete) {
        ConfirmDialog(
            stringResource(R.string.tools_mcp_remove_title, existing?.name.orEmpty()), stringResource(R.string.tools_mcp_remove_body), stringResource(R.string.action_remove),
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
                val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: error(Strings.get(R.string.tools_skill_read_failed))
                val name = uri.lastPathSegment.orEmpty()
                val s = if (name.endsWith(".zip", true) || (bytes.size > 2 && bytes[0] == 'P'.code.toByte() && bytes[1] == 'K'.code.toByte())) {
                    container.skills.importZip(bytes)
                } else {
                    container.skills.importMarkdown(bytes.toString(Charsets.UTF_8), fallbackName = name.substringAfterLast('/').substringBeforeLast('.'))
                }
                true to Strings.get(R.string.tools_skill_imported, s.name)
            }.getOrElse { false to (it.message ?: Strings.get(R.string.tools_skill_import_failed)) }
        }
    }
    SettingsPage(stringResource(R.string.tools_skills_title), onBack) {
        Intro(stringResource(R.string.tools_skills_intro))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FacetButton(stringResource(R.string.tools_skill_new), { onEdit(null) }, icon = R.drawable.ic_plus, modifier = Modifier.weight(1f))
            FacetButton(stringResource(R.string.tools_skill_import), { importMenu = true }, style = ButtonStyle.Tonal, icon = R.drawable.ic_download, modifier = Modifier.weight(1f))
        }
        message?.let { (ok, text) -> StatusBanner(ok, text) }
        if (skills.isNotEmpty()) {
            val alwaysOn = stringResource(R.string.tools_skill_always_on)
            SettingsGroup(title = stringResource(R.string.tools_skills_yours)) {
                skills.forEachIndexed { i, s ->
                    if (i > 0) GroupDivider()
                    SettingsRow(
                        s.name,
                        subtitle = (if (s.alwaysOn) "$alwaysOn · " else "") + s.description.take(140),
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
            SettingsGroup(title = stringResource(R.string.tools_skills_examples)) {
                examples.forEachIndexed { i, ex ->
                    if (i > 0) GroupDivider()
                    // The example's description is written for models; show the translated summary when there is one.
                    val blurb = ExampleSkillBlurbs[ex.name]?.let { stringResource(it) } ?: ex.description.substringBefore(". Use when").take(120)
                    SettingsRow(
                        ex.name, subtitle = blurb, icon = R.drawable.ic_plus,
                        onClick = { scope.launch { container.skills.save(null, ex.name, ex.description, ex.body) } },
                    )
                }
            }
        }
        if (skills.isEmpty() && examples.isEmpty()) {
            EmptyState(
                stringResource(R.string.tools_skills_empty_title), stringResource(R.string.tools_skills_empty_body),
                icon = R.drawable.ic_wand, modifier = Modifier.fillMaxWidth(),
            )
        }
    }
    if (importMenu) {
        MenuSheet(
            stringResource(R.string.tools_skill_import_title),
            listOf(
                MenuEntry(R.drawable.ic_files, stringResource(R.string.tools_skill_import_file)) { picker.launch(arrayOf("text/*", "application/zip", "application/octet-stream")) },
                MenuEntry(R.drawable.ic_link, stringResource(R.string.tools_skill_import_link)) { importUrl = true },
            ),
            onDismiss = { importMenu = false },
        )
    }
    if (importUrl) {
        TextInputDialog(
            stringResource(R.string.tools_skill_import_link_title), "", stringResource(R.string.tools_skill_import),
            onConfirm = { link ->
                scope.launch {
                    message = runCatching { container.skills.importUrl(link) }
                        .fold(
                            { true to Strings.get(R.string.tools_skill_imported, it.name) },
                            { false to (it.message ?: Strings.get(R.string.tools_skill_import_link_failed)) },
                        )
                }
            },
            onDismiss = { importUrl = false },
            placeholder = stringResource(R.string.tools_skill_import_link_placeholder),
        )
    }
}

/** Interface summaries of [SkillRepository.EXAMPLES], by skill name (their descriptions are written for models). */
private val ExampleSkillBlurbs = mapOf(
    "meeting-notes" to R.string.tools_skill_example_meeting_notes,
    "code-review" to R.string.tools_skill_example_code_review,
    "trip-planner" to R.string.tools_skill_example_trip_planner,
)

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
    SettingsPage(stringResource(if (skillId == null) R.string.tools_skill_new else R.string.tools_skill_edit_title), onDone) {
        if (!loaded) return@SettingsPage
        FacetTextField(
            name, { name = it }, label = stringResource(R.string.common_name), placeholder = stringResource(R.string.tools_skill_name_placeholder, "meeting-notes"),
            supporting = stringResource(R.string.tools_skill_name_supporting),
        )
        FacetTextField(
            description, { description = it }, label = stringResource(R.string.tools_skill_description),
            placeholder = stringResource(R.string.tools_skill_description_placeholder),
            singleLine = false, minLines = 2, maxLines = 5,
            supporting = stringResource(R.string.tools_skill_description_supporting),
        )
        FacetTextField(
            instructions, { instructions = it }, label = stringResource(R.string.tools_skill_instructions),
            placeholder = stringResource(R.string.tools_skill_instructions_placeholder),
            singleLine = false, minLines = 8, maxLines = 24, imeAction = ImeAction.Default,
        )
        SettingsGroup {
            SwitchRow(
                stringResource(R.string.tools_skill_always_on), alwaysOn, { alwaysOn = it },
                subtitle = stringResource(R.string.tools_skill_always_on_subtitle),
                icon = R.drawable.ic_infinity,
            )
        }
        if (resources.isNotEmpty()) {
            SettingsGroup(title = stringResource(R.string.tools_skill_bundled_files)) {
                resources.forEachIndexed { i, r ->
                    if (i > 0) GroupDivider()
                    val length = r.content.length
                    SettingsRow(
                        r.path, subtitle = pluralStringResource(R.plurals.tools_skill_characters, length, Format.number(length.toLong())),
                        icon = R.drawable.ic_file_text, showChevron = false,
                        trailing = {
                            io.dtsoftware.facet.ui.components.FacetIconButton(
                                R.drawable.ic_close, stringResource(R.string.action_remove), { resources = resources - r },
                                tint = FacetTheme.colors.textTertiary, size = 16.dp,
                            )
                        },
                    )
                }
            }
        }
        sourceUrl?.let {
            Text(
                stringResource(R.string.tools_skill_imported_from, it), style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal),
                color = FacetTheme.colors.textTertiary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 12.dp),
            )
        }
        FacetButton(
            stringResource(R.string.tools_skill_save),
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
        if (skillId != null) FacetButton(stringResource(R.string.tools_skill_delete), { confirmDelete = true }, style = ButtonStyle.Danger, modifier = Modifier.fillMaxWidth())
    }
    if (confirmDelete && skillId != null) {
        ConfirmDialog(
            stringResource(R.string.tools_skill_delete_title), stringResource(R.string.tools_skill_delete_body), stringResource(R.string.action_delete),
            onConfirm = { scope.launch { container.skills.delete(skillId); onDone() } }, onDismiss = { confirmDelete = false }, danger = true,
        )
    }
}
