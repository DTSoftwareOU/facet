package io.dtsoftware.facet.sync

import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.AppJson
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

// ---- Wire types (docs/API.md) ----

@Serializable data class Kdf(val algorithm: String = "pbkdf2-sha256", val iterations: Int, val salt: String)
@Serializable data class Storage(val usedBytes: Long = 0, val quotaBytes: Long = 0, val recordBytes: Long = 0, val blobBytes: Long = 0)
@Serializable data class UserDto(
    val id: String,
    val email: String,
    val displayName: String? = null,
    val createdAt: Long = 0,
    val storage: Storage = Storage(),
)
@Serializable data class TokensDto(val accessToken: String, val accessExpiresAt: Long, val refreshToken: String, val sessionId: String)
@Serializable data class DeviceDto(val name: String, val platform: String = "android")
@Serializable data class RecoveryDto(val authHash: String, val wrappedVaultKey: String)
@Serializable data class MetaDto(
    val name: String = "",
    val version: String = "",
    val registrationOpen: Boolean = true,
    val emailEnabled: Boolean = false,
)
@Serializable data class SessionDto(
    val id: String,
    val deviceName: String = "",
    val platform: String = "",
    val createdAt: Long = 0,
    val lastSeenAt: Long = 0,
    val ip: String? = null,
    val current: Boolean = false,
)

@Serializable data class RegisterReq(
    val email: String, val displayName: String?, val kdf: Kdf, val authHash: String,
    val wrappedVaultKey: String, val recovery: RecoveryDto, val device: DeviceDto,
)
@Serializable data class LoginReq(val email: String, val authHash: String, val device: DeviceDto)
@Serializable data class AuthRes(val user: UserDto, val tokens: TokensDto)
@Serializable data class LoginRes(val user: UserDto, val tokens: TokensDto, val kdf: Kdf, val wrappedVaultKey: String)
@Serializable data class RecoverStartRes(val resetToken: String, val recoveryWrappedVaultKey: String, val kdf: Kdf)
@Serializable data class RecoverFinishReq(
    val resetToken: String, val kdf: Kdf, val authHash: String, val wrappedVaultKey: String,
    val recovery: RecoveryDto, val device: DeviceDto,
)
@Serializable data class ResetConfirmReq(
    val email: String, val code: String, val kdf: Kdf, val authHash: String, val wrappedVaultKey: String,
    val recovery: RecoveryDto, val device: DeviceDto,
)
@Serializable data class ChangePasswordReq(val currentAuthHash: String, val kdf: Kdf, val authHash: String, val wrappedVaultKey: String)

@Serializable data class RecordDto(
    val id: String,
    val type: String,
    val updatedAt: Long,
    val deleted: Boolean,
    val ct: String? = null,
    val seq: Long = 0,
)
@Serializable data class PushReq(val records: List<RecordDto>)
@Serializable data class Accepted(val id: String, val type: String, val seq: Long)
@Serializable data class Rejected(val id: String, val type: String, val reason: String, val current: RecordDto? = null)
@Serializable data class PushRes(val accepted: List<Accepted> = emptyList(), val rejected: List<Rejected> = emptyList(), val cursor: Long = 0)
@Serializable data class PullRes(val records: List<RecordDto> = emptyList(), val cursor: Long = 0, val hasMore: Boolean = false, val reset: Boolean = false)

/** Another session of this account with an open change stream (docs/REMOTE.md). */
@Serializable data class PeerDto(val sessionId: String, val deviceName: String = "", val platform: String = "")
@Serializable data class PeersRes(val peers: List<PeerDto> = emptyList())
@Serializable data class RelayReq(val to: String, val msg: String)

class ApiException(val status: Int, val code: String, message: String, val retryAfter: Long? = null) : IOException(message)

/** Thin, stateless client for the Facet sync server. Authentication is handled by [AuthManager]. */
class SyncApi(private val http: OkHttpClient) {
    private val jsonType = "application/json".toMediaType()
    private val octet = "application/octet-stream".toMediaType()

