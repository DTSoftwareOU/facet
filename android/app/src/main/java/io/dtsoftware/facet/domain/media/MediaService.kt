package io.dtsoftware.facet.domain.media

import io.dtsoftware.facet.data.db.AttachmentEntity
import io.dtsoftware.facet.data.db.ProviderEntity
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.data.prefs.SettingsStore
import io.dtsoftware.facet.data.repo.AttachmentStore
import io.dtsoftware.facet.data.repo.ProviderRepository
import io.dtsoftware.facet.domain.tools.SearchKind
import io.dtsoftware.facet.llm.ErrorKind
import io.dtsoftware.facet.llm.LlmError
import io.dtsoftware.facet.llm.LlmException
import io.dtsoftware.facet.llm.ModelCatalog
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ModelOutput
import io.dtsoftware.facet.llm.ProviderConfig
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.llm.media.Aspect
import io.dtsoftware.facet.llm.media.MediaFile
import io.dtsoftware.facet.llm.media.MediaGen
import io.dtsoftware.facet.llm.media.MediaJob
import io.dtsoftware.facet.llm.media.Voice
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient

/** A media model ready to run. */
data class MediaChoice(val provider: ProviderEntity, val model: ModelInfo, val explicit: Boolean) {
    val ref get() = ModelRef(provider.id, model.id)
    val label get() = "${model.displayName} · ${provider.label}"
}

/** Generator seam so tests can swap in a fake. */
fun interface MediaRunner {
    suspend fun run(config: ProviderConfig, model: ModelInfo, job: MediaJob, onProgress: (String) -> Unit): MediaFile
}

/**
 * Picks the user's media models (or the best available ones) and runs them: images, video, speech
 * and music become synced attachments; speech also powers Read aloud and transcription powers dictation.
 */
