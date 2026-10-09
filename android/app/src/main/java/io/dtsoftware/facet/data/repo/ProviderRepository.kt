package io.dtsoftware.facet.data.repo

import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.db.FacetDatabase
import io.dtsoftware.facet.data.db.ProviderEntity
import io.dtsoftware.facet.llm.LlmClient
import io.dtsoftware.facet.llm.LlmClients
import io.dtsoftware.facet.llm.ModelCaps
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ModelOutput
import io.dtsoftware.facet.llm.ModelPricing
import io.dtsoftware.facet.llm.PricingCatalog
import io.dtsoftware.facet.llm.ProviderConfig
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.llm.QuirkStore
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient

/** A configured provider with its parsed model list, for pickers. */
data class ProviderModels(
    val provider: ProviderEntity,
    val kind: ProviderKind,
    val models: List<ModelInfo>,
    val favorites: Set<String>,
    /** Models the user hid from pickers (still usable by chats that already use them). */
    val hidden: Set<String> = emptySet(),
    /** Image, video, speech, music and transcription models ([models] holds the chat models). */
    val media: List<ModelInfo> = emptyList(),
)

/** The user's edits to one model, synced end-to-end encrypted with its provider. Null keeps the provider's value. */
@Serializable
data class ModelPrefs(
    val name: String? = null,
    val hidden: Boolean = false,
    val caps: ModelCaps? = null,
    val contextWindow: Int? = null,
    val maxOutput: Int? = null,
    val pricing: ModelPricing? = null,
    /** Corrects what the model makes when the automatic sorting got it wrong. */
    val output: ModelOutput? = null,
) {
    val isEmpty: Boolean get() = this == ModelPrefs()

    /** True when anything other than visibility is changed. */
    val customized: Boolean get() = copy(hidden = false) != ModelPrefs()

    fun applyTo(m: ModelInfo): ModelInfo = m.copy(
        displayName = name?.takeIf { it.isNotBlank() } ?: m.displayName,
        caps = caps ?: m.caps,
        contextWindow = contextWindow ?: m.contextWindow,
        maxOutput = maxOutput ?: m.maxOutput,
        pricing = pricing ?: m.pricing,
        output = output ?: m.output,
    )
}

