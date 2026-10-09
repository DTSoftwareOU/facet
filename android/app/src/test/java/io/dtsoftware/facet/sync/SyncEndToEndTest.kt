package io.dtsoftware.facet.sync

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.room.Room
import org.robolectric.RuntimeEnvironment
import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.db.AttachmentEntity
import io.dtsoftware.facet.data.db.FacetDatabase
import io.dtsoftware.facet.data.db.MessageEntity
import io.dtsoftware.facet.data.prefs.SettingsStore
import io.dtsoftware.facet.data.repo.AttachmentStore
import io.dtsoftware.facet.data.repo.ConversationRepository
import io.dtsoftware.facet.data.repo.ProviderRepository
import io.dtsoftware.facet.llm.GenParams
import io.dtsoftware.facet.llm.InMemoryQuirkStore
import io.dtsoftware.facet.llm.PricingCatalog
import io.dtsoftware.facet.llm.ProviderKind
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Two simulated devices sync through a real Facet server (server/). Skipped unless one is running:
 *   PORT=8788 JWT_SECRET=… SERVER_SECRET=… node dist/index.js
 * and the test runs with -Dfacet.e2eServer=http://127.0.0.1:8788 (or the server answers on that default).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class SyncEndToEndTest {
    private val server = System.getProperty("facet.e2eServer") ?: "http://127.0.0.1:8788"
    private val http = OkHttpClient()

    private fun serverUp(): Boolean = runCatching {
        http.newCall(Request.Builder().url("$server/v1/health").build()).execute().use { it.isSuccessful }
    }.getOrDefault(false)

    /** Separate preferences and files per simulated device. */
    private class DeviceContext(base: Context, private val prefix: String) : ContextWrapper(base) {
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = super.getSharedPreferences("$prefix-$name", mode)
        override fun getApplicationContext(): Context = this
        override fun getFilesDir(): File = File(super.getFilesDir(), prefix).apply { mkdirs() }
    }

    private class PlainBox : SecretBox {
        override fun seal(plain: ByteArray) = "v1:" + FacetCrypto.b64(plain)
        override fun open(sealed: String) = FacetCrypto.unb64(sealed.removePrefix("v1:"))
    }

    private inner class Device(name: String) {
        val ctx = DeviceContext(RuntimeEnvironment.getApplication(), name + Ids.new())
        val db: FacetDatabase = Room.inMemoryDatabaseBuilder(ctx, FacetDatabase::class.java).build()
        val secrets = PlainBox()
        val settings = SettingsStore(ctx)
        val api = SyncApi(http)
        val auth = AuthManager(ctx, api, secrets).apply {
            setServerUrl(server)
            onProfileName = { name -> settings.updateSynced { it.copy(profileName = name) } }
        }
        val attachments = AttachmentStore(ctx, db) {}
        val sync = SyncEngine(ctx, CoroutineScope(SupervisorJob() + Dispatchers.IO), db, auth, api, settings, attachments, secrets, http)
        val conversations = ConversationRepository(db) {}
        val providers = ProviderRepository(db, secrets, http, InMemoryQuirkStore(), PricingCatalog(null, null)) {}
        val mcp = io.dtsoftware.facet.domain.tools.McpManager(ctx, db, secrets, http, CoroutineScope(SupervisorJob() + Dispatchers.IO)) {}
        val skills = io.dtsoftware.facet.domain.tools.SkillRepository(db, http) {}

        suspend fun syncOk() {
            val ok = sync.syncNow()
            assertTrue("sync failed: ${sync.state.value}", ok)
        }
    }

    @Test
    fun twoDevicesStayInSync() = runBlocking {
        assumeTrue("Facet server not running at $server", serverUp())
        val email = "e2e-${Ids.new()}@example.com"
        val password = "correct horse battery staple ✓"

        // Device A signs up and creates content.
        val a = Device("a")
        val recoveryCode = a.auth.register(email, password, "Ada Lovelace")
        assertTrue(a.auth.isSignedIn)
        val provider = a.providers.add(ProviderKind.ANTHROPIC, "Personal", "", "sk-ant-test-key-123", emptyMap())
        val conv = a.conversations.create(null, provider.id, "claude-opus-5-5", GenParams(webSearch = true))
        a.conversations.rename(conv.id, "Trip to Lisbon 🇵🇹")
        val now = Clock.now()
        val user = MessageEntity(Ids.new(), conv.id, null, "user", "Plan three days in Lisbon.", createdAt = now, updatedAt = now)
        val longReply = buildString { repeat(200) { append("Day $it: pastéis de nata and trams. ") } }
        val reply = MessageEntity(Ids.new(), conv.id, user.id, "assistant", longReply, thinking = "Thinking about trams", createdAt = now + 1, updatedAt = now + 1)
        a.conversations.insertMessage(user)
        a.conversations.insertMessage(reply)
        // An attachment with a local file.
        val attId = Ids.new()
        val bytes = ByteArray(50_000) { (it % 251).toByte() }
        File(a.attachments.dir, "$attId.jpg").writeBytes(bytes)
        a.db.attachments().upsert(
            AttachmentEntity(attId, conv.id, "image", "image/jpeg", "photo.jpg", bytes.size.toLong(), 10, 10, "$attId.jpg", createdAt = now, updatedAt = now),
        )
        a.settings.updateSynced { it.copy(aboutMe = "I like trains") }
        val server = a.mcp.add("Acme Tracker", "https://mcp.acme.example/mcp", io.dtsoftware.facet.mcp.McpAuthMode.HEADERS, mapOf("Authorization" to "Bearer mcp-secret-token-xyz"))
        a.skills.save(null, "lisbon-guide", "Use for trips to Lisbon.", "Always recommend pastel de nata at Manteigaria.")
        a.syncOk()

        // The operator's view: nothing readable on the server, and no structure leaks in record types or ids.
        val raw = a.auth.authed { base, token -> a.api.pull(base, token, 0, 1000) }
        assertTrue(raw.records.isNotEmpty())
        assertTrue("record types must be opaque", raw.records.all { it.type == "e" })
        assertTrue("record ids must be opaque", raw.records.none { it.id == conv.id || it.id == user.id || it.id == provider.id || it.id == attId })
        System.getenv("FACET_E2E_DATA")?.takeIf { it.isNotBlank() }?.let { dir ->
            val files = File(dir).walkTopDown().filter { it.isFile }.toList()
            assertTrue("server data dir has files", files.isNotEmpty())
            val secretsToHide = listOf(
                "Plan three days in Lisbon", "Trip to Lisbon", "pastéis de nata", "Thinking about trams", "sk-ant-test-key-123",
                "I like trains", "Ada Lovelace", "photo.jpg", "mcp-secret-token-xyz", "Acme Tracker", "acme.example",
                "pastel de nata at Manteigaria", "lisbon-guide", "claude-opus-5-5",
            )
            for (f in files) {
                val bytes = f.readBytes()
                val asText = String(bytes, Charsets.ISO_8859_1)
                for (secret in secretsToHide) {
                    val needle = String(secret.toByteArray(Charsets.UTF_8), Charsets.ISO_8859_1)
                    assertFalse("\"$secret\" is readable in ${f.name}", asText.contains(needle))
                }
            }
            println("Operator view OK: scanned ${files.size} server files, no plaintext found.")
        }
        assertNotNull(server)

        // Device B signs in and receives everything, decrypted.
        val b = Device("b")
        b.auth.login(email, password)
        b.syncOk()
        val bConv = b.conversations.get(conv.id)
        assertNotNull(bConv)
        assertEquals("Trip to Lisbon 🇵🇹", bConv!!.title)
        val bMsgs = b.conversations.messages(conv.id)
        assertEquals(2, bMsgs.size)
        assertEquals(longReply, bMsgs.first { it.role == "assistant" }.content)
        assertEquals("Thinking about trams", bMsgs.first { it.role == "assistant" }.thinking)
        val bProvider = b.providers.get(provider.id)!!
        assertEquals("sk-ant-test-key-123", b.providers.apiKey(bProvider))
        assertEquals("I like trains", b.settings.synced.value.aboutMe)
        assertEquals("Ada Lovelace", b.settings.synced.value.profileName)
        val bServer = b.mcp.all().single()
        assertEquals("Acme Tracker", bServer.name)
        assertEquals("Bearer mcp-secret-token-xyz", b.mcp.headers(bServer)["Authorization"])
        assertEquals("Always recommend pastel de nata at Manteigaria.", b.skills.all().single().instructions)
        assertTrue(b.sync.ensureLocal(attId))
        assertTrue(bytes.contentEquals(b.attachments.bytes(attId)))

        // B edits; A sees it.
        b.conversations.rename(conv.id, "Lisbon, 3 days")
        b.syncOk()
        a.syncOk()
        assertEquals("Lisbon, 3 days", a.conversations.get(conv.id)!!.title)

        // A deletes; B loses it.
        a.conversations.delete(conv.id)
        a.syncOk()
        b.syncOk()
        assertNull(b.conversations.get(conv.id))
        assertEquals(0, b.conversations.messages(conv.id).size)

        // Recovery code on a third device resets the password and keeps the data.
        val c = Device("c")
        val newCode = c.auth.recoverWithCode(email, recoveryCode, "a brand new passphrase")
        assertFalse(newCode == recoveryCode)
        c.syncOk()
        assertEquals("sk-ant-test-key-123", c.providers.apiKey(c.providers.get(provider.id)!!))

        // Old sessions were revoked by the reset: A's next sync pauses and asks to sign in again.
        assertFalse(a.sync.syncNow())
        assertTrue(a.auth.state.value is AccountState.Expired)

        // The old password no longer works; the new one does.
        val d = Device("d")
        runCatching { d.auth.login(email, password) }.onSuccess { error("old password should fail") }
        d.auth.login(email, "a brand new passphrase")
        d.syncOk()
        assertEquals("I like trains", d.settings.synced.value.aboutMe)

        // Delete the account.
        d.auth.deleteAccount("a brand new passphrase")
        assertFalse(d.auth.isSignedIn)
    }
}
