package io.dtsoftware.facet.llm.media

import io.dtsoftware.facet.core.net.HttpStatusException
import io.dtsoftware.facet.core.net.await
import io.dtsoftware.facet.core.net.fetchString
import io.dtsoftware.facet.core.net.toJsonBody
import io.dtsoftware.facet.llm.ErrorKind
import io.dtsoftware.facet.llm.LlmError
import io.dtsoftware.facet.llm.LlmErrors
import io.dtsoftware.facet.llm.LlmException
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ModelOutput
import io.dtsoftware.facet.llm.ProviderConfig
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.llm.internal.arr
import io.dtsoftware.facet.llm.internal.obj
import io.dtsoftware.facet.llm.internal.parseJsonOrNull
import io.dtsoftware.facet.llm.internal.parseObjectOrNull
import io.dtsoftware.facet.llm.internal.str
import io.dtsoftware.facet.llm.internal.trimBaseUrl
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Shape of a picture or video. */
@kotlinx.serialization.Serializable
enum class Aspect(val label: String, val ratio: String) {
    SQUARE("Square", "1:1"),
    PORTRAIT("Portrait", "9:16"),
    LANDSCAPE("Landscape", "16:9"),
}

/** What to make. [seconds] applies to video and music; [voice] to speech. */
data class MediaJob(
    val output: ModelOutput,
    val prompt: String,
    val aspect: Aspect = Aspect.SQUARE,
    val seconds: Int? = null,
    val voice: String? = null,
)

/** A finished image, video or audio file. */
class MediaFile(val bytes: ByteArray, val mimeType: String) {
    val extension: String get() = MediaGen.extensionFor(mimeType)
}

data class Voice(val id: String, val name: String)

/**
 * Runs media models over each provider's own API: images, video, speech, music and transcription.
 * Long jobs (video, FLUX) are polled; everything returns plain bytes ready to store as an attachment.
 */
object MediaGen {
    private const val MAX_POLL_MS = 15 * 60_000L

    // ------------------------------------------------------------------ public API

    suspend fun generate(
        config: ProviderConfig,
        http: OkHttpClient,
        model: ModelInfo,
        job: MediaJob,
        onProgress: (String) -> Unit = {},
    ): MediaFile {
        val client = slow(http)
        return try {
            when (job.output) {
                ModelOutput.IMAGE -> image(config, client, model.id, job)
                ModelOutput.VIDEO -> video(config, client, model.id, job, onProgress)
                ModelOutput.SPEECH -> speech(config, client, model.id, job.prompt, job.voice ?: defaultVoice(config.kind, model.id))
                ModelOutput.MUSIC -> music(config, client, model.id, job)
                ModelOutput.TRANSCRIPTION, ModelOutput.TEXT -> unsupported(config, job.output)
            }
        } catch (e: HttpStatusException) {
            throw LlmException(LlmErrors.fromHttp(config, model.id, e))
        } catch (e: LlmException) {
            throw e
        } catch (e: IOException) {
            throw LlmException(LlmErrors.fromIo(config, e))
        }
    }

    /** Speech to text. */
    suspend fun transcribe(config: ProviderConfig, http: OkHttpClient, model: ModelInfo, audio: ByteArray, mimeType: String, fileName: String): String {
        val client = slow(http)
        val base = config.baseUrl.trimBaseUrl()
        return try {
            when (config.kind) {
                ProviderKind.ELEVENLABS -> {
                    val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                        .addFormDataPart("model_id", model.id)
                        .addFormDataPart("file", fileName, audio.toRequestBody(mimeType.toMediaType()))
                        .build()
                    json(client, post(config, "$base/v1/speech-to-text", body)).str("text").orEmpty()
                }
                ProviderKind.DEEPGRAM -> {
                    val url = "$base/v1/listen".toHttpUrl().newBuilder()
                        .addQueryParameter("model", model.id).addQueryParameter("smart_format", "true").build()
                    val res = json(client, authorize(config, Request.Builder().url(url)).post(audio.toRequestBody(mimeType.toMediaType())).build())
                    res.obj("results")?.arr("channels")?.firstOrNull()?.let { it as? JsonObject }
                        ?.arr("alternatives")?.firstOrNull()?.let { it as? JsonObject }?.str("transcript").orEmpty()
                }
                else -> {
                    val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                        .addFormDataPart("model", model.id)
                        .addFormDataPart("file", fileName, audio.toRequestBody(mimeType.toMediaType()))
                        .build()
                    json(client, post(config, "$base/audio/transcriptions", body)).str("text").orEmpty()
                }
            }.trim()
        } catch (e: HttpStatusException) {
            throw LlmException(LlmErrors.fromHttp(config, model.id, e))
        } catch (e: IOException) {
            throw LlmException(LlmErrors.fromIo(config, e))
        }
    }

