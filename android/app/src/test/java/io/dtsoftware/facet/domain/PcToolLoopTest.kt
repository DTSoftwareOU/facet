package io.dtsoftware.facet.domain

import androidx.room.Room
import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.data.db.FacetDatabase
import io.dtsoftware.facet.data.db.MessageStatus
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.data.prefs.SettingsStore
import io.dtsoftware.facet.data.repo.AssistantRepository
import io.dtsoftware.facet.data.repo.AttachmentStore
import io.dtsoftware.facet.data.repo.ConversationRepository
import io.dtsoftware.facet.data.repo.ProviderRepository
import io.dtsoftware.facet.domain.tools.McpManager
import io.dtsoftware.facet.domain.tools.PcTools
import io.dtsoftware.facet.domain.tools.SkillRepository
import io.dtsoftware.facet.domain.tools.ToolApproval
import io.dtsoftware.facet.domain.tools.ToolKind
import io.dtsoftware.facet.domain.tools.ToolRegistry
import io.dtsoftware.facet.domain.tools.ToolTrace
import io.dtsoftware.facet.domain.tools.WebSearch
import io.dtsoftware.facet.llm.ApiStyle
import io.dtsoftware.facet.llm.ChatRequest
import io.dtsoftware.facet.llm.GenParams
import io.dtsoftware.facet.llm.InMemoryQuirkStore
import io.dtsoftware.facet.llm.LlmClient
import io.dtsoftware.facet.llm.ModelCaps
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.Part
import io.dtsoftware.facet.llm.PricingCatalog
import io.dtsoftware.facet.llm.ProviderBlocks
import io.dtsoftware.facet.llm.ProviderConfig
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.llm.Role
import io.dtsoftware.facet.llm.StopReason
import io.dtsoftware.facet.llm.StreamEvent
import io.dtsoftware.facet.remote.FakePc
import io.dtsoftware.facet.remote.FakeRelay
import io.dtsoftware.facet.remote.RemoteHosts
import io.dtsoftware.facet.remote.RemoteMethod
import io.dtsoftware.facet.remote.eventually
import java.util.Collections
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** A chat bound to a PC: the model gets the PC's tools, they run there through the relay, and Stop cancels them. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class PcToolLoopTest {
    private class PlainBox : SecretBox {
        override fun seal(plain: ByteArray) = "v1:" + FacetCrypto.b64(plain)
        override fun open(sealed: String) = FacetCrypto.unb64(sealed.removePrefix("v1:"))
    }

    /** Calls [tool] on every new user message; answers once the result is back. */
    private class ScriptedClient(override val config: ProviderConfig, val tool: String, val args: String) : LlmClient {
        val requests: MutableList<ChatRequest> = Collections.synchronizedList(ArrayList())
        override suspend fun listModels() = emptyList<ModelInfo>()
        override suspend fun verify() = Result.success(Unit)
        override fun stream(request: ChatRequest): Flow<StreamEvent> = flow {
            requests += request
            emit(StreamEvent.Started(request.model))
            val last = request.messages.last()
            val results = last.parts.filterIsInstance<Part.ToolResult>()
            if (request.utility) {
                emit(StreamEvent.TextDelta("Title"))
                emit(StreamEvent.Completed(StopReason.END, null))
            } else if (results.isEmpty() && last.role == Role.USER) {
                val id = "call_${requests.size}"
                emit(StreamEvent.ToolCallStarted(id, tool))
                emit(StreamEvent.ToolCallReady(id, tool, args))
                emit(StreamEvent.Completed(StopReason.TOOL_USE, ProviderBlocks(ApiStyle.OPENAI_CHAT, request.model, "[]")))
            } else {
                emit(StreamEvent.TextDelta("Done: " + results.first().content))
                emit(StreamEvent.Completed(StopReason.END, null))
            }
        }
    }

    private class Env {
        val ctx = RuntimeEnvironment.getApplication()
        val db: FacetDatabase = Room.inMemoryDatabaseBuilder(ctx, FacetDatabase::class.java).build()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val secrets = PlainBox()
        val http = OkHttpClient()
        val settings = SettingsStore(ctx).apply { updateSynced { it.copy(autoTitle = false) } }
        val conversations = ConversationRepository(db) {}
        val providers = ProviderRepository(db, secrets, http, InMemoryQuirkStore(), PricingCatalog(null, null)) {}
        val api = io.dtsoftware.facet.sync.SyncApi(http)
        val auth = io.dtsoftware.facet.sync.AuthManager(ctx, api, secrets)
        val attachments = AttachmentStore(ctx, db) {}
        val sync = io.dtsoftware.facet.sync.SyncEngine(ctx, scope, db, auth, api, settings, attachments, secrets, http)
        val relay = FakeRelay()
        val remote = RemoteHosts(scope, relay)
        val pcTools = PcTools(remote, conversations, settings)
        val tools = ToolRegistry(WebSearch(http), providers, McpManager(ctx, db, secrets, http, scope) {}, SkillRepository(db, http) {}, settings, null, pcTools)
        val chat = ChatEngine(scope, conversations, providers, AssistantRepository(db) {}, attachments, settings, PricingCatalog(null, null), sync, tools)
        val pc = relay.add(FakePc(relay))

        init {
            pc.handler = { method, _ ->
                when (method) {
                    RemoteMethod.COMPUTER_TOOLS -> buildJsonArray {
                        add(tool("run_command", "Run a PowerShell command", false))
                        add(tool("read_file", "Read a file", true))
                        // Clashes with Facet's own page reader, so it's renamed for the model.
                        add(tool("fetch_page", "Fetch a page through the PC", true))
                    }
                    RemoteMethod.COMPUTER_INFO -> buildJsonObject {
                        put("os", "Windows 11"); put("shell", "PowerShell 7.5"); put("home", "C:\\Users\\alex"); put("user", "alex"); put("hostname", "OFFICE-PC")
                    }
                    RemoteMethod.COMPUTER_CALL -> buildJsonObject { put("content", "3 passed"); put("isError", false); put("label", "Ran `npm test`") }
                    else -> null
                }
            }
        }

        private fun tool(name: String, description: String, readOnly: Boolean) = buildJsonObject {
            put("name", name); put("description", description); put("inputSchemaJson", """{"type":"object","properties":{}}"""); put("readOnly", readOnly)
        }

        suspend fun online() {
            pc.announce()
            eventually { remote.hosts.value.containsKey("host-1") }
        }

        suspend fun awaitIdle() = withTimeout(10_000) {
            delay(100)
            while (chat.active.value.isNotEmpty()) delay(50)
        }

        suspend fun awaitApproval() = withTimeout(10_000) {
            while (chat.live.value.values.none { t -> t.tools.any { it.status == ToolStatus.AWAITING_APPROVAL } }) delay(20)
            chat.live.value.values.flatMap { it.tools }.first { it.status == ToolStatus.AWAITING_APPROVAL }
        }

        suspend fun send(client: ScriptedClient, text: String, conversationId: String? = null, host: String? = "host-1"): String {
            providers.clientOverride = { client }
            val p = providers.all().first()
            return chat.send(conversationId, text, emptyList(), NewChatSpec(null, ModelRef(p.id, "m1"), GenParams(), computerHost = host, computerFolder = host?.let { "C:\\Users\\alex\\app" }))
        }
    }

    private suspend fun Env.client(tool: String = "run_command", args: String = """{"command":"npm test"}"""): ScriptedClient {
        val p = providers.all().firstOrNull() ?: providers.add(ProviderKind.CUSTOM, "Test", "http://localhost", "", emptyMap())
        return ScriptedClient(providers.config(p), tool, args)
    }

    @Test
    fun runsTheToolOnThePcAfterApproval() = runBlocking {
        val env = Env()
        env.online()
        val client = env.client()
        val convId = env.send(client, "Run the tests")
        val waiting = env.awaitApproval()
        assertEquals(ToolKind.COMPUTER, waiting.kind)
        assertEquals("run_command", waiting.remoteName)
        assertEquals("OFFICE-PC", waiting.serverName)
        env.chat.respondToApproval(waiting.id, ApprovalDecision.ALLOW)
        env.awaitIdle()

        val first = client.requests[0]
        assertTrue(first.tools.map { it.name }.containsAll(listOf("run_command", "read_file", "computer_fetch_page", "fetch_page")))
        assertTrue(first.system!!.contains("You can use the user's computer (Windows 11, OFFICE-PC) through the computer tools"))
        assertTrue(first.system!!.contains("Commands run in PowerShell 7.5."))
        assertTrue(first.system!!.contains("The working folder for this chat is C:\\Users\\alex\\app; relative paths resolve there."))

        val (_, params) = env.pc.calls.last { it.first == RemoteMethod.COMPUTER_CALL }
        fun p(k: String) = (params[k] as JsonPrimitive).content
        assertEquals("run_command", p("name"))
        assertEquals("""{"command":"npm test"}""", p("argumentsJson"))
        assertEquals("C:\\Users\\alex\\app", p("cwd"))
        assertEquals("call_1", p("callId"))

        val reply = env.conversations.messages(convId).last { it.role == "assistant" }
        assertEquals(MessageStatus.DONE.name, reply.status)
        assertTrue(reply.content.contains("Done: 3 passed"))
        val call = AppJson.decodeFromString<ToolTrace>(reply.stepsJson!!).steps.single().calls.single()
        assertEquals("COMPUTER", call.kind)
        assertEquals("Ran `npm test`", call.label)
        assertEquals("OFFICE-PC", call.serverName)
        assertEquals("3 passed", call.result)
    }

    @Test
    fun allowForThisChatSkipsLaterApprovals() = runBlocking {
        val env = Env()
        env.online()
        val client = env.client()
        val convId = env.send(client, "Run the tests")
        env.chat.respondToApproval(env.awaitApproval().id, ApprovalDecision.ALWAYS)
        env.awaitIdle()
        val seen = Collections.synchronizedSet(HashSet<ToolStatus>())
        val watcher = env.scope.launch { env.chat.live.collect { m -> m.values.forEach { t -> t.tools.forEach { seen += it.status } } } }
        env.send(client, "Again", convId)
        env.awaitIdle()
        watcher.cancel()
        assertFalse(ToolStatus.AWAITING_APPROVAL in seen)
        assertEquals(2, env.pc.calls.count { it.first == RemoteMethod.COMPUTER_CALL })
    }

    @Test
    fun stoppingTheReplyCancelsTheCommandOnThePc() = runBlocking {
        val env = Env()
        env.settings.updateLocal { it.copy(pcApproval = ToolApproval.NEVER) }
        val handler = env.pc.handler
        env.pc.handler = { method, params -> if (method == RemoteMethod.COMPUTER_CALL) null else handler(method, params) }
        env.online()
        val convId = env.send(env.client(), "Run the tests")
        eventually { env.pc.calls.any { it.first == RemoteMethod.COMPUTER_CALL } }
        env.chat.stop(convId)
        env.awaitIdle()
        eventually { env.pc.cancelled.size == 1 }
        assertEquals(env.relay.messagesTo(env.pc.session, "call").last().let { (it["id"] as JsonPrimitive).content }, env.pc.cancelled.single())
        assertEquals(MessageStatus.STOPPED.name, env.conversations.messages(convId).last { it.role == "assistant" }.status)
    }

    @Test
    fun onlyChatsBoundToAnAvailablePcGetItsTools() = runBlocking {
        val env = Env()
        env.online()
        env.client()
        val caps = ModelCaps(tools = true)
        suspend fun computerTools(conv: io.dtsoftware.facet.data.db.ConversationEntity?, params: GenParams = GenParams(), c: ModelCaps = caps) =
            env.tools.prepare(params, c, conv).defs.filter { it.kind == ToolKind.COMPUTER }
        val p = env.providers.all().first()
        val bound = env.conversations.create(null, p.id, "m1", GenParams(), computerHost = "host-1", computerFolder = "C:\\Users\\alex\\app")
        val plain = env.conversations.create(null, p.id, "m1", GenParams())
        assertEquals(3, computerTools(bound).size)
        // Not bound, tools off, or a model without tools: none.
        assertTrue(computerTools(plain).isEmpty())
        assertTrue(computerTools(bound, GenParams(tools = false)).isEmpty())
        assertTrue(computerTools(bound, c = ModelCaps(tools = false)).isEmpty())
        // Bound to another PC that isn't online: none.
        assertTrue(computerTools(bound.copy(computerHost = "host-2")).isEmpty())

        // Ask before: changes (default), every action, or never.
        val byName = computerTools(bound).associateBy { it.remoteName }
        assertTrue(byName.getValue("run_command").needsApproval)
        assertFalse(byName.getValue("read_file").needsApproval)
        env.settings.updateLocal { it.copy(pcApproval = ToolApproval.ALWAYS) }
        assertTrue(computerTools(bound).all { it.needsApproval })
        env.settings.updateLocal { it.copy(pcApproval = ToolApproval.NEVER) }
        assertTrue(computerTools(bound).none { it.needsApproval })

        // Remote use switched off on the PC: none.
        env.pc.remote = false
        env.pc.announce()
        eventually { env.remote.hosts.value["host-1"]?.remote == false }
        assertTrue(computerTools(bound).isEmpty())
    }
}
