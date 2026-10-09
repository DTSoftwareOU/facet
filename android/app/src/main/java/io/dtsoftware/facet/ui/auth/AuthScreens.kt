package io.dtsoftware.facet.ui.auth

import android.content.ClipData
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
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
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.ui.chat.Segmented
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.FacetIconButton
import io.dtsoftware.facet.ui.components.FacetTextField
import io.dtsoftware.facet.ui.components.Gem
import io.dtsoftware.facet.ui.settings.passwordHint
import io.dtsoftware.facet.ui.settings.passwordOk
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlinx.coroutines.launch

/** Full-screen form layout shared by auth screens. */
@Composable
private fun AuthLayout(onBack: (() -> Unit)?, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().background(FacetTheme.colors.background).statusBarsPadding().imePadding()) {
        // Fixed top bar so scrolled content never slides under the back button.
        Box(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 6.dp), contentAlignment = Alignment.CenterStart) {
            if (onBack != null) FacetIconButton(R.drawable.ic_arrow_left, "Back", onBack)
        }
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier
                    .widthIn(max = 480.dp)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp)
                    .padding(top = 4.dp, bottom = 32.dp)
                    .navigationBarsPadding(),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                content = content,
            )
        }
    }
}

@Composable
fun AuthScreen(
    container: AppContainer,
    signUpInitially: Boolean,
    onBack: () -> Unit,
    onForgot: () -> Unit,
    onSignedUp: (recoveryCode: String) -> Unit,
    onSignedIn: () -> Unit,
) {
    val c = FacetTheme.colors
    val scope = rememberCoroutineScope()
    var signUp by rememberSaveable { mutableStateOf(signUpInitially) }
    var name by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var registrationOpen by remember { mutableStateOf(true) }
    var server by remember { mutableStateOf(container.auth.serverUrl) }
    var editServer by remember { mutableStateOf(false) }
    LaunchedEffect(server) { runCatching { container.auth.meta() }.onSuccess { registrationOpen = it.registrationOpen } }

    val emailOk = email.contains('@') && email.substringAfter('@').contains('.')
    val canSubmit = emailOk && !busy && if (signUp) passwordOk(password) && password == confirm else password.isNotEmpty()

    fun submit() {
        if (!canSubmit) return
        busy = true
        error = null
        scope.launch {
            try {
                if (signUp) onSignedUp(container.auth.register(email, password, name)) else { container.auth.login(email, password); onSignedIn() }
            } catch (e: Exception) {
                error = e.message ?: "Something went wrong."
            } finally {
                busy = false
            }
        }
    }

    AuthLayout(onBack) {
        Gem(size = 40.dp)
        Spacer(Modifier.height(4.dp))
        AnimatedContent(signUp, label = "authTitle") { up ->
            Column {
                Text(if (up) "Create your account" else "Welcome back", style = FacetTheme.type.display, color = c.text)
                Spacer(Modifier.height(8.dp))
                Text(
                    if (up) "Your chats, assistants and keys are encrypted on this device before they sync. Not even we can read them."
                    else "Sign in to sync your encrypted chats to this device.",
                    style = FacetTheme.type.body, color = c.textSecondary,
                )
            }
        }
        Spacer(Modifier.height(6.dp))
        if (signUp) FacetTextField(name, { name = it }, label = "Name (optional)", placeholder = "What should we call you?")
        FacetTextField(email, { email = it.trim(); error = null }, label = "Email", placeholder = "you@example.com", keyboardType = KeyboardType.Email)
        FacetTextField(
            password, { password = it; error = null }, label = "Password", password = true,
            supporting = if (signUp) passwordHint(password) else null,
            imeAction = if (signUp) ImeAction.Next else ImeAction.Done, onIme = { if (!signUp) submit() },
        )
        if (signUp) {
            FacetTextField(
                confirm, { confirm = it }, label = "Confirm password", password = true, imeAction = ImeAction.Done, onIme = ::submit,
                isError = confirm.isNotEmpty() && confirm != password,
                supporting = if (confirm.isNotEmpty() && confirm != password) "Passwords don't match." else null,
            )
            Row(
                Modifier.fillMaxWidth().clip(FacetShapes.group).background(c.surface).padding(14.dp),
                verticalAlignment = Alignment.Top,
            ) {
                FacetIcon(R.drawable.ic_key, null, tint = c.warning, size = 18.dp, modifier = Modifier.padding(top = 2.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    "Because your data is end-to-end encrypted, we can't reset your password for you. You'll get a recovery code next. Keep it somewhere safe.",
                    style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary,
                )
            }
            if (!registrationOpen) Text("This server isn't accepting new accounts.", style = FacetTheme.type.labelM, color = c.error)
        }
        error?.let { Text(it, style = FacetTheme.type.labelM, color = c.error) }
        FacetButton(
            when {
                busy && signUp -> "Securing your account…"
                busy -> "Unlocking…"
                signUp -> "Create account"
                else -> "Sign in"
            },
            ::submit, loading = busy, enabled = canSubmit && (!signUp || registrationOpen), modifier = Modifier.fillMaxWidth(),
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            Text(
                if (signUp) "Already have an account? Sign in" else "New to Facet? Create an account",
                style = FacetTheme.type.labelM, color = c.primary,
                modifier = Modifier.clip(FacetShapes.small).clickable { signUp = !signUp; error = null }.padding(8.dp),
            )
        }
        if (!signUp) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                Text(
                    "Forgot password?", style = FacetTheme.type.labelM, color = c.textSecondary,
                    modifier = Modifier.clip(FacetShapes.small).clickable(onClick = onForgot).padding(8.dp),
                )
            }
        }
        Text(
            "Sync server: " + server.removePrefix("https://") + " · Change",
            style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().clip(FacetShapes.small).clickable { editServer = true }.padding(8.dp),
        )
    }
    if (editServer) {
        io.dtsoftware.facet.ui.settings.ServerSheet(container, server, onSaved = { server = it }, onDismiss = { editServer = false })
    }
}