    /** Voices a speech model can use; the first is the default. */
    suspend fun voices(config: ProviderConfig, http: OkHttpClient, modelId: String): List<Voice> = when (config.kind) {
        ProviderKind.ELEVENLABS -> runCatching {
            val res = json(http, authorize(config, Request.Builder().url("${config.baseUrl.trimBaseUrl()}/v1/voices")).get().build())
            res.arr("voices").orEmpty().mapNotNull { it as? JsonObject }.mapNotNull { v ->
                v.str("voice_id")?.let { Voice(it, v.str("name") ?: it) }
            }
        }.getOrDefault(emptyList()).ifEmpty { listOf(Voice(ELEVEN_DEFAULT_VOICE, "George")) }
        // Mistral voices are the ones saved (or cloned) in your Mistral account; "" lets Mistral pick.
        ProviderKind.MISTRAL -> listOf(Voice("", "Default voice")) + runCatching {
            val res = parseJsonOrNull(http.fetchString(authorize(config, Request.Builder().url("${config.baseUrl.trimBaseUrl()}/audio/voices")).get().build()))
            val items = (res as? kotlinx.serialization.json.JsonArray)
                ?: (res as? JsonObject)?.let { it.arr("data") ?: it.arr("voices") ?: it.arr("items") }
            items.orEmpty().mapNotNull { it as? JsonObject }.mapNotNull { v ->
                (v.str("id") ?: v.str("voice_id"))?.let { Voice(it, v.str("name") ?: it) }
            }
        }.getOrDefault(emptyList())
        else -> staticVoices(config.kind, modelId)
    }

    fun staticVoices(kind: ProviderKind, modelId: String): List<Voice> = when (kind) {
        ProviderKind.GOOGLE -> GEMINI_VOICES.map { Voice(it, it) }
        ProviderKind.DEEPGRAM -> listOf("thalia", "andromeda", "helena", "apollo", "arcas", "aries").map { Voice(it, it.replaceFirstChar(Char::titlecase)) }
        ProviderKind.ELEVENLABS -> listOf(Voice(ELEVEN_DEFAULT_VOICE, "George"))
        else -> {
            val extra = if (modelId.startsWith("gpt-")) listOf("ballad", "verse", "marin", "cedar") else emptyList()
            (listOf("alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer") + extra)
                .map { Voice(it, it.replaceFirstChar(Char::titlecase)) }
        }
    }

    fun defaultVoice(kind: ProviderKind, modelId: String): String = when (kind) {
        ProviderKind.GOOGLE -> "Kore"
        ProviderKind.ELEVENLABS -> ELEVEN_DEFAULT_VOICE
        ProviderKind.DEEPGRAM -> "thalia"
        ProviderKind.MISTRAL -> ""
        else -> "alloy"
    }

    /** Adds the provider's auth headers (and the user's extra headers) to a request. */
    fun authorize(config: ProviderConfig, b: Request.Builder): Request.Builder = b.apply {
        val key = config.apiKey
        if (key.isNotBlank()) {
            when (config.kind) {
                ProviderKind.GOOGLE -> header("x-goog-api-key", key)
                ProviderKind.ELEVENLABS -> header("xi-api-key", key)
                ProviderKind.BFL -> header("x-key", key)
                ProviderKind.DEEPGRAM -> header("Authorization", "Token $key")
                else -> header("Authorization", "Bearer $key")
            }
        }
        if (config.kind == ProviderKind.OPENROUTER) {
            header("HTTP-Referer", "https://facet.dtsoftware.io")
            header("X-Title", "Facet AI")
        }
        config.headers.forEach { (k, v) -> header(k, v) }
    }

    // ------------------------------------------------------------------ images

