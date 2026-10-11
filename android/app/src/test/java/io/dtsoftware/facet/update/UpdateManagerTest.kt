package io.dtsoftware.facet.update

import android.content.Intent
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The update flow end to end, with a fake network and installer and virtual time. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class UpdateManagerTest {
    @get:Rule val tmp = TemporaryFolder()

    private val hour = 60 * 60 * 1000L
    private val t0 = 1_800_000_000_000L
    private val apk = ByteArray(50_000) { (it * 7 + 3).toByte() }
    private val sha = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }
    private val v2 = UpdateManifest(2, "1.1.0", "https://facet.dtsoftware.io/download/android/facet-1.1.0.apk", sha, apk.size.toLong(), "Faster sync.")

    private class FakeSource : UpdateSource {
        var manifest: UpdateManifest? = null
        var checkError: UpdateError? = null
        var checkGate: CompletableDeferred<Unit>? = null
        var payload = ByteArray(0)
        var downloadError: UpdateError? = null
        var downloadGate: CompletableDeferred<Unit>? = null
        var checks = 0
        var downloads = 0

        override suspend fun fetchManifest(): UpdateManifest {
            checks++
            checkGate?.await()
            checkError?.let { throw UpdateException(it) }
            return manifest!!
        }

        override suspend fun download(manifest: UpdateManifest, dest: File, onProgress: (Long, Long) -> Unit) {
            downloads++
            onProgress(0, manifest.size)
            downloadGate?.await()
            downloadError?.let { throw UpdateException(it) }
            dest.parentFile!!.mkdirs()
            dest.writeBytes(payload)
            onProgress(payload.size.toLong(), manifest.size)
        }
    }

    private class FakeInstaller : UpdateInstaller {
        var allowed = true
        var identity: ArchiveIdentity? = ArchiveIdentity("io.dtsoftware.facet", 2)
        val installed = mutableListOf<File>()

        override fun canRequestInstalls() = allowed
        override fun inspect(file: File) = identity
        override fun install(file: File): Int {
            installed += file
            return SESSION
        }
    }

    private class MemoryStore : UpdateStore {
        override var lastCheckAt = 0L
        override var skippedVersionCode = 0L
        override var skippedAt = 0L
        override var latest: UpdateManifest? = null
        override var resumeInstallFor = 0L
    }

    /** One app install: a store, cache dir, network and installer that outlive [relaunch]. */
    private inner class Harness(val test: TestScope, val enabled: Boolean = true) {
        val source = FakeSource().apply { manifest = v2; payload = apk }
        val installer = FakeInstaller()
        val store = MemoryStore()
        val dir = tmp.newFolder()
        var autoCheck = true

        /** Wall-clock offset on top of virtual time (simulates hours passing between launches). */
        var skew = 0L

        /**
         * Not backgroundScope: advanceUntilIdle() doesn't drain background work. A separate (non-child)
         * scope on the test scheduler runs with virtual time, and a fetch left hanging doesn't hold up runTest.
         */
        private val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(test.testScheduler))

        var manager = create()
            private set

        fun create() = UpdateManager(
            scope = scope,
            source = source,
            store = store,
            installer = installer,
            downloadDir = dir,
            installedVersionCode = 1,
            installedVersionName = "1.0.0",
            enabled = enabled,
            autoCheck = { autoCheck },
            clock = { t0 + skew + test.testScheduler.currentTime },
            uptime = { test.testScheduler.currentTime },
            io = StandardTestDispatcher(test.testScheduler),
        )

        /** A new process (Android ended Facet, or the person reopened it later). */
        fun relaunch(afterMs: Long = 0) {
            skew += afterMs
            manager = create()
        }

        val state get() = manager.state.value
    }

    private fun TestScope.harness(enabled: Boolean = true) = Harness(this, enabled)

    // ---------------- Debug builds ----------------

    @Test
    fun debugBuildChecksNothingAndShowsNothing() = runTest {
        val h = harness(enabled = false)
        h.store.latest = v2
        h.relaunch()
        val gate = h.manager.launchCheck()
        assertFalse(gate.holding)
        h.manager.onForeground()
        h.manager.checkNow()
        h.manager.startUpdate()
        h.manager.onResume()
        h.manager.start()
        advanceUntilIdle()
        assertEquals(0, h.source.checks)
        assertEquals(0, h.source.downloads)
        assertTrue(h.installer.installed.isEmpty())
        assertFalse(h.manager.prompt.value)
        assertFalse(h.state.enabled)
        assertNull(h.state.available)
        assertEquals(UpdatePhase.Idle, h.state.phase)
    }

    // ---------------- Launch check ----------------

    @Test
    fun launchCheckPromptsForANewerVersion() = runTest {
        val h = harness()
        val gate = h.manager.launchCheck()
        assertTrue(gate.holding)
        advanceUntilIdle()
        assertFalse(gate.holding)
        assertTrue(h.manager.prompt.value)
        assertEquals(v2, h.state.available)
        assertEquals(h.store.lastCheckAt, h.state.lastCheckedAt)
        assertTrue(h.store.lastCheckAt > 0)
        assertEquals(v2, h.store.latest)
    }

    @Test
    fun launchCheckIsQuietWhenUpToDate() = runTest {
        val h = harness()
        h.source.manifest = v2.copy(versionCode = 1, versionName = "1.0.0")
        h.manager.launchCheck()
        advanceUntilIdle()
        assertFalse(h.manager.prompt.value)
        assertNull(h.state.available)
        assertNull(h.store.latest)
        assertTrue(h.state.lastCheckedAt > 0)
    }

    @Test
    fun splashIsNeverHeldPastTheLimit() = runTest {
        val h = harness()
        h.source.checkGate = CompletableDeferred()
        val gate = h.manager.launchCheck()
        advanceTimeBy(UpdatePolicy.LAUNCH_HOLD_MS - 1)
        runCurrent()
        assertTrue(gate.holding)
        advanceTimeBy(2)
        runCurrent()
        assertFalse(gate.holding)
        assertFalse(h.manager.prompt.value)

        // A slow answer still counts: the prompt appears when it arrives.
        h.source.checkGate!!.complete(Unit)
        advanceUntilIdle()
        assertTrue(h.manager.prompt.value)
    }

    @Test
    fun offlineLaunchReleasesTheSplashAndStaysQuiet() = runTest {
        val h = harness()
        h.source.checkError = UpdateError.CHECK
        val gate = h.manager.launchCheck()
        runCurrent()
        assertFalse(gate.holding)
        advanceUntilIdle()
        assertFalse(h.manager.prompt.value)
        assertNull(h.state.error)
        assertEquals(0L, h.store.lastCheckAt)
        assertEquals(UpdatePhase.Idle, h.state.phase)
    }

    @Test
    fun turningAutomaticChecksOffSkipsLaunchAndForegroundChecks() = runTest {
        val h = harness()
        h.autoCheck = false
        assertFalse(h.manager.launchCheck().holding)
        h.manager.onForeground()
        advanceUntilIdle()
        assertEquals(0, h.source.checks)

        // "Check for updates" still works, and shows the result without the dialog.
        h.manager.checkNow()
        advanceUntilIdle()
        assertEquals(1, h.source.checks)
        assertEquals(v2, h.state.available)
        assertFalse(h.manager.prompt.value)
    }

    @Test
    fun knownUpdateShowsBeforeTheNextCheck() = runTest {
        val h = harness()
        h.manager.launchCheck()
        advanceUntilIdle()
        h.relaunch()
        assertEquals(v2, h.state.available)
    }

    // ---------------- Not now ----------------

    @Test
    fun notNowHidesThatVersionFor24Hours() = runTest {
        val h = harness()
        h.manager.launchCheck()
        advanceUntilIdle()
        assertTrue(h.manager.prompt.value)
        h.manager.notNow()
        assertFalse(h.manager.prompt.value)
        assertEquals(2L, h.store.skippedVersionCode)

        h.relaunch(afterMs = 23 * hour)
        h.manager.launchCheck()
        advanceUntilIdle()
        assertFalse("skipped version stays hidden", h.manager.prompt.value)
        assertEquals("but Settings → About still knows", v2, h.state.available)

        h.relaunch(afterMs = 1 * hour)
        h.manager.launchCheck()
        advanceUntilIdle()
        assertTrue("24 hours later it asks again", h.manager.prompt.value)
    }

    @Test
    fun aNewerReleaseAfterNotNowPromptsRightAway() = runTest {
        val h = harness()
        h.manager.launchCheck()
        advanceUntilIdle()
        h.manager.notNow()
        h.source.manifest = v2.copy(versionCode = 3, versionName = "1.2.0")
        h.relaunch(afterMs = hour)
        h.manager.launchCheck()
        advanceUntilIdle()
        assertTrue(h.manager.prompt.value)
    }

    // ---------------- Foreground re-check ----------------

    @Test
    fun foregroundRechecksOnlySixHoursAfterTheLastCheck() = runTest {
        val h = harness()
        h.manager.launchCheck()
        h.manager.onForeground() // the same start: the launch check is already running
        advanceUntilIdle()
        assertEquals(1, h.source.checks)

        h.skew += 5 * hour
        h.manager.onForeground()
        advanceUntilIdle()
        assertEquals(1, h.source.checks)

        h.skew += 1 * hour
        h.manager.onForeground()
        advanceUntilIdle()
        assertEquals(2, h.source.checks)
    }

    @Test
    fun aSecondLaunchInTheSameProcessFollowsTheSixHourRule() = runTest {
        val h = harness()
        h.manager.launchCheck()
        advanceUntilIdle()
        assertFalse(h.manager.launchCheck().holding)
        advanceUntilIdle()
        assertEquals(1, h.source.checks)
        h.skew += 6 * hour
        assertTrue(h.manager.launchCheck().holding)
        advanceUntilIdle()
        assertEquals(2, h.source.checks)
    }

    @Test
    fun requestedCheckReportsFailures() = runTest {
        val h = harness()
        h.source.checkError = UpdateError.CHECK
        h.manager.checkNow()
        assertEquals(UpdatePhase.Checking, h.state.phase)
        advanceUntilIdle()
        assertEquals(UpdateError.CHECK, h.state.error)
        assertEquals(UpdatePhase.Idle, h.state.phase)

        h.source.checkError = null
        h.manager.checkNow()
        advanceUntilIdle()
        assertNull(h.state.error)
        assertEquals(v2, h.state.available)
    }

    // ---------------- Download, verify, install ----------------

    private fun TestScope.available(h: Harness) {
        h.manager.launchCheck()
        advanceUntilIdle()
    }

    @Test
    fun updateDownloadsVerifiesAndHandsOffToTheInstaller() = runTest {
        val h = harness()
        available(h)
        h.manager.startUpdate()
        assertTrue(h.state.phase is UpdatePhase.Downloading)
        advanceUntilIdle()
        assertEquals(1, h.source.downloads)
        assertEquals(listOf(File(h.dir, "facet-2.apk")), h.installer.installed)
        assertEquals(UpdatePhase.Installing, h.state.phase)
        assertTrue(h.manager.prompt.value)

        // Android asks for confirmation; the activity opens it.
        val confirm = Intent("android.content.pm.action.CONFIRM_INSTALL")
        h.manager.onInstallStatus(SESSION, InstallStatus.NeedsUserAction(confirm))
        assertEquals(confirm, h.manager.userAction.value)
        h.manager.onUserActionOpened()
        assertNull(h.manager.userAction.value)
        assertEquals(UpdatePhase.Installing, h.state.phase)
    }

    @Test
    fun tamperedDownloadIsNeverInstalled() = runTest {
        val h = harness()
        h.source.payload = apk.copyOf().also { it[10] = (it[10] + 1).toByte() }
        available(h)
        h.manager.startUpdate()
        advanceUntilIdle()
        assertEquals(UpdateError.CORRUPT, h.state.error)
        assertEquals(UpdatePhase.Idle, h.state.phase)
        assertTrue(h.installer.installed.isEmpty())
        assertFalse(File(h.dir, "facet-2.apk").exists())
        assertTrue(h.manager.prompt.value)
    }

    @Test
    fun wrongSizeIsNeverInstalled() = runTest {
        val h = harness()
        h.source.payload = apk + byteArrayOf(0)
        available(h)
        h.manager.startUpdate()
        advanceUntilIdle()
        assertEquals(UpdateError.CORRUPT, h.state.error)
        assertTrue(h.installer.installed.isEmpty())
    }

    @Test
    fun anotherPackageIsNeverInstalled() = runTest {
        val h = harness()
        h.installer.identity = ArchiveIdentity("com.example.other", 2)
        available(h)
        h.manager.startUpdate()
        advanceUntilIdle()
        assertEquals(UpdateError.NOT_FACET, h.state.error)
        assertTrue(h.installer.installed.isEmpty())
        assertFalse(File(h.dir, "facet-2.apk").exists())
    }

    @Test
    fun aDifferentVersionCodeIsNeverInstalled() = runTest {
        val h = harness()
        h.installer.identity = ArchiveIdentity("io.dtsoftware.facet", 3)
        available(h)
        h.manager.startUpdate()
        advanceUntilIdle()
        assertEquals(UpdateError.NOT_FACET, h.state.error)
        assertTrue(h.installer.installed.isEmpty())
    }

    @Test
    fun downloadFailureSaysSoAndCanBeRetried() = runTest {
        val h = harness()
        h.source.downloadError = UpdateError.DOWNLOAD
        available(h)
        h.manager.startUpdate()
        advanceUntilIdle()
        assertEquals(UpdateError.DOWNLOAD, h.state.error)
        assertEquals("Couldn't download the update. Check your connection and try again.", h.state.error!!.message)

        h.source.downloadError = null
        h.manager.startUpdate()
        advanceUntilIdle()
        assertNull(h.state.error)
        assertEquals(1, h.installer.installed.size)
    }

    @Test
    fun cancellingADownloadGoesBackToThePrompt() = runTest {
        val h = harness()
        h.source.downloadGate = CompletableDeferred()
        available(h)
        h.manager.startUpdate()
        runCurrent()
        assertTrue(h.state.phase is UpdatePhase.Downloading)
        h.manager.cancelDownload()
        advanceUntilIdle()
        assertEquals(UpdatePhase.Idle, h.state.phase)
        assertNull(h.state.error)
        assertTrue(h.installer.installed.isEmpty())
    }

    @Test
    fun aVerifiedDownloadIsReused() = runTest {
        val h = harness()
        available(h)
        h.manager.startUpdate()
        advanceUntilIdle()
        h.manager.onInstallStatus(SESSION, InstallStatus.Aborted)
        assertEquals(UpdatePhase.Idle, h.state.phase)
        assertNull(h.state.error)

        h.manager.startUpdate()
        advanceUntilIdle()
        assertEquals(1, h.source.downloads)
        assertEquals(2, h.installer.installed.size)
    }

    @Test
    fun installerFailureIsExplained() = runTest {
        val h = harness()
        available(h)
        h.manager.startUpdate()
        advanceUntilIdle()
        h.manager.onInstallStatus(SESSION, InstallStatus.Failed(UpdateError.INSTALL_CONFLICT))
        assertEquals(UpdatePhase.Idle, h.state.phase)
        assertEquals(UpdateError.INSTALL_CONFLICT, h.state.error)
        assertTrue(h.manager.prompt.value)
    }

    @Test
    fun statusForAnotherSessionIsIgnored() = runTest {
        val h = harness()
        available(h)
        h.manager.startUpdate()
        advanceUntilIdle()
        h.manager.onInstallStatus(SESSION + 1, InstallStatus.Aborted)
        assertEquals(UpdatePhase.Installing, h.state.phase)
    }

    @Test
    fun confirmationClosedWithoutAResultLetsThePersonTryAgain() = runTest {
        val h = harness()
        available(h)
        h.manager.startUpdate()
        advanceUntilIdle()
        h.manager.onInstallStatus(SESSION, InstallStatus.NeedsUserAction(Intent("confirm")))
        h.manager.onUserActionOpened()
        h.manager.onResume()
        advanceUntilIdle()
        assertEquals(UpdatePhase.Idle, h.state.phase)
    }

    // ---------------- "Install unknown apps" ----------------

    @Test
    fun withoutPermissionItAsksThenContinuesWhenThePersonComesBack() = runTest {
        val h = harness()
        h.installer.allowed = false
        available(h)
        h.manager.startUpdate()
        advanceUntilIdle()
        assertEquals(UpdatePhase.NeedsPermission, h.state.phase)
        assertTrue(h.manager.prompt.value)
        assertTrue(h.installer.installed.isEmpty())

        h.manager.onPermissionRequested()
        assertEquals(2L, h.store.resumeInstallFor)

        // Back without allowing it: still waiting.
        h.manager.onResume()
        advanceUntilIdle()
        assertEquals(UpdatePhase.NeedsPermission, h.state.phase)

        h.installer.allowed = true
        h.manager.onResume()
        h.manager.onResume() // ON_RESUME and the activity result both report back
        advanceUntilIdle()
        assertEquals(UpdatePhase.Installing, h.state.phase)
        assertEquals(1, h.installer.installed.size)
        assertEquals("the verified download is reused", 1, h.source.downloads)
        assertEquals(0L, h.store.resumeInstallFor)
    }

    @Test
    fun installResumesIfAndroidEndedFacetDuringThePermissionScreen() = runTest {
        val h = harness()
        h.installer.allowed = false
        available(h)
        h.manager.startUpdate()
        advanceUntilIdle()
        h.manager.onPermissionRequested()

        h.installer.allowed = true
        h.relaunch()
        h.manager.launchCheck()
        advanceUntilIdle()
        assertEquals(UpdatePhase.Installing, h.state.phase)
        assertTrue(h.manager.prompt.value)
        assertEquals(1, h.installer.installed.size)
        assertEquals(1, h.source.downloads)
    }

    @Test
    fun notNowAtThePermissionStepStops() = runTest {
        val h = harness()
        h.installer.allowed = false
        available(h)
        h.manager.startUpdate()
        advanceUntilIdle()
        h.manager.notNow()
        assertEquals(UpdatePhase.Idle, h.state.phase)
        assertFalse(h.manager.prompt.value)
        h.installer.allowed = true
        h.manager.onResume()
        advanceUntilIdle()
        assertTrue(h.installer.installed.isEmpty())
    }

    // ---------------- Cache housekeeping ----------------

    @Test
    fun oldDownloadsAreCleanedUp() = runTest {
        val h = harness()
        listOf("facet-1.apk", "facet-0.apk.part", "junk.tmp", "facet-3.apk").forEach { File(h.dir, it).writeText("x") }
        h.manager.start()
        advanceUntilIdle()
        assertEquals(setOf("facet-3.apk"), h.dir.list()!!.toSet())

        // The manifest says 2 is the latest: anything else goes.
        h.manager.launchCheck()
        advanceUntilIdle()
        assertEquals(emptySet<String>(), h.dir.list()!!.toSet())
        h.manager.startUpdate()
        advanceUntilIdle()
        assertEquals(setOf("facet-2.apk"), h.dir.list()!!.toSet())
        assertNotNull(h.state.available)
    }

    private companion object {
        const val SESSION = 42
    }
}