@Composable
fun RecoveryCodeScreen(code: String, reason: String, onDone: () -> Unit) {
    val c = FacetTheme.colors
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var saved by rememberSaveable { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
        if (uri != null) {
            runCatching {
                context.contentResolver.openOutputStream(uri)?.use {
                    it.write("Facet recovery code\n\n$code\n\nKeep this somewhere safe. It unlocks your encrypted data if you forget your password.\n".toByteArray())
                }
                saved = true
            }
        }
    }
    AuthLayout(onBack = null) {
        Gem(size = 40.dp)
        Text("Save your recovery code", style = FacetTheme.type.display, color = c.text)
        Text(
            when (reason) {
                "reset" -> "Your password was reset. Here is your new recovery code. Any older code no longer works."
                "regenerated" -> "Here is your new recovery code. Your previous code no longer works."
                else -> "If you forget your password, this code is the only way to unlock your encrypted data. We can't recover it for you."
            },
            style = FacetTheme.type.body, color = c.textSecondary,
        )
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(20.dp))
                .background(c.surface)
                .border(1.dp, c.outline, RoundedCornerShape(20.dp))
                .padding(vertical = 22.dp, horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            val groups = code.split('-')
            groups.chunked(4).forEach { row ->
                Text(
                    row.joinToString("  "),
                    style = FacetTheme.type.code.copy(fontSize = 19.sp, letterSpacing = 1.sp, fontWeight = FontWeight.Medium),
                    color = c.text,
                    modifier = Modifier.padding(vertical = 4.dp),
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FacetButton(if (copied) "Copied" else "Copy", {
                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Facet recovery code", code))) }
                copied = true
            }, style = ButtonStyle.Tonal, icon = if (copied) R.drawable.ic_check else R.drawable.ic_copy, modifier = Modifier.weight(1f))
            FacetButton("Save file", { saver.launch("facet-recovery-code.txt") }, style = ButtonStyle.Tonal, icon = R.drawable.ic_download, modifier = Modifier.weight(1f))
        }
        FacetButton("Share to a password manager", {
            val intent = Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, "Facet recovery code: $code") }
            context.startActivity(Intent.createChooser(intent, null))
        }, style = ButtonStyle.Text, modifier = Modifier.fillMaxWidth())
        Row(
            Modifier.fillMaxWidth().clip(FacetShapes.group).clickable { saved = !saved }.padding(vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(
                saved, { saved = it },
                colors = CheckboxDefaults.colors(checkedColor = c.primary, uncheckedColor = c.textTertiary, checkmarkColor = c.onPrimary),
            )
            Text("I saved my recovery code somewhere safe", style = FacetTheme.type.body, color = c.text)
        }
        FacetButton("Continue", onDone, enabled = saved, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
fun ForgotPasswordScreen(container: AppContainer, onBack: () -> Unit, onDone: (newRecoveryCode: String) -> Unit) {
    val c = FacetTheme.colors
    val scope = rememberCoroutineScope()
    var mode by rememberSaveable { mutableStateOf("code") }
    var email by rememberSaveable { mutableStateOf("") }
    var recovery by remember { mutableStateOf("") }
    var emailCode by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var codeSent by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var emailEnabled by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(Unit) { emailEnabled = runCatching { container.auth.meta().emailEnabled }.getOrDefault(false) }

    fun run(block: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            try { block() } catch (e: Exception) { error = e.message ?: "Something went wrong." } finally { busy = false }
        }
    }

    AuthLayout(onBack) {
        Text("Reset your password", style = FacetTheme.type.display, color = c.text)
        Segmented(listOf("code", "email"), mode, { if (it == "code") "Recovery code" else "Email" }, { mode = it; error = null })
        FacetTextField(email, { email = it.trim() }, label = "Email", keyboardType = KeyboardType.Email)
        if (mode == "code") {
            Text("Your data stays intact. You'll get a new recovery code afterwards.", style = FacetTheme.type.body, color = c.textSecondary)
            FacetTextField(recovery, { recovery = it }, label = "Recovery code", placeholder = "XXXX-XXXX-XXXX-XXXX-…", mono = true)
            FacetTextField(password, { password = it }, label = "New password", password = true, supporting = passwordHint(password))
            FacetTextField(confirm, { confirm = it }, label = "Confirm new password", password = true, imeAction = ImeAction.Done, isError = confirm.isNotEmpty() && confirm != password)
            error?.let { Text(it, style = FacetTheme.type.labelM, color = c.error) }
            FacetButton(
                "Reset password", { run { onDone(container.auth.recoverWithCode(email, recovery, password)) } },
                loading = busy, enabled = email.contains('@') && recovery.isNotBlank() && passwordOk(password) && password == confirm,
                modifier = Modifier.fillMaxWidth(),
            )
        } else if (emailEnabled == false) {
            Text(
                "This sync server can't send email. Use your recovery code instead, or ask the server's operator.",
                style = FacetTheme.type.body, color = c.textSecondary,
            )
        } else {
            Row(
                Modifier.fillMaxWidth().clip(FacetShapes.group).background(c.errorContainer).padding(14.dp),
                verticalAlignment = Alignment.Top,
            ) {
                FacetIcon(R.drawable.ic_warning, null, tint = c.error, size = 18.dp, modifier = Modifier.padding(top = 2.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    "Without your recovery code, your encrypted data on the server can't be unlocked, so it will be deleted. Chats on this device are uploaded again afterwards.",
                    style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.text,
                )
            }
            if (!codeSent) {
                error?.let { Text(it, style = FacetTheme.type.labelM, color = c.error) }
                FacetButton("Email me a code", { run { container.auth.requestEmailReset(email); codeSent = true } }, loading = busy, enabled = email.contains('@'), modifier = Modifier.fillMaxWidth())
            } else {
                Text("If an account exists for $email, we sent an 8-digit code. It expires in 30 minutes.", style = FacetTheme.type.body, color = c.textSecondary)
                FacetTextField(emailCode, { emailCode = it.filter(Char::isDigit).take(8) }, label = "Code from the email", keyboardType = KeyboardType.Number, mono = true)
                FacetTextField(password, { password = it }, label = "New password", password = true, supporting = passwordHint(password))
                FacetTextField(confirm, { confirm = it }, label = "Confirm new password", password = true, imeAction = ImeAction.Done, isError = confirm.isNotEmpty() && confirm != password)
                error?.let { Text(it, style = FacetTheme.type.labelM, color = c.error) }
                FacetButton(
                    "Reset password and data", { run { onDone(container.auth.confirmEmailReset(email, emailCode, password)) } },
                    style = ButtonStyle.Danger, loading = busy, enabled = emailCode.length == 8 && passwordOk(password) && password == confirm,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        Spacer(Modifier.size(4.dp))
    }
}