    private suspend fun image(config: ProviderConfig, http: OkHttpClient, id: String, job: MediaJob): MediaFile {
        val base = config.baseUrl.trimBaseUrl()
        return when (config.kind) {
            ProviderKind.GOOGLE -> interaction(config, http, id, job.prompt, "image") { put("aspect_ratio", job.aspect.ratio) }
            ProviderKind.OPENROUTER -> openRouterImage(config, http, id, job)
            ProviderKind.STABILITY -> stabilityImage(config, http, id, job)
            ProviderKind.BFL -> fluxImage(config, http, id, job)
            else -> {
                val body = buildJsonObject {
                    put("model", id)
                    put("prompt", job.prompt)
                    put("n", 1)
                    when (config.kind) {
                        ProviderKind.XAI -> put("response_format", "b64_json")
                        ProviderKind.TOGETHER -> {
                            val (w, h) = when (job.aspect) { Aspect.SQUARE -> 1024 to 1024; Aspect.PORTRAIT -> 768 to 1344; Aspect.LANDSCAPE -> 1344 to 768 }
                            put("width", w); put("height", h); put("response_format", "base64")
                        }
                        else -> {
                            put("size", openAiSize(id, job.aspect))
                            // GPT Image models always return base64 and reject response_format.
                            if (!id.startsWith("gpt-image") && !id.startsWith("chatgpt-image")) put("response_format", "b64_json")
                        }
                    }
                }
                val res = json(http, post(config, "$base/images/generations", body.toString().toJsonBody()))
                val first = res.arr("data")?.firstOrNull() as? JsonObject ?: throw failure(config, "returned no image")
                first.str("b64_json")?.let { fileFromBase64(it, null) }
                    ?: first.str("url")?.let { download(http, it, null) }
                    ?: throw failure(config, "returned no image")
            }
        }
    }

    private fun openAiSize(id: String, aspect: Aspect): String = when {
        id.startsWith("dall-e-2") -> "1024x1024"
        id.startsWith("dall-e-3") -> when (aspect) { Aspect.SQUARE -> "1024x1024"; Aspect.PORTRAIT -> "1024x1792"; Aspect.LANDSCAPE -> "1792x1024" }
        else -> when (aspect) { Aspect.SQUARE -> "1024x1024"; Aspect.PORTRAIT -> "1024x1536"; Aspect.LANDSCAPE -> "1536x1024" }
    }

    private suspend fun openRouterImage(config: ProviderConfig, http: OkHttpClient, id: String, job: MediaJob): MediaFile {
        val body = buildJsonObject {
            put("model", id)
            putJsonArray("messages") { addJsonObject { put("role", "user"); put("content", job.prompt) } }
            putJsonArray("modalities") { add(kotlinx.serialization.json.JsonPrimitive("image")); add(kotlinx.serialization.json.JsonPrimitive("text")) }
            putJsonObject("image_config") { put("aspect_ratio", job.aspect.ratio) }
        }
        val res = json(http, post(config, "${config.baseUrl.trimBaseUrl()}/chat/completions", body.toString().toJsonBody()))
        val message = (res.arr("choices")?.firstOrNull() as? JsonObject)?.obj("message")
        val url = (message?.arr("images")?.firstOrNull() as? JsonObject)?.obj("image_url")?.str("url")
            ?: throw failure(config, "didn't return an image" + (message?.str("content")?.takeIf { it.isNotBlank() }?.let { ": ${it.take(200)}" } ?: ""))
        return if (url.startsWith("data:")) fileFromDataUrl(url) else download(http, url, null)
    }

    private suspend fun stabilityImage(config: ProviderConfig, http: OkHttpClient, id: String, job: MediaJob): MediaFile {
        val endpoint = when {
            id == "stable-image-ultra" -> "ultra"
            id == "stable-image-core" -> "core"
            else -> "sd3"
        }
        val form = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("prompt", job.prompt)
            .addFormDataPart("output_format", "png")
            .addFormDataPart("aspect_ratio", job.aspect.ratio)
            .apply { if (endpoint == "sd3") addFormDataPart("model", id) }
            .build()
        val req = authorize(config, Request.Builder().url("${config.baseUrl.trimBaseUrl()}/v2beta/stable-image/generate/$endpoint"))
            .header("Accept", "image/*").post(form).build()
        return bytes(http, req)
    }

