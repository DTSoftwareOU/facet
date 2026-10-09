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
    val chat = ChatEngine(scope, conversations, providers, assistants, attachments, settings, pricing, sync)

    @Volatile var appInForeground = false

    init {
        Notifications.createChannels(app)
        settings.onSyncedChanged = { sync.requestSync() }
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
        sync.start()
        if (auth.isSignedIn) SyncWorker.schedule(app)
    }
}
