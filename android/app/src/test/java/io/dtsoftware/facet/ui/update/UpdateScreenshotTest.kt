package io.dtsoftware.facet.ui.update

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.ui.theme.ThemeMode
import io.dtsoftware.facet.update.UpdateError
import io.dtsoftware.facet.update.UpdateManifest
import io.dtsoftware.facet.update.UpdatePhase
import io.dtsoftware.facet.update.UpdateState
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The update dialog and Settings → About states, for design review: `gradlew :app:recordRoborazziDebug`. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xxhdpi", application = android.app.Application::class)
class UpdateScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private val manifest = UpdateManifest(
        versionCode = 2, versionName = "1.1.0", url = "https://facet.dtsoftware.io/download/android/facet-1.1.0.apk",
        sha256 = "ab".repeat(32), size = 36_812_345,
        notes = "Control your PC from your phone with Facet for Windows.\nFaster sync on slow connections.\nFacet now updates itself.",
    )
    private val base = UpdateState(enabled = true, installedVersionName = "1.0.0", available = manifest)
    private val actions = UpdateActions({}, {}, {}, {})

    private fun shoot(name: String, mode: ThemeMode, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            FacetTheme(mode = mode) {
                Box(Modifier.fillMaxSize().background(FacetTheme.colors.background).padding(16.dp), contentAlignment = Alignment.TopCenter) {
                    content()
                }
            }
        }
        repeat(4) {
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            compose.mainClock.advanceTimeBy(300)
        }
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/update_$name.png")
    }

    @Test fun dialogDark() = shoot("dialog_dark", ThemeMode.DARK) {
        Box(Modifier.fillMaxSize().background(FacetTheme.colors.scrim), contentAlignment = Alignment.Center) { UpdateCard(base, manifest, actions) }
    }

    @Test fun dialogLight() = shoot("dialog_light", ThemeMode.LIGHT) {
        Box(Modifier.fillMaxSize().background(FacetTheme.colors.scrim), contentAlignment = Alignment.Center) { UpdateCard(base, manifest, actions) }
    }

    @Test fun dialogStatesDark() = shoot("dialog_states_dark", ThemeMode.DARK) {
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            UpdateCard(base.copy(phase = UpdatePhase.Downloading(14_200_000, manifest.size)), manifest, actions)
            UpdateCard(base.copy(error = UpdateError.DOWNLOAD), manifest, actions)
        }
    }

    @Test fun dialogPermissionLight() = shoot("dialog_permission_light", ThemeMode.LIGHT) {
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            UpdateCard(base.copy(phase = UpdatePhase.NeedsPermission), manifest, actions)
            UpdateCard(base.copy(phase = UpdatePhase.Installing), manifest, actions)
        }
    }

    @Test fun aboutDark() = shoot("about_dark", ThemeMode.DARK) {
        Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
            UpdateGroup(base, autoCheck = true, actions = actions, onCheck = {}, onAutoCheck = {})
            UpdateGroup(base.copy(phase = UpdatePhase.Downloading(14_200_000, manifest.size)), autoCheck = true, actions = actions, onCheck = {}, onAutoCheck = {})
            UpdateGroup(base.copy(available = null, lastCheckedAt = System.currentTimeMillis() - 5 * 60_000), autoCheck = false, actions = actions, onCheck = {}, onAutoCheck = {})
        }
    }

    @Test fun aboutStatesLight() = shoot("about_states_light", ThemeMode.LIGHT) {
        Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
            UpdateGroup(base.copy(phase = UpdatePhase.NeedsPermission), autoCheck = true, actions = actions, onCheck = {}, onAutoCheck = {})
            UpdateGroup(base.copy(available = null, error = UpdateError.CHECK), autoCheck = true, actions = actions, onCheck = {}, onAutoCheck = {})
            UpdateGroup(base.copy(available = null, phase = UpdatePhase.Checking), autoCheck = true, actions = actions, onCheck = {}, onAutoCheck = {})
        }
    }
}
