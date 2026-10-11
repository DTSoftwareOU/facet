package io.dtsoftware.facet.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import androidx.room.withTransaction
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.crypto.DecryptionException
import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.data.db.FacetDatabase
import io.dtsoftware.facet.data.db.MessageStatus
import io.dtsoftware.facet.data.prefs.SettingsStore
import io.dtsoftware.facet.data.repo.AttachmentStore
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.OkHttpClient

enum class SyncPhase { OFF, IDLE, SYNCING, OFFLINE, ERROR, PAUSED }

data class SyncState(
    val phase: SyncPhase,
    val lastSyncAt: Long = 0,
    val message: String? = null,
    /** The account's sync storage is full: some changes and files are waiting on this device. */
    val storageFull: Boolean = false,
)

/** An automatic clean-up: [files] old files ([bytes]) left sync storage and stayed on the devices that had them. */
data class AutoFreed(val at: Long, val files: Int, val bytes: Long)

/**
 * Offline-first, end-to-end encrypted sync (docs/API.md "Sync"). Local rows carry a dirty flag;
 * pushes are last-writer-wins on `updatedAt`; pulls follow the server's change cursor.
 * While the app is open, an SSE stream triggers a pull whenever another device pushes.
 */
class SyncEngine(
    context: Context,
    private val scope: CoroutineScope,
    private val db: FacetDatabase,
    private val auth: AuthManager,
    private val api: SyncApi,
    private val settings: SettingsStore,
    private val attachments: AttachmentStore,
    private val secrets: SecretBox,
    http: OkHttpClient,
) {
    private val prefs = context.getSharedPreferences("facet_sync", Context.MODE_PRIVATE)
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val streamHttp = http.newBuilder()
        .readTimeout(70, java.util.concurrent.TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private val mutex = Mutex()
    private val _state = MutableStateFlow(SyncState(SyncPhase.OFF, prefs.getLong(K_LAST, 0)))
    val state: StateFlow<SyncState> = _state.asStateFlow()

    private var debounceJob: Job? = null
    private var streamJob: Job? = null
    @Volatile private var foreground = false
    /** Reasons to keep the stream open in the background: a pending remote call, a reply that uses a PC. */
    private val streamHolds = java.util.concurrent.atomic.AtomicInteger(0)
    private val streamGeneration = java.util.concurrent.atomic.AtomicLong(0)

    private val _streamConnected = MutableStateFlow(false)
    /** True while the change stream is open (after its `ready` event). */
    val streamConnected: StateFlow<Boolean> = _streamConnected.asStateFlow()

    /**
     * Receives the stream's device-to-device events (docs/REMOTE.md): `ready`, `presence` and `relay` with their
     * JSON data, and `closed` when an open stream ends. Called on a background thread.
     */
    @Volatile var streamListener: ((event: String, data: String) -> Unit)? = null
    private var lastAccountRefresh = 0L
    @Volatile private var storageFull = false
    @Volatile private var uploadedBytes = 0L
    private var roomChecks = 0

    private val _autoFreed = MutableStateFlow(
        prefs.getLong(K_FREED_AT, 0).takeIf { it > 0 }?.let { AutoFreed(it, prefs.getInt(K_FREED_FILES, 0), prefs.getLong(K_FREED_BYTES, 0)) },
    )
    /** The last automatic clean-up this device did, if any. */
    val autoFreed: StateFlow<AutoFreed?> = _autoFreed.asStateFlow()

    private var cursor: Long
        get() = prefs.getLong(K_CURSOR, 0)
        set(value) { prefs.edit().putLong(K_CURSOR, value).apply() }

    fun start() {
        scope.launch {
            auth.state.collect { s ->
                when (s) {
                    is AccountState.SignedIn -> {
                        if (_state.value.phase == SyncPhase.OFF || _state.value.phase == SyncPhase.PAUSED) {
                            _state.value = SyncState(SyncPhase.IDLE, prefs.getLong(K_LAST, 0))
                        }
                        requestSync(0)
                    }
                    AccountState.Guest -> _state.value = SyncState(SyncPhase.OFF)
                    is AccountState.Expired -> _state.value = SyncState(SyncPhase.PAUSED, prefs.getLong(K_LAST, 0), Strings.get(R.string.sync_status_sign_in_to_resume))
                }
                updateStream()
            }
        }
        runCatching {
            connectivity?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    requestSync(500)
                    updateStream()
                }
            })
        }
    }

    fun setForeground(value: Boolean) {
        foreground = value
        updateStream()
        if (value) requestSync(0)
    }

    /** Debounced sync request after local edits. */
    fun requestSync(delayMs: Long = 1500) {
        if (!auth.isSignedIn) return
        debounceJob?.cancel()
        debounceJob = scope.launch {
            delay(delayMs)
            syncNow()
        }
    }

    suspend fun syncNow(): Boolean = mutex.withLock {
        if (!auth.isSignedIn) return false
        val key = auth.vaultKey() ?: return false
        val codec = RecordCodec(key, secrets)
        _state.value = _state.value.copy(phase = SyncPhase.SYNCING, message = null)
        storageFull = false
        uploadedBytes = 0
        roomChecks = 0
        return try {
            withContext(Dispatchers.IO) {
                push(codec, key)
                pull(codec)
                purge(codec)
                downloadPending(codec, key)
                // Keep the storage meter current after uploads, and whenever space is tight.
                if (storageFull || uploadedBytes > 0 || Clock.now() - lastAccountRefresh > 10 * 60_000) {
                    runCatching { auth.refreshAccount() }
                    lastAccountRefresh = Clock.now()
                }
            }
            val now = Clock.now()
            prefs.edit().putLong(K_LAST, now).apply()
            _state.value = SyncState(SyncPhase.IDLE, now, if (storageFull) Strings.get(R.string.sync_status_storage_full) else null, storageFull)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: AuthException) {
            _state.value = SyncState(if (auth.isSignedIn) SyncPhase.ERROR else SyncPhase.PAUSED, prefs.getLong(K_LAST, 0), e.message)
            false
        } catch (e: ApiException) {
            _state.value = SyncState(SyncPhase.ERROR, prefs.getLong(K_LAST, 0), e.message)
            false
        } catch (e: IOException) {
            _state.value = SyncState(SyncPhase.OFFLINE, prefs.getLong(K_LAST, 0), Strings.get(R.string.sync_status_offline))
            false
        } catch (e: Exception) {
            Log.w(TAG, "sync failed", e)
            _state.value = SyncState(SyncPhase.ERROR, prefs.getLong(K_LAST, 0), Strings.get(R.string.sync_status_failed))
            false
        }
    }

    // ---- push ----

    private class Pending(val record: RecordDto, val onAccepted: suspend () -> Unit)

    private suspend fun push(codec: RecordCodec, vaultKey: ByteArray) {
        // Clean up as storage fills, so devices that hold none of the old files can keep syncing too.
        if (settings.synced.value.autoFreeSpace) {
            account()?.takeIf { it.quotaBytes > 0 }?.let { ensureRoom(codec, it.quotaBytes / 50, Long.MAX_VALUE, fresh = false) }
        }
        retryWaitingFiles(codec)
        repeat(MAX_ROUNDS) {
            val batch = collectDirty(codec, vaultKey)
            if (batch.isEmpty()) return
            var refusedForSpace = false
            for (chunk in chunked(batch)) {
                val res = auth.authed { base, token -> api.push(base, token, chunk.map { it.record }) }
                val byKey = chunk.associateBy { it.record.type + "/" + it.record.id }
                db.withTransaction {
                    res.accepted.forEach { a -> byKey[a.type + "/" + a.id]?.onAccepted?.invoke() }
                    res.rejected.forEach { r -> r.current?.let { applyRemote(codec, it, force = true) } }
                }
                // Refused for space: make room and send them next round, or keep them queued here until there's space.
                val refused = res.rejected.filter { it.reason == "quota" }
                if (refused.isNotEmpty()) {
                    val need = refused.sumOf { r -> (byKey[r.type + "/" + r.id]?.record?.ct?.length ?: 0) * 3L / 4 + RECORD_OVERHEAD }
                    if (!ensureRoom(codec, need, Long.MAX_VALUE, fresh = true)) {
                        storageFull = true
                        refusedForSpace = true
                    }
                }
            }
            if (refusedForSpace) return
        }
    }

    private fun chunked(batch: List<Pending>): List<List<Pending>> {
        val out = ArrayList<List<Pending>>()
        var cur = ArrayList<Pending>()
        var bytes = 0
        for (p in batch) {
            val size = (p.record.ct?.length ?: 0) + 200
            if (cur.isNotEmpty() && (cur.size >= 200 || bytes + size > 5_000_000)) {
                out += cur
                cur = ArrayList()
                bytes = 0
            }
            cur += p
            bytes += size
        }
        if (cur.isNotEmpty()) out += cur
        return out
    }

    private suspend fun collectDirty(codec: RecordCodec, vaultKey: ByteArray): List<Pending> {
        val out = ArrayList<Pending>()
        if (settings.syncedDirty) {
            val s = settings.synced.value
            out += Pending(codec.encode(s)) { settings.markSyncedClean(s.updatedAt) }
        }
        val providers = db.providers()
        providers.dirty(LIMIT).forEach { e -> out += Pending(codec.encode(e)) { providers.markClean(e.id, e.updatedAt) } }
        val folders = db.folders()
        folders.dirty(LIMIT).forEach { e -> out += Pending(codec.encode(e)) { folders.markClean(e.id, e.updatedAt) } }
        val prompts = db.prompts()
        prompts.dirty(LIMIT).forEach { e -> out += Pending(codec.encode(e)) { prompts.markClean(e.id, e.updatedAt) } }
        val assistants = db.assistants()
        assistants.dirty(LIMIT).forEach { e -> out += Pending(codec.encode(e)) { assistants.markClean(e.id, e.updatedAt) } }
        val conversations = db.conversations()
        conversations.dirty(LIMIT).forEach { e -> out += Pending(codec.encode(e)) { conversations.markClean(e.id, e.updatedAt) } }
        val atts = db.attachments()
        atts.dirty(LIMIT).forEach { e ->
            if (e.conversationId == null && !e.deleted) return@forEach // unsent draft
            var current = e
            if (!e.deleted && !e.uploaded && !e.localOnly) {
                val file = attachments.file(e) ?: return@forEach
                // Files over the server's blob limit stay on this device; only their record syncs.
                if (file.length() <= MAX_SYNC_BLOB_BYTES) {
                    val blobId = codec.blobId(e.id)
                    val blob = try {
                        FacetCrypto.encryptBlob(vaultKey, blobId, file.readBytes(), compressible = compressible(e.mimeType))
                    } catch (err: Exception) {
                        return@forEach
                    }
                    val size = blob.size.toLong()
                    // When storage looks full, make room first (by clearing older files) rather than send a doomed upload.
                    val roomy = ensureRoom(codec, size, e.createdAt, fresh = false)
                    var result = if (roomy) putBlob(blobId, blob) else Upload.FULL
                    if (result == Upload.FULL && roomy && ensureRoom(codec, size, e.createdAt, fresh = true)) result = putBlob(blobId, blob)
                    when (result) {
                        Upload.DONE -> {
                            uploadedBytes += size
                            atts.markUploaded(e.id)
                            current = e.copy(uploaded = true)
                        }
                        // Sync storage is full: the file waits here, its record syncs, and it uploads once there's room.
                        Upload.FULL -> storageFull = true
                        // e.g. a network blip: retry next sync without holding up everything else.
                        Upload.FAILED -> return@forEach
                    }
                }
            }
            out += Pending(codec.encode(current)) { atts.markClean(e.id, e.updatedAt) }
        }
        val mcp = db.mcpServers()
        mcp.dirty(LIMIT).forEach { e -> out += Pending(codec.encode(e)) { mcp.markClean(e.id, e.updatedAt) } }
        val skills = db.skills()
        skills.dirty(LIMIT).forEach { e -> out += Pending(codec.encode(e)) { skills.markClean(e.id, e.updatedAt) } }
        val messages = db.messages()
        messages.dirty(LIMIT * 2).forEach { e -> out += Pending(codec.encode(e)) { messages.markClean(e.id, e.updatedAt) } }
        return out
    }

    // ---- pull ----

    private suspend fun pull(codec: RecordCodec) {
        var since = cursor
        var seen: MutableMap<String, MutableSet<String>>? = null
        var rounds = 0
        while (rounds++ < 10_000) {
            val res = auth.authed { base, token -> api.pull(base, token, since, PAGE) }
            if (res.reset) {
                since = 0
                cursor = 0
                seen = HashMap()
                continue
            }
            db.withTransaction {
                for (r in res.records) {
                    val opened = applyRemote(codec, r, force = false)
                    if (opened != null) seen?.getOrPut(opened.type) { HashSet() }?.add(opened.id)
                }
            }
            since = res.cursor
            cursor = since
            if (!res.hasMore) break
        }
        seen?.let { deleteUnseen(it) }
    }

    /** Decrypts and applies one pulled record (last writer wins). Returns the opened record, or null if unreadable. */
    private suspend fun applyRemote(codec: RecordCodec, raw: RecordDto, force: Boolean): OpenedRecord? {
        try {
            val r = codec.open(raw) ?: return null
            when (r.type) {
                RecordType.CONVERSATION -> {
                    val dao = db.conversations()
                    val local = dao.get(r.id)
                    if (!force && local != null && local.dirty && local.updatedAt > r.updatedAt) return r
                    if (r.deleted) {
                        dao.hardDelete(r.id)
                        db.messages().hardDeleteConversation(r.id)
                    } else {
                        dao.upsert(codec.conversation(r))
                    }
                }
                RecordType.MESSAGE -> {
                    val dao = db.messages()
                    val local = dao.get(r.id)
                    if (local != null && local.status == MessageStatus.STREAMING.name) return r
                    if (!force && local != null && local.dirty && local.updatedAt > r.updatedAt) return r
                    if (r.deleted) dao.hardDelete(r.id) else dao.upsert(codec.message(r))
                }
                RecordType.ATTACHMENT -> {
                    val dao = db.attachments()
                    val local = dao.get(r.id)
                    if (!force && local != null && local.dirty && local.updatedAt > r.updatedAt) return r
                    if (r.deleted) {
                        local?.let { attachments.deleteFile(it) }
                        dao.hardDelete(r.id)
                    } else {
                        dao.upsert(codec.attachment(r, local))
                    }
                }
                RecordType.ASSISTANT -> {
                    val dao = db.assistants()
                    val local = dao.get(r.id)
                    if (!force && local != null && local.dirty && local.updatedAt > r.updatedAt) return r
                    if (r.deleted) dao.hardDelete(r.id) else dao.upsert(codec.assistant(r))
                }
                RecordType.FOLDER -> {
                    val dao = db.folders()
                    val local = dao.get(r.id)
                    if (!force && local != null && local.dirty && local.updatedAt > r.updatedAt) return r
                    if (r.deleted) dao.hardDelete(r.id) else dao.upsert(codec.folder(r))
                }
                RecordType.PROMPT -> {
                    val dao = db.prompts()
                    val local = dao.get(r.id)
                    if (!force && local != null && local.dirty && local.updatedAt > r.updatedAt) return r
                    if (r.deleted) dao.hardDelete(r.id) else dao.upsert(codec.prompt(r))
                }
                RecordType.PROVIDER -> {
                    val dao = db.providers()
                    val local = dao.get(r.id)
                    if (!force && local != null && local.dirty && local.updatedAt > r.updatedAt) return r
                    if (r.deleted) dao.hardDelete(r.id) else dao.upsert(codec.provider(r, local))
                }
                RecordType.SETTINGS -> if (!r.deleted) {
                    val remote = codec.settings(r)
                    if (force || !settings.syncedDirty || remote.updatedAt >= settings.synced.value.updatedAt) {
                        settings.applyRemoteSynced(remote)
                    }
                }
                RecordType.MCP -> {
                    val dao = db.mcpServers()
                    val local = dao.get(r.id)
                    if (!force && local != null && local.dirty && local.updatedAt > r.updatedAt) return r
                    if (r.deleted) dao.hardDelete(r.id) else dao.upsert(codec.mcpServer(r, local))
                }
                RecordType.SKILL -> {
                    val dao = db.skills()
                    val local = dao.get(r.id)
                    if (!force && local != null && local.dirty && local.updatedAt > r.updatedAt) return r
                    if (r.deleted) dao.hardDelete(r.id) else dao.upsert(codec.skill(r))
                }
                else -> Unit // Unknown type from a newer client: ignore.
            }
            return r
        } catch (e: DecryptionException) {
            Log.w(TAG, "skipping undecryptable record")
        } catch (e: kotlinx.serialization.SerializationException) {
            Log.w(TAG, "skipping malformed record")
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "skipping malformed record")
        }
        return null
    }

    /** After a server reset, local clean rows the server no longer has are deleted. */
    private suspend fun deleteUnseen(seen: Map<String, Set<String>>) = db.withTransaction {
        fun gone(type: String, ids: List<String>) = ids.filter { it !in seen[type].orEmpty() }
        gone(RecordType.CONVERSATION, db.conversations().cleanIds()).forEach {
            db.conversations().hardDelete(it); db.messages().hardDeleteConversation(it)
        }
        gone(RecordType.MESSAGE, db.messages().cleanIds()).forEach { db.messages().hardDelete(it) }
        gone(RecordType.ATTACHMENT, db.attachments().cleanIds()).forEach { id ->
            db.attachments().get(id)?.takeIf { it.uploaded }?.let { attachments.deleteFile(it); db.attachments().hardDelete(id) }
        }
        gone(RecordType.ASSISTANT, db.assistants().cleanIds()).forEach { db.assistants().hardDelete(it) }
        gone(RecordType.FOLDER, db.folders().cleanIds()).forEach { db.folders().hardDelete(it) }
        gone(RecordType.PROMPT, db.prompts().cleanIds()).forEach { db.prompts().hardDelete(it) }
        gone(RecordType.PROVIDER, db.providers().cleanIds()).forEach { db.providers().hardDelete(it) }
        gone(RecordType.MCP, db.mcpServers().cleanIds()).forEach { db.mcpServers().hardDelete(it) }
        gone(RecordType.SKILL, db.skills().cleanIds()).forEach { db.skills().hardDelete(it) }
    }

    private suspend fun purge(codec: RecordCodec) {
        db.mcpServers().purgeTombstones()
        db.skills().purgeTombstones()
        db.conversations().purgeTombstones()
        db.messages().purgeTombstones()
        db.assistants().purgeTombstones()
        db.folders().purgeTombstones()
        db.prompts().purgeTombstones()
        db.providers().purgeTombstones()
        db.attachments().purgeable().forEach { a ->
            if (a.uploaded) runCatching { auth.authed { base, token -> api.deleteBlob(base, token, codec.blobId(a.id)) } }
            attachments.deleteFile(a)
            db.attachments().hardDelete(a.id)
        }
    }

    private suspend fun downloadPending(codec: RecordCodec, vaultKey: ByteArray) {
        db.attachments().pendingDownload(EAGER_DOWNLOAD_MAX, 20).forEach { a ->
            runCatching {
                val blobId = codec.blobId(a.id)
                val blob = auth.authed { base, token -> api.getBlob(base, token, blobId) }
                attachments.storeDownloaded(a, FacetCrypto.decryptBlob(vaultKey, blobId, blob))
            }
        }
    }

    /** Downloads an attachment's file on demand. Returns false if it isn't available. */
    suspend fun ensureLocal(attachmentId: String): Boolean = withContext(Dispatchers.IO) {
        val a = db.attachments().get(attachmentId) ?: return@withContext false
        if (attachments.file(a) != null) return@withContext true
        if (!a.uploaded || !auth.isSignedIn) return@withContext false
        val key = auth.vaultKey() ?: return@withContext false
        runCatching {
            val blobId = RecordCodec(key, secrets).blobId(a.id)
            val blob = auth.authed { base, token -> api.getBlob(base, token, blobId) }
            attachments.storeDownloaded(a, FacetCrypto.decryptBlob(key, blobId, blob))
            true
        }.getOrDefault(false)
    }

    // ---- storage ----

    private enum class Upload { DONE, FULL, FAILED }

    private suspend fun putBlob(blobId: String, blob: ByteArray): Upload = try {
        auth.authed { base, token -> api.putBlob(base, token, blobId, blob) }
        Upload.DONE
    } catch (err: CancellationException) {
        throw err
    } catch (err: ApiException) {
        if (err.code == "quota_exceeded") Upload.FULL else Upload.FAILED
    } catch (err: Exception) {
        Upload.FAILED
    }

    private fun account() = auth.state.value as? AccountState.SignedIn

    /**
     * Whether [need] more bytes fit in sync storage ([fresh]: check with the server rather than
     * the last known usage). When they don't and automatic clean-up is on, removes the cloud copies
     * of the oldest files this device holds (created before [before]), plus some headroom so it
     * doesn't run on every change. Those files stay on this device, and on any device that
     * downloaded them. Nothing is removed unless that makes [need] fit.
     */
    private suspend fun ensureRoom(codec: RecordCodec, need: Long, before: Long, fresh: Boolean): Boolean {
        // Bytes past the quota; null when the server sets no quota.
        fun over(): Long? = account()?.takeIf { it.quotaBytes > 0 }?.let { it.usedBytes + need - it.quotaBytes }
        if (!fresh && (over() ?: 0) <= 0) return true
        if (roomChecks++ >= MAX_ROOM_CHECKS) return false
        runCatching { auth.refreshAccount() }
        val excess = over() ?: 0
        if (excess <= 0) return true
        if (!settings.synced.value.autoFreeSpace) return false
        val quota = account()?.quotaBytes ?: return false
        // Only files whose complete copy is here: the cloud copy is the one going away.
        val candidates = db.attachments().inCloudOldestFirst(before).filter { attachments.file(it)?.length() == it.sizeBytes }
        if (candidates.sumOf { it.sizeBytes } < excess) return false
        val goal = excess + quota / 20
        var freed = 0L
        var files = 0
        for (f in candidates) {
            if (freed >= goal) break
            try {
                auth.authed { base, token -> api.deleteBlob(base, token, codec.blobId(f.id)) }
            } catch (err: CancellationException) {
                throw err
            } catch (err: Exception) {
                break
            }
            db.attachments().unsync(f.id, Clock.now())
            freed += f.sizeBytes
            files++
        }
        if (files == 0) return false
        val at = Clock.now()
        prefs.edit().putLong(K_FREED_AT, at).putInt(K_FREED_FILES, files).putLong(K_FREED_BYTES, freed).apply()
        _autoFreed.value = AutoFreed(at, files, freed)
        val refreshed = runCatching { auth.refreshAccount() }.isSuccess
        return (over() ?: 0) - (if (refreshed) 0 else freed) <= 0
    }

    /** Files that waited because storage was full upload again, oldest first, once there's room for them. */
    private suspend fun retryWaitingFiles(codec: RecordCodec) {
        val waiting = db.attachments().waitingForSpace(MAX_SYNC_BLOB_BYTES)
        var queued = 0L
        for (f in waiting) {
            if (!ensureRoom(codec, queued + f.sizeBytes, f.createdAt, fresh = false)) {
                storageFull = true
                return
            }
            db.attachments().requeue(f.id, Clock.now())
            queued += f.sizeBytes
        }
    }

    /** Frees cloud space: deletes a file's encrypted copy from the server and keeps it on this device. */
    suspend fun keepOnDeviceOnly(attachmentId: String) = withContext(Dispatchers.IO) {
        val a = db.attachments().get(attachmentId) ?: return@withContext
        val key = auth.vaultKey()
        if (a.uploaded && key != null && auth.isSignedIn) {
            auth.authed { base, token -> api.deleteBlob(base, token, RecordCodec(key, secrets).blobId(a.id)) }
        }
        db.attachments().unsync(a.id, Clock.now())
        requestSync()
    }

    /** Tries to upload files that were kept on this device (after you freed space). */
    suspend fun retryDeviceOnlyFiles() = withContext(Dispatchers.IO) {
        db.attachments().retryLocalOnly(Clock.now())
        requestSync()
    }

    /** Frees space on this device: removes local copies of files that are safely on the server. */
    suspend fun clearDownloadedCopies(): Long = withContext(Dispatchers.IO) {
        var freed = 0L
        db.attachments().downloadedCopies().forEach { a ->
            val f = attachments.file(a) ?: return@forEach
            freed += f.length()
            attachments.deleteFile(a)
            db.attachments().clearLocalFile(a.id)
        }
        freed
    }

    // ---- account lifecycle ----

    /** Queues every local entity for upload (new account, or after an email reset). */
    suspend fun markEverythingDirty() = withContext(Dispatchers.IO) {
        db.withTransaction {
            db.conversations().markAllDirty()
            db.messages().markAllDirty()
            db.attachments().markAllDirty()
            db.assistants().markAllDirty()
            db.folders().markAllDirty()
            db.prompts().markAllDirty()
            db.providers().markAllDirty()
            db.mcpServers().markAllDirty()
            db.skills().markAllDirty()
        }
        settings.markSyncedDirty()
        cursor = 0
    }

    /** Removes all synced content from this device (sign out with "remove data"). */
    suspend fun wipeLocalData() = withContext(Dispatchers.IO) {
        db.withTransaction {
            db.conversations().clear()
            db.messages().clear()
            db.attachments().clear()
            db.assistants().clear()
            db.folders().clear()
            db.prompts().clear()
            db.providers().clear()
            db.mcpServers().clear()
            db.skills().clear()
        }
        attachments.clearAll()
        settings.resetSynced()
        cursor = 0
        prefs.edit().remove(K_LAST).apply()
    }

    fun resetCursor() {
        cursor = 0
    }

    // ---- live updates ----

    /**
     * Keeps the change stream open, even with Facet in the background, until the returned function is called
     * (docs/REMOTE.md: controllers keep their stream open while they wait for a result).
     */
    fun holdStream(): () -> Unit {
        streamHolds.incrementAndGet()
        updateStream()
        val released = java.util.concurrent.atomic.AtomicBoolean(false)
        return {
            if (released.compareAndSet(false, true)) {
                streamHolds.decrementAndGet()
                updateStream()
            }
        }
    }

    @Synchronized
    private fun updateStream() {
        val want = (foreground || streamHolds.get() > 0) && auth.isSignedIn
        if (want && streamJob?.isActive != true) {
            streamJob = scope.launch { runStream() }
        } else if (!want) {
            streamJob?.cancel()
            streamJob = null
        }
    }

    private suspend fun runStream() {
        var backoff = 1_000L
        while (currentCoroutineContext().isActive) {
            try {
                val token = auth.authed { _, t -> t }
                val call = api.streamCall(streamHttp, auth.serverUrl, token)
                coroutineScope {
                    val watcher = launch {
                        try { awaitCancellation() } finally { call.cancel() }
                    }
                    withContext(Dispatchers.IO) {
                        call.execute().use { resp ->
                            if (resp.code == 401) {
                                runCatching { auth.authed { base, t -> api.account(base, t) } }
                                return@withContext
                            }
                            if (!resp.isSuccessful) return@withContext
                            backoff = 1_000L
                            val generation = streamGeneration.incrementAndGet()
                            val reader = io.dtsoftware.facet.core.net.SseReader(resp.body.source())
                            try {
                                while (true) {
                                    val ev = reader.next() ?: break
                                    when (ev.event) {
                                        "ready", "changed" -> {
                                            val remote = runCatching {
                                                AppJson.parseToJsonElement(ev.data).jsonObject["cursor"]!!.jsonPrimitive.long
                                            }.getOrNull()
                                            if (remote != null && remote != cursor) requestSync(250)
                                            if (ev.event == "ready") {
                                                _streamConnected.value = true
                                                notifyStream("ready", ev.data)
                                            }
                                        }
                                        "presence", "relay" -> notifyStream(ev.event!!, ev.data)
                                    }
                                }
                            } finally {
                                if (streamGeneration.get() == generation && _streamConnected.value) {
                                    _streamConnected.value = false
                                    notifyStream("closed", "")
                                }
                            }
                        }
                    }
                    watcher.cancel()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Network drop or auth issue: retry with backoff.
            }
            if (!auth.isSignedIn) return
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(60_000)
        }
    }

    private fun notifyStream(event: String, data: String) {
        try {
            streamListener?.invoke(event, data)
        } catch (e: Exception) {
            Log.w(TAG, "stream listener failed", e)
        }
    }

    private companion object {
        const val TAG = "FacetSync"
        const val K_CURSOR = "cursor"
        const val K_LAST = "last_sync"
        const val LIMIT = 200
        const val PAGE = 500
        const val MAX_ROUNDS = 25
        /** Usage checks with the server per sync while storage is tight. */
        const val MAX_ROOM_CHECKS = 6
        /** The server counts each record's ciphertext plus this much. */
        const val RECORD_OVERHEAD = 64L
        const val K_FREED_AT = "auto_freed_at"
        const val K_FREED_FILES = "auto_freed_files"
        const val K_FREED_BYTES = "auto_freed_bytes"
        const val EAGER_DOWNLOAD_MAX = 6L * 1024 * 1024
    }
}

/** The sync server rejects encrypted blobs over 32 MiB; leave headroom for encryption overhead. */
private const val MAX_SYNC_BLOB_BYTES = 31L * 1024 * 1024

/** Already-compressed formats (JPEG, PNG, MP3, MP4, …) gain nothing from DEFLATE; text-like ones shrink a lot. */
internal fun compressible(mimeType: String): Boolean {
    val m = mimeType.lowercase()
    return m.startsWith("text/") || m == "application/json" || m == "application/pdf" || m == "application/xml" ||
        m == "image/svg+xml" || m == "audio/wav" || m == "audio/x-wav"
}
