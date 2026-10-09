package io.dtsoftware.facet.ui.settings

import androidx.compose.foundation.background
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.BuildConfig
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.util.Dates
import io.dtsoftware.facet.core.util.Format
import io.dtsoftware.facet.sync.AccountState
import io.dtsoftware.facet.sync.SessionDto
import io.dtsoftware.facet.sync.SyncPhase
import io.dtsoftware.facet.sync.SyncWorker
import io.dtsoftware.facet.sync.shownName
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.EmptyState
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.FacetSheet
import io.dtsoftware.facet.ui.components.FacetTextField
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SettingsRow
import io.dtsoftware.facet.ui.components.TextInputDialog
import io.dtsoftware.facet.ui.components.UserAvatar
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlinx.coroutines.launch

@Composable
fun AccountScreen(
    container: AppContainer,
    onBack: () -> Unit,
    onSignIn: () -> Unit,
    onCreate: () -> Unit,
    onDevices: () -> Unit,
    onRecoveryCode: (String) -> Unit,
) {
    val account by container.auth.state.collectAsStateWithLifecycle()
    when (val a = account) {
        is AccountState.SignedIn -> SignedInAccount(container, a, onBack, onDevices, onRecoveryCode)
        else -> GuestAccount(container, a, onBack, onSignIn, onCreate)
    }
}

@Composable
private fun GuestAccount(container: AppContainer, state: AccountState, onBack: () -> Unit, onSignIn: () -> Unit, onCreate: () -> Unit) {
    val c = FacetTheme.colors
    var server by remember { mutableStateOf(container.auth.serverUrl) }
    var editServer by remember { mutableStateOf(false) }
    SettingsPage("Account", onBack) {
        Column(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.size(64.dp).clip(CircleShape).background(c.primaryContainer), contentAlignment = Alignment.Center) {
                FacetIcon(R.drawable.ic_cloud, null, tint = c.onPrimaryContainer, size = 28.dp)
            }
            Spacer(Modifier.height(18.dp))
            Text(
                if (state is AccountState.Expired) "Sign in to resume sync" else "Sync across your devices",
                style = FacetTheme.type.headline, color = c.text, textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                if (state is AccountState.Expired) "Your session for ${state.email} ended. Your chats are still on this device."
                else "Keep chats, assistants and API keys in step on every device. Everything is encrypted before it leaves your phone.",
                style = FacetTheme.type.body, color = c.textSecondary, textAlign = TextAlign.Center,
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (state !is AccountState.Expired) FacetButton("Create a free account", onCreate, modifier = Modifier.fillMaxWidth())
            FacetButton("Sign in", onSignIn, style = if (state is AccountState.Expired) ButtonStyle.Primary else ButtonStyle.Tonal, modifier = Modifier.fillMaxWidth())
        }
        SettingsGroup(title = "Sync server") {
            SettingsRow(
                server.removePrefix("https://").removePrefix("http://"),
                subtitle = if (server == BuildConfig.DEFAULT_SYNC_URL) "Hosted by DT Software" else "Self-hosted",
                icon = R.drawable.ic_server, onClick = { editServer = true },
            )
        }
        Text(
            "Facet is open source. You can run your own sync server and point the app at it before signing in.",
            style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textTertiary, modifier = Modifier.padding(horizontal = 12.dp),
        )
    }
    if (editServer) {
        ServerSheet(container, server, onSaved = { server = it }, onDismiss = { editServer = false })
    }
}

