package io.dtsoftware.facet.ui.lock

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.ContextWrapper
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.Gem
import io.dtsoftware.facet.ui.theme.FacetTheme
import androidx.compose.material3.Text

/** Biometric / device-credential authentication via the platform APIs (no extra libraries). */
object DeviceAuth {
    fun isAvailable(context: Context): Boolean {
        val km = context.getSystemService(KeyguardManager::class.java)
        return km?.isDeviceSecure == true
    }

    fun authenticate(context: Context, title: String, onResult: (Boolean) -> Unit) {
        val activity = context.findActivity() ?: return onResult(false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val builder = BiometricPrompt.Builder(activity).setTitle(title).setSubtitle("Facet AI")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
            } else {
                @Suppress("DEPRECATION") builder.setDeviceCredentialAllowed(true)
            }
            val prompt = builder.build()
            prompt.authenticate(
                CancellationSignal(),
                activity.mainExecutor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) = onResult(true)
                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) = onResult(false)
                },
            )
        } else {
            // Android 8.x: confirm the device credential through the keyguard.
            val km = activity.getSystemService(KeyguardManager::class.java)
            @Suppress("DEPRECATION")
            val intent = km?.createConfirmDeviceCredentialIntent(title, "Facet AI") ?: return onResult(true)
            pendingLegacyCallback = onResult
            @Suppress("DEPRECATION") activity.startActivityForResult(intent, LEGACY_REQUEST)
        }
    }

    const val LEGACY_REQUEST = 4242
    var pendingLegacyCallback: ((Boolean) -> Unit)? = null

    private fun Context.findActivity(): Activity? {
        var c = this
        while (c is ContextWrapper) {
            if (c is Activity) return c
            c = c.baseContext
        }
        return null
    }
}

/** Locks the UI on cold start and after 30 s in the background when app lock is on. */
@Composable
fun AppLockGate(enabled: Boolean, content: @Composable () -> Unit) {
    var locked by rememberSaveable { mutableStateOf(enabled) }
    var backgroundedAt by remember { mutableLongStateOf(0L) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val context = LocalContext.current
    DisposableEffect(lifecycle, enabled) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> backgroundedAt = Clock.now()
                Lifecycle.Event.ON_START -> if (enabled && backgroundedAt > 0 && Clock.now() - backgroundedAt > 30_000) locked = true
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    if (!enabled) {
        content()
        return
    }
    if (!locked) {
        content()
        return
    }
    val promptTitle = stringResource(R.string.lock_prompt_title)
    val unlock = { DeviceAuth.authenticate(context, promptTitle) { ok -> if (ok) locked = false } }
    LaunchedEffect(Unit) { unlock() }
    Box(Modifier.fillMaxSize().background(FacetTheme.colors.background), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Gem(size = 56.dp)
            Spacer(Modifier.height(20.dp))
            Text(stringResource(R.string.lock_locked), style = FacetTheme.type.headline, color = FacetTheme.colors.text)
            Spacer(Modifier.height(24.dp))
            FacetButton(stringResource(R.string.lock_unlock), { unlock() }, icon = R.drawable.ic_fingerprint)
        }
    }
}