class ProviderRepository(
    private val db: FacetDatabase,
    private val secrets: SecretBox,
    private val http: OkHttpClient,
    private val quirks: QuirkStore,
    private val pricing: PricingCatalog,
    private val onLocalChange: () -> Unit,
) {
    private val dao = db.providers()
    private val modelCache = ConcurrentHashMap<String, Pair<String, List<ModelInfo>>>()
    private val clientCache = ConcurrentHashMap<String, Pair<Long, LlmClient>>()

    fun observeAll(): Flow<List<ProviderEntity>> = dao.observeAll()

    fun observeCatalog(): Flow<List<ProviderModels>> = dao.observeAll().map { list ->
        // Chat pickers: providers with chat models (media-only providers are chosen in Settings → Media models).
        list.filter { it.enabled && !io.dtsoftware.facet.domain.tools.SearchKind.isSearch(it.kind) && ProviderKind.fromId(it.kind).style != io.dtsoftware.facet.llm.ApiStyle.MEDIA }.map { p ->
            val all = models(p)
            ProviderModels(
                p, ProviderKind.fromId(p.kind), all.filter { it.output == ModelOutput.TEXT }, favorites(p), hiddenModels(p),
                media = all.filter { it.output != ModelOutput.TEXT },
            )
        }
    }

    fun observe(id: String): Flow<ProviderEntity?> = dao.observe(id)
    suspend fun get(id: String): ProviderEntity? = dao.get(id)
    suspend fun all(): List<ProviderEntity> = dao.all()

    suspend fun add(kind: ProviderKind, label: String, baseUrl: String, apiKey: String, headers: Map<String, String>): ProviderEntity {
        val now = Clock.now()
        val p = ProviderEntity(
            id = Ids.new(),
            kind = kind.id,
            label = label.ifBlank { kind.displayName },
            baseUrl = normalizeBaseUrl(baseUrl.ifBlank { kind.defaultBaseUrl }),
            apiKeySealed = if (apiKey.isBlank()) "" else secrets.sealString(apiKey.trim()),
            headersJson = AppJson.encodeToString(headers),
            sort = dao.all().size,
            createdAt = now,
            updatedAt = now,
        )
        dao.upsert(p)
        onLocalChange()
        return p
    }

    /** Adds a non-LLM service row (web search backends) that shares key sealing and sync with providers. */
    suspend fun addService(kindId: String, label: String, baseUrl: String, apiKey: String): ProviderEntity {
        val now = Clock.now()
        val p = ProviderEntity(
            id = Ids.new(),
            kind = kindId,
            label = label,
            baseUrl = normalizeBaseUrl(baseUrl),
            apiKeySealed = if (apiKey.isBlank()) "" else secrets.sealString(apiKey.trim()),
            sort = 1000,
            createdAt = now,
            updatedAt = now,
        )
        dao.upsert(p)
        onLocalChange()
        return p
    }

    suspend fun update(
        id: String,
        label: String,
        baseUrl: String,
        apiKey: String?,
        headers: Map<String, String>,
        enabled: Boolean,
    ) {
        val p = dao.get(id) ?: return
        dao.upsert(
            p.copy(
                label = label.ifBlank { ProviderKind.fromId(p.kind).displayName },
                baseUrl = normalizeBaseUrl(baseUrl),
                apiKeySealed = when {
                    apiKey == null -> p.apiKeySealed
                    apiKey.isBlank() -> ""
                    else -> secrets.sealString(apiKey.trim())
                },
                headersJson = AppJson.encodeToString(headers),
                enabled = enabled,
                updatedAt = Clock.now(),
                dirty = true,
            ),
        )
        clientCache.remove(id)
        onLocalChange()
    }

    suspend fun delete(id: String) {
        val p = dao.get(id) ?: return
        dao.upsert(p.copy(deleted = true, dirty = true, apiKeySealed = "", updatedAt = Clock.now()))
        clientCache.remove(id)
        onLocalChange()
    }

    fun apiKey(p: ProviderEntity): String =
        if (p.apiKeySealed.isBlank()) "" else runCatching { secrets.openString(p.apiKeySealed) }.getOrDefault("")

    fun headers(p: ProviderEntity): Map<String, String> =
        runCatching { AppJson.decodeFromString<Map<String, String>>(p.headersJson) }.getOrDefault(emptyMap())

    fun config(p: ProviderEntity): ProviderConfig = ProviderConfig(
        id = p.id,
        kind = ProviderKind.fromId(p.kind),
        label = p.label,
        baseUrl = p.baseUrl,
        apiKey = apiKey(p),
        headers = headers(p),
    )

    /** Test hook: replaces real provider clients. */
    @androidx.annotation.VisibleForTesting
    internal var clientOverride: ((ProviderEntity) -> LlmClient)? = null

    fun client(p: ProviderEntity): LlmClient {
        clientOverride?.let { return it(p) }
        clientCache[p.id]?.let { (stamp, client) -> if (stamp == p.updatedAt) return client }
        val client = LlmClients.create(config(p), http, quirks, pricing)
        clientCache[p.id] = p.updatedAt to client
        return client
    }

    /** Validates a key before saving. */
    suspend fun verify(kind: ProviderKind, baseUrl: String, apiKey: String, headers: Map<String, String>): Result<Unit> = runCatching {
        val cfg = ProviderConfig("verify", kind, kind.displayName, normalizeBaseUrl(baseUrl), apiKey.trim(), headers)
        LlmClients.create(cfg, http, quirks, pricing).verify().getOrThrow()
    }

    suspend fun refreshModels(id: String): Result<List<ModelInfo>> = runCatching {
        val p = dao.get(id) ?: error("Provider not found")
        val models = client(p).listModels().sortedWith(compareByDescending<ModelInfo> { it.createdAt ?: 0 }.thenBy { it.displayName })
        dao.setModels(id, AppJson.encodeToString(models), Clock.now())
        models
    }

    fun favorites(p: ProviderEntity): Set<String> =
        runCatching { AppJson.decodeFromString<List<String>>(p.favoritesJson).toSet() }.getOrDefault(emptySet())

    /** Fetched + manually added models as the provider describes them, with known pricing filled in. */
    fun baseModels(p: ProviderEntity): List<ModelInfo> {
        val kind = ProviderKind.fromId(p.kind)
        val fetched = runCatching { AppJson.decodeFromString<List<ModelInfo>>(p.modelsJson) }.getOrDefault(emptyList())
        val custom = customModels(p)
        return (custom + fetched.filter { f -> custom.none { it.id == f.id } }).map { m ->
            m.copy(pricing = m.pricing ?: pricing.priceFor(kind, m.id))
        }
    }

    /** [baseModels] with the user's edits applied: what pickers, chats and cost estimates use. */
    fun models(p: ProviderEntity): List<ModelInfo> {
        val key = "${p.modelsFetchedAt}|${p.customModelsJson.hashCode()}|${p.capsOverridesJson.hashCode()}|${p.modelPrefsJson.hashCode()}|${p.modelsJson.length}"
        modelCache[p.id]?.let { (k, v) -> if (k == key) return v }
        val legacyCaps = runCatching { AppJson.decodeFromString<Map<String, ModelCaps>>(p.capsOverridesJson) }.getOrDefault(emptyMap())
        val prefs = modelPrefs(p)
        val merged = baseModels(p).map { m ->
            val withLegacy = legacyCaps[m.id]?.let { m.copy(caps = it) } ?: m
            prefs[m.id]?.applyTo(withLegacy) ?: withLegacy
        }
        modelCache[p.id] = key to merged
        return merged
    }

    fun customModels(p: ProviderEntity): List<ModelInfo> =
        runCatching { AppJson.decodeFromString<List<ModelInfo>>(p.customModelsJson) }.getOrDefault(emptyList())

    fun modelPrefs(p: ProviderEntity): Map<String, ModelPrefs> =
        runCatching { AppJson.decodeFromString<Map<String, ModelPrefs>>(p.modelPrefsJson) }.getOrDefault(emptyMap())

    fun hiddenModels(p: ProviderEntity): Set<String> = modelPrefs(p).filterValues { it.hidden }.keys

    fun modelInfo(p: ProviderEntity, modelId: String): ModelInfo =
        models(p).firstOrNull { it.id == modelId } ?: ModelInfo(id = modelId, displayName = modelId)

    suspend fun toggleFavorite(id: String, modelId: String) = mutate(id) { p ->
        val favs = favorites(p).toMutableSet()
        if (!favs.add(modelId)) favs.remove(modelId)
        p.copy(favoritesJson = AppJson.encodeToString(favs.toList()))
    }

    suspend fun addCustomModel(id: String, model: ModelInfo) = mutate(id) { p ->
        val list = runCatching { AppJson.decodeFromString<List<ModelInfo>>(p.customModelsJson) }.getOrDefault(emptyList())
        p.copy(customModelsJson = AppJson.encodeToString(list.filterNot { it.id == model.id } + model))
    }

    /** Removes a manually added model along with its edits and favorite. */
    suspend fun removeCustomModel(id: String, modelId: String) = mutate(id) { p ->
        p.copy(
            customModelsJson = AppJson.encodeToString(customModels(p).filterNot { it.id == modelId }),
            modelPrefsJson = AppJson.encodeToString(modelPrefs(p) - modelId),
            favoritesJson = AppJson.encodeToString((favorites(p) - modelId).toList()),
        )
    }

    /** Saves the user's edits to one model; an empty [prefs] restores the provider's values. */
    suspend fun setModelPrefs(id: String, modelId: String, prefs: ModelPrefs) = mutate(id) { p ->
        val map = modelPrefs(p).toMutableMap()
        if (prefs.isEmpty) map.remove(modelId) else map[modelId] = prefs
        // Edits replace the older caps-only override for this model.
        val legacy = runCatching { AppJson.decodeFromString<Map<String, ModelCaps>>(p.capsOverridesJson) }.getOrDefault(emptyMap())
        p.copy(modelPrefsJson = AppJson.encodeToString(map.toMap()), capsOverridesJson = AppJson.encodeToString(legacy - modelId))
    }

    /** Hides or shows models in pickers. */
    suspend fun setHidden(id: String, modelIds: Collection<String>, hidden: Boolean) = mutate(id) { p ->
        val map = modelPrefs(p).toMutableMap()
        modelIds.forEach { mid ->
            val next = (map[mid] ?: ModelPrefs()).copy(hidden = hidden)
            if (next.isEmpty) map.remove(mid) else map[mid] = next
        }
        p.copy(modelPrefsJson = AppJson.encodeToString(map.toMap()))
    }

    private suspend fun mutate(id: String, transform: (ProviderEntity) -> ProviderEntity) {
        val p = dao.get(id) ?: return
        dao.upsert(transform(p).copy(updatedAt = Clock.now(), dirty = true))
        onLocalChange()
    }

    companion object {
        fun normalizeBaseUrl(url: String): String = url.trim().trimEnd('/')
    }
}
