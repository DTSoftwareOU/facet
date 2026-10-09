package io.dtsoftware.facet.sync

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.provider.Settings
import io.dtsoftware.facet.BuildConfig
import io.dtsoftware.facet.core.crypto.DecryptionException
import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.RecoveryCode
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.util.Clock
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

sealed interface AccountState {
    /** Using Facet without an account; everything stays on this device. */
    data object Guest : AccountState

    data class SignedIn(
        val userId: String,
        val email: String,
        val displayName: String?,
        val serverUrl: String,
        val usedBytes: Long,
        val quotaBytes: Long,
    ) : AccountState

    /** The session ended (revoked or expired). Local data is kept; sync is paused until sign-in. */
    data class Expired(val email: String, val serverUrl: String) : AccountState
}

/** User-facing auth failure. */
class AuthException(message: String) : Exception(message)

/**
 * Owns the account session: client-side key derivation (docs/SECURITY.md), tokens,
 * and the vault key. Passwords and the vault key never leave the device in plaintext.
 */
class AuthManager(
    context: Context,
    private val api: SyncApi,
    private val secrets: SecretBox,
) {
    private val appContext = context.applicationContext
    private val prefs: SharedPreferences = context.getSharedPreferences("facet_account", Context.MODE_PRIVATE)
    private val refreshMutex = Mutex()

    @Volatile private var vaultKeyCache: ByteArray? = null

    private val _state = MutableStateFlow(readState())
    val state: StateFlow<AccountState> = _state.asStateFlow()

    /** Called after sign-in/sign-up so the sync engine can start. Arg: true when local data should be uploaded. */
    var onSignedIn: ((freshAccount: Boolean) -> Unit)? = null

    val serverUrl: String
        get() = prefs.getString(K_SERVER, null) ?: BuildConfig.DEFAULT_SYNC_URL

    fun setServerUrl(url: String) {
        val clean = url.trim().trimEnd('/').ifEmpty { BuildConfig.DEFAULT_SYNC_URL }
        prefs.edit().putString(K_SERVER, clean).apply()
    }

    val isSignedIn: Boolean get() = _state.value is AccountState.SignedIn

    private fun readState(): AccountState {
        val userId = prefs.getString(K_USER, null) ?: return AccountState.Guest
        val email = prefs.getString(K_EMAIL, "") ?: ""
        if (prefs.getBoolean(K_EXPIRED, false)) return AccountState.Expired(email, serverUrl)
        return AccountState.SignedIn(
            userId, email, prefs.getString(K_NAME, null), serverUrl,
            prefs.getLong(K_USED, 0), prefs.getLong(K_QUOTA, 0),
        )
    }

    fun vaultKey(): ByteArray? {
        vaultKeyCache?.let { return it }
        val sealed = prefs.getString(K_VAULT, null) ?: return null
        return runCatching { secrets.open(sealed) }.getOrNull()?.also { vaultKeyCache = it }
    }

    suspend fun meta(url: String = serverUrl): MetaDto = api.meta(url)

    // ---- Sign up / sign in ----

    /** Creates an account. Returns the recovery code the user must save. */
    suspend fun register(email: String, password: String, displayName: String?): String = withContext(Dispatchers.Default) {
        val cleanEmail = email.trim().lowercase()
        val salt = FacetCrypto.randomBytes(16)
        val iterations = FacetCrypto.DEFAULT_ITERATIONS
        val keys = FacetCrypto.deriveFromPassword(password, salt, iterations)
        val vaultKey = FacetCrypto.randomBytes(32)
        val recovery = RecoveryCode.generate()
        val recKeys = FacetCrypto.deriveFromRecovery(recovery)
        val res = mapErrors {
            api.register(
                serverUrl,
                RegisterReq(
                    email = cleanEmail,
                    displayName = displayName?.trim()?.takeIf { it.isNotEmpty() },
                    kdf = Kdf(iterations = iterations, salt = FacetCrypto.b64(salt)),
                    authHash = FacetCrypto.b64(keys.authHash),
                    wrappedVaultKey = FacetCrypto.b64(FacetCrypto.wrapVaultKey(keys.wrapKey, vaultKey)),
                    recovery = RecoveryDto(
                        FacetCrypto.b64(recKeys.authHash),
                        FacetCrypto.b64(FacetCrypto.wrapVaultKey(recKeys.wrapKey, vaultKey, recovery = true)),
                    ),
                    device = device(),
                ),
            )
        }
        saveSession(res.user, res.tokens, vaultKey)
        onSignedIn?.invoke(true)
        RecoveryCode.format(recovery)
    }

    suspend fun login(email: String, password: String) = withContext(Dispatchers.Default) {
        val cleanEmail = email.trim().lowercase()
        val kdf = mapErrors { api.prelogin(serverUrl, cleanEmail) }
        val keys = FacetCrypto.deriveFromPassword(password, FacetCrypto.unb64(kdf.salt), kdf.iterations)
        val res = mapErrors { api.login(serverUrl, LoginReq(cleanEmail, FacetCrypto.b64(keys.authHash), device())) }
        val vaultKey = try {
            FacetCrypto.unwrapVaultKey(keys.wrapKey, FacetCrypto.unb64(res.wrappedVaultKey))
        } catch (e: DecryptionException) {
            throw AuthException("Your encryption key couldn't be unlocked with this password.")
        }
        val previousUser = prefs.getString(K_USER, null)
        saveSession(res.user, res.tokens, vaultKey)
        onSignedIn?.invoke(previousUser != null && previousUser != res.user.id)
    }

    // ---- Recovery ----

    /** Resets the password with a recovery code. Keeps all data. Returns the new recovery code. */
    suspend fun recoverWithCode(email: String, code: String, newPassword: String): String = withContext(Dispatchers.Default) {
        val cleanEmail = email.trim().lowercase()
        val codeBytes = RecoveryCode.parse(code) ?: throw AuthException("That recovery code isn't valid. It has 32 letters and digits.")
        val recKeys = FacetCrypto.deriveFromRecovery(codeBytes)
        val start = mapErrors { api.recoverStart(serverUrl, cleanEmail, FacetCrypto.b64(recKeys.authHash)) }
        val vaultKey = try {
            FacetCrypto.unwrapVaultKey(recKeys.wrapKey, FacetCrypto.unb64(start.recoveryWrappedVaultKey), recovery = true)
        } catch (e: DecryptionException) {
            throw AuthException("That recovery code doesn't match this account.")
        }
        val (kdf, authHash, wrapped) = passwordMaterial(newPassword, vaultKey)
        val (newCode, recovery) = recoveryMaterial(vaultKey)
        val res = mapErrors {
            api.recoverFinish(serverUrl, RecoverFinishReq(start.resetToken, kdf, authHash, wrapped, recovery, device()))
        }
        saveSession(res.user, res.tokens, vaultKey)
        onSignedIn?.invoke(false)
        newCode
    }

    suspend fun requestEmailReset(email: String) = mapErrors { api.resetRequest(serverUrl, email.trim().lowercase()) }

    /**
     * Resets the password with an emailed code. The server deletes all encrypted data; this device
     * re-uploads what it has under a new vault key. Returns the new recovery code.
     */
    suspend fun confirmEmailReset(email: String, code: String, newPassword: String): String = withContext(Dispatchers.Default) {
        val vaultKey = FacetCrypto.randomBytes(32)
        val (kdf, authHash, wrapped) = passwordMaterial(newPassword, vaultKey)
        val (newCode, recovery) = recoveryMaterial(vaultKey)
        val res = mapErrors {
            api.resetConfirm(serverUrl, ResetConfirmReq(email.trim().lowercase(), code.trim(), kdf, authHash, wrapped, recovery, device()))
        }
        saveSession(res.user, res.tokens, vaultKey)
        onSignedIn?.invoke(true)
        newCode
    }

    // ---- Account management ----

    suspend fun changePassword(current: String, newPassword: String) = withContext(Dispatchers.Default) {
        val vaultKey = vaultKey() ?: throw AuthException("Sign in again to change your password.")
        val currentHash = currentAuthHash(current)
        val (kdf, authHash, wrapped) = passwordMaterial(newPassword, vaultKey)
        val tokens = authed { base, token -> api.changePassword(base, token, ChangePasswordReq(currentHash, kdf, authHash, wrapped)) }
        saveTokens(tokens)
    }

    /** Creates a new recovery code (the old one stops working). */
    suspend fun regenerateRecoveryCode(password: String): String = withContext(Dispatchers.Default) {
        val vaultKey = vaultKey() ?: throw AuthException("Sign in again to create a recovery code.")
        val currentHash = currentAuthHash(password)
        val (code, recovery) = recoveryMaterial(vaultKey)
        authed { base, token -> api.setRecovery(base, token, currentHash, recovery) }
        code
    }

    suspend fun deleteAccount(password: String) = withContext(Dispatchers.Default) {
        val currentHash = currentAuthHash(password)
        authed { base, token -> api.deleteAccount(base, token, currentHash) }
        clearSession()
    }

    suspend fun updateDisplayName(name: String?) {
        val user = authed { base, token -> api.updateDisplayName(base, token, name?.trim()?.takeIf { it.isNotEmpty() }) }
        saveUser(user)
    }

    suspend fun refreshAccount() {
        val user = authed { base, token -> api.account(base, token) }
        saveUser(user)
    }

    suspend fun sessions(): List<SessionDto> = authed { base, token -> api.sessions(base, token) }
    suspend fun revokeSession(id: String) = authed { base, token -> api.revokeSession(base, token, id) }
    suspend fun revokeOtherSessions() = authed { base, token -> api.revokeOtherSessions(base, token) }

    /** Signs out. The caller decides whether to wipe local data. */
    suspend fun logout() {
        runCatching { authed { base, token -> api.logout(base, token) } }
        clearSession()
    }

    // ---- Token handling ----

    /**
     * Runs [block] with a valid access token, refreshing it when needed and retrying once on 401.
     * Throws [AuthException] when the session has ended.
     */
    suspend fun <T> authed(block: suspend (base: String, token: String) -> T): T {
        val token = accessToken()
        return try {
            block(serverUrl, token)
        } catch (e: ApiException) {
            if (e.status == 401 && e.code == "unauthorized") {
                block(serverUrl, accessToken(forceRefresh = true))
            } else {
                throw e
            }
        }
    }

    private suspend fun accessToken(forceRefresh: Boolean = false): String = refreshMutex.withLock {
        if (_state.value !is AccountState.SignedIn) throw AuthException("You're not signed in.")
        val current = prefs.getString(K_ACCESS, null)?.let { runCatching { secrets.openString(it) }.getOrNull() }
        val expiresAt = prefs.getLong(K_ACCESS_EXP, 0)
        if (!forceRefresh && current != null && expiresAt - Clock.now() > 60_000) return current
        val refresh = prefs.getString(K_REFRESH, null)?.let { runCatching { secrets.openString(it) }.getOrNull() }
            ?: run { markExpired(); throw AuthException("Your session ended. Sign in again to keep syncing.") }
        try {
            val tokens = api.refresh(serverUrl, refresh)
            saveTokens(tokens)
            tokens.accessToken
        } catch (e: ApiException) {
            if (e.status == 401) {
                markExpired()
                throw AuthException("Your session ended. Sign in again to keep syncing.")
            }
            throw e
        }
    }

    // ---- helpers ----

    private suspend fun currentAuthHash(password: String): String {
        val email = prefs.getString(K_EMAIL, null) ?: throw AuthException("You're not signed in.")
        val kdf = mapErrors { api.prelogin(serverUrl, email) }
        val keys = FacetCrypto.deriveFromPassword(password, FacetCrypto.unb64(kdf.salt), kdf.iterations)
        return FacetCrypto.b64(keys.authHash)
    }

    private fun passwordMaterial(password: String, vaultKey: ByteArray): Triple<Kdf, String, String> {
        val salt = FacetCrypto.randomBytes(16)
        val keys = FacetCrypto.deriveFromPassword(password, salt, FacetCrypto.DEFAULT_ITERATIONS)
        return Triple(
            Kdf(iterations = FacetCrypto.DEFAULT_ITERATIONS, salt = FacetCrypto.b64(salt)),
            FacetCrypto.b64(keys.authHash),
            FacetCrypto.b64(FacetCrypto.wrapVaultKey(keys.wrapKey, vaultKey)),
        )
    }

    private fun recoveryMaterial(vaultKey: ByteArray): Pair<String, RecoveryDto> {
        val code = RecoveryCode.generate()
        val keys = FacetCrypto.deriveFromRecovery(code)
        return RecoveryCode.format(code) to RecoveryDto(
            FacetCrypto.b64(keys.authHash),
            FacetCrypto.b64(FacetCrypto.wrapVaultKey(keys.wrapKey, vaultKey, recovery = true)),
        )
    }

    private fun saveSession(user: UserDto, tokens: TokensDto, vaultKey: ByteArray) {
        vaultKeyCache = vaultKey
        prefs.edit()
            .putString(K_VAULT, secrets.seal(vaultKey))
            .putBoolean(K_EXPIRED, false)
            .commit()
        saveTokens(tokens)
        saveUser(user)
    }

    private fun saveTokens(tokens: TokensDto) {
        // Persist the refresh token before the access token is used (docs/API.md).
        prefs.edit()
            .putString(K_REFRESH, secrets.sealString(tokens.refreshToken))
            .putString(K_ACCESS, secrets.sealString(tokens.accessToken))
            .putLong(K_ACCESS_EXP, tokens.accessExpiresAt)
            .putString(K_SESSION, tokens.sessionId)
            .commit()
    }

    private fun saveUser(user: UserDto) {
        prefs.edit()
            .putString(K_USER, user.id)
            .putString(K_EMAIL, user.email)
            .putString(K_NAME, user.displayName)
            .putLong(K_USED, user.storage.usedBytes)
            .putLong(K_QUOTA, user.storage.quotaBytes)
            .commit()
        _state.value = readState()
    }

    private fun markExpired() {
        prefs.edit().putBoolean(K_EXPIRED, true).remove(K_ACCESS).remove(K_REFRESH).apply()
        _state.value = readState()
    }

    private fun clearSession() {
        vaultKeyCache = null
        val server = prefs.getString(K_SERVER, null)
        prefs.edit().clear().apply {
            if (server != null) putString(K_SERVER, server)
        }.commit()
        _state.value = AccountState.Guest
    }

    val previousUserId: String? get() = prefs.getString(K_USER, null)

    private fun device(): DeviceDto {
        val userName = runCatching { Settings.Global.getString(appContext.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
        val name = userName?.takeIf { it.isNotBlank() } ?: run {
            val model = Build.MODEL.orEmpty()
            val maker = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
            if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model"
        }
        return DeviceDto(name.take(80), "android")
    }

    private suspend fun <T> mapErrors(block: suspend () -> T): T = try {
        block()
    } catch (e: ApiException) {
        throw AuthException(
            when (e.code) {
                "invalid_credentials" -> "That email and password don't match an account."
                "email_taken" -> "An account with this email already exists. Sign in instead."
                "registration_closed" -> "This server isn't accepting new accounts."
                "rate_limited" -> "Too many attempts. Wait a few minutes and try again."
                "email_disabled" -> "This server can't send email. Use your recovery code instead."
                else -> e.message ?: "The sync server returned an error."
            },
        )
    } catch (e: AuthException) {
        throw e
    } catch (e: IOException) {
        throw AuthException("Couldn't reach the sync server. Check your connection and the server address.")
    }

    private companion object {
        const val K_SERVER = "server_url"
        const val K_USER = "user_id"
        const val K_EMAIL = "email"
        const val K_NAME = "display_name"
        const val K_USED = "storage_used"
        const val K_QUOTA = "storage_quota"
        const val K_ACCESS = "access"
        const val K_ACCESS_EXP = "access_exp"
        const val K_REFRESH = "refresh"
        const val K_SESSION = "session_id"
        const val K_VAULT = "vault"
        const val K_EXPIRED = "expired"
    }
}
