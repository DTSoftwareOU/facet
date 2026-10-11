package io.dtsoftware.facet.ui.update

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.util.Dates
import io.dtsoftware.facet.core.util.Format
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.Gem
import io.dtsoftware.facet.ui.components.GroupDivider
import io.dtsoftware.facet.ui.components.SettingsGroup
import io.dtsoftware.facet.ui.components.SettingsRow
import io.dtsoftware.facet.ui.components.SwitchRow
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.update.InstallStatus
import io.dtsoftware.facet.update.UpdateError
import io.dtsoftware.facet.update.UpdateManager
import io.dtsoftware.facet.update.UpdateManifest
import io.dtsoftware.facet.update.UpdatePhase
import io.dtsoftware.facet.update.UpdateState

/** Callbacks shared by the dialog and Settings → About. */
class UpdateActions(
    val update: () -> Unit,
    val notNow: () -> Unit,
    val cancel: () -> Unit,
    val openInstallSettings: () -> Unit,
)

/**
 * The update prompt, plus the hand-offs to Android: its "Install unknown apps" screen and its install
 * confirmation. Sits inside the app lock, so nothing appears over a locked Facet. Inert in debug builds.
 */
@Composable
fun UpdateHost(updates: UpdateManager) {
    if (!updates.enabled) return
    val state by updates.state.collectAsStateWithLifecycle()
    val prompt by updates.prompt.collectAsStateWithLifecycle()
    val userAction by updates.userAction.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val lifecycleState by lifecycle.currentStateAsState()
    val actions = rememberUpdateActions(updates)

    // Coming back from Android's settings or its installer: continue, or let the person try again.
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) updates.onResume() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    // Android's install confirmation opens from a resumed activity (never from the background).
    LaunchedEffect(userAction, lifecycleState) {
        val intent = userAction ?: return@LaunchedEffect
        if (!lifecycleState.isAtLeast(Lifecycle.State.RESUMED)) return@LaunchedEffect
        updates.onUserActionOpened()
        try {
            context.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            updates.onInstallStatus(-1, InstallStatus.Failed(UpdateError.INSTALL))
        } catch (e: SecurityException) {
            updates.onInstallStatus(-1, InstallStatus.Failed(UpdateError.INSTALL))
        }
    }

    val manifest = state.available
    if (prompt && manifest != null) {
        val busy = state.busy
        Dialog(
            // While it works, closing only hides the dialog; otherwise it's "Not now".
            onDismissRequest = { if (busy) updates.hidePrompt() else updates.notNow() },
            properties = DialogProperties(dismissOnClickOutside = busy, usePlatformDefaultWidth = false),
        ) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 24.dp), contentAlignment = Alignment.Center) {
                UpdateCard(state, manifest, actions)
            }
        }
    }
}

@Composable
fun rememberUpdateActions(updates: UpdateManager): UpdateActions {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { updates.onResume() }
    return remember(updates, launcher, context) {
        UpdateActions(
            update = updates::startUpdate,
            notNow = updates::notNow,
            cancel = updates::cancelDownload,
            openInstallSettings = {
                updates.onPermissionRequested()
                val uri = Uri.parse("package:${context.packageName}")
                try {
                    launcher.launch(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, uri))
                } catch (e: ActivityNotFoundException) {
                    runCatching { launcher.launch(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)) }
                }
            },
        )
    }
}

