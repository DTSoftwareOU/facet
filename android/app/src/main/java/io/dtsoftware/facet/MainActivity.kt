package io.dtsoftware.facet

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.core.i18n.AppLanguage
import io.dtsoftware.facet.domain.Notifications
import io.dtsoftware.facet.ui.FacetRoot
import io.dtsoftware.facet.ui.LaunchRequest
import io.dtsoftware.facet.ui.lock.DeviceAuth
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.ui.theme.resolveDark
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    private val launchRequests = MutableStateFlow<LaunchRequest?>(null)

    /** Before Android 13, the language picked in Settings → Appearance (Android 13+ applies it itself). */
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(AppLanguage.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        val container = (application as FacetApp).container
        // The activity is recreated when the interface language changes: redraw cached text, rename channels.
        io.dtsoftware.facet.core.i18n.Strings.refresh()
        Notifications.createChannels(this)
        if (savedInstanceState == null) {
            // The update check keeps the splash up for at most 1.5 s, so a prompt can be the first thing shown.
            val updateGate = container.updates.launchCheck()
            splash.setKeepOnScreenCondition { updateGate.holding }
        }
        launchRequests.value = parseIntent(intent)

        setContent {
            val prefs by container.settings.local.collectAsStateWithLifecycle()
            val dark = resolveDark(prefs.theme)
            LaunchedEffect(dark) {
                val style = if (dark) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
            }
            LaunchedEffect(prefs.secureScreen) {
                if (prefs.secureScreen) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
            FacetTheme(
                mode = prefs.theme,
                dynamicColor = prefs.dynamicColor,
                chatScale = prefs.chatTextScale,
                reducedMotion = prefs.reducedMotion,
            ) {
                FacetRoot(container, launchRequests)
            }
        }
    }

    @Deprecated("Only used for the Android 8 device-credential fallback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == DeviceAuth.LEGACY_REQUEST) {
            DeviceAuth.pendingLegacyCallback?.invoke(resultCode == RESULT_OK)
            DeviceAuth.pendingLegacyCallback = null
            return
        }
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        parseIntent(intent)?.let { launchRequests.value = it }
    }

    private fun parseIntent(intent: Intent?): LaunchRequest? {
        intent ?: return null
        intent.getStringExtra(EXTRA_CONVERSATION)?.let { return LaunchRequest.OpenConversation(it) }
        intent.data?.takeIf { it.scheme == packageName && it.path == "/oauth/mcp" }?.let { uri ->
            return LaunchRequest.McpOAuth(uri.getQueryParameter("state"), uri.getQueryParameter("code"), uri.getQueryParameter("error"))
        }
        return when (intent.action) {
            ACTION_NEW_CHAT -> LaunchRequest.NewChat(voice = false)
            ACTION_VOICE -> LaunchRequest.NewChat(voice = true)
            Intent.ACTION_SEND -> {
                val text = intent.getStringExtra(Intent.EXTRA_TEXT)
                val uri = streamExtra(intent)
                LaunchRequest.Share(text, listOfNotNull(uri))
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                val uris = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION") intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
                }
                LaunchRequest.Share(intent.getStringExtra(Intent.EXTRA_TEXT), uris.orEmpty())
            }
            else -> null
        }
    }

    private fun streamExtra(intent: Intent): Uri? = if (Build.VERSION.SDK_INT >= 33) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
        @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
    }

    companion object {
        const val EXTRA_CONVERSATION = "io.dtsoftware.facet.CONVERSATION"
        const val ACTION_NEW_CHAT = "io.dtsoftware.facet.NEW_CHAT"
        const val ACTION_VOICE = "io.dtsoftware.facet.VOICE_CHAT"
    }
}
