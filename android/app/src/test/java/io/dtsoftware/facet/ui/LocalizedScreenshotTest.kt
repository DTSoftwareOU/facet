package io.dtsoftware.facet.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.github.takahirom.roborazzi.captureRoboImage
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.db.ConversationEntity
import io.dtsoftware.facet.data.db.MessageEntity
import io.dtsoftware.facet.data.db.ProviderEntity
import io.dtsoftware.facet.data.prefs.LocalPrefs
import io.dtsoftware.facet.llm.Effort
import io.dtsoftware.facet.llm.GenParams
import io.dtsoftware.facet.llm.ModelCaps
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ModelPricing
import io.dtsoftware.facet.llm.ReasoningKind
import io.dtsoftware.facet.llm.ReasoningSupport
import io.dtsoftware.facet.llm.Usage
import io.dtsoftware.facet.ui.components.ConfirmDialog
import io.dtsoftware.facet.ui.home.DrawerContent
import io.dtsoftware.facet.ui.home.DrawerViewModel
import io.dtsoftware.facet.ui.home.HomeScreen
import io.dtsoftware.facet.ui.markdown.MathRenderer
import io.dtsoftware.facet.ui.onboarding.OnboardingScreen
import io.dtsoftware.facet.ui.settings.AppearanceScreen
import io.dtsoftware.facet.ui.settings.SettingsScreen
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.ui.theme.ThemeMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Key screens in a few languages, for checking translations for length and right-to-left layout:
 * `gradlew :app:recordRoborazziDebug --tests '*LocalizedScreenshotTest*'` writes
 * app/build/outputs/roborazzi/l10n_<screen>_<lang>.png.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], application = android.app.Application::class)
class LocalizedScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private val app get() = RuntimeEnvironment.getApplication()

    @After
    fun reset() {
        Strings.reset()
        java.util.Locale.setDefault(java.util.Locale.US)
    }

    private fun container(seed: Boolean): AppContainer {
        app.getSharedPreferences("facet_settings", Context.MODE_PRIVATE).edit()
            .putString("local_v1", AppJson.encodeToString(LocalPrefs(onboardingDone = true, pricingFeed = false)))
            .commit()
        val c = AppContainer(app)
        MathRenderer.warmUp(app)
        if (seed) runBlocking { seed(c) }
        return c
    }

    private var conversation: String? = null

    private suspend fun seed(c: AppContainer) {
        val now = Clock.now()
        val reasoning = ReasoningSupport(ReasoningKind.EFFORT, listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH), Effort.MEDIUM, true)
        val models = listOf(
            ModelInfo("claude-opus-5-5", "Claude Opus 5.5", 1_000_000, 128_000, ModelCaps(vision = true, pdf = true, reasoning = reasoning, webSearch = true, sampling = false), ModelPricing(4.0, 20.0)),
        )
        c.db.providers().upsert(
            ProviderEntity(
                id = "p-anthropic", kind = "anthropic", label = "Anthropic", baseUrl = "https://api.anthropic.com",
                modelsJson = AppJson.encodeToString(models), modelsFetchedAt = now, createdAt = now, updatedAt = now,
            ),
        )
        val day = 24 * 60 * 60 * 1000L
        listOf("Plan a 3-day trip to Lisbon" to 0L, "خطة رحلة إلى مراكش" to 3 * 60 * 60 * 1000L, "Kotlin coroutine retry" to day + 1000, "Renting vs buying" to 40 * day)
            .forEachIndexed { i, (title, ago) ->
                val id = Ids.new()
                if (i == 0) conversation = id
                c.db.conversations().upsert(
                    ConversationEntity(
                        id = id, title = title, titleSet = true, providerId = "p-anthropic", modelId = "claude-opus-5-5",
                        paramsJson = AppJson.encodeToString(GenParams(effort = Effort.HIGH, webSearch = true)),
                        pinned = i == 1, createdAt = now - ago, lastActivityAt = now - ago, updatedAt = now - ago,
                    ),
                )
            }
        val conv = conversation!!
        val u = MessageEntity(Ids.new(), conv, null, "user", "Plan a 3-day trip to Lisbon in late October.", createdAt = now - 60_000, updatedAt = now - 60_000)
        val a = MessageEntity(
            Ids.new(), conv, u.id, "assistant",
            "Late October is a lovely time for Lisbon.\n\n## Day by day\n\n- Alfama walk and fado\n- Belém pastries\n- Sintra by train\n\n```text\nPacking list: rain jacket, walking shoes\n```",
            thinkingMs = 14_000, providerId = "p-anthropic", modelId = "claude-opus-5-5", modelName = "Claude Opus 5.5",
            usageJson = AppJson.encodeToString(Usage(inputTokens = 1840, outputTokens = 612)), costUsd = 0.0196,
            createdAt = now - 50_000, updatedAt = now - 50_000,
        )
        val u2 = MessageEntity(Ids.new(), conv, a.id, "user", "ما هي أفضل الأحياء للإقامة؟", createdAt = now - 20_000, updatedAt = now - 20_000)
        val a2 = MessageEntity(
            Ids.new(), conv, u2.id, "assistant",
            "أفضل الأحياء للإقامة هي **ألفاما** و**بايشا**:\n\n- ألفاما: شوارع ضيقة وإطلالات رائعة\n- بايشا: قريبة من كل شيء",
            providerId = "p-anthropic", modelId = "claude-opus-5-5", modelName = "Claude Opus 5.5", thinkingMs = 6_000,
            createdAt = now - 10_000, updatedAt = now - 10_000,
        )
        listOf(u, a, u2, a2).forEach { c.db.messages().upsert(it) }
        c.db.conversations().upsert(c.db.conversations().get(conv)!!.copy(currentLeafId = a2.id))
    }

    private fun shoot(name: String, content: @Composable () -> Unit) {
        val lang = app.resources.configuration.locales[0].toLanguageTag()
        compose.mainClock.autoAdvance = false
        compose.setContent {
            FacetTheme(mode = ThemeMode.DARK) {
                Box(Modifier.fillMaxSize().background(FacetTheme.colors.background)) { content() }
            }
        }
        repeat(12) {
            Thread.sleep(120)
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            compose.mainClock.advanceTimeBy(300)
        }
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/l10n_${name}_$lang.png")
    }

    private fun chat() {
        val c = container(seed = true)
        shoot("chat") { HomeScreen(c, MutableStateFlow(LaunchRequest.OpenConversation(conversation!!)), {}, {}, {}, {}, {}) }
    }

    private fun newChat() {
        val c = container(seed = true)
        shoot("new_chat") { HomeScreen(c, MutableStateFlow(null), {}, {}, {}, {}, {}) }
    }

    private fun drawer() {
        val c = container(seed = true)
        shoot("drawer") {
            val vm = androidx.lifecycle.viewmodel.compose.viewModel { DrawerViewModel(c) }
            val state = vm.state.collectAsStateWithLifecycle().value
            Box(Modifier.width(318.dp)) {
                DrawerContent(
                    state, vm, conversation, io.dtsoftware.facet.sync.AccountState.SignedIn("u", "ada@example.com", "Ada Lovelace", "https://facet.dtsoftware.io", 1L shl 24, 2L shl 30),
                    io.dtsoftware.facet.sync.SyncState(io.dtsoftware.facet.sync.SyncPhase.IDLE, Clock.now() - 120_000),
                    io.dtsoftware.facet.ui.home.DrawerCallbacks({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}),
                )
            }
        }
    }

    private fun settings() {
        val c = container(seed = true)
        shoot("settings") { SettingsScreen(c, {}, {}) }
    }

    private fun appearance() {
        val c = container(seed = false)
        shoot("appearance") { AppearanceScreen(c) {} }
    }

    private fun onboarding() {
        val c = container(seed = false)
        shoot("onboarding") { OnboardingScreen(c, {}, {}, {}, {}) }
    }

    private fun dialog() {
        container(seed = false)
        shoot("dialog") {
            ConfirmDialog(
                stringResource(R.string.settings_delete_all_chats_title), stringResource(R.string.settings_delete_all_chats_body),
                stringResource(R.string.settings_delete_everything), {}, {}, danger = true,
            )
        }
    }

    // English, Arabic (right to left), Japanese, Hindi and German (long words).

    @Test @Config(qualifiers = EN) fun chatEn() = chat()
    @Test @Config(qualifiers = AR) fun chatAr() = chat()
    @Test @Config(qualifiers = JA) fun chatJa() = chat()
    @Test @Config(qualifiers = HI) fun chatHi() = chat()
    @Test @Config(qualifiers = DE) fun chatDe() = chat()

    @Test @Config(qualifiers = EN) fun newChatEn() = newChat()
    @Test @Config(qualifiers = AR) fun newChatAr() = newChat()
    @Test @Config(qualifiers = JA) fun newChatJa() = newChat()
    @Test @Config(qualifiers = HI) fun newChatHi() = newChat()
    @Test @Config(qualifiers = DE) fun newChatDe() = newChat()

    @Test @Config(qualifiers = EN) fun drawerEn() = drawer()
    @Test @Config(qualifiers = AR) fun drawerAr() = drawer()
    @Test @Config(qualifiers = JA) fun drawerJa() = drawer()
    @Test @Config(qualifiers = HI) fun drawerHi() = drawer()
    @Test @Config(qualifiers = DE) fun drawerDe() = drawer()

    @Test @Config(qualifiers = EN_TALL) fun settingsEn() = settings()
    @Test @Config(qualifiers = AR_TALL) fun settingsAr() = settings()
    @Test @Config(qualifiers = JA_TALL) fun settingsJa() = settings()
    @Test @Config(qualifiers = HI_TALL) fun settingsHi() = settings()
    @Test @Config(qualifiers = DE_TALL) fun settingsDe() = settings()

    @Test @Config(qualifiers = EN) fun appearanceEn() = appearance()
    @Test @Config(qualifiers = AR) fun appearanceAr() = appearance()
    @Test @Config(qualifiers = JA) fun appearanceJa() = appearance()
    @Test @Config(qualifiers = HI) fun appearanceHi() = appearance()
    @Test @Config(qualifiers = DE) fun appearanceDe() = appearance()

    @Test @Config(qualifiers = EN) fun onboardingEn() = onboarding()
    @Test @Config(qualifiers = AR) fun onboardingAr() = onboarding()
    @Test @Config(qualifiers = JA) fun onboardingJa() = onboarding()
    @Test @Config(qualifiers = HI) fun onboardingHi() = onboarding()
    @Test @Config(qualifiers = DE) fun onboardingDe() = onboarding()

    @Test @Config(qualifiers = EN) fun dialogEn() = dialog()
    @Test @Config(qualifiers = AR) fun dialogAr() = dialog()
    @Test @Config(qualifiers = JA) fun dialogJa() = dialog()
    @Test @Config(qualifiers = HI) fun dialogHi() = dialog()
    @Test @Config(qualifiers = DE) fun dialogDe() = dialog()

    private companion object {
        const val SIZE = "w412dp-h915dp-xxhdpi"
        const val TALL = "w412dp-h1500dp-xxhdpi"
        const val EN = "en-rUS-$SIZE"
        const val AR = "ar-ldrtl-$SIZE"
        const val JA = "ja-$SIZE"
        const val HI = "hi-$SIZE"
        const val DE = "de-$SIZE"
        const val EN_TALL = "en-rUS-$TALL"
        const val AR_TALL = "ar-ldrtl-$TALL"
        const val JA_TALL = "ja-$TALL"
        const val HI_TALL = "hi-$TALL"
        const val DE_TALL = "de-$TALL"
    }
}