    suspend fun meta(base: String): MetaDto = get(base, "/v1/meta", null)
    suspend fun prelogin(base: String, email: String): Kdf =
        post<JsonObject>(base, "/v1/auth/prelogin", null, mapOf("email" to email).toJsonBody())
            .let { AppJson.decodeFromJsonElement(Kdf.serializer(), it["kdf"]!!) }
    suspend fun register(base: String, req: RegisterReq): AuthRes = post(base, "/v1/auth/register", null, AppJson.encodeToString(req))
    suspend fun login(base: String, req: LoginReq): LoginRes = post(base, "/v1/auth/login", null, AppJson.encodeToString(req))
    suspend fun refresh(base: String, refreshToken: String): TokensDto =
        post<JsonObject>(base, "/v1/auth/refresh", null, mapOf("refreshToken" to refreshToken).toJsonBody())
            .let { AppJson.decodeFromJsonElement(TokensDto.serializer(), it["tokens"]!!) }
    suspend fun logout(base: String, token: String) { send(base, "POST", "/v1/auth/logout", token, "{}") }
    suspend fun recoverStart(base: String, email: String, recoveryAuthHash: String): RecoverStartRes =
        post(base, "/v1/auth/recover/start", null, mapOf("email" to email, "recoveryAuthHash" to recoveryAuthHash).toJsonBody())
    suspend fun recoverFinish(base: String, req: RecoverFinishReq): AuthRes = post(base, "/v1/auth/recover/finish", null, AppJson.encodeToString(req))
    suspend fun resetRequest(base: String, email: String) { send(base, "POST", "/v1/auth/reset/request", null, mapOf("email" to email).toJsonBody()) }
    suspend fun resetConfirm(base: String, req: ResetConfirmReq): AuthRes = post(base, "/v1/auth/reset/confirm", null, AppJson.encodeToString(req))

