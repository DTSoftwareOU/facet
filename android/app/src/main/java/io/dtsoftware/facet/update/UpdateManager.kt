package io.dtsoftware.facet.update

import android.app.Application
import android.content.Intent
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import io.dtsoftware.facet.BuildConfig
import io.dtsoftware.facet.data.prefs.SettingsStore
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

sealed interface UpdatePhase {
    data object Idle : UpdatePhase
    data object Checking : UpdatePhase
    data class Downloading(val bytes: Long, val total: Long) : UpdatePhase {
        val fraction: Float get() = if (total > 0) (bytes.toFloat() / total).coerceIn(0f, 1f) else 0f
    }

    /** Checking the APK's size, SHA-256, package name and versionCode. */
    data object Verifying : UpdatePhase

    /** Waiting for the person to allow Facet to install apps. */
    data object NeedsPermission : UpdatePhase

    /** Handed to Android's package installer. */
    data object Installing : UpdatePhase
}

data class UpdateState(
    /** False in debug builds: nothing checks and nothing is shown. */
    val enabled: Boolean,
    val installedVersionName: String,
    /** A newer version, when one is known. */
    val available: UpdateManifest? = null,
    val phase: UpdatePhase = UpdatePhase.Idle,
    val error: UpdateError? = null,
    val lastCheckedAt: Long = 0,
) {
    /** Downloading, verifying or installing. */
    val busy: Boolean
        get() = phase is UpdatePhase.Downloading || phase == UpdatePhase.Verifying || phase == UpdatePhase.Installing
}

/** Holds the splash screen while the launch check runs, never past its deadline. */
class LaunchGate(private val deadline: Long, private val uptime: () -> Long) {
    @Volatile private var released = false

    fun release() {
        released = true
    }

    val holding: Boolean get() = !released && uptime() < deadline

    companion object {
        fun released(): LaunchGate = LaunchGate(0) { 0 }.apply { release() }
    }
}

/**
 * Keeps Facet up to date from facet.dtsoftware.io (docs/UPDATES.md, "Android"): checks at launch
 * (holding the splash screen at most [UpdatePolicy.LAUNCH_HOLD_MS]) and when the app returns to the
 * foreground [UpdatePolicy.RECHECK_MS] after the last check; prompts unless "Not now" was chosen for
 * that version in the last [UpdatePolicy.SKIP_MS]; downloads into the cache, verifies size, SHA-256,
 * package name and versionCode, then hands the APK to Android's installer.
 */