@Composable
fun ServerSheet(container: AppContainer, current: String, onSaved: (String) -> Unit, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(current) }
    var checking by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    FacetSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).navigationBarsPadding().imePadding().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Sync server", style = FacetTheme.type.titleL, color = FacetTheme.colors.text)
            FacetTextField(url, { url = it.trim(); error = null }, label = "Server address", mono = true, keyboardType = KeyboardType.Uri, isError = error != null, supporting = error ?: "The address of a Facet sync server, e.g. https://facet.example.com")
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FacetButton("Use default", { url = BuildConfig.DEFAULT_SYNC_URL }, style = ButtonStyle.Tonal, modifier = Modifier.weight(1f))
                FacetButton(
                    "Save", {
                        checking = true
                        scope.launch {
                            val clean = url.trimEnd('/')
                            val ok = runCatching { container.auth.meta(clean) }
                            checking = false
                            if (ok.isSuccess) {
                                container.auth.setServerUrl(clean)
                                onSaved(clean)
                                onDismiss()
                            } else {
                                error = "No Facet server answered at that address."
                            }
                        }
                    },
                    loading = checking, enabled = url.startsWith("http"), modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun SignedInAccount(
    container: AppContainer,
    a: AccountState.SignedIn,
    onBack: () -> Unit,
    onDevices: () -> Unit,
    onRecoveryCode: (String) -> Unit,
) {
    val c = FacetTheme.colors
    val scope = rememberCoroutineScope()
    val sync by container.sync.state.collectAsStateWithLifecycle()
    val synced by container.settings.synced.collectAsStateWithLifecycle()
    var renaming by remember { mutableStateOf(false) }
    var passwordSheet by remember { mutableStateOf(false) }
    var recoverySheet by remember { mutableStateOf(false) }
    var signOutSheet by remember { mutableStateOf(false) }
    var deleteSheet by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { runCatching { container.auth.refreshAccount() } }

    SettingsPage("Account", onBack) {
        Column(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            UserAvatar(a.shownName(synced.profileName), size = 72.dp)
            Spacer(Modifier.height(14.dp))
            Text(a.shownName(synced.profileName), style = FacetTheme.type.titleL, color = c.text)
            Text(a.email, style = FacetTheme.type.body, color = c.textSecondary)
        }
        Column(Modifier.fillMaxWidth().clip(FacetShapes.group).background(c.surface).padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                FacetIcon(R.drawable.ic_shield, null, tint = c.primary, size = 20.dp)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text("End-to-end encrypted sync", style = FacetTheme.type.labelL, color = c.text)
                    Text(
                        when (sync.phase) {
                            SyncPhase.SYNCING -> "Syncing now…"
                            SyncPhase.IDLE -> if (sync.lastSyncAt > 0) "Last synced " + Dates.relative(sync.lastSyncAt).replaceFirstChar { it.lowercase() } else "Up to date"
                            else -> sync.message ?: "Waiting to sync"
                        },
                        style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary,
                    )
                }
                FacetButton("Sync now", { scope.launch { container.sync.syncNow() } }, style = ButtonStyle.Tonal, loading = sync.phase == SyncPhase.SYNCING)
            }
            if (a.quotaBytes > 0) {
                Spacer(Modifier.height(14.dp))
                val frac = (a.usedBytes.toFloat() / a.quotaBytes).coerceIn(0f, 1f)
                Box(Modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(c.surfaceHighest)) {
                    Box(Modifier.fillMaxWidth(frac.coerceAtLeast(0.01f)).height(6.dp).clip(CircleShape).background(c.primary))
                }
                Spacer(Modifier.height(6.dp))
                Text("${Format.bytes(a.usedBytes)} of ${Format.bytes(a.quotaBytes)} used for attachments", style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary)
            }
        }
        SettingsGroup {
            SettingsRow("Display name", subtitle = synced.profileName.ifBlank { a.displayName ?: "Not set" }, icon = R.drawable.ic_user, onClick = { renaming = true })
            GroupDivider()
            SettingsRow("Change password", icon = R.drawable.ic_lock, onClick = { passwordSheet = true })
            GroupDivider()
            SettingsRow("Recovery code", subtitle = "Create a new code if you lost yours", icon = R.drawable.ic_key, onClick = { recoverySheet = true })
            GroupDivider()
            SettingsRow("Signed-in devices", icon = R.drawable.ic_phone, onClick = onDevices)
        }
        SettingsGroup {
            SettingsRow("Sign out", icon = R.drawable.ic_log_out, onClick = { signOutSheet = true })
            GroupDivider()
            SettingsRow("Delete account", icon = R.drawable.ic_delete, iconTint = c.error, titleColor = c.error, onClick = { deleteSheet = true })
        }
        Text(
            "Server: ${a.serverUrl.removePrefix("https://")}",
            style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary, modifier = Modifier.padding(start = 12.dp),
        )
    }

    if (renaming) {
        TextInputDialog("Display name", synced.profileName.ifBlank { a.displayName.orEmpty() }, "Save", { name -> container.auth.updateDisplayName(name) }, { renaming = false })
    }
    if (passwordSheet) ChangePasswordSheet(container) { passwordSheet = false }
    if (recoverySheet) {
        PasswordConfirmSheet(
            title = "New recovery code",
            body = "Your current recovery code will stop working. Enter your password to continue.",
            action = "Create new code",
            onConfirm = { pw -> val code = container.auth.regenerateRecoveryCode(pw); onRecoveryCode(code) },
            onDismiss = { recoverySheet = false },
        )
    }
    if (signOutSheet) {
        FacetSheet({ signOutSheet = false }) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).navigationBarsPadding().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Sign out?", style = FacetTheme.type.titleL, color = c.text)
                Text(
                    "Your data stays safe in your account. Choose whether to keep a copy on this device.",
                    style = FacetTheme.type.body, color = c.textSecondary,
                )
                FacetButton("Sign out and remove data from this device", {
                    scope.launch {
                        container.auth.logout()
                        container.sync.wipeLocalData()
                        SyncWorker.cancel(container.appContext)
                        signOutSheet = false
                        onBack()
                    }
                }, modifier = Modifier.fillMaxWidth())
                FacetButton("Sign out and keep data here", {
                    scope.launch {
                        container.auth.logout()
                        container.sync.resetCursor()
                        signOutSheet = false
                        onBack()
                    }
                }, style = ButtonStyle.Tonal, modifier = Modifier.fillMaxWidth())
            }
        }
    }
    if (deleteSheet) {
        PasswordConfirmSheet(
            title = "Delete your account?",
            body = "This permanently deletes your account and all synced data on the server, for every device. Chats stay on this device unless you remove them.",
            action = "Delete account",
            danger = true,
            onConfirm = { pw ->
                container.auth.deleteAccount(pw)
                container.sync.resetCursor()
                onBack()
            },
            onDismiss = { deleteSheet = false },
        )
    }
}


