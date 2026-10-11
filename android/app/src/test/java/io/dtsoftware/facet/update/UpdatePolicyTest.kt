package io.dtsoftware.facet.update

import io.dtsoftware.facet.BuildConfig
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePolicyTest {
    private val hour = 60 * 60 * 1000L
    private val now = 1_800_000_000_000L

    private fun manifest(code: Long) = UpdateManifest(code, "1.$code.0", "https://facet.dtsoftware.io/a.apk", "ab".repeat(32), 10)

    @Test
    fun onlyAHigherVersionCodeIsAnUpdate() {
        assertTrue(UpdatePolicy.isNewer(manifest(2), installedVersionCode = 1))
        assertTrue(UpdatePolicy.isNewer(manifest(10), installedVersionCode = 9))
        assertFalse(UpdatePolicy.isNewer(manifest(1), installedVersionCode = 1))
        assertFalse(UpdatePolicy.isNewer(manifest(1), installedVersionCode = 2))
    }

    @Test
    fun versionNameDoesNotDecide() {
        // A "bigger" name with a lower code is not an update; versionCode is the only order.
        val m = UpdateManifest(3, "0.9.0", "https://facet.dtsoftware.io/a.apk", "ab".repeat(32), 10)
        assertTrue(UpdatePolicy.isNewer(m, installedVersionCode = 2))
        assertFalse(UpdatePolicy.isNewer(m.copy(versionCode = 2, versionName = "9.9.9"), installedVersionCode = 2))
    }

    @Test
    fun notNowHidesThatVersionFor24Hours() {
        val skippedAt = now
        fun prompt(code: Long, at: Long) = UpdatePolicy.shouldPrompt(manifest(code), 1, skippedVersionCode = 2, skippedAt = skippedAt, now = at)
        assertFalse(prompt(2, now))
        assertFalse(prompt(2, now + 23 * hour))
        assertFalse(prompt(2, now + 24 * hour - 1))
        assertTrue(prompt(2, now + 24 * hour))
        assertTrue(prompt(2, now + 72 * hour))
    }

    @Test
    fun aNewerVersionThanTheSkippedOneStillPrompts() {
        assertTrue(UpdatePolicy.shouldPrompt(manifest(3), 1, skippedVersionCode = 2, skippedAt = now, now = now + hour))
    }

    @Test
    fun nothingSkippedMeansPrompt() {
        assertTrue(UpdatePolicy.shouldPrompt(manifest(2), 1, skippedVersionCode = 0, skippedAt = 0, now = now))
        assertFalse(UpdatePolicy.shouldPrompt(manifest(1), 1, skippedVersionCode = 0, skippedAt = 0, now = now))
    }

    @Test
    fun clockSetBackEndsTheSkip() {
        assertFalse(UpdatePolicy.isSkipped(2, skippedVersionCode = 2, skippedAt = now, now = now - hour))
    }

    @Test
    fun foregroundRecheckAfterSixHours() {
        assertFalse(UpdatePolicy.isRecheckDue(lastCheckAt = now, now = now))
        assertFalse(UpdatePolicy.isRecheckDue(lastCheckAt = now, now = now + 5 * hour))
        assertFalse(UpdatePolicy.isRecheckDue(lastCheckAt = now, now = now + 6 * hour - 1))
        assertTrue(UpdatePolicy.isRecheckDue(lastCheckAt = now, now = now + 6 * hour))
        assertTrue(UpdatePolicy.isRecheckDue(lastCheckAt = now, now = now + 30 * hour))
    }

    @Test
    fun recheckDueWhenNeverCheckedOrClockWentBack() {
        assertTrue(UpdatePolicy.isRecheckDue(lastCheckAt = 0, now = now))
        assertTrue(UpdatePolicy.isRecheckDue(lastCheckAt = now, now = now - 1))
    }

    @Test
    fun debugBuildsNeverCheck() {
        assertFalse(UpdateConfig.isEnabled("io.dtsoftware.facet.debug", debug = true))
        assertFalse(UpdateConfig.isEnabled("io.dtsoftware.facet.debug", debug = false))
        assertFalse(UpdateConfig.isEnabled("io.dtsoftware.facet", debug = true))
        assertTrue(UpdateConfig.isEnabled("io.dtsoftware.facet", debug = false))
    }

    @Test
    fun thisBuildMatchesItsVariant() {
        // Unit tests run against the debug variant, which must be inert; a release run must be live.
        assertTrue(UpdateConfig.enabled == (!BuildConfig.DEBUG && BuildConfig.APPLICATION_ID == "io.dtsoftware.facet"))
        if (BuildConfig.DEBUG) assertFalse(UpdateConfig.enabled)
    }
}
