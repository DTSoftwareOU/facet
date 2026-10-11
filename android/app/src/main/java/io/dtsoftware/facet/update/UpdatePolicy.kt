package io.dtsoftware.facet.update

import io.dtsoftware.facet.BuildConfig

object UpdateConfig {
    const val MANIFEST_URL = "https://facet.dtsoftware.io/download/android/latest.json"

    /** The release application id. An update must be this package. */
    const val PACKAGE_NAME = "io.dtsoftware.facet"

    /** Only release builds of Facet update themselves; debug builds (io.dtsoftware.facet.debug) never check. */
    fun isEnabled(applicationId: String, debug: Boolean): Boolean = !debug && applicationId == PACKAGE_NAME

    val enabled: Boolean get() = isEnabled(BuildConfig.APPLICATION_ID, BuildConfig.DEBUG)
}

/** When to check and when to prompt. Pure functions of times and version codes, so they're easy to test. */
object UpdatePolicy {
    /** The launch check holds the splash screen at most this long. */
    const val LAUNCH_HOLD_MS = 1_500L

    /** "Not now" hides the prompt for that version this long. */
    const val SKIP_MS = 24 * 60 * 60 * 1000L

    /** Returning to the foreground checks again once the last check is this old. */
    const val RECHECK_MS = 6 * 60 * 60 * 1000L

    fun isNewer(manifest: UpdateManifest, installedVersionCode: Long): Boolean = manifest.versionCode > installedVersionCode

    /** True while "Not now" for [versionCode] still applies. A clock set back before the skip ends it. */
    fun isSkipped(versionCode: Long, skippedVersionCode: Long, skippedAt: Long, now: Long): Boolean =
        skippedVersionCode == versionCode && skippedAt > 0 && now >= skippedAt && now - skippedAt < SKIP_MS

    fun shouldPrompt(manifest: UpdateManifest, installedVersionCode: Long, skippedVersionCode: Long, skippedAt: Long, now: Long): Boolean =
        isNewer(manifest, installedVersionCode) && !isSkipped(manifest.versionCode, skippedVersionCode, skippedAt, now)

    /** A foreground re-check is due when there was no check yet, the last one is [RECHECK_MS] old, or the clock went back. */
    fun isRecheckDue(lastCheckAt: Long, now: Long): Boolean =
        lastCheckAt <= 0 || now < lastCheckAt || now - lastCheckAt >= RECHECK_MS
}