    private suspend fun fluxImage(config: ProviderConfig, http: OkHttpClient, id: String, job: MediaJob): MediaFile {
        val body = buildJsonObject {
            put("prompt", job.prompt)
            if (id.startsWith("flux-2")) {
                val (w, h) = when (job.aspect) { Aspect.SQUARE -> 1024 to 1024; Aspect.PORTRAIT -> 768 to 1360; Aspect.LANDSCAPE -> 1360 to 768 }
                put("width", w); put("height", h)
            } else {
                put("aspect_ratio", job.aspect.ratio)
            }
        }
        val start = json(http, post(config, "${config.baseUrl.trimBaseUrl()}/v1/$id", body.toString().toJsonBody()))
        val pollUrl = start.str("polling_url") ?: start.str("id")?.let { "${config.baseUrl.trimBaseUrl()}/v1/get_result?id=$it" }
            ?: throw failure(config, "didn't start the image")
        val began = System.currentTimeMillis()
        while (System.currentTimeMillis() - began < MAX_POLL_MS) {
            delay(1_500)
            val res = json(http, authorize(config, Request.Builder().url(pollUrl)).get().build())
            when (res.str("status")) {
                "Ready" -> {
                    val sample = res.obj("result")?.str("sample") ?: throw failure(config, "returned no image")
                    return download(http, sample, null, withAuth = null)
                }
                "Pending", "Queued", "Processing", null -> Unit
                else -> throw failure(config, "couldn't make that image (${res.str("status")})")
            }
        }
        throw failure(config, "took too long to make the image")
    }

    // ------------------------------------------------------------------ video

    private suspend fun video(config: ProviderConfig, http: OkHttpClient, id: String, job: MediaJob, onProgress: (String) -> Unit): MediaFile {
        if (config.kind != ProviderKind.GOOGLE) unsupported(config, ModelOutput.VIDEO)
        val aspect = if (job.aspect == Aspect.PORTRAIT) "9:16" else "16:9"
        if (!id.startsWith("veo")) {
            onProgress("Creating video")
            return interaction(config, http, id, job.prompt, "video") { put("aspect_ratio", aspect) }
        }
        // Veo: long-running operation, polled until done.
        val native = geminiNative(config)
        val body = buildJsonObject {
            putJsonArray("instances") { addJsonObject { put("prompt", job.prompt) } }
            putJsonObject("parameters") { put("aspectRatio", aspect) }
        }
        val op = json(http, post(config, "$native/models/$id:predictLongRunning", body.toString().toJsonBody()))
        val name = op.str("name") ?: throw failure(config, "didn't start the video")
        val began = System.currentTimeMillis()
        while (System.currentTimeMillis() - began < MAX_POLL_MS) {
            delay(8_000)
            val elapsed = (System.currentTimeMillis() - began) / 1000
            onProgress("Creating video · ${elapsed / 60}:${(elapsed % 60).toString().padStart(2, '0')}")
            val res = json(http, authorize(config, Request.Builder().url("$native/$name")).get().build())
            res.obj("error")?.let { throw failure(config, it.str("message") ?: "couldn't make that video") }
            if (res["done"]?.toString() == "true") {
                val uri = res.obj("response")?.obj("generateVideoResponse")?.arr("generatedSamples")
                    ?.firstOrNull()?.let { it as? JsonObject }?.obj("video")?.str("uri")
                    ?: throw failure(config, "finished without a video (it may have been filtered)")
                return download(http, uri, "video/mp4", withAuth = config)
            }
        }
        throw failure(config, "took too long to make the video")
    }

    // ------------------------------------------------------------------ speech

