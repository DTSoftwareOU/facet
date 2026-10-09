package io.dtsoftware.facet.llm

import io.dtsoftware.facet.llm.media.Aspect
import io.dtsoftware.facet.llm.media.MediaGen
import io.dtsoftware.facet.llm.media.MediaJob
import java.util.Base64
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Request shapes and response parsing for each media backend, against a local server. */
class MediaGenTest {
    private val server = MockWebServer()
    private val http = OkHttpClient()
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4)
    private val mp3 = "ID3".toByteArray() + ByteArray(64) { 7 }
    private val mp4 = byteArrayOf(0, 0, 0, 0x18) + "ftypmp42".toByteArray() + ByteArray(32)

    @Before fun start() = server.start()
    @After fun stop() = server.close()

    private fun config(kind: ProviderKind, path: String = "/v1") =
        ProviderConfig("p", kind, kind.displayName, server.url(path).toString().trimEnd('/'), "key-123")

    private fun model(id: String, out: ModelOutput) = ModelInfo(id, id, output = out)
    private fun b64(b: ByteArray) = Base64.getEncoder().encodeToString(b)
    private fun json(body: String) = MockResponse.Builder().addHeader("Content-Type", "application/json").body(body).build()
    private fun bytes(b: ByteArray, type: String) = MockResponse.Builder().addHeader("Content-Type", type).body(Buffer().write(b)).build()
    private fun RecordedRequest.json(): JsonObject = Json.parseToJsonElement(body!!.utf8()).jsonObject
    private fun JsonObject.s(k: String) = this[k]?.jsonPrimitive?.content

    @Test
    fun openAiImage() = runTest {
        server.enqueue(json("""{"data":[{"b64_json":"${b64(png)}"}]}"""))
        val f = MediaGen.generate(config(ProviderKind.OPENAI), http, model("gpt-image-1", ModelOutput.IMAGE), MediaJob(ModelOutput.IMAGE, "a fox", Aspect.PORTRAIT))
        assertEquals("image/png", f.mimeType)
        assertTrue(f.bytes.contentEquals(png))
        val req = server.takeRequest()
        assertEquals("/v1/images/generations", req.url.encodedPath)
        assertEquals("Bearer key-123", req.headers["Authorization"])
        val body = req.json()
        assertEquals("1024x1536", body.s("size"))
        assertNull("GPT Image rejects response_format", body["response_format"])

        server.enqueue(json("""{"data":[{"b64_json":"${b64(png)}"}]}"""))
        MediaGen.generate(config(ProviderKind.OPENAI), http, model("dall-e-3", ModelOutput.IMAGE), MediaJob(ModelOutput.IMAGE, "x", Aspect.LANDSCAPE))
        val dalle = server.takeRequest().json()
        assertEquals("b64_json", dalle.s("response_format"))
        assertEquals("1792x1024", dalle.s("size"))
    }

    @Test
    fun geminiImageViaInteractionsRetriesWithoutOptions() = runTest {
        server.enqueue(json("""{"error":{"message":"aspect_ratio not supported"}}""").newBuilder().code(400).build())
        server.enqueue(json("""{"id":"i1","status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"Here"},{"type":"image","mime_type":"image/png","data":"${b64(png)}"}]}]}"""))
        val f = MediaGen.generate(config(ProviderKind.GOOGLE, "/v1beta/openai"), http, model("gemini-nano-banana-2.1", ModelOutput.IMAGE), MediaJob(ModelOutput.IMAGE, "a fox", Aspect.LANDSCAPE))
        assertEquals("image/png", f.mimeType)
        val first = server.takeRequest()
        assertEquals("/v1beta/interactions", first.url.encodedPath)
        assertEquals("key-123", first.headers["x-goog-api-key"])
        val fmt = first.json()["response_format"]!!.jsonObject
        assertEquals("image", fmt.s("type"))
        assertEquals("16:9", fmt.s("aspect_ratio"))
        val retry = server.takeRequest().json()["response_format"]!!.jsonObject
        assertNull(retry["aspect_ratio"])
    }

    @Test
    fun geminiSpeechPcmBecomesWav() = runTest {
        val pcm = ByteArray(480) { (it % 7).toByte() }
        server.enqueue(json("""{"steps":[{"type":"model_output","content":[{"type":"audio","mime_type":"audio/l16;rate=24000","data":"${b64(pcm)}"}]}]}"""))
        val f = MediaGen.generate(config(ProviderKind.GOOGLE, "/v1beta/openai"), http, model("gemini-3.8-flash-tts", ModelOutput.SPEECH), MediaJob(ModelOutput.SPEECH, "Hello", voice = "Puck"))
        assertEquals("audio/wav", f.mimeType)
        assertEquals("RIFF", String(f.bytes, 0, 4))
        assertEquals(44 + pcm.size, f.bytes.size)
        val body = server.takeRequest().json()
        val voice = body["generation_config"]!!.jsonObject["speech_config"].toString()
        assertTrue(voice.contains("Puck"))
    }

    @Test
    fun veoIsPolledAndDownloaded() = runTest {
        server.enqueue(json("""{"name":"models/veo-3.1-generate-preview/operations/op1"}"""))
        server.enqueue(json("""{"name":"models/veo-3.1-generate-preview/operations/op1","done":false}"""))
        server.enqueue(json("""{"done":true,"response":{"generateVideoResponse":{"generatedSamples":[{"video":{"uri":"${server.url("/v1beta/files/v1:download?alt=media")}"}}]}}}"""))
        server.enqueue(bytes(mp4, "video/mp4"))
        val progress = ArrayList<String>()
        val f = MediaGen.generate(config(ProviderKind.GOOGLE, "/v1beta/openai"), http, model("veo-3.1-generate-preview", ModelOutput.VIDEO), MediaJob(ModelOutput.VIDEO, "waves", Aspect.PORTRAIT)) { progress += it }
        assertEquals("video/mp4", f.mimeType)
        val start = server.takeRequest()
        assertEquals("/v1beta/models/veo-3.1-generate-preview:predictLongRunning", start.url.encodedPath)
        assertTrue(start.json()["parameters"].toString().contains("9:16"))
        assertEquals("/v1beta/models/veo-3.1-generate-preview/operations/op1", server.takeRequest().url.encodedPath)
        server.takeRequest()
        assertEquals("key-123", server.takeRequest().headers["x-goog-api-key"])
        assertTrue(progress.any { it.startsWith("Creating video") })
    }

    @Test
    fun elevenLabsSpeechMusicAndTranscription() = runTest {
        val cfg = config(ProviderKind.ELEVENLABS, "/")
        server.enqueue(bytes(mp3, "audio/mpeg"))
        val speech = MediaGen.generate(cfg, http, model("eleven_multilingual_v2", ModelOutput.SPEECH), MediaJob(ModelOutput.SPEECH, "Hi there", voice = "voice42"))
        assertEquals("audio/mpeg", speech.mimeType)
        val tts = server.takeRequest()
        assertEquals("/v1/text-to-speech/voice42", tts.url.encodedPath)
        assertEquals("mp3_44100_128", tts.url.queryParameter("output_format"))
        assertEquals("key-123", tts.headers["xi-api-key"])
        assertEquals("eleven_multilingual_v2", tts.json().s("model_id"))

        server.enqueue(bytes(mp3, "audio/mpeg"))
        MediaGen.generate(cfg, http, model("music_v1", ModelOutput.MUSIC), MediaJob(ModelOutput.MUSIC, "lofi", seconds = 45))
        val music = server.takeRequest()
        assertEquals("/v1/music", music.url.encodedPath)
        assertEquals("45000", music.json().s("music_length_ms"))

        server.enqueue(json("""{"text":" hello world "}"""))
        val text = MediaGen.transcribe(cfg, http, model("scribe_v2", ModelOutput.TRANSCRIPTION), ByteArray(2000), "audio/mp4", "d.m4a")
        assertEquals("hello world", text)
        val stt = server.takeRequest()
        assertEquals("/v1/speech-to-text", stt.url.encodedPath)
        assertTrue(stt.body!!.utf8().contains("name=\"model_id\""))
    }

    @Test
    fun deepgramAndOpenAiTranscription() = runTest {
        server.enqueue(json("""{"results":{"channels":[{"alternatives":[{"transcript":"buenos dias"}]}]}}"""))
        val dg = MediaGen.transcribe(config(ProviderKind.DEEPGRAM, "/"), http, model("nova-3", ModelOutput.TRANSCRIPTION), ByteArray(2000), "audio/mp4", "d.m4a")
        assertEquals("buenos dias", dg)
        val req = server.takeRequest()
        assertEquals("Token key-123", req.headers["Authorization"])
        assertEquals("nova-3", req.url.queryParameter("model"))

        server.enqueue(json("""{"text":"hi"}"""))
        assertEquals("hi", MediaGen.transcribe(config(ProviderKind.GROQ), http, model("whisper-large-v3-turbo", ModelOutput.TRANSCRIPTION), ByteArray(2000), "audio/mp4", "d.m4a"))
        assertEquals("/v1/audio/transcriptions", server.takeRequest().url.encodedPath)
    }

    @Test
    fun mistralSpeechAndTranscription() = runTest {
        server.enqueue(json("""{"audio_data":"${b64(mp3)}"}"""))
        val f = MediaGen.generate(config(ProviderKind.MISTRAL), http, model("voxtral-mini-tts-2603", ModelOutput.SPEECH), MediaJob(ModelOutput.SPEECH, "Bonjour", voice = "v-123"))
        assertEquals("audio/mpeg", f.mimeType)
        val tts = server.takeRequest()
        assertEquals("/v1/audio/speech", tts.url.encodedPath)
        assertEquals("v-123", tts.json().s("voice_id"))
        assertEquals("mp3", tts.json().s("response_format"))

        // No saved voice: let Mistral choose.
        server.enqueue(json("""{"audio_data":"${b64(mp3)}"}"""))
        MediaGen.generate(config(ProviderKind.MISTRAL), http, model("voxtral-mini-tts-2603", ModelOutput.SPEECH), MediaJob(ModelOutput.SPEECH, "Hola", voice = ""))
        assertNull(server.takeRequest().json()["voice_id"])

        server.enqueue(json("""{"text":"salut"}"""))
        assertEquals("salut", MediaGen.transcribe(config(ProviderKind.MISTRAL), http, model("voxtral-mini-latest", ModelOutput.TRANSCRIPTION), ByteArray(2000), "audio/mp4", "d.m4a"))
        assertEquals("/v1/audio/transcriptions", server.takeRequest().url.encodedPath)
    }

    @Test
    fun openRouterImageFromDataUrl() = runTest {
        server.enqueue(json("""{"choices":[{"message":{"content":"","images":[{"type":"image_url","image_url":{"url":"data:image/png;base64,${b64(png)}"}}]}}]}"""))
        val f = MediaGen.generate(config(ProviderKind.OPENROUTER), http, model("google/gemini-2.5-flash-image", ModelOutput.IMAGE), MediaJob(ModelOutput.IMAGE, "x"))
        assertTrue(f.bytes.contentEquals(png))
        val body = server.takeRequest().json()
        assertTrue(body["modalities"].toString().contains("image"))
    }

    @Test
    fun fluxIsPolled() = runTest {
        server.enqueue(json("""{"id":"t1","polling_url":"${server.url("/v1/get_result?id=t1")}"}"""))
        server.enqueue(json("""{"status":"Pending"}"""))
        server.enqueue(json("""{"status":"Ready","result":{"sample":"${server.url("/sample.png")}"}}"""))
        server.enqueue(bytes(png, "image/png"))
        val f = MediaGen.generate(config(ProviderKind.BFL, "/"), http, model("flux-2-pro", ModelOutput.IMAGE), MediaJob(ModelOutput.IMAGE, "x", Aspect.SQUARE))
        assertEquals("image/png", f.mimeType)
        val start = server.takeRequest()
        assertEquals("/v1/flux-2-pro", start.url.encodedPath)
        assertEquals("key-123", start.headers["x-key"])
        assertEquals("1024", start.json().s("width"))
    }

    @Test
    fun stabilityImageIsMultipart() = runTest {
        server.enqueue(bytes(png, "image/png"))
        MediaGen.generate(config(ProviderKind.STABILITY, "/"), http, model("sd3.5-large", ModelOutput.IMAGE), MediaJob(ModelOutput.IMAGE, "x", Aspect.LANDSCAPE))
        val req = server.takeRequest()
        assertEquals("/v2beta/stable-image/generate/sd3", req.url.encodedPath)
        assertEquals("image/*", req.headers["Accept"])
        val body = req.body!!.utf8()
        assertTrue(body.contains("sd3.5-large") && body.contains("16:9"))
    }

    @Test
    fun errorsAreFriendly() = runTest {
        server.enqueue(json("""{"error":{"message":"Incorrect API key provided"}}""").newBuilder().code(401).build())
        val e = runCatching {
            MediaGen.generate(config(ProviderKind.OPENAI), http, model("gpt-image-1", ModelOutput.IMAGE), MediaJob(ModelOutput.IMAGE, "x"))
        }.exceptionOrNull()
        assertTrue(e is LlmException)
        assertEquals(ErrorKind.AUTH, (e as LlmException).error.kind)
    }

    @Test
    fun helpers() {
        assertEquals("image/jpeg", MediaGen.sniff(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0)))
        assertEquals("audio/mpeg", MediaGen.sniff(mp3))
        assertEquals("video/mp4", MediaGen.sniff(mp4))
        val parts = MediaGen.chunks("One. ".repeat(500), 1000)
        assertTrue(parts.all { it.length <= 1000 })
        assertEquals("One. ".repeat(500).trim().replace(" ", ""), parts.joinToString(" ").replace(" ", ""))
        assertFalse(MediaGen.wav(ByteArray(10), 24000).isEmpty())
    }
}