    suspend fun account(base: String, token: String): UserDto =
        get<JsonObject>(base, "/v1/account", token).let { AppJson.decodeFromJsonElement(UserDto.serializer(), it["user"]!!) }
    suspend fun updateDisplayName(base: String, token: String, name: String?): UserDto =
        send(base, "PATCH", "/v1/account", token, AppJson.encodeToString(mapOf("displayName" to name)))
            .let { AppJson.decodeFromJsonElement(UserDto.serializer(), AppJson.parseToJsonElement(it).jsonObject["user"]!!) }
    suspend fun changePassword(base: String, token: String, req: ChangePasswordReq): TokensDto =
        post<JsonObject>(base, "/v1/account/password", token, AppJson.encodeToString(req))
            .let { AppJson.decodeFromJsonElement(TokensDto.serializer(), it["tokens"]!!) }
    suspend fun setRecovery(base: String, token: String, currentAuthHash: String, recovery: RecoveryDto) {
        send(base, "POST", "/v1/account/recovery", token, AppJson.encodeToString(SetRecoveryReq(currentAuthHash, recovery)))
    }
    suspend fun deleteAccount(base: String, token: String, currentAuthHash: String) {
        send(base, "DELETE", "/v1/account", token, mapOf("currentAuthHash" to currentAuthHash).toJsonBody())
    }
    suspend fun sessions(base: String, token: String): List<SessionDto> =
        get<JsonObject>(base, "/v1/sessions", token).let {
            AppJson.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(SessionDto.serializer()), it["sessions"]!!)
        }
    suspend fun revokeSession(base: String, token: String, id: String) { send(base, "DELETE", "/v1/sessions/$id", token, null) }
    suspend fun revokeOtherSessions(base: String, token: String) { send(base, "DELETE", "/v1/sessions", token, null) }

    suspend fun push(base: String, token: String, records: List<RecordDto>): PushRes =
        post(base, "/v1/sync/push", token, AppJson.encodeToString(PushReq(records)))
    suspend fun pull(base: String, token: String, since: Long, limit: Int = 500): PullRes =
        get(base, "/v1/sync/pull?since=$since&limit=$limit", token)

    suspend fun putBlob(base: String, token: String, id: String, bytes: ByteArray) {
        execute(request(base, "/v1/blobs/$id", token).put(bytes.toRequestBody(octet)).build()).use { it.ensureOk() }
    }
    suspend fun getBlob(base: String, token: String, id: String): ByteArray =
        execute(request(base, "/v1/blobs/$id", token).get().build()).use { it.ensureOk(); it.body.bytes() }
    suspend fun deleteBlob(base: String, token: String, id: String) {
        execute(request(base, "/v1/blobs/$id", token).delete().build()).use { it.ensureOk() }
    }

    /** Forwards an encrypted envelope (b64) to another session. Throws [ApiException] 404 `peer_offline` when it has no open stream. */
    suspend fun relay(base: String, token: String, to: String, msg: String) {
        send(base, "POST", "/v1/relay", token, AppJson.encodeToString(RelayReq(to, msg)))
    }

    /** The account's other sessions that have an open stream right now. */
    suspend fun relayPeers(base: String, token: String): List<PeerDto> = get<PeersRes>(base, "/v1/relay/peers", token).peers

    /** Opens the SSE change stream. Caller reads `response.body.source()` and closes the call. */
    fun streamCall(streamHttp: OkHttpClient, base: String, token: String): Call =
        streamHttp.newCall(request(base, "/v1/sync/stream", token).header("Accept", "text/event-stream").get().build())

    // ---- plumbing ----

    @Serializable private data class SetRecoveryReq(val currentAuthHash: String, val recovery: RecoveryDto)

    private fun Map<String, String?>.toJsonBody(): String = AppJson.encodeToString(this)

    private fun request(base: String, path: String, token: String?): Request.Builder =
        Request.Builder().url(base.trimEnd('/') + path).apply {
            if (token != null) header("Authorization", "Bearer $token")
            header("User-Agent", "Facet-Android")
        }

    private suspend inline fun <reified T> get(base: String, path: String, token: String?): T =
        AppJson.decodeFromString(send(base, "GET", path, token, null))

    private suspend inline fun <reified T> post(base: String, path: String, token: String?, body: String): T =
        AppJson.decodeFromString(send(base, "POST", path, token, body))

    private suspend fun send(base: String, method: String, path: String, token: String?, body: String?): String {
        val rb: RequestBody? = body?.toRequestBody(jsonType)
        val req = request(base, path, token).method(method, rb ?: if (method == "GET") null else ByteArray(0).toRequestBody(null)).build()
        return execute(req).use { resp ->
            resp.ensureOk()
            withContext(Dispatchers.IO) { resp.body.string() }.ifEmpty { "{}" }
        }
    }

    private fun Response.ensureOk() {
        if (isSuccessful) return
        val text = runCatching { body.string() }.getOrDefault("")
        val err = runCatching { AppJson.parseToJsonElement(text).jsonObject["error"]?.jsonObject }.getOrNull()
        val code = err?.get("code")?.jsonPrimitive?.content ?: "http_$code"
        val message = err?.get("message")?.jsonPrimitive?.content ?: defaultMessage(this.code)
        throw ApiException(this.code, code, message, header("Retry-After")?.toLongOrNull())
    }

    private fun defaultMessage(status: Int) = when (status) {
        in 500..599 -> Strings.get(R.string.sync_error_server_problem)
        404 -> Strings.get(R.string.sync_error_unknown_request)
        else -> Strings.get(R.string.sync_error_server_status, status.toString())
    }

    private suspend fun execute(request: Request): Response = suspendCancellableCoroutine { cont ->
        val call = http.newCall(request)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                cont.resumeWithException(e)
            }
            override fun onResponse(call: Call, response: Response) {
                cont.resume(response)
            }
        })
    }
}