    private suspend fun speech(config: ProviderConfig, http: OkHttpClient, id: String, text: String, voice: String): MediaFile {
        val base = config.baseUrl.trimBaseUrl()
        return when (config.kind) {
            ProviderKind.GOOGLE -> {
                val body = buildJsonObject {
                    put("model", id)
                    putJsonArray("input") {
                        addJsonObject {
                            put("type", "user_input")
                            putJsonArray("content") { addJsonObject { put("type", "text"); put("text", text) } }
                        }
                    }
                    putJsonObject("response_format") { put("type", "audio") }
                    putJsonObject("generation_config") { putJsonArray("speech_config") { addJsonObject { put("voice", voice) } } }
                    put("store", false)
                }
                interactionResult(config, http, body, "audio")
            }
            ProviderKind.ELEVENLABS -> {
                val url = "$base/v1/text-to-speech/$voice".toHttpUrl().newBuilder().addQueryParameter("output_format", "mp3_44100_128").build()
                concat(chunks(text, 4_500)) { part ->
                    val body = buildJsonObject { put("text", part); put("model_id", id) }
                    bytes(http, authorize(config, Request.Builder().url(url)).post(body.toString().toJsonBody()).build())
                }
            }
            ProviderKind.MISTRAL -> concat(chunks(text, 4_000)) { part ->
                val body = buildJsonObject {
                    put("model", id); put("input", part); put("response_format", "mp3")
                    if (voice.isNotBlank()) put("voice_id", voice)
                }
                val res = json(http, post(config, "$base/audio/speech", body.toString().toJsonBody()))
                res.str("audio_data")?.let { fileFromBase64(it, "audio/mpeg") } ?: throw failure(config, "returned no audio")
            }
            ProviderKind.DEEPGRAM -> {
                val url = "$base/v1/speak".toHttpUrl().newBuilder()
                    .addQueryParameter("model", "$id-$voice-en").addQueryParameter("encoding", "mp3").build()
                concat(chunks(text, 1_900)) { part ->
                    bytes(http, authorize(config, Request.Builder().url(url)).post(buildJsonObject { put("text", part) }.toString().toJsonBody()).build())
                }
            }
            else -> concat(chunks(text, 4_000)) { part ->
                val body = buildJsonObject {
                    put("model", id); put("input", part); put("voice", voice); put("response_format", "mp3")
                }
                bytes(http, post(config, "$base/audio/speech", body.toString().toJsonBody()))
            }
        }
    }

    // ------------------------------------------------------------------ music

    private suspend fun music(config: ProviderConfig, http: OkHttpClient, id: String, job: MediaJob): MediaFile {
        val base = config.baseUrl.trimBaseUrl()
        val seconds = (job.seconds ?: 30).coerceIn(3, 600)
        return when (config.kind) {
            ProviderKind.ELEVENLABS -> if (id == "sound_effects") {
                val body = buildJsonObject { put("text", job.prompt); put("duration_seconds", seconds.coerceAtMost(30).toDouble()) }
                bytes(http, post(config, "$base/v1/sound-generation", body.toString().toJsonBody()))
            } else {
                val url = "$base/v1/music".toHttpUrl().newBuilder().addQueryParameter("output_format", "mp3_44100_128").build()
                val body = buildJsonObject { put("prompt", job.prompt); put("music_length_ms", seconds * 1000); put("model_id", id) }
                bytes(http, authorize(config, Request.Builder().url(url)).post(body.toString().toJsonBody()).build())
            }
            ProviderKind.STABILITY -> {
                val form = MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart("prompt", job.prompt)
                    .addFormDataPart("duration", seconds.coerceAtMost(190).toString())
                    .addFormDataPart("model", id)
                    .addFormDataPart("output_format", "mp3")
                    .build()
                bytes(http, authorize(config, Request.Builder().url("$base/v2beta/audio/stable-audio-2/text-to-audio")).header("Accept", "audio/*").post(form).build())
            }
            ProviderKind.GOOGLE -> {
                val prompt = if (job.seconds != null) "${job.prompt}\n\nLength: about $seconds seconds." else job.prompt
                interaction(config, http, id, prompt, "audio") {}
            }
            else -> unsupported(config, ModelOutput.MUSIC)
        }
    }

    // ------------------------------------------------------------------ Gemini Interactions API

    private fun geminiNative(config: ProviderConfig): String = config.baseUrl.trimBaseUrl().removeSuffix("/openai")

    private suspend fun interaction(
        config: ProviderConfig,
        http: OkHttpClient,
        model: String,
        prompt: String,
        type: String,
        format: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit,
    ): MediaFile {
        val body = buildJsonObject {
            put("model", model)
            put("input", prompt)
            putJsonObject("response_format") { put("type", type); format() }
            put("store", false)
        }
        return try {
            interactionResult(config, http, body, type)
        } catch (e: HttpStatusException) {
            // Some models reject an option (e.g. an aspect ratio); retry once with the plain request.
            if (e.code != 400) throw e
            val plain = buildJsonObject {
                put("model", model); put("input", prompt)
                putJsonObject("response_format") { put("type", type) }
                put("store", false)
            }
            interactionResult(config, http, plain, type)
        }
    }

