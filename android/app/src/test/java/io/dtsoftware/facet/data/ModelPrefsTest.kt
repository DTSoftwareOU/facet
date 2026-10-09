package io.dtsoftware.facet.data

import androidx.room.Room
import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.data.db.FacetDatabase
import io.dtsoftware.facet.data.repo.ModelPrefs
import io.dtsoftware.facet.data.repo.ProviderRepository
import io.dtsoftware.facet.llm.InMemoryQuirkStore
import io.dtsoftware.facet.llm.ModelCaps
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ModelPricing
import io.dtsoftware.facet.llm.PricingCatalog
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.ui.settings.parsePrice
import io.dtsoftware.facet.ui.settings.parseTokens
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Per-model edits: names, visibility, capabilities, limits and prices layered over the provider's list. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class ModelPrefsTest {
    private class PlainBox : SecretBox {
        override fun seal(plain: ByteArray) = "v1:" + FacetCrypto.b64(plain)
        override fun open(sealed: String) = FacetCrypto.unb64(sealed.removePrefix("v1:"))
    }

    private val db = Room.inMemoryDatabaseBuilder(RuntimeEnvironment.getApplication(), FacetDatabase::class.java)
        .allowMainThreadQueries().build()
    private val repo = ProviderRepository(db, PlainBox(), OkHttpClient(), InMemoryQuirkStore(), PricingCatalog(null, null)) {}

    private val fetched = listOf(
        ModelInfo("m-pro", "Mock Pro", contextWindow = 200_000, caps = ModelCaps(vision = true), pricing = ModelPricing(3.0, 15.0)),
        ModelInfo("m-mini", "Mock Mini"),
    )

    private suspend fun provider(): String {
        val p = repo.add(ProviderKind.CUSTOM, "Lab", "http://localhost", "", emptyMap())
        db.providers().setModels(p.id, AppJson.encodeToString(fetched), 1)
        return p.id
    }

    @Test
    fun editsApplyEverywhereAndResetRestores() = runBlocking {
        val id = provider()
        val prefs = ModelPrefs(
            name = "Work model", caps = ModelCaps(vision = false, tools = false), contextWindow = 1_000_000,
            maxOutput = 64_000, pricing = ModelPricing(1.0, 2.0),
        )
        repo.setModelPrefs(id, "m-pro", prefs)

        val m = repo.modelInfo(repo.get(id)!!, "m-pro")
        assertEquals("Work model", m.displayName)
        assertFalse(m.caps.vision)
        assertFalse(m.caps.tools)
        assertEquals(1_000_000, m.contextWindow)
        assertEquals(64_000, m.maxOutput)
        assertEquals(ModelPricing(1.0, 2.0), m.pricing)
        // The provider's own description is still available for "Reset".
        assertEquals("Mock Pro", repo.baseModels(repo.get(id)!!).first { it.id == "m-pro" }.displayName)

        repo.setModelPrefs(id, "m-pro", ModelPrefs())
        val reset = repo.modelInfo(repo.get(id)!!, "m-pro")
        assertEquals("Mock Pro", reset.displayName)
        assertTrue(reset.caps.vision)
        assertEquals("{}", repo.get(id)!!.modelPrefsJson)
    }

    @Test
    fun hiddenModelsLeavePickersButStayResolvable() = runBlocking {
        val id = provider()
        repo.setHidden(id, listOf("m-mini"), true)
        val pm = repo.observeCatalog().first().single()
        assertEquals(setOf("m-mini"), pm.hidden)
        // Still listed (chats that use it keep their caps and name).
        assertTrue(pm.models.any { it.id == "m-mini" })

        repo.setHidden(id, listOf("m-mini"), false)
        assertTrue(repo.observeCatalog().first().single().hidden.isEmpty())
        assertEquals("{}", repo.get(id)!!.modelPrefsJson)
    }

    @Test
    fun hidingKeepsOtherEdits() = runBlocking {
        val id = provider()
        repo.setModelPrefs(id, "m-pro", ModelPrefs(name = "Renamed"))
        repo.setHidden(id, listOf("m-pro"), true)
        repo.setHidden(id, listOf("m-pro"), false)
        assertEquals(ModelPrefs(name = "Renamed"), repo.modelPrefs(repo.get(id)!!)["m-pro"])
    }

    @Test
    fun editsReplaceLegacyCapsOverride() = runBlocking {
        val id = provider()
        val p = repo.get(id)!!
        db.providers().upsert(p.copy(capsOverridesJson = AppJson.encodeToString(mapOf("m-mini" to ModelCaps(vision = true)))))
        assertTrue(repo.modelInfo(repo.get(id)!!, "m-mini").caps.vision)

        repo.setModelPrefs(id, "m-mini", ModelPrefs(name = "Mini"))
        val after = repo.get(id)!!
        assertEquals("{}", after.capsOverridesJson)
        assertFalse(repo.modelInfo(after, "m-mini").caps.vision)
    }

    @Test
    fun removingAnAddedModelClearsItsEdits() = runBlocking {
        val id = provider()
        repo.addCustomModel(id, ModelInfo("my-finetune", "My finetune"))
        repo.setModelPrefs(id, "my-finetune", ModelPrefs(name = "Tuned", hidden = true))
        repo.toggleFavorite(id, "my-finetune")

        repo.removeCustomModel(id, "my-finetune")
        val p = repo.get(id)!!
        assertTrue(repo.models(p).none { it.id == "my-finetune" })
        assertNull(repo.modelPrefs(p)["my-finetune"])
        assertFalse("my-finetune" in repo.favorites(p))
    }

    @Test
    fun parsesTokenAndPriceInput() {
        assertEquals(128_000, parseTokens("128k"))
        assertEquals(1_500_000, parseTokens("1.5m"))
        assertEquals(200_000, parseTokens("200,000"))
        assertNull(parseTokens("0"))
        assertNull(parseTokens("lots"))
        assertEquals(2.5, parsePrice("2,5")!!, 0.0)
        assertEquals(0.15, parsePrice("$0.15")!!, 0.0)
        assertNull(parsePrice("-1"))
    }
}
