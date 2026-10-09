package io.dtsoftware.facet.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.github.takahirom.roborazzi.captureRoboImage
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.db.ConversationEntity
import io.dtsoftware.facet.data.db.MessageEntity
import io.dtsoftware.facet.data.db.ProviderEntity
import io.dtsoftware.facet.data.prefs.LocalPrefs
import io.dtsoftware.facet.llm.Citation
import io.dtsoftware.facet.llm.Effort
import io.dtsoftware.facet.llm.GenParams
import io.dtsoftware.facet.llm.ModelCaps
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ModelPricing
import io.dtsoftware.facet.llm.ProviderBlocks
import io.dtsoftware.facet.llm.ReasoningKind
import io.dtsoftware.facet.llm.ReasoningSupport
import io.dtsoftware.facet.llm.Usage
import io.dtsoftware.facet.ui.auth.AuthScreen
import io.dtsoftware.facet.ui.auth.RecoveryCodeScreen
import io.dtsoftware.facet.ui.home.DrawerContent
import io.dtsoftware.facet.ui.home.DrawerViewModel
import io.dtsoftware.facet.ui.home.HomeScreen
import io.dtsoftware.facet.ui.markdown.MathRenderer
import io.dtsoftware.facet.ui.onboarding.OnboardingScreen
import io.dtsoftware.facet.ui.settings.ProviderEditScreen
import io.dtsoftware.facet.ui.settings.SettingsScreen
import io.dtsoftware.facet.ui.theme.FacetTheme
import io.dtsoftware.facet.ui.theme.ThemeMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Renders real screens with sample data for design review: `gradlew :app:recordRoborazziDebug`. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w412dp-h915dp-xxhdpi", application = android.app.Application::class)
class AppScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private val app get() = RuntimeEnvironment.getApplication()

    private fun container(seed: Boolean = true, providers: Boolean = true): Pair<AppContainer, String?> {
        app.getSharedPreferences("facet_settings", Context.MODE_PRIVATE).edit()
            .putString("local_v1", AppJson.encodeToString(LocalPrefs(onboardingDone = true, pricingFeed = false)))
            .commit()
        val c = AppContainer(app)
        MathRenderer.warmUp(app)
        val convId = if (seed) runBlocking { seed(c, providers) } else null
        return c to convId
    }

    private suspend fun seed(c: AppContainer, withProviders: Boolean): String? {
        if (!withProviders) return null
        val now = Clock.now()
        val reasoning = ReasoningSupport(ReasoningKind.EFFORT, listOf(Effort.LOW, Effort.MEDIUM, Effort.HIGH, Effort.XHIGH, Effort.MAX), Effort.MEDIUM, true)
        val claude = listOf(
            ModelInfo("claude-opus-5-5", "Claude Opus 5.5", 1_000_000, 128_000, ModelCaps(vision = true, pdf = true, reasoning = reasoning, webSearch = true, sampling = false, fastMode = true), ModelPricing(4.0, 20.0)),
            ModelInfo("claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, 128_000, ModelCaps(vision = true, pdf = true, reasoning = reasoning, webSearch = true, sampling = false), ModelPricing(2.0, 10.0)),
            ModelInfo("claude-haiku-5-5", "Claude Haiku 5.5", 1_000_000, 128_000, ModelCaps(vision = true, reasoning = reasoning, sampling = false), ModelPricing(0.1, 0.5)),
        )
        val anthropic = ProviderEntity(
            id = "p-anthropic", kind = "anthropic", label = "Anthropic", baseUrl = "https://api.anthropic.com",
            modelsJson = AppJson.encodeToString(claude), modelsFetchedAt = now, favoritesJson = "[\"claude-opus-5-5\"]",
            createdAt = now, updatedAt = now,
        )
        val gpt = listOf(
            ModelInfo("gpt-5.5", "GPT-5.5", 400_000, 128_000, ModelCaps(vision = true, pdf = true, reasoning = reasoning, webSearch = true, sampling = false, verbosity = true), ModelPricing(1.25, 10.0)),
        )
        val openai = ProviderEntity(
            id = "p-openai", kind = "openai", label = "OpenAI", baseUrl = "https://api.openai.com/v1",
            modelsJson = AppJson.encodeToString(gpt), modelsFetchedAt = now, createdAt = now + 1, updatedAt = now + 1,
        )
        c.db.providers().upsert(anthropic)
        c.db.providers().upsert(openai)

        val day = 24 * 60 * 60 * 1000L
        val titles = listOf(
            "Plan a 3-day trip to Lisbon" to 0L, "Kotlin coroutine retry with backoff" to 2 * 60 * 60 * 1000L,
            "Explain HTTPS like I'm five" to day + 1000, "Renting vs buying in Porto" to 3 * day, "Spanish past tense quiz" to 4 * day,
            "Unit economics for a coffee cart" to 12 * day, "Draft: conference talk bio" to 20 * day,
        )
        var mainId: String? = null
        titles.forEachIndexed { i, (title, ago) ->
            val id = Ids.new()
            if (i == 0) mainId = id
            c.db.conversations().upsert(
                ConversationEntity(
                    id = id, title = title, titleSet = true, providerId = anthropic.id, modelId = "claude-opus-5-5",
                    paramsJson = AppJson.encodeToString(GenParams(effort = Effort.HIGH, webSearch = true)),
                    pinned = i == 1, createdAt = now - ago, lastActivityAt = now - ago, updatedAt = now - ago,
                ),
            )
        }
        val conv = mainId!!
        val u = MessageEntity(Ids.new(), conv, null, "user", "Plan a 3-day trip to Lisbon in late October. I like food, viewpoints and walking, not museums.", createdAt = now - 60_000, updatedAt = now - 60_000)
        val reply = """
            Late October is a lovely time for Lisbon: mild days around **20 °C**, fewer crowds, and the light is soft for viewpoints.

            ## Day by day

            | Day | Morning | Afternoon | Evening |
            |---|---|---|---|
            | 1 | Alfama walk | Miradouro de Santa Luzia | Fado in Mouraria |
            | 2 | Belém pastries | LX Factory | Sunset at Senhora do Monte |
            | 3 | Time Out Market | Príncipe Real | Dinner in Cais do Sodré |

            ### Tips
            - Buy a **Navegante** card for trams and metro; tram 28 gets packed after 10 am.
            - Book fado ahead on weekends.
            - Wear grippy shoes: the *calçada* gets slick after rain.

            The walk from Alfama up to the castle is about $2.1\ \text{km}$ with $\approx 110\ \text{m}$ of climb.
        """.trimIndent()
        val a = MessageEntity(
            Ids.new(), conv, u.id, "assistant", reply,
            thinking = "The user wants food, viewpoints and walking. Late October weather is mild. Group sights by neighborhood to minimize hills…",
            thinkingMs = 14_000, providerId = anthropic.id, modelId = "claude-opus-5-5", modelName = "Claude Opus 5.5",
            citationsJson = AppJson.encodeToString(
                listOf(
                    Citation("https://www.visitlisboa.com/en", "Visit Lisboa: official guide"),
                    Citation("https://www.carris.pt/en", "Carris: trams and buses"),
                    Citation("https://www.timeoutmarket.com/lisboa", "Time Out Market Lisboa"),
                ),
            ),
            usageJson = AppJson.encodeToString(Usage(inputTokens = 1840, outputTokens = 612, reasoningTokens = 290)),
            costUsd = 0.0196,
            blocksJson = AppJson.encodeToString(ProviderBlocks(io.dtsoftware.facet.llm.ApiStyle.ANTHROPIC, "claude-opus-5-5", "[]")),
            createdAt = now - 50_000, updatedAt = now - 50_000,
        )
        val u2 = MessageEntity(Ids.new(), conv, a.id, "user", "Add a day trip to Sintra and give me a packing list.", createdAt = now - 20_000, updatedAt = now - 20_000)
        val a2 = MessageEntity(
            Ids.new(), conv, u2.id, "assistant",
            "Sure. Take the train from **Rossio** (about 40 minutes) and start with Pena Palace before the tour buses arrive.\n\n```text\nPacking list\n- Light rain jacket\n- Walking shoes with grip\n- Layers for 14–22 °C\n- Power bank\n```",
            providerId = anthropic.id, modelId = "claude-opus-5-5", modelName = "Claude Opus 5.5", thinkingMs = 6_000,
            usageJson = AppJson.encodeToString(Usage(inputTokens = 2520, outputTokens = 188)), costUsd = 0.0138,
            createdAt = now - 10_000, updatedAt = now - 10_000,
        )
        listOf(u, a, u2, a2).forEach { c.db.messages().upsert(it) }
        c.db.conversations().upsert(c.db.conversations().get(conv)!!.copy(currentLeafId = a2.id))
        return conv
    }

    private fun shoot(name: String, mode: ThemeMode, content: @Composable () -> Unit) {
        compose.mainClock.autoAdvance = false
        compose.setContent {
            FacetTheme(mode = mode) {
                Box(Modifier.fillMaxSize().background(FacetTheme.colors.background)) { content() }
            }
        }
        repeat(12) {
            Thread.sleep(120)
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            compose.mainClock.advanceTimeBy(300)
        }
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/app_$name.png")
    }

    @Test fun chatDark() = chat(ThemeMode.DARK, "chat_dark")
    @Test fun chatLight() = chat(ThemeMode.LIGHT, "chat_light")

    private fun chat(mode: ThemeMode, name: String) {
        val (c, conv) = container()
        val requests = MutableStateFlow<LaunchRequest?>(LaunchRequest.OpenConversation(conv!!))
        shoot(name, mode) { HomeScreen(c, requests, {}, {}, {}, {}, {}) }
    }

    @Test fun thinkingDark() = live("thinking_dark", text = "", thinking = "Comparing the user's budget against typical rents in each neighborhood, then checking transport times…")
    @Test fun streamingDark() = live(
        "streaming_dark",
        text = "Here's how the two neighborhoods compare for a remote worker:\n\n| | Arroios | Campo de Ourique |\n|---|---|---|\n| Rent (1-bed) | €1,150 | €1,300 |\n| Cafés with Wi-Fi | Many | Some |\n\nArroios is livelier and closer to the metro, while",
        thinking = "",
        searching = true,
    )

    private fun live(name: String, text: String, thinking: String, searching: Boolean = false) {
        val (c, conv) = container()
        val now = Clock.now()
        val user = MessageEntity(Ids.new(), conv!!, null, "user", "Which neighborhood should I live in as a remote worker in Lisbon?", createdAt = now + 100_000, updatedAt = now + 100_000)
        val reply = MessageEntity(
            Ids.new(), conv, user.id, "assistant", "", providerId = "p-anthropic", modelId = "claude-opus-5-5", modelName = "Claude Opus 5.5",
            status = io.dtsoftware.facet.data.db.MessageStatus.STREAMING.name, createdAt = now + 100_001, updatedAt = now + 100_001,
        )
        runBlocking {
            c.db.messages().upsert(user)
            c.db.messages().upsert(reply)
            c.db.conversations().upsert(c.db.conversations().get(conv)!!.copy(currentLeafId = reply.id))
        }
        c.chat.showLiveForTest(
            io.dtsoftware.facet.domain.LiveTurn(
                reply.id, conv, text = text, thinking = thinking, thinkingActive = text.isEmpty(),
                thinkingStartedAt = now - 4_000, thinkingMs = if (text.isEmpty()) 0 else 9_000,
                searching = searching, searchQuery = if (searching) "Arroios rent prices 2026" else null, searchCount = if (searching) 1 else 0,
            ),
        )
        val requests = MutableStateFlow<LaunchRequest?>(LaunchRequest.OpenConversation(conv))
        shoot(name, ThemeMode.DARK) { HomeScreen(c, requests, {}, {}, {}, {}, {}) }
    }

    @Test
    fun newChatDark() {
        val (c, _) = container()
        shoot("new_chat_dark", ThemeMode.DARK) { HomeScreen(c, MutableStateFlow(null), {}, {}, {}, {}, {}) }
    }

    @Test
    fun noKeysDark() {
        val (c, _) = container(providers = false)
        shoot("no_keys_dark", ThemeMode.DARK) { HomeScreen(c, MutableStateFlow(null), {}, {}, {}, {}, {}) }
    }

    @Test
    fun drawerDark() {
        val (c, conv) = container()
        shoot("drawer_dark", ThemeMode.DARK) {
            val vm = androidx.lifecycle.viewmodel.compose.viewModel { DrawerViewModel(c) }
            val state = vm.state.collectAsStateWithLifecycle().value
            Box(Modifier.width(318.dp)) {
                DrawerContent(
                    state, vm, conv, io.dtsoftware.facet.sync.AccountState.SignedIn("u", "ada@example.com", "Ada Lovelace", "https://facet.dtsoftware.io", 1L shl 24, 2L shl 30),
                    io.dtsoftware.facet.sync.SyncState(io.dtsoftware.facet.sync.SyncPhase.IDLE, Clock.now() - 120_000),
                    io.dtsoftware.facet.ui.home.DrawerCallbacks({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}),
                )
            }
        }
    }

    @Test
    fun settingsDark() {
        val (c, _) = container()
        shoot("settings_dark", ThemeMode.DARK) { SettingsScreen(c, {}, {}) }
    }

    @Test
    fun onboardingLight() {
        val (c, _) = container(seed = false)
        shoot("onboarding_light", ThemeMode.LIGHT) { OnboardingScreen(c, {}, {}, {}, {}) }
    }

    @Test
    fun onboardingDark() {
        val (c, _) = container(seed = false)
        shoot("onboarding_dark", ThemeMode.DARK) { OnboardingScreen(c, {}, {}, {}, {}) }
    }

    @Test
    fun signUpDark() {
        val (c, _) = container(seed = false)
        shoot("signup_dark", ThemeMode.DARK) { AuthScreen(c, true, {}, {}, {}, {}) }
    }

    @Test
    fun recoveryCodeDark() {
        shoot("recovery_dark", ThemeMode.DARK) { RecoveryCodeScreen("R30W-5GY4-RQ3C-FJ69-SB5W-SKEE-SZ8D-3MPK", "signup") {} }
    }

    @Test
    fun providerEditDark() {
        val (c, _) = container(seed = false)
        shoot("provider_edit_dark", ThemeMode.DARK) { ProviderEditScreen(c, null, "anthropic") {} }
    }

    private fun editedModels(c: AppContainer) = runBlocking {
        c.providers.setModelPrefs("p-anthropic", "claude-haiku-5-5", io.dtsoftware.facet.data.repo.ModelPrefs(hidden = true))
        c.providers.setModelPrefs("p-anthropic", "claude-sonnet-5-5", io.dtsoftware.facet.data.repo.ModelPrefs(name = "Sonnet for work", maxOutput = 32_000))
    }

    /** A tall screen, so the model list below the provider form is in frame. */
    @Test
    @Config(qualifiers = "w412dp-h1500dp-xxhdpi")
    fun providerModelsDark() {
        val (c, _) = container()
        editedModels(c)
        shoot("provider_models_dark", ThemeMode.DARK) { ProviderEditScreen(c, "p-anthropic", null) {} }
    }

    @Test
    @Config(qualifiers = "w412dp-h1500dp-xxhdpi")
    fun mcpDirectoryDark() {
        val (c, _) = container(seed = false)
        shoot("mcp_directory_dark", ThemeMode.DARK) { io.dtsoftware.facet.ui.settings.McpServersScreen(c, {}, {}) }
    }

    /** A reply with a generated image and a generated song. */
    @Test
    fun chatMediaDark() {
        val (c, _) = container()
        val conv = runBlocking {
            val now = Clock.now()
            val id = Ids.new()
            c.db.conversations().upsert(
                ConversationEntity(
                    id = id, title = "Fox poster", titleSet = true, providerId = "p-openai", modelId = "gpt-5.5",
                    paramsJson = AppJson.encodeToString(GenParams()), createdAt = now, lastActivityAt = now, updatedAt = now,
                ),
            )
            val bmp = android.graphics.Bitmap.createBitmap(512, 512, android.graphics.Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(bmp)
            val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
            paint.shader = android.graphics.LinearGradient(0f, 0f, 0f, 512f, 0xFF27406B.toInt(), 0xFFE7EEF7.toInt(), android.graphics.Shader.TileMode.CLAMP)
            canvas.drawRect(0f, 0f, 512f, 512f, paint)
            paint.shader = null
            paint.color = 0xFFE0662E.toInt()
            canvas.drawCircle(256f, 300f, 110f, paint)
            paint.color = 0xFFFFFFFF.toInt()
            canvas.drawRect(0f, 420f, 512f, 512f, paint)
            val png = java.io.ByteArrayOutputStream().also { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
            val img = c.attachments.storeGenerated(png, "image/png", "red-fox-poster.png", id)
            val song = c.attachments.storeGenerated("ID3".toByteArray() + ByteArray(4096), "audio/mpeg", "fox-theme-lofi.mp3", id)
            val u = MessageEntity(Ids.new(), id, null, "user", "Make a poster of a red fox in the snow, and a short theme song for it.", createdAt = now - 60_000, updatedAt = now - 60_000)
            val calls = listOf(
                io.dtsoftware.facet.domain.tools.ToolCallRecord("c1", "generate_image", "MEDIA", "Created image with GPT Image 1", "{}", "ok", false),
                io.dtsoftware.facet.domain.tools.ToolCallRecord("c2", "generate_music", "MEDIA", "Created track with Eleven Music", "{}", "ok", false),
            )
            val text = "Here's a poster of a red fox in fresh snow, plus a 30-second lo-fi theme to go with it. Want another style, or a longer track?"
            val a = MessageEntity(
                Ids.new(), id, u.id, "assistant", text,
                providerId = "p-openai", modelId = "gpt-5.5", modelName = "GPT-5.5",
                stepsJson = AppJson.encodeToString(io.dtsoftware.facet.domain.tools.ToolTrace(listOf(io.dtsoftware.facet.domain.tools.ToolStep("", calls)), text)),
                attachmentsJson = AppJson.encodeToString(listOf(io.dtsoftware.facet.data.repo.AttachmentStore.ref(img), io.dtsoftware.facet.data.repo.AttachmentStore.ref(song))),
                createdAt = now - 50_000, updatedAt = now - 50_000,
            )
            listOf(u, a).forEach { c.db.messages().upsert(it) }
            c.db.conversations().upsert(c.db.conversations().get(id)!!.copy(currentLeafId = a.id))
            id
        }
        val requests = MutableStateFlow<LaunchRequest?>(LaunchRequest.OpenConversation(conv))
        shoot("chat_media_dark", ThemeMode.DARK) { HomeScreen(c, requests, {}, {}, {}, {}, {}) }
    }

    @Test
    @Config(qualifiers = "w412dp-h1500dp-xxhdpi")
    fun mediaModelsDark() {
        val (c, _) = container()
        runBlocking {
            val out = io.dtsoftware.facet.llm.ModelOutput.entries
            val models = listOf(
                ModelInfo("gpt-5.5", "GPT-5.5"),
                ModelInfo("gpt-image-1", "GPT Image 1", output = out[1]),
                ModelInfo("gpt-4o-mini-tts", "GPT-4o mini TTS", output = io.dtsoftware.facet.llm.ModelOutput.SPEECH),
                ModelInfo("gpt-4o-transcribe", "GPT-4o Transcribe", output = io.dtsoftware.facet.llm.ModelOutput.TRANSCRIPTION),
            )
            c.db.providers().setModels("p-openai", AppJson.encodeToString(models), Clock.now())
            c.settings.updateSynced { it.copy(media = it.media.copy(speech = io.dtsoftware.facet.data.prefs.ModelRef("p-openai", "gpt-4o-mini-tts"))) }
        }
        shoot("media_models_dark", ThemeMode.DARK) { io.dtsoftware.facet.ui.settings.MediaModelsScreen(c, {}, {}) }
    }

    @Test
    fun modelEditDark() {
        val (c, _) = container()
        editedModels(c)
        val p = runBlocking { c.providers.get("p-anthropic")!! }
        shoot("model_edit_dark", ThemeMode.DARK) {
            Box(Modifier.background(FacetTheme.colors.surface)) { io.dtsoftware.facet.ui.settings.ModelEditForm(c, p, "claude-sonnet-5-5") {} }
        }
    }
}