    private suspend fun interactionResult(config: ProviderConfig, http: OkHttpClient, body: JsonObject, type: String): MediaFile {
        val res = json(http, post(config, "${geminiNative(config)}/interactions", body.toString().toJsonBody()))
        (res.arr("errors")?.firstOrNull() as? JsonObject)?.let { throw failure(config, it.str("message") ?: "couldn't make that") }
        val blocks = res.arr("steps").orEmpty().mapNotNull { it as? JsonObject }
            .flatMap { step -> step.arr("content").orEmpty().mapNotNull { it as? JsonObject } }
            .filter { it.str("type") == type }
        val block = blocks.lastOrNull()
            ?: throw failure(config, "returned no $type" + (res.str("status")?.let { " (status: $it)" } ?: ""))
        val mime = block.str("mime_type")
        block.str("data")?.let { return normalizeAudio(fileFromBase64(it, mime)) }
        val uri = block.str("uri") ?: throw failure(config, "returned no $type")
        val url = if (uri.startsWith("http")) uri else "${geminiNative(config)}/$uri:download?alt=media"
        return normalizeAudio(download(http, url, mime, withAuth = config))
    }

    // ------------------------------------------------------------------ helpers

    private fun slow(http: OkHttpClient) = http.newBuilder()
        .readTimeout(10, TimeUnit.MINUTES).writeTimeout(2, TimeUnit.MINUTES).callTimeout(12, TimeUnit.MINUTES).build()

    private fun post(config: ProviderConfig, url: String, body: okhttp3.RequestBody): Request =
        authorize(config, Request.Builder().url(url)).post(body).build()

    private suspend fun json(http: OkHttpClient, request: Request): JsonObject {
        val response = http.newCall(request).await()
        val text = withContext(Dispatchers.IO) {
            if (!response.isSuccessful) throw HttpStatusException.from(response)
            response.use { it.body.string() }
        }
        return parseObjectOrNull(text) ?: throw IOException("The response wasn't JSON.")
    }

    private suspend fun bytes(http: OkHttpClient, request: Request): MediaFile {
        val response = http.newCall(request).await()
        return withContext(Dispatchers.IO) {
            if (!response.isSuccessful) throw HttpStatusException.from(response)
            response.use { r ->
                val data = r.body.bytes()
                MediaFile(data, sniff(data) ?: r.header("Content-Type")?.substringBefore(';')?.trim() ?: "application/octet-stream")
            }
        }
    }

    private suspend fun download(http: OkHttpClient, url: String, mime: String?, withAuth: ProviderConfig? = null): MediaFile {
        val b = Request.Builder().url(url).get()
        if (withAuth != null) authorize(withAuth, b)
        val file = bytes(http, b.build())
        return if (mime != null && sniff(file.bytes) == null) MediaFile(file.bytes, mime) else file
    }

    private suspend fun concat(parts: List<String>, one: suspend (String) -> MediaFile): MediaFile {
        if (parts.size == 1) return one(parts[0])
        val out = ByteArrayOutputStream()
        var mime = "audio/mpeg"
        for (p in parts) {
            val f = one(p)
            mime = f.mimeType
            out.write(f.bytes)
        }
        return MediaFile(out.toByteArray(), mime)
    }

    /** Splits long text at sentence or paragraph ends so each part fits a TTS request. */
    internal fun chunks(text: String, max: Int): List<String> {
        val t = text.trim()
        if (t.length <= max) return listOf(t)
        val out = ArrayList<String>()
        var rest = t
        while (rest.length > max) {
            val window = rest.substring(0, max)
            val cut = listOf("\n\n", ". ", "! ", "? ", "\n", "; ", ", ", " ")
                .map { window.lastIndexOf(it).let { i -> if (i < 0) -1 else i + it.length } }
                .firstOrNull { it > max / 2 } ?: max
            out += rest.substring(0, cut).trim()
            rest = rest.substring(cut).trim()
        }
        if (rest.isNotEmpty()) out += rest
        return out
    }

