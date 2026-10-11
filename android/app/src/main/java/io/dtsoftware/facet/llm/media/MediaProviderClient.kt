package io.dtsoftware.facet.llm.media

import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.net.HttpStatusException
import io.dtsoftware.facet.core.net.fetchString
import io.dtsoftware.facet.llm.ChatRequest
import io.dtsoftware.facet.llm.ErrorKind
import io.dtsoftware.facet.llm.LlmClient
import io.dtsoftware.facet.llm.LlmError
import io.dtsoftware.facet.llm.LlmErrors
import io.dtsoftware.facet.llm.LlmException
import io.dtsoftware.facet.llm.ModelCatalog
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ModelOutput
import io.dtsoftware.facet.llm.ProviderConfig
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.llm.StreamEvent
import io.dtsoftware.facet.llm.internal.parseJsonOrNull
import io.dtsoftware.facet.llm.internal.str
import io.dtsoftware.facet.llm.internal.trimBaseUrl
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Client for providers that only make media (ElevenLabs, Stability AI, Black Forest Labs, Deepgram).
 * It lists their models and checks keys; generation goes through [MediaGen]. It has no chat.
 */
class MediaProviderClient(override val config: ProviderConfig, private val http: OkHttpClient) : LlmClient {
    private val base = config.baseUrl.trimBaseUrl()

    override suspend fun listModels(): List<ModelInfo> {
        val builtIn = ModelCatalog.mediaProviderModels(config.kind)
        if (config.kind != ProviderKind.ELEVENLABS) return builtIn
        // ElevenLabs lists its voice models; keep the built-in music, sound and transcription entries.
        val live = runCatching {
            val arr = parseJsonOrNull(fetch(MediaGen.authorize(config, Request.Builder().url("$base/v1/models")).get().build())) as? JsonArray
            arr.orEmpty().mapNotNull { it as? JsonObject }
                .filter { (it["can_do_text_to_speech"] as? JsonPrimitive)?.booleanOrNull == true }
                .mapNotNull { m -> m.str("model_id")?.let { ModelInfo(it, m.str("name") ?: it, output = ModelOutput.SPEECH) } }
        }.getOrDefault(emptyList())
        return if (live.isEmpty()) builtIn else live + builtIn.filter { it.output != ModelOutput.SPEECH }
    }

    override fun stream(request: ChatRequest): Flow<StreamEvent> = flow {
        emit(StreamEvent.Failed(LlmError(ErrorKind.BAD_REQUEST, Strings.get(R.string.llm_media_only, config.label))))
    }

    override suspend fun verify(): Result<Unit> = try {
        val path = when (config.kind) {
            ProviderKind.ELEVENLABS -> "/v1/models"
            ProviderKind.STABILITY -> "/v1/user/account"
            ProviderKind.BFL -> "/v1/credits"
            ProviderKind.DEEPGRAM -> "/v1/projects"
            else -> "/"
        }
        fetch(MediaGen.authorize(config, Request.Builder().url(base + path)).get().build())
        Result.success(Unit)
    } catch (e: LlmException) {
        Result.failure(e)
    }

    private suspend fun fetch(request: Request): String = try {
        http.fetchString(request)
    } catch (e: HttpStatusException) {
        throw LlmException(LlmErrors.fromHttp(config, null, e))
    } catch (e: IOException) {
        throw LlmException(LlmErrors.fromIo(config, e))
    }
}
