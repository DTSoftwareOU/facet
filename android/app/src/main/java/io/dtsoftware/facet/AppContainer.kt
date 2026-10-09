package io.dtsoftware.facet

import android.app.Application
import io.dtsoftware.facet.core.crypto.KeystoreSecretBox
import io.dtsoftware.facet.data.db.FacetDatabase
import io.dtsoftware.facet.data.prefs.PrefsQuirkStore
import io.dtsoftware.facet.data.prefs.SettingsStore
import io.dtsoftware.facet.data.repo.AssistantRepository
import io.dtsoftware.facet.data.repo.AttachmentStore
import io.dtsoftware.facet.data.repo.ConversationRepository
import io.dtsoftware.facet.data.repo.FolderRepository
import io.dtsoftware.facet.data.repo.PromptRepository
import io.dtsoftware.facet.data.repo.ProviderRepository
import io.dtsoftware.facet.domain.ChatEngine
import io.dtsoftware.facet.domain.GenerationService
import io.dtsoftware.facet.domain.Notifications
import io.dtsoftware.facet.domain.tools.McpManager
import io.dtsoftware.facet.domain.tools.SearchKind
import io.dtsoftware.facet.domain.tools.SkillRepository
import io.dtsoftware.facet.domain.tools.ToolRegistry
import io.dtsoftware.facet.domain.tools.WebSearch
import io.dtsoftware.facet.llm.PricingCatalog
import io.dtsoftware.facet.sync.AuthManager
import io.dtsoftware.facet.sync.SyncApi
import io.dtsoftware.facet.sync.SyncEngine
import io.dtsoftware.facet.sync.SyncWorker
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/** Manual dependency graph: small, explicit, and fast to start. */
class AppContainer(private val app: Application) {
    val appContext: android.content.Context get() = app
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val secrets = KeystoreSecretBox()
    val settings = SettingsStore(app)
    val db = FacetDatabase.create(app)

    /** Long read timeout: reasoning models can stay silent for minutes before streaming. */
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.MINUTES)
        .writeTimeout(2, TimeUnit.MINUTES)
        .build()

    val quirks = PrefsQuirkStore(app)
    val pricing = PricingCatalog(File(app.cacheDir, "pricing.json"), http)

    private lateinit var syncRef: SyncEngine
    private val onLocalChange: () -> Unit = { if (::syncRef.isInitialized) syncRef.requestSync() }

    val conversations = ConversationRepository(db, onLocalChange)
    val providers = ProviderRepository(db, secrets, http, quirks, pricing, onLocalChange)
    val assistants = AssistantRepository(db, onLocalChange)
    val folders = FolderRepository(db, onLocalChange)
    val prompts = PromptRepository(db, onLocalChange)
    val attachments = AttachmentStore(app, db, onLocalChange)

    val syncApi = SyncApi(http)
    val auth = AuthManager(app, syncApi, secrets)
    val sync: SyncEngine = SyncEngine(app, scope, db, auth, syncApi, settings, attachments, secrets, http).also { syncRef = it }
    val webSearch = WebSearch(http)
    val skills = SkillRepository(db, http, onLocalChange)
    val mcp = McpManager(app, db, secrets, http, scope, onLocalChange)
    val media = io.dtsoftware.facet.domain.media.MediaService(providers, settings, attachments, http, app.cacheDir)
    val tools = ToolRegistry(webSearch, providers, mcp, skills, settings, media)
    val chat = ChatEngine(
        scope, conversations, providers, assistants, attachments, settings, pricing, sync, tools,
        mcpAutoApprove = { serverId, tool -> mcp.setAutoApprove(serverId, tool, true) },
    )

    @Volatile var appInForeground = false

    init {
        Notifications.createChannels(app)
        settings.onSyncedChanged = { sync.requestSync() }
        auth.onProfileName = { name -> settings.updateSynced { it.copy(profileName = name) } }
        auth.onSignedIn = { fresh ->
            scope.launch {
                if (fresh) sync.markEverythingDirty()
                sync.syncNow()
            }
            SyncWorker.schedule(app)
        }
        chat.onReplyFinished = { id, title, preview ->
            if (!appInForeground && settings.local.value.notifyOnComplete) Notifications.replyReady(app, id, title, preview)
        }
        scope.launch {
            chat.active.map { it.isNotEmpty() }.distinctUntilChanged().collect { busy ->
                if (busy) GenerationService.start(app)
            }
        }
        scope.launch { conversations.recoverInterrupted() }
        scope.launch { runCatching { io.dtsoftware.facet.ui.markdown.MathRenderer.warmUpAsync(app) } }
        scope.launch {
            if (settings.local.value.pricingFeed) runCatching { pricing.refreshIfStale(24 * 60 * 60 * 1000L) }
        }
        // Providers that arrive by sync (or were just added) fetch their model lists, and lists older
        // than a day refresh once per launch, so new models and corrected capabilities show up.
        scope.launch {
            val attempted = HashSet<String>()
            providers.observeAll().collect { list ->
                val stale = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
                list.filter { it.enabled && it.modelsFetchedAt < stale && !SearchKind.isSearch(it.kind) && attempted.add(it.id) }
                    .forEach { p -> launch { runCatching { providers.refreshModels(p.id) } } }
            }
        }
        scope.launch {
            val attempted = HashSet<String>()
            mcp.observeAll().collect { list ->
                list.filter { it.enabled && it.toolsFetchedAt == 0L && it.status == null && attempted.add(it.id) }
                    .forEach { e -> launch { runCatching { mcp.refreshTools(e.id) } } }
            }
        }
        sync.start()
        if (auth.isSignedIn) SyncWorker.schedule(app)
    }
}
