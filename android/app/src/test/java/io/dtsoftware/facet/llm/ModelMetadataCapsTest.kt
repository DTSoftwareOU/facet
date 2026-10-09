package io.dtsoftware.facet.llm

import io.dtsoftware.facet.core.util.AppJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Capabilities that OpenAI-compatible providers report in their model lists win over name guesses. */
class ModelMetadataCapsTest {
    private fun json(s: String): JsonObject = AppJson.parseToJsonElement(s).jsonObject

    @Test
    fun mistralCapabilitiesSetVisionAndTools() {
        val m = json("""{"id":"mistral-large-2512","capabilities":{"completion_chat":true,"function_calling":true,"vision":true},"max_context_length":262144}""")
        val caps = ModelCatalog.metadataCaps(ModelCatalog.compatCaps(ProviderKind.MISTRAL, "mistral-large-4"), m)
        assertTrue(caps.vision)
        assertTrue(caps.tools)
        val textOnly = json("""{"id":"codestral-latest","capabilities":{"completion_chat":true,"function_calling":false,"vision":false}}""")
        val c2 = ModelCatalog.metadataCaps(ModelCatalog.compatCaps(ProviderKind.MISTRAL, "codestral-latest"), textOnly)
        assertFalse(c2.vision)
        assertFalse(c2.tools)
        assertEquals(false, ModelCatalog.chatByMetadata(json("""{"id":"mistral-embed","capabilities":{"completion_chat":false}}""")))
    }

    @Test
    fun flagsModalitiesAndTags() {
        val fireworks = json("""{"id":"accounts/fireworks/models/x","supports_image_input":true,"supports_tools":true,"supports_chat":true}""")
        assertTrue(ModelCatalog.metadataCaps(ModelCaps(), fireworks).vision)
        val hf = json("""{"id":"Qwen/Qwen3-VL","architecture":{"input_modalities":["text","image"]},"providers":[{"supports_tools":false},{"supports_tools":true}]}""")
        val hfCaps = ModelCatalog.metadataCaps(ModelCaps(tools = false), hf)
        assertTrue(hfCaps.vision)
        assertTrue(hfCaps.tools)
        val vercel = json("""{"id":"x/y","tags":["vision","file-input","reasoning","tool-use"]}""")
        val v = ModelCatalog.metadataCaps(ModelCaps(), vercel)
        assertTrue(v.vision && v.pdf && v.tools && v.reasoning.summaries)
        // Nothing reported: the name-based guess stands.
        val plain = ModelCatalog.compatCaps(ProviderKind.GROQ, "meta-llama/llama-4-scout")
        assertEquals(plain, ModelCatalog.metadataCaps(plain, json("""{"id":"meta-llama/llama-4-scout","context_window":131072}""")))
    }

    @Test
    fun newerMistralNamesLookMultimodal() {
        assertTrue(ModelCatalog.looksVision("mistral-large-3"))
        assertTrue(ModelCatalog.looksVision("magistral-medium-latest"))
    }
}