/** The dialog's card: what's new, then progress, the permission step or an error, and the next action. */
@Composable
fun UpdateCard(state: UpdateState, manifest: UpdateManifest, actions: UpdateActions, modifier: Modifier = Modifier) {
    val c = FacetTheme.colors
    val phase = state.phase
    Column(
        modifier
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(c.surface)
            .padding(24.dp),
    ) {
        Gem(size = 40.dp, thinking = state.busy)
        Spacer(Modifier.height(18.dp))
        Text(
            when {
                phase == UpdatePhase.NeedsPermission -> "Allow Facet to install updates"
                state.busy -> "Updating to Facet ${manifest.versionName}"
                else -> "Facet ${manifest.versionName} is available"
            },
            style = FacetTheme.type.titleL, color = c.text,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            "You have ${state.installedVersionName} · ${Format.bytes(manifest.size)} download",
            style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
        )
        Spacer(Modifier.height(18.dp))
        when (phase) {
            is UpdatePhase.Downloading -> ProgressBlock(
                phase.fraction,
                "${Format.bytes(phase.bytes)} of ${Format.bytes(phase.total)}",
                "${(phase.fraction * 100).toInt()}%",
            )
            UpdatePhase.Verifying -> ProgressBlock(1f, "Checking the download…", null)
            UpdatePhase.NeedsPermission -> Text(
                "Android asks once before an app can install updates. On the next screen, turn on " +
                    "\"Allow from this source\", then come back to Facet.",
                style = FacetTheme.type.body, color = c.textSecondary,
            )
            UpdatePhase.Installing -> Text(
                "Confirm the update in Android's prompt. Facet closes while it installs.",
                style = FacetTheme.type.body, color = c.textSecondary,
            )
            else -> ReleaseNotes(manifest)
        }
        if (!state.busy) state.error?.let { ErrorLine(it.message, Modifier.padding(top = 16.dp)) }
        val buttons: @Composable RowScope.() -> Unit = when (phase) {
            is UpdatePhase.Downloading, UpdatePhase.Verifying -> ({
                FacetButton("Cancel", actions.cancel, style = ButtonStyle.Text)
            })
            UpdatePhase.Installing -> ({})
            UpdatePhase.NeedsPermission -> ({
                FacetButton("Not now", actions.notNow, style = ButtonStyle.Text)
                FacetButton("Open settings", actions.openInstallSettings)
            })
            else -> ({
                FacetButton("Not now", actions.notNow, style = ButtonStyle.Text)
                FacetButton(if (state.error?.isCheck == false) "Try again" else "Update", actions.update, icon = R.drawable.ic_download)
            })
        }
        if (phase != UpdatePhase.Installing) {
            Spacer(Modifier.height(24.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), content = buttons)
        }
    }
}

@Composable
private fun ReleaseNotes(manifest: UpdateManifest) {
    val c = FacetTheme.colors
    val lines = manifest.noteLines
    if (lines.isEmpty()) {
        Text("Bug fixes and improvements.", style = FacetTheme.type.body, color = c.textSecondary)
        return
    }
    Text("What's new", style = FacetTheme.type.labelM, color = c.textTertiary)
    Spacer(Modifier.height(8.dp))
    Column(Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        lines.forEach { Bullet(it) }
    }
}

@Composable
private fun Bullet(text: String) {
    val c = FacetTheme.colors
    Row {
        Box(Modifier.padding(top = 9.dp).size(5.dp).clip(CircleShape).background(c.textTertiary))
        Spacer(Modifier.width(10.dp))
        Text(text, style = FacetTheme.type.body, color = c.textSecondary)
    }
}

@Composable
private fun ProgressBlock(fraction: Float, label: String, trailing: String?) {
    val c = FacetTheme.colors
    Column {
        ProgressTrack(fraction)
        Spacer(Modifier.height(8.dp))
        Row {
            Text(label, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary, modifier = Modifier.weight(1f))
            if (trailing != null) Text(trailing, style = FacetTheme.type.labelM, color = c.textSecondary)
        }
    }
}

@Composable
private fun ProgressTrack(fraction: Float, modifier: Modifier = Modifier) {
    val c = FacetTheme.colors
    val shown by animateFloatAsState(fraction.coerceIn(0f, 1f), tween(if (FacetTheme.reducedMotion) 0 else 220), label = "updateProgress")
    Box(modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(c.surfaceHighest)) {
        if (shown > 0f) Box(Modifier.fillMaxWidth(shown).fillMaxHeight().clip(CircleShape).background(c.primary))
    }
}

@Composable
private fun ErrorLine(message: String, modifier: Modifier = Modifier) {
    val c = FacetTheme.colors
    Row(modifier) {
        FacetIcon(R.drawable.ic_alert, null, tint = c.error, size = 18.dp, modifier = Modifier.padding(top = 2.dp))
        Spacer(Modifier.width(10.dp))
        Text(message, style = FacetTheme.type.body, color = c.error)
    }
}

// ---------------- Settings → About ----------------

/** The "Updates" group in Settings → About. Nothing in debug builds. */
@Composable
fun UpdateSection(container: AppContainer) {
    val updates = container.updates
    if (!updates.enabled) return
    val state by updates.state.collectAsStateWithLifecycle()
    val prefs by container.settings.local.collectAsStateWithLifecycle()
    val actions = rememberUpdateActions(updates)
    UpdateGroup(
        state = state,
        autoCheck = prefs.autoUpdateCheck,
        actions = actions,
        onCheck = updates::checkNow,
        onAutoCheck = { on ->
            container.settings.updateLocal { it.copy(autoUpdateCheck = on) }
            if (on) updates.onForeground()
        },
    )
}