class UpdateManager(
    private val scope: CoroutineScope,
    private val source: UpdateSource,
    private val store: UpdateStore,
    private val installer: UpdateInstaller,
    private val downloadDir: File,
    val installedVersionCode: Long,
    installedVersionName: String,
    val enabled: Boolean,
    private val autoCheck: () -> Boolean,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val uptime: () -> Long = { System.nanoTime() / 1_000_000 },
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val _state = MutableStateFlow(
        UpdateState(
            enabled = enabled,
            installedVersionName = installedVersionName,
            available = if (enabled) store.latest?.takeIf { UpdatePolicy.isNewer(it, installedVersionCode) } else null,
            lastCheckedAt = if (enabled) store.lastCheckAt else 0,
        ),
    )
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    private val _prompt = MutableStateFlow(false)

    /** Whether the update dialog is showing. */
    val prompt: StateFlow<Boolean> = _prompt.asStateFlow()

    private val _userAction = MutableStateFlow<Intent?>(null)

    /** Android's install confirmation, waiting for a resumed activity to open it. */
    val userAction: StateFlow<Intent?> = _userAction.asStateFlow()

    private var checkJob: Job? = null
    private var updateJob: Job? = null
    private var launchChecked = false
    @Volatile private var sessionId = NO_SESSION
    @Volatile private var confirmOpened = false

    /** Removes downloads of the installed version or older (the update went through). */
    fun start() {
        if (!enabled) return
        scope.launch(io) {
            downloadDir.listFiles()?.forEach { f ->
                val code = APK_NAME.matchEntire(f.name)?.groupValues?.get(1)?.toLongOrNull()
                if (code == null || code <= installedVersionCode) f.delete()
            }
        }
    }

    /**
     * Starts the launch check and returns the gate for the splash screen. Checks on the first launch of
     * the process, and on later launches when a re-check is due. Released at once when there's nothing to do.
     */
    @Synchronized
    fun launchCheck(): LaunchGate {
        if (!enabled || !autoCheck()) return LaunchGate.released()
        val first = !launchChecked
        launchChecked = true
        if (!first && !UpdatePolicy.isRecheckDue(store.lastCheckAt, clock())) return LaunchGate.released()
        val job = runCheck(auto = true) ?: return LaunchGate.released()
        val gate = LaunchGate(uptime() + UpdatePolicy.LAUNCH_HOLD_MS, uptime)
        job.invokeOnCompletion { gate.release() }
        scope.launch {
            delay(UpdatePolicy.LAUNCH_HOLD_MS)
            gate.release()
        }
        return gate
    }

    /** The app came to the foreground. */
    @Synchronized
    fun onForeground() {
        if (!enabled || !autoCheck()) return
        if (!UpdatePolicy.isRecheckDue(store.lastCheckAt, clock())) return
        runCheck(auto = true)
    }

    /** "Check for updates" in Settings → About. Shows the result there and reports failures. */
    @Synchronized
    fun checkNow() {
        if (enabled) runCheck(auto = false)
    }

    private fun runCheck(auto: Boolean): Job? {
        if (checkJob?.isActive == true || updateJob?.isActive == true) return null
        val phase = _state.value.phase
        if (phase != UpdatePhase.Idle) return null
        _state.update { it.copy(phase = UpdatePhase.Checking, error = if (auto) it.error else null) }
        val job = scope.launch {
            try {
                onChecked(source.fetchManifest(), auto)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Automatic checks fail quietly (offline is normal); a requested check says what happened.
                val error = (e as? UpdateException)?.error ?: UpdateError.CHECK
                if (!auto) _state.update { it.copy(error = error) }
            } finally {
                _state.update { if (it.phase == UpdatePhase.Checking) it.copy(phase = UpdatePhase.Idle) else it }
            }
        }
        checkJob = job
        return job
    }

    private suspend fun onChecked(manifest: UpdateManifest, auto: Boolean) {
        val now = clock()
        val newer = UpdatePolicy.isNewer(manifest, installedVersionCode)
        store.lastCheckAt = now
        store.latest = if (newer) manifest else null
        withContext(io) { deleteDownloadsExcept(if (newer) manifest.versionCode else null) }
        _state.update { it.copy(available = if (newer) manifest else null, error = null, lastCheckedAt = now) }
        if (!newer) return
        if (auto && store.resumeInstallFor == manifest.versionCode) {
            // Android ended Facet while the person was allowing installs; pick the update back up.
            store.resumeInstallFor = 0
            if (installer.canRequestInstalls()) {
                _prompt.value = true
                synchronized(this) { beginUpdate(manifest) }
                return
            }
        }
        if (auto && UpdatePolicy.shouldPrompt(manifest, installedVersionCode, store.skippedVersionCode, store.skippedAt, now)) {
            _prompt.value = true
        }
    }

    /** "Update": download (or reuse a verified download), verify, install. Shows the dialog for progress. */
    @Synchronized
    fun startUpdate() {
        if (!enabled) return
        val manifest = _state.value.available ?: return
        _prompt.value = true
        if (updateJob?.isActive == true) return
        if (_state.value.phase == UpdatePhase.Installing || _state.value.phase == UpdatePhase.NeedsPermission) return
        checkJob?.cancel()
        beginUpdate(manifest)
    }

    private fun beginUpdate(manifest: UpdateManifest) {
        if (updateJob?.isActive == true) return
        store.resumeInstallFor = 0
        val first = if (apkFile(manifest.versionCode).exists()) UpdatePhase.Verifying else UpdatePhase.Downloading(0, manifest.size)
        _state.update { it.copy(phase = first, error = null) }
        updateJob = scope.launch {
            try {
                val apk = obtainApk(manifest)
                install(apk)
            } catch (e: CancellationException) {
                _state.update { it.copy(phase = UpdatePhase.Idle) }
                throw e
            } catch (e: Exception) {
                val error = (e as? UpdateException)?.error ?: UpdateError.DOWNLOAD
                _state.update { it.copy(phase = UpdatePhase.Idle, error = error) }
                _prompt.value = true
            }
        }
    }

    private suspend fun obtainApk(manifest: UpdateManifest): File {
        val file = apkFile(manifest.versionCode)
        val reuse = withContext(io) { ApkVerifier.verify(file, manifest) == ApkVerifier.Result.OK }
        if (!reuse) {
            withContext(io) {
                downloadDir.mkdirs()
                file.delete()
                val free = downloadDir.usableSpace
                if (free in 1 until manifest.size + SPACE_MARGIN) throw UpdateException(UpdateError.NO_SPACE)
            }
            _state.update { it.copy(phase = UpdatePhase.Downloading(0, manifest.size)) }
            source.download(manifest, file) { bytes, total ->
                _state.update { s -> if (s.phase is UpdatePhase.Downloading) s.copy(phase = UpdatePhase.Downloading(bytes, total)) else s }
            }
        }
        _state.update { it.copy(phase = UpdatePhase.Verifying) }
        withContext(io) {
            if (!reuse && ApkVerifier.verify(file, manifest) != ApkVerifier.Result.OK) {
                file.delete()
                throw UpdateException(UpdateError.CORRUPT)
            }
            val identity = runCatching { installer.inspect(file) }.getOrNull()
            if (!ApkVerifier.isExpectedArchive(identity, manifest)) {
                file.delete()
                throw UpdateException(UpdateError.NOT_FACET)
            }
        }
        return file
    }

    private suspend fun install(apk: File) {
        if (!installer.canRequestInstalls()) {
            _state.update { it.copy(phase = UpdatePhase.NeedsPermission) }
            _prompt.value = true
            return
        }
        sessionId = NO_SESSION
        confirmOpened = false
        _state.update { it.copy(phase = UpdatePhase.Installing) }
        sessionId = try {
            withContext(io) { installer.install(apk) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw UpdateException(UpdateError.INSTALL, e)
        }
    }

    /** The person is about to open Android's "Install unknown apps" screen for Facet. */
    @Synchronized
    fun onPermissionRequested() {
        _state.value.available?.let { store.resumeInstallFor = it.versionCode }
    }

    /**
     * An activity resumed: continue once installs are allowed, and recover when Android's confirmation
     * closed without reporting back (some versions don't report a dismissal).
     */
    @Synchronized
    fun onResume() {
        if (!enabled) return
        val s = _state.value
        when (s.phase) {
            UpdatePhase.NeedsPermission -> if (installer.canRequestInstalls()) {
                val manifest = s.available
                if (manifest != null) beginUpdate(manifest) else _state.update { it.copy(phase = UpdatePhase.Idle) }
            }
            UpdatePhase.Installing -> if (confirmOpened) {
                val session = sessionId
                scope.launch {
                    delay(INSTALL_RESULT_GRACE_MS)
                    _state.update { if (it.phase == UpdatePhase.Installing && sessionId == session && confirmOpened) it.copy(phase = UpdatePhase.Idle) else it }
                }
            }
            else -> Unit
        }
    }

    /** The activity opened [userAction]. */
    fun onUserActionOpened() {
        _userAction.value = null
        confirmOpened = true
    }

    /** A result from Android's installer (via [InstallResultReceiver]). */
    @Synchronized
    fun onInstallStatus(session: Int, status: InstallStatus) {
        if (!enabled || _state.value.phase != UpdatePhase.Installing) return
        val current = sessionId
        if (current != NO_SESSION && session != -1 && session != current) return
        when (status) {
            is InstallStatus.NeedsUserAction -> _userAction.value = status.intent
            InstallStatus.Success -> {
                _userAction.value = null
                _state.update { it.copy(phase = UpdatePhase.Idle, error = null) }
            }
            InstallStatus.Aborted -> {
                _userAction.value = null
                _state.update { it.copy(phase = UpdatePhase.Idle, error = null) }
            }
            is InstallStatus.Failed -> {
                _userAction.value = null
                _state.update { it.copy(phase = UpdatePhase.Idle, error = status.error) }
                _prompt.value = true
            }
        }
    }

    /** "Not now": hide the prompt for this version for [UpdatePolicy.SKIP_MS]. */
    @Synchronized
    fun notNow() {
        _state.value.available?.let {
            store.skippedVersionCode = it.versionCode
            store.skippedAt = clock()
        }
        store.resumeInstallFor = 0
        _prompt.value = false
        _state.update { if (it.phase == UpdatePhase.NeedsPermission) it.copy(phase = UpdatePhase.Idle, error = null) else it.copy(error = null) }
    }

    /** Closes the dialog without skipping; a running download carries on (progress shows in Settings → About). */
    fun hidePrompt() {
        _prompt.value = false
    }

    @Synchronized
    fun cancelDownload() {
        val phase = _state.value.phase
        if (phase is UpdatePhase.Downloading || phase == UpdatePhase.Verifying) updateJob?.cancel()
    }

    private fun apkFile(versionCode: Long) = File(downloadDir, "facet-$versionCode.apk")

    private fun deleteDownloadsExcept(versionCode: Long?) {
        val keep = versionCode?.let { apkFile(it).name }
        downloadDir.listFiles()?.forEach { if (it.name != keep) it.delete() }
    }

    companion object {
        private const val NO_SESSION = Int.MIN_VALUE
        private const val INSTALL_RESULT_GRACE_MS = 2_000L
        private const val SPACE_MARGIN = 16L * 1024 * 1024
        private val APK_NAME = Regex("""^facet-(\d+)\.apk(\.part)?$""")

        /** The app's manager: release builds check facet.dtsoftware.io; debug builds are inert. */
        fun create(app: Application, http: OkHttpClient, settings: SettingsStore, scope: CoroutineScope): UpdateManager {
            val manager = UpdateManager(
                scope = scope,
                source = HttpUpdateSource(http),
                store = PrefsUpdateStore(app),
                installer = AndroidUpdateInstaller(app),
                downloadDir = File(app.cacheDir, "updates"),
                installedVersionCode = BuildConfig.VERSION_CODE.toLong(),
                installedVersionName = BuildConfig.VERSION_NAME,
                enabled = UpdateConfig.enabled,
                autoCheck = { settings.local.value.autoUpdateCheck },
            )
            if (manager.enabled) {
                manager.start()
                ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                    override fun onStart(owner: LifecycleOwner) = manager.onForeground()
                })
            }
            return manager
        }
    }
}
