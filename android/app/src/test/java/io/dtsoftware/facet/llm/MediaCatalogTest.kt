package io.dtsoftware.facet.llm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Automatic sorting of models by what they make. */
class MediaCatalogTest {
    private fun out(kind: ProviderKind, id: String) = ModelCatalog.mediaOutput(kind, id)

    @Test
    fun sortsByOutput() {
        assertEquals(ModelOutput.IMAGE, out(ProviderKind.OPENAI, "gpt-image-1"))
        assertEquals(ModelOutput.IMAGE, out(ProviderKind.OPENAI, "dall-e-3"))
        assertEquals(ModelOutput.SPEECH, out(ProviderKind.OPENAI, "gpt-4o-mini-tts"))
        assertEquals(ModelOutput.TRANSCRIPTION, out(ProviderKind.OPENAI, "gpt-4o-transcribe"))
        assertEquals(ModelOutput.TRANSCRIPTION, out(ProviderKind.GROQ, "whisper-large-v3-turbo"))
        assertEquals(ModelOutput.IMAGE, out(ProviderKind.GOOGLE, "models/gemini-nano-banana-2.1"))
        assertEquals(ModelOutput.IMAGE, out(ProviderKind.GOOGLE, "gemini-3.1-flash-image"))
        assertEquals(ModelOutput.VIDEO, out(ProviderKind.GOOGLE, "gemini-omni-1.1-flash"))
        assertEquals(ModelOutput.VIDEO, out(ProviderKind.GOOGLE, "veo-3.1-generate-preview"))
        assertEquals(ModelOutput.SPEECH, out(ProviderKind.GOOGLE, "gemini-3.8-flash-tts"))
        assertEquals(ModelOutput.MUSIC, out(ProviderKind.GOOGLE, "lyria-3.5"))
        assertEquals(ModelOutput.IMAGE, out(ProviderKind.TOGETHER, "black-forest-labs/FLUX.1-schnell"))
        assertEquals(ModelOutput.IMAGE, out(ProviderKind.XAI, "grok-2-image-1212"))
        // Not media (or not runnable): embeddings, realtime and live models, chat models.
        assertNull(out(ProviderKind.GOOGLE, "gemini-embedding-2"))
        assertNull(out(ProviderKind.OPENAI, "gpt-realtime"))
        assertNull(out(ProviderKind.GOOGLE, "lyria-realtime-exp"))
        assertNull(out(ProviderKind.GOOGLE, "gemini-3.6-flash"))
        assertNull(out(ProviderKind.OPENAI, "gpt-5.5"))
    }

    @Test
    fun mistralAudioModels() {
        assertEquals(ModelOutput.TRANSCRIPTION, out(ProviderKind.MISTRAL, "voxtral-mini-latest"))
        assertEquals(ModelOutput.TRANSCRIPTION, out(ProviderKind.MISTRAL, "voxtral-mini-2602"))
        assertEquals(ModelOutput.SPEECH, out(ProviderKind.MISTRAL, "voxtral-mini-tts-2603"))
        assertNull("Voxtral Small is a chat model", out(ProviderKind.MISTRAL, "voxtral-small-latest"))
        assertTrue(ModelCatalog.isCompatChatModel("voxtral-small-latest"))
        // OCR, live transcription and guard models are neither chat nor media.
        assertNull(out(ProviderKind.MISTRAL, "voxtral-mini-transcribe-realtime-2602"))
        assertFalse(ModelCatalog.isCompatChatModel("voxtral-mini-transcribe-realtime-2602"))
        assertFalse(ModelCatalog.isCompatChatModel("mistral-ocr-latest"))
        assertTrue(ModelCatalog.canRun(ProviderKind.MISTRAL, ModelOutput.TRANSCRIPTION))
        assertTrue(ModelCatalog.canRun(ProviderKind.MISTRAL, ModelOutput.SPEECH))
    }

    @Test
    fun onlyRunnableCombinations() {
        assertTrue(ModelCatalog.canRun(ProviderKind.GOOGLE, ModelOutput.VIDEO))
        assertFalse(ModelCatalog.canRun(ProviderKind.OPENAI, ModelOutput.VIDEO))
        assertFalse(ModelCatalog.canRun(ProviderKind.GROQ, ModelOutput.SPEECH))
        assertFalse(ModelCatalog.canRun(ProviderKind.ELEVENLABS, ModelOutput.TEXT))
        assertTrue(ModelCatalog.canRun(ProviderKind.ELEVENLABS, ModelOutput.MUSIC))
    }

    @Test
    fun picksTheBestAutomatically() {
        val models = listOf(
            ModelInfo("dall-e-2", "DALL·E 2", output = ModelOutput.IMAGE),
            ModelInfo("gpt-image-1", "GPT Image 1", output = ModelOutput.IMAGE),
            ModelInfo("tts-1", "TTS 1", output = ModelOutput.SPEECH),
        )
        assertEquals("gpt-image-1", ModelCatalog.preferredMedia(ModelOutput.IMAGE, models)?.id)
        assertEquals("tts-1", ModelCatalog.preferredMedia(ModelOutput.SPEECH, models)?.id)
        assertNull(ModelCatalog.preferredMedia(ModelOutput.VIDEO, models))
    }

    @Test
    fun mediaOnlyProvidersHaveBuiltInModels() {
        for (k in listOf(ProviderKind.ELEVENLABS, ProviderKind.STABILITY, ProviderKind.BFL, ProviderKind.DEEPGRAM)) {
            val models = ModelCatalog.mediaProviderModels(k)
            assertTrue(k.name, models.isNotEmpty())
            assertTrue(models.all { it.output != ModelOutput.TEXT && ModelCatalog.canRun(k, it.output) })
        }
        assertEquals("GPT Image 1", ModelCatalog.displayName(ProviderKind.OPENAI, "gpt-image-1"))
    }
}