@Composable
fun UpdateGroup(state: UpdateState, autoCheck: Boolean, actions: UpdateActions, onCheck: () -> Unit, onAutoCheck: (Boolean) -> Unit) {
    val idle = state.phase == UpdatePhase.Idle
    SettingsGroup(title = "Updates") {
        UpdateStatus(state, actions)
        GroupDivider()
        SettingsRow(
            "Check for updates", icon = R.drawable.ic_regenerate, showChevron = false,
            titleColor = if (idle) FacetTheme.colors.text else FacetTheme.colors.textTertiary,
            onClick = if (idle) onCheck else null,
        )
        GroupDivider()
        SwitchRow(
            "Check for updates automatically", autoCheck, onAutoCheck,
            subtitle = "Asks facet.dtsoftware.io for the latest version when Facet opens and every few hours. No personal data is sent.",
            icon = R.drawable.ic_timer,
        )
    }
}

@Composable
private fun UpdateStatus(state: UpdateState, actions: UpdateActions) {
    val c = FacetTheme.colors
    val m = state.available
    val phase = state.phase
    val installed = "Version ${state.installedVersionName}"
    when {
        phase is UpdatePhase.Downloading && m != null -> Column(Modifier.padding(bottom = 14.dp)) {
            StatusRow(
                "Downloading version ${m.versionName}", "${Format.bytes(phase.bytes)} of ${Format.bytes(phase.total)}",
                icon = R.drawable.ic_download, iconTint = c.primary,
                trailing = { FacetButton("Cancel", actions.cancel, style = ButtonStyle.Text) },
            )
            ProgressTrack(phase.fraction, Modifier.padding(start = 53.dp, end = 16.dp))
        }
        phase == UpdatePhase.Verifying && m != null -> StatusRow("Checking the download…", "Version ${m.versionName}", spinner = true)
        phase == UpdatePhase.NeedsPermission -> StatusRow(
            "Allow Facet to install updates", "Turn on \"Allow from this source\" for Facet, then come back.",
            icon = R.drawable.ic_shield, iconTint = c.warning,
            trailing = { FacetButton("Open settings", actions.openInstallSettings, style = ButtonStyle.Tonal) },
        )
        phase == UpdatePhase.Installing && m != null -> StatusRow("Installing version ${m.versionName}", "Confirm the update in Android's prompt.", spinner = true)
        phase == UpdatePhase.Checking -> StatusRow("Checking for updates…", installed, spinner = true)
        m != null -> Column(Modifier.padding(bottom = 14.dp)) {
            StatusRow(
                "Version ${m.versionName} is available",
                state.error?.message ?: "${Format.bytes(m.size)} · You have ${state.installedVersionName}",
                subtitleColor = if (state.error != null) c.error else c.textSecondary,
                icon = R.drawable.ic_download, iconTint = c.primary,
                trailing = { FacetButton(if (state.error?.isCheck == false) "Try again" else "Update", actions.update) },
            )
            val notes = m.noteLines
            if (notes.isNotEmpty()) {
                Column(Modifier.padding(start = 53.dp, end = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    notes.forEach { line ->
                        Row {
                            Box(Modifier.padding(top = 8.dp).size(4.dp).clip(CircleShape).background(c.textTertiary))
                            Spacer(Modifier.width(8.dp))
                            Text(line, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary)
                        }
                    }
                }
            }
        }
        state.error != null -> StatusRow(installed, state.error.message, subtitleColor = c.error, icon = R.drawable.ic_alert, iconTint = c.error)
        state.lastCheckedAt > 0 -> StatusRow(
            "Facet is up to date", "$installed · Checked ${Dates.relative(state.lastCheckedAt).replaceFirstChar { it.lowercase() }}",
            icon = R.drawable.ic_circle_check, iconTint = c.success,
        )
        else -> StatusRow(installed, "Not checked yet", icon = R.drawable.ic_info)
    }
}

/** A settings row whose subtitle can carry an error, with an optional spinner in place of the icon. */
@Composable
private fun StatusRow(
    title: String,
    subtitle: String,
    subtitleColor: Color = FacetTheme.colors.textSecondary,
    @DrawableRes icon: Int? = null,
    iconTint: Color = FacetTheme.colors.textSecondary,
    spinner: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = FacetTheme.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(21.dp), contentAlignment = Alignment.Center) {
            if (spinner) {
                CircularProgressIndicator(Modifier.size(18.dp), color = c.primary, strokeWidth = 2.dp)
            } else if (icon != null) {
                FacetIcon(icon, null, tint = iconTint, size = 21.dp)
            }
        }
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = FacetTheme.type.labelL, color = c.text)
            Spacer(Modifier.height(2.dp))
            Text(subtitle, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = subtitleColor)
        }
        if (trailing != null) {
            Spacer(Modifier.width(12.dp))
            trailing()
        }
    }
}

/** The Settings list's "About Facet AI" subtitle: the version, or the update waiting. */
fun aboutSubtitle(state: UpdateState): String =
    state.available?.takeIf { state.enabled }?.let { "Version ${it.versionName} is available" } ?: "Version ${state.installedVersionName}"