@Composable
private fun ChangePasswordSheet(container: AppContainer, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf(false) }
    val c = FacetTheme.colors
    FacetSheet(onDismiss) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).navigationBarsPadding().imePadding().padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Change password", style = FacetTheme.type.titleL, color = c.text)
            if (done) {
                Text("Password changed. Other devices were signed out and will ask for the new password.", style = FacetTheme.type.body, color = c.textSecondary)
                FacetButton("Done", onDismiss, modifier = Modifier.fillMaxWidth())
                return@Column
            }
            FacetTextField(current, { current = it }, label = "Current password", password = true)
            FacetTextField(next, { next = it }, label = "New password", password = true, supporting = passwordHint(next))
            FacetTextField(confirm, { confirm = it }, label = "Confirm new password", password = true, imeAction = ImeAction.Done, isError = confirm.isNotEmpty() && confirm != next)
            error?.let { Text(it, style = FacetTheme.type.labelM, color = c.error) }
            FacetButton(
                "Change password", {
                    busy = true
                    error = null
                    scope.launch {
                        runCatching { container.auth.changePassword(current, next) }
                            .onSuccess { done = true }
                            .onFailure { error = it.message }
                        busy = false
                    }
                },
                loading = busy, enabled = current.isNotEmpty() && passwordOk(next) && next == confirm, modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
fun PasswordConfirmSheet(
    title: String,
    body: String,
    action: String,
    onConfirm: suspend (String) -> Unit,
    onDismiss: () -> Unit,
    danger: Boolean = false,
) {
    val scope = rememberCoroutineScope()
    var pw by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val c = FacetTheme.colors
    FacetSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).navigationBarsPadding().imePadding().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(title, style = FacetTheme.type.titleL, color = c.text)
            Text(body, style = FacetTheme.type.body, color = c.textSecondary)
            FacetTextField(pw, { pw = it; error = null }, label = "Password", password = true, imeAction = ImeAction.Done)
            error?.let { Text(it, style = FacetTheme.type.labelM, color = c.error) }
            FacetButton(
                action, {
                    busy = true
                    scope.launch {
                        runCatching { onConfirm(pw) }.onSuccess { onDismiss() }.onFailure { error = it.message ?: "That didn't work." }
                        busy = false
                    }
                },
                style = if (danger) ButtonStyle.Danger else ButtonStyle.Primary, loading = busy, enabled = pw.isNotEmpty(), modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

fun passwordOk(p: String) = p.length >= 10

fun passwordHint(p: String): String = when {
    p.isEmpty() -> "At least 10 characters. A passphrase of a few words works well."
    p.length < 10 -> "${10 - p.length} more characters"
    p.length < 14 -> "Good. Longer is even stronger."
    else -> "Strong"
}

// ---------------- Devices ----------------

@Composable
fun DevicesScreen(container: AppContainer, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var sessions by remember { mutableStateOf<List<SessionDto>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val c = FacetTheme.colors
    suspend fun load() {
        runCatching { container.auth.sessions() }.onSuccess { sessions = it.sortedByDescending { s -> s.lastSeenAt } }.onFailure { error = it.message }
    }
    LaunchedEffect(Unit) { load() }
    SettingsPage("Signed-in devices", onBack) {
        val list = sessions
        when {
            error != null -> EmptyState("Couldn't load devices", error!!, icon = R.drawable.ic_cloud_off, modifier = Modifier.fillMaxWidth())
            list == null -> Text("Loading…", style = FacetTheme.type.body, color = c.textTertiary, modifier = Modifier.padding(12.dp))
            else -> {
                SettingsGroup {
                    list.forEachIndexed { i, s ->
                        if (i > 0) GroupDivider()
                        SettingsRow(
                            s.deviceName.ifBlank { "Unknown device" } + if (s.current) " (this device)" else "",
                            subtitle = "Active ${Dates.relative(s.lastSeenAt).replaceFirstChar { it.lowercase() }}" + (s.ip?.let { " · $it" } ?: ""),
                            icon = R.drawable.ic_phone,
                            showChevron = false,
                            trailing = if (!s.current) {
                                { FacetButton("Sign out", { scope.launch { runCatching { container.auth.revokeSession(s.id) }; load() } }, style = ButtonStyle.Text) }
                            } else null,
                        )
                    }
                }
                if (list.count { !it.current } > 0) {
                    FacetButton(
                        "Sign out of all other devices", { scope.launch { runCatching { container.auth.revokeOtherSessions() }; load() } },
                        style = ButtonStyle.Tonal, modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}