class MediaService(
    private val providers: ProviderRepository,
    private val settings: SettingsStore,
    private val attachments: AttachmentStore,
    private val http: OkHttpClient,
    private val cacheDir: File,
    private val runner: MediaRunner = MediaRunner { config, model, job, onProgress -> MediaGen.generate(config, http, model, job, onProgress) },
) {
    /** Every enabled, visible model that makes [output]. */
    suspend fun available(output: ModelOutput): List<MediaChoice> = providers.all()
        .filter { it.enabled && !it.deleted && !SearchKind.isSearch(it.kind) }
        .flatMap { p ->
            val kind = ProviderKind.fromId(p.kind)
            val hidden = providers.hiddenModels(p)
            providers.models(p)
                .filter { it.output == output && it.id !in hidden && ModelCatalog.canRun(kind, output) }
                .map { MediaChoice(p, it, explicit = false) }
        }

    /** The model chosen in Settings, else the best available one (unless [explicitOnly]). */
    suspend fun resolve(output: ModelOutput, explicitOnly: Boolean = false): MediaChoice? {
        val all = available(output)
        val ref = settings.synced.value.media.ref(output)
        ref?.let { r -> all.firstOrNull { it.provider.id == r.providerId && it.model.id == r.modelId } }?.let { return it.copy(explicit = true) }
        if (explicitOnly) return null
        val best = ModelCatalog.preferredMedia(output, all.map { it.model }) ?: return null
        return all.firstOrNull { it.model === best }
    }

    /** Voice for [choice]: the saved one if it belongs to this model, else the provider's default. */
    fun voiceFor(choice: MediaChoice): String {
        val m = settings.synced.value.media
        return m.voice?.takeIf { m.voiceFor == "${choice.provider.id}/${choice.model.id}" }
            ?: MediaGen.defaultVoice(ProviderKind.fromId(choice.provider.kind), choice.model.id)
    }

    suspend fun voices(choice: MediaChoice): List<Voice> =
        MediaGen.voices(providers.config(choice.provider), http, choice.model.id)

    /** Makes a picture, video, voice clip or song and stores it as an attachment of [conversationId]. */
    suspend fun create(
        output: ModelOutput,
        prompt: String,
        conversationId: String,
        aspect: Aspect? = null,
        seconds: Int? = null,
        onProgress: (String) -> Unit = {},
    ): Pair<AttachmentEntity, MediaChoice> {
        val choice = resolve(output) ?: throw LlmException(
            LlmError(ErrorKind.BAD_REQUEST, "No ${output.noun} model is set up. Add a provider that makes ${output.noun} in Settings → Media models."),
        )
        val prefs = settings.synced.value.media
        val job = MediaJob(
            output = output,
            prompt = prompt,
            aspect = aspect ?: when (output) {
                ModelOutput.VIDEO -> prefs.videoAspect
                else -> prefs.imageAspect
            },
            seconds = seconds ?: prefs.musicSeconds.takeIf { output == ModelOutput.MUSIC },
            voice = if (output == ModelOutput.SPEECH) voiceFor(choice) else null,
        )
        val file = runner.run(providers.config(choice.provider), choice.model, job, onProgress)
        val att = attachments.storeGenerated(file.bytes, file.mimeType, fileName(prompt, output, file.extension), conversationId)
        return att to choice
    }

    /**
     * Speaks [text] with the speech model chosen in Settings, caching the audio per text and voice.
     * Null when no speech model is chosen or AI read-aloud is off (callers fall back to the phone's voice).
     */
    suspend fun speak(text: String): File? {
        if (!settings.synced.value.media.aiReadAloud) return null
        val choice = resolve(ModelOutput.SPEECH, explicitOnly = true) ?: return null
        val voice = voiceFor(choice)
        val dir = File(cacheDir, "speech").apply { mkdirs() }
        val key = sha("${choice.provider.id}/${choice.model.id}/$voice/$text")
        dir.listFiles()?.firstOrNull { it.name.startsWith(key) }?.let { return it }
        val file = runner.run(providers.config(choice.provider), choice.model, MediaJob(ModelOutput.SPEECH, text, voice = voice)) {}
        return withContext(Dispatchers.IO) {
            pruneCache(dir)
            File(dir, "$key.${file.extension}").apply { writeBytes(file.bytes) }
        }
    }

    /** True when dictation should use the transcription model chosen in Settings. */
    suspend fun dictationAvailable(): Boolean =
        settings.synced.value.media.aiDictation && resolve(ModelOutput.TRANSCRIPTION, explicitOnly = true) != null

    suspend fun transcribe(audio: ByteArray, mimeType: String, fileName: String): String {
        val choice = resolve(ModelOutput.TRANSCRIPTION, explicitOnly = true)
            ?: throw LlmException(LlmError(ErrorKind.BAD_REQUEST, "Choose a transcription model in Settings → Media models."))
        return MediaGen.transcribe(providers.config(choice.provider), http, choice.model, audio, mimeType, fileName)
    }

    private fun pruneCache(dir: File) {
        val files = dir.listFiles()?.sortedBy { it.lastModified() } ?: return
        var total = files.sumOf { it.length() }
        for (f in files) {
            if (total < MAX_SPEECH_CACHE) break
            total -= f.length()
            f.delete()
        }
    }

    companion object {
        private const val MAX_SPEECH_CACHE = 40L * 1024 * 1024

        /** "A fox in the snow, watercolor" → "fox-in-the-snow-watercolor.png". */
        fun fileName(prompt: String, output: ModelOutput, ext: String): String {
            val words = prompt.lowercase().replace(Regex("[^a-z0-9]+"), " ").trim().split(' ')
                .filter { it.isNotEmpty() && it !in setOf("a", "an", "the", "of", "and", "with") }
            val slug = words.joinToString("-").take(40).trimEnd('-').ifEmpty { output.noun }
            return "$slug.$ext"
        }

        private fun sha(s: String): String = MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
            .take(12).joinToString("") { "%02x".format(it) }
    }
}