    private fun fileFromBase64(b64: String, mime: String?): MediaFile {
        val data = Base64.getMimeDecoder().decode(b64)
        return MediaFile(data, sniff(data) ?: mime?.substringBefore(';')?.trim()?.ifBlank { null } ?: "application/octet-stream").let {
            if (mime != null && ("l16" in mime.lowercase() || "pcm" in mime.lowercase())) MediaFile(data, mime) else it
        }
    }

    private fun fileFromDataUrl(url: String): MediaFile {
        val mime = url.substringAfter("data:").substringBefore(';')
        return fileFromBase64(url.substringAfter("base64,"), mime)
    }

    /** Raw PCM (audio/l16 or audio/pcm) gets a WAV header so phones can play it. */
    private fun normalizeAudio(f: MediaFile): MediaFile {
        val m = f.mimeType.lowercase(Locale.ROOT)
        if (!("l16" in m || "pcm" in m)) return f
        val rate = Regex("""rate=(\d+)""").find(m)?.groupValues?.get(1)?.toIntOrNull() ?: 24_000
        return MediaFile(wav(f.bytes, rate), "audio/wav")
    }

    internal fun wav(pcm: ByteArray, sampleRate: Int, channels: Int = 1, bits: Int = 16): ByteArray {
        val byteRate = sampleRate * channels * bits / 8
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray()); putInt(36 + pcm.size); put("WAVE".toByteArray())
            put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(channels.toShort()); putInt(sampleRate)
            putInt(byteRate); putShort((channels * bits / 8).toShort()); putShort(bits.toShort())
            put("data".toByteArray()); putInt(pcm.size)
        }.array()
        return header + pcm
    }

    /** Recognizes common image, audio and video formats from their first bytes. */
    internal fun sniff(b: ByteArray): String? {
        fun at(i: Int, vararg v: Int) = b.size > i + v.size && v.indices.all { (b[i + it].toInt() and 0xFF) == v[it] }
        fun ascii(i: Int, s: String) = b.size >= i + s.length && String(b, i, s.length, Charsets.ISO_8859_1) == s
        return when {
            at(0, 0x89, 0x50, 0x4E, 0x47) -> "image/png"
            at(0, 0xFF, 0xD8, 0xFF) -> "image/jpeg"
            ascii(0, "RIFF") && ascii(8, "WEBP") -> "image/webp"
            ascii(0, "GIF8") -> "image/gif"
            ascii(0, "RIFF") && ascii(8, "WAVE") -> "audio/wav"
            ascii(0, "ID3") || (b.size > 1 && (b[0].toInt() and 0xFF) == 0xFF && (b[1].toInt() and 0xE0) == 0xE0) -> "audio/mpeg"
            ascii(0, "OggS") -> "audio/ogg"
            ascii(0, "fLaC") -> "audio/flac"
            ascii(4, "ftyp") -> if (ascii(8, "M4A")) "audio/mp4" else "video/mp4"
            ascii(0, "\u001AEß£") -> "video/webm"
            else -> null
        }
    }

    fun extensionFor(mime: String): String = when (mime.lowercase(Locale.ROOT).substringBefore(';')) {
        "image/png" -> "png"; "image/jpeg" -> "jpg"; "image/webp" -> "webp"; "image/gif" -> "gif"
        "audio/mpeg", "audio/mp3" -> "mp3"; "audio/wav", "audio/x-wav" -> "wav"; "audio/ogg" -> "ogg"; "audio/flac" -> "flac"
        "audio/mp4" -> "m4a"; "video/mp4" -> "mp4"; "video/webm" -> "webm"
        else -> "bin"
    }

    private fun failure(config: ProviderConfig, what: String) = LlmException(LlmError(ErrorKind.UNKNOWN, "${config.label} $what."))

    private fun unsupported(config: ProviderConfig, output: ModelOutput): Nothing =
        throw LlmException(LlmError(ErrorKind.BAD_REQUEST, "Facet can't make ${output.what} with ${config.label} yet."))

    private const val ELEVEN_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"

    private val GEMINI_VOICES = listOf(
        "Kore", "Puck", "Zephyr", "Charon", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus",
        "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam",
        "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
    )
}
