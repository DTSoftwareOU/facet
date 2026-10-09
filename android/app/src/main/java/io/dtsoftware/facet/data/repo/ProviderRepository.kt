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
import io.dtsoftware.facet.llm.PricingCatalog
import io.dtsoftware.facet.llm.ProviderConfig
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.llm.QuirkStore
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import okhttp3.OkHttpClient

/** A configured provider with its parsed model list, for pickers. */
data class ProviderModels(
    val provider: ProviderEntity,
    val kind: ProviderKind,
    val models: List<ModelInfo>,
    val favorites: Set<String>,
)

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
        list.filter { it.enabled }.map { p ->
            ProviderModels(p, ProviderKind.fromId(p.kind), models(p), favorites(p))
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

    fun client(p: ProviderEntity): LlmClient {
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

    /** Fetched + manually added models, with capability overrides and known pricing applied. */
    fun models(p: ProviderEntity): List<ModelInfo> {
        val key = "${p.modelsFetchedAt}|${p.customModelsJson.hashCode()}|${p.capsOverridesJson.hashCode()}|${p.modelsJson.length}"
        modelCache[p.id]?.let { (k, v) -> if (k == key) return v }
        val kind = ProviderKind.fromId(p.kind)
        val fetched = runCatching { AppJson.decodeFromString<List<ModelInfo>>(p.modelsJson) }.getOrDefault(emptyList())
        val custom = runCatching { AppJson.decodeFromString<List<ModelInfo>>(p.customModelsJson) }.getOrDefault(emptyList())
        val overrides = runCatching { AppJson.decodeFromString<Map<String, ModelCaps>>(p.capsOverridesJson) }.getOrDefault(emptyMap())
        val merged = (custom + fetched.filter { f -> custom.none { it.id == f.id } }).map { m ->
            m.copy(
                caps = overrides[m.id] ?: m.caps,
                pricing = m.pricing ?: pricing.priceFor(kind, m.id),
            )
        }
        modelCache[p.id] = key to merged
        return merged
    }

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

    suspend fun removeCustomModel(id: String, modelId: String) = mutate(id) { p ->
        val list = runCatching { AppJson.decodeFromString<List<ModelInfo>>(p.customModelsJson) }.getOrDefault(emptyList())
        p.copy(customModelsJson = AppJson.encodeToString(list.filterNot { it.id == modelId }))
    }

    suspend fun setCapsOverride(id: String, modelId: String, caps: ModelCaps?) = mutate(id) { p ->
        val map = runCatching { AppJson.decodeFromString<Map<String, ModelCaps>>(p.capsOverridesJson) }.getOrDefault(emptyMap()).toMutableMap()
        if (caps == null) map.remove(modelId) else map[modelId] = caps
        p.copy(capsOverridesJson = AppJson.encodeToString(map.toMap()))
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
