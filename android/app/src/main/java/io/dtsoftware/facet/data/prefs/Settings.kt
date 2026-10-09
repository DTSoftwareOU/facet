package io.dtsoftware.facet.data.prefs

import android.content.Context
import android.content.SharedPreferences
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.llm.GenParams
import io.dtsoftware.facet.llm.ModelOutput
import io.dtsoftware.facet.llm.media.Aspect
import io.dtsoftware.facet.ui.theme.ThemeMode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

/** Device-local preferences (not synced). */
@Serializable
data class LocalPrefs(
    val theme: ThemeMode = ThemeMode.SYSTEM,
    val dynamicColor: Boolean = false,
    val chatTextScale: Float = 1f,
    val reducedMotion: Boolean = false,
    val haptics: Boolean = true,
    val sendOnEnter: Boolean = false,
    val showUsage: Boolean = true,
    val showCost: Boolean = true,
    val expandThinking: Boolean = false,
    val appLock: Boolean = false,
    val secureScreen: Boolean = false,
    val notifyOnComplete: Boolean = true,
    val notificationsAsked: Boolean = false,
    val pricingFeed: Boolean = true,
    val onboardingDone: Boolean = false,
    /** Model used for the next new chat when no assistant default applies. */
    val lastProviderId: String? = null,
    val lastModelId: String? = null,
)

/** A model reference: a configured provider plus a model id. */
@Serializable
data class ModelRef(val providerId: String, val modelId: String)

/** Preferred media models and their options. A null model means "pick the best available". */
@Serializable
data class MediaPrefs(
    val image: ModelRef? = null,
    val video: ModelRef? = null,
    val speech: ModelRef? = null,
    val music: ModelRef? = null,
    val transcription: ModelRef? = null,
    /** Voice for [speech]; [voiceFor] is the "providerId/modelId" it belongs to, so a stale voice isn't sent elsewhere. */
    val voice: String? = null,
    val voiceFor: String? = null,
    val imageAspect: Aspect = Aspect.SQUARE,
    val videoAspect: Aspect = Aspect.LANDSCAPE,
    val musicSeconds: Int = 30,
    /** Chat models may call the generate_* tools. */
    val chatTools: Boolean = true,
    /** Read aloud uses the chosen speech model instead of the phone's voice. */
    val aiReadAloud: Boolean = true,
    /** Dictation uses the chosen transcription model instead of the phone's recognizer. */
    val aiDictation: Boolean = true,
) {
    fun ref(output: ModelOutput): ModelRef? = when (output) {
        ModelOutput.IMAGE -> image
        ModelOutput.VIDEO -> video
        ModelOutput.SPEECH -> speech
        ModelOutput.MUSIC -> music
        ModelOutput.TRANSCRIPTION -> transcription
        ModelOutput.TEXT -> null
    }

    fun with(output: ModelOutput, ref: ModelRef?): MediaPrefs = when (output) {
        ModelOutput.IMAGE -> copy(image = ref)
        ModelOutput.VIDEO -> copy(video = ref)
        ModelOutput.SPEECH -> copy(speech = ref)
        ModelOutput.MUSIC -> copy(music = ref)
        ModelOutput.TRANSCRIPTION -> copy(transcription = ref)
        ModelOutput.TEXT -> this
    }
}

/** Preferences that follow the account across devices (synced as the "settings" record). */
@Serializable
data class SyncedPrefs(
    /** Display name. Kept here (end-to-end encrypted) instead of on the sync server. */
    val profileName: String = "",
    val aboutMe: String = "",
    val responseStyle: String = "",
    val customInstructionsEnabled: Boolean = true,
    val defaultModel: ModelRef? = null,
    val defaultParams: GenParams = GenParams(),
    val titleModel: ModelRef? = null,
    val autoTitle: Boolean = true,
    /** Use the model's own web search when it has one; otherwise Facet's search tool. */
    val preferNativeSearch: Boolean = true,
    /** YOLO mode: run every tool call without asking, and let the model take more tool rounds. */
    val yoloMode: Boolean = false,
    val media: MediaPrefs = MediaPrefs(),
    /** When sync storage is full, remove the cloud copies of the oldest files; devices that have them keep them. */
    val autoFreeSpace: Boolean = true,
    val updatedAt: Long = 0,
)

class SettingsStore(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("facet_settings", Context.MODE_PRIVATE)

    private val _local = MutableStateFlow(readLocal())
    val local: StateFlow<LocalPrefs> = _local.asStateFlow()

    private val _synced = MutableStateFlow(readSynced())
    val synced: StateFlow<SyncedPrefs> = _synced.asStateFlow()

    /** Invoked after the user changes synced prefs, so the sync engine can push them. */
    var onSyncedChanged: (() -> Unit)? = null

    private fun readLocal(): LocalPrefs = prefs.getString(KEY_LOCAL, null)
        ?.let { runCatching { AppJson.decodeFromString<LocalPrefs>(it) }.getOrNull() } ?: LocalPrefs()

    private fun readSynced(): SyncedPrefs = prefs.getString(KEY_SYNCED, null)
        ?.let { runCatching { AppJson.decodeFromString<SyncedPrefs>(it) }.getOrNull() } ?: SyncedPrefs()

    fun updateLocal(transform: (LocalPrefs) -> LocalPrefs) {
        val next = transform(_local.value)
        _local.value = next
        prefs.edit().putString(KEY_LOCAL, AppJson.encodeToString(next)).apply()
    }

    fun updateSynced(transform: (SyncedPrefs) -> SyncedPrefs) {
        val next = transform(_synced.value).copy(updatedAt = Clock.now())
        _synced.value = next
        prefs.edit().putString(KEY_SYNCED, AppJson.encodeToString(next)).putBoolean(KEY_SYNCED_DIRTY, true).apply()
        onSyncedChanged?.invoke()
    }

    /** Applies a remote copy (from sync). Returns false if the local copy is newer. */
    fun applyRemoteSynced(remote: SyncedPrefs): Boolean {
        if (remote.updatedAt < _synced.value.updatedAt) return false
        _synced.value = remote
        prefs.edit().putString(KEY_SYNCED, AppJson.encodeToString(remote)).putBoolean(KEY_SYNCED_DIRTY, false).apply()
        return true
    }

    val syncedDirty: Boolean get() = prefs.getBoolean(KEY_SYNCED_DIRTY, false)

    fun markSyncedClean(updatedAt: Long) {
        if (_synced.value.updatedAt == updatedAt) prefs.edit().putBoolean(KEY_SYNCED_DIRTY, false).apply()
    }

    fun markSyncedDirty() = prefs.edit().putBoolean(KEY_SYNCED_DIRTY, true).apply()

    fun resetSynced() {
        _synced.value = SyncedPrefs()
        prefs.edit().remove(KEY_SYNCED).remove(KEY_SYNCED_DIRTY).apply()
    }

    private companion object {
        const val KEY_LOCAL = "local_v1"
        const val KEY_SYNCED = "synced_v1"
        const val KEY_SYNCED_DIRTY = "synced_dirty"
    }
}
