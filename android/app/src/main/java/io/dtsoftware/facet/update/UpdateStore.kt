package io.dtsoftware.facet.update

import android.content.Context
import android.content.SharedPreferences

/** Update bookkeeping that outlives the process. Device-local, never synced. */
interface UpdateStore {
    /** When the manifest was last fetched successfully (epoch ms), 0 if never. */
    var lastCheckAt: Long

    /** "Not now": the version it was for, and when. */
    var skippedVersionCode: Long
    var skippedAt: Long

    /** The newest manifest seen, so Settings → About can show a known update before the next check. */
    var latest: UpdateManifest?

    /**
     * The version whose install was waiting for "install unknown apps" when Facet left for Android's
     * settings. If Android ends Facet meanwhile, the next launch picks the install back up.
     */
    var resumeInstallFor: Long
}

class PrefsUpdateStore(context: Context) : UpdateStore {
    private val prefs: SharedPreferences = context.getSharedPreferences("facet_updates", Context.MODE_PRIVATE)

    override var lastCheckAt: Long
        get() = prefs.getLong(KEY_LAST_CHECK, 0)
        set(value) = prefs.edit().putLong(KEY_LAST_CHECK, value).apply()

    override var skippedVersionCode: Long
        get() = prefs.getLong(KEY_SKIPPED_VERSION, 0)
        set(value) = prefs.edit().putLong(KEY_SKIPPED_VERSION, value).apply()

    override var skippedAt: Long
        get() = prefs.getLong(KEY_SKIPPED_AT, 0)
        set(value) = prefs.edit().putLong(KEY_SKIPPED_AT, value).apply()

    override var latest: UpdateManifest?
        get() = prefs.getString(KEY_LATEST, null)?.let { UpdateManifest.parse(it) }
        set(value) = prefs.edit().apply { if (value == null) remove(KEY_LATEST) else putString(KEY_LATEST, UpdateManifest.encode(value)) }.apply()

    override var resumeInstallFor: Long
        get() = prefs.getLong(KEY_RESUME_INSTALL, 0)
        set(value) = prefs.edit().putLong(KEY_RESUME_INSTALL, value).apply()

    private companion object {
        const val KEY_LAST_CHECK = "last_check_at"
        const val KEY_SKIPPED_VERSION = "skipped_version_code"
        const val KEY_SKIPPED_AT = "skipped_at"
        const val KEY_LATEST = "latest_manifest"
        const val KEY_RESUME_INSTALL = "resume_install_for"
    }
}
