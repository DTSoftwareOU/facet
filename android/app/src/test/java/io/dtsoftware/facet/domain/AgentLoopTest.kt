package io.dtsoftware.facet.domain

import androidx.room.Room
import io.dtsoftware.facet.core.crypto.FacetCrypto
import io.dtsoftware.facet.core.crypto.SecretBox
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.data.attachments
import io.dtsoftware.facet.data.db.FacetDatabase
import io.dtsoftware.facet.data.db.McpServerEntity
import io.dtsoftware.facet.data.db.MessageStatus
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.data.prefs.SettingsStore
import io.dtsoftware.facet.data.repo.AssistantRepository
import io.dtsoftware.facet.data.repo.AttachmentStore
import io.dtsoftware.facet.data.repo.ConversationRepository
import io.dtsoftware.facet.data.repo.ProviderRepository
import io.dtsoftware.facet.domain.tools.McpManager
import io.dtsoftware.facet.domain.tools.SkillRepository
import io.dtsoftware.facet.domain.tools.ToolTrace
import io.dtsoftware.facet.domain.tools.ToolRegistry
import io.dtsoftware.facet.domain.tools.WebSearch
import io.dtsoftware.facet.llm.ApiStyle
import io.dtsoftware.facet.llm.ChatRequest
import io.dtsoftware.facet.llm.GenParams
import io.dtsoftware.facet.llm.InMemoryQuirkStore
import io.dtsoftware.facet.llm.LlmClient
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.Part
import io.dtsoftware.facet.llm.PricingCatalog
import io.dtsoftware.facet.llm.ProviderBlocks
import io.dtsoftware.facet.llm.ProviderConfig
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.llm.Role
import io.dtsoftware.facet.llm.StopReason
import io.dtsoftware.facet.llm.StreamEvent
import io.dtsoftware.facet.mcp.McpTool
import io.dtsoftware.facet.sync.AuthManager
import io.dtsoftware.facet.sync.SyncApi
import io.dtsoftware.facet.sync.SyncEngine
import java.util.Collections
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

private val PNG = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13)

/** The tool loop end to end with a scripted model: call → run tool → feed result → answer → replay later. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class AgentLoopTest {
    private class PlainBox : SecretBox {
        override fun seal(plain: ByteArray) = "v1:" + FacetCrypto.b64(plain)
        override fun open(sealed: String) = FacetCrypto.unb64(sealed.removePrefix("v1:"))
    }

    /** Scripted model: if the last message has no tool results, call [toolName]; otherwise answer. */
    private class ScriptedClient(override val config: ProviderConfig, val toolName: () -> String, val args: String) : LlmClient {
        val requests: MutableList<ChatRequest> = Collections.synchronizedList(ArrayList())
        override suspend fun listModels() = emptyList<ModelInfo>()
        override suspend fun verify() = Result.success(Unit)
        override fun stream(request: ChatRequest): Flow<StreamEvent> = flow {
            requests += request
            emit(StreamEvent.Started(request.model))
            val last = request.messages.last()
            val results = last.parts.filterIsInstance<Part.ToolResult>()
            if (request.utility) {
                emit(StreamEvent.TextDelta("Lisbon trip"))
                emit(StreamEvent.Completed(StopReason.END, null))
            } else if (results.isEmpty() && last.role == Role.USER && request.messages.count { m -> m.parts.any { it is Part.ToolResult } } == 0) {
                emit(StreamEvent.TextDelta("Let me check."))
                emit(StreamEvent.ToolCallStarted("call_1", toolName()))
                emit(StreamEvent.ToolCallReady("call_1", toolName(), args))
                emit(StreamEvent.Completed(StopReason.TOOL_USE, ProviderBlocks(ApiStyle.OPENAI_CHAT, request.model, "[]")))
            } else {
                val r = results.firstOrNull()
                emit(StreamEvent.TextDelta(if (r != null) "Answer using ${r.content.length} chars (error=${r.isError})." else "Plain answer."))
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
        val assistants = AssistantRepository(db) {}
        val attachments = AttachmentStore(ctx, db) {}
        val api = SyncApi(http)
        val auth = AuthManager(ctx, api, secrets)
        val sync = SyncEngine(ctx, scope, db, auth, api, settings, attachments, secrets, http)
        val skills = SkillRepository(db, http) {}
        val mcp = McpManager(ctx, db, secrets, http, scope) {}
        val jobs: MutableList<io.dtsoftware.facet.llm.media.MediaJob> = Collections.synchronizedList(ArrayList())
        val media = io.dtsoftware.facet.domain.media.MediaService(providers, settings, attachments, http, ctx.cacheDir) { _, _, job, onProgress ->
            jobs += job
            onProgress("Creating an image · 50%")
            io.dtsoftware.facet.llm.media.MediaFile(PNG, "image/png")
        }
        val tools = ToolRegistry(WebSearch(http), providers, mcp, skills, settings, media)
        val chat = ChatEngine(scope, conversations, providers, assistants, attachments, settings, PricingCatalog(null, null), sync, tools)

        suspend fun awaitIdle() = withTimeout(10_000) {
            delay(100)
            while (chat.active.value.isNotEmpty()) delay(50)
        }
    }

    private suspend fun Env.providerWithImageModel(): io.dtsoftware.facet.data.db.ProviderEntity {
        val p = providers.add(ProviderKind.CUSTOM, "Test", "http://localhost", "", emptyMap())
        val list = listOf(ModelInfo("m1", "M1"), ModelInfo("img-1", "Img One", output = io.dtsoftware.facet.llm.ModelOutput.IMAGE))
        db.providers().setModels(p.id, AppJson.encodeToString(list), Clock.now())
        return providers.get(p.id)!!
    }

    @Test
    fun imageToolAttachesTheImageToTheReply() = runBlocking {
        val env = Env()
        val p = env.providerWithImageModel()
        val client = ScriptedClient(env.providers.config(p), { "generate_image" }, """{"prompt":"A red fox in the snow","aspect_ratio":"portrait"}""")
        env.providers.clientOverride = { client }
        val convId = env.chat.send(null, "Draw a fox", emptyList(), io.dtsoftware.facet.domain.NewChatSpec(null, ModelRef(p.id, "m1"), GenParams()))
        env.awaitIdle()

        // The image model is offered automatically, and isn't listed as a chat model.
        assertTrue(client.requests[0].tools.any { it.name == "generate_image" && it.description.contains("Img One") })
        assertTrue(env.providers.observeCatalog().first().single().models.none { it.id == "img-1" })
        assertEquals(io.dtsoftware.facet.llm.media.Aspect.PORTRAIT, env.jobs.single().aspect)

        val reply = env.conversations.messages(convId).last { it.role == "assistant" }
        val refs = reply.attachments()
        assertEquals(1, refs.size)
        assertEquals("image", refs[0].kind)
        assertEquals("red-fox-in-snow.png", refs[0].name)
        val stored = env.attachments.get(refs[0].id)!!
        assertEquals(convId, stored.conversationId)
        assertTrue("queued for encrypted sync", stored.dirty)
        val trace = AppJson.decodeFromString<ToolTrace>(reply.stepsJson!!)
        assertTrue(trace.steps[0].calls[0].label.startsWith("Created image"))
    }

    @Test
    fun mediaToolsFollowSettings() = runBlocking {
        val env = Env()
        val p = env.providerWithImageModel()
        val caps = io.dtsoftware.facet.llm.ModelCaps(tools = true)
        assertTrue(env.tools.prepare(GenParams(), caps).defs.any { it.spec.name == "generate_image" })
        // An explicit choice wins; turning the tools off removes them.
        env.settings.updateSynced { it.copy(media = it.media.copy(image = ModelRef(p.id, "img-1"))) }
        assertTrue(env.media.resolve(io.dtsoftware.facet.llm.ModelOutput.IMAGE)!!.explicit)
        env.settings.updateSynced { it.copy(media = it.media.copy(chatTools = false)) }
        assertTrue(env.tools.prepare(GenParams(), caps).defs.none { it.spec.name == "generate_image" })
        // No speech model: Read aloud falls back to the phone's voice.
        assertEquals(null, env.media.speak("hello"))
    }

    @Test
    fun skillToolRoundTripAndReplay() = runBlocking {
        val env = Env()
        val p = env.providers.add(ProviderKind.CUSTOM, "Test", "http://localhost", "", emptyMap())
        env.skills.save(null, "lisbon-guide", "Use for Lisbon trips.", "Recommend Manteigaria for pastel de nata.")
        val client = ScriptedClient(env.providers.config(p), { "use_skill" }, """{"name":"lisbon-guide"}""")
        env.providers.clientOverride = { client }

        val convId = env.chat.send(null, "Plan Lisbon", emptyList(), io.dtsoftware.facet.domain.NewChatSpec(null, ModelRef(p.id, "m1"), GenParams()))
        env.awaitIdle()

        // Request 1 offered the skill tool; request 2 carried the call and its result.
        assertTrue(client.requests[0].tools.any { it.name == "use_skill" && it.description.contains("lisbon-guide") })
        val second = client.requests[1].messages
        val call = second[second.size - 2]
        val result = second.last()
        assertEquals(Role.ASSISTANT, call.role)
        assertTrue(call.parts.any { it is Part.ToolCall && it.name == "use_skill" })
        assertTrue((result.parts.single() as Part.ToolResult).content.contains("Manteigaria"))

        val reply = env.conversations.messages(convId).last { it.role == "assistant" }
        assertEquals(MessageStatus.DONE.name, reply.status)
        assertTrue(reply.content.startsWith("Let me check."))
        assertTrue(reply.content.contains("Answer using"))
        val trace = AppJson.decodeFromString<ToolTrace>(reply.stepsJson!!)
        assertEquals(1, trace.steps.size)
        assertEquals("Used skill lisbon-guide", trace.steps[0].calls[0].label)
        assertTrue(trace.finalText.startsWith("Answer using"))

        // A follow-up replays the stored tool exchange exactly.
        env.chat.send(convId, "Thanks", emptyList(), null)
        env.awaitIdle()
        val replay = client.requests.last().messages
        val replayCall = replay.first { m -> m.parts.any { it is Part.ToolCall } }
        val replayResult = replay.first { m -> m.parts.any { it is Part.ToolResult } }
        assertEquals(call.parts.filterIsInstance<Part.ToolCall>(), replayCall.parts.filterIsInstance<Part.ToolCall>())
        assertEquals(result.parts, replayResult.parts)
    }

    @Test
    fun deniedApprovalSkipsTheTool() = runBlocking {
        val env = Env()
        val p = env.providers.add(ProviderKind.CUSTOM, "Test", "http://localhost", "", emptyMap())
        env.addAcmeServer()
        val client = ScriptedClient(env.providers.config(p), { "mcp_acme_create_issue" }, """{"title":"Bug"}""")
        env.providers.clientOverride = { client }
        val convId = env.chat.send(null, "File a bug", emptyList(), io.dtsoftware.facet.domain.NewChatSpec(null, ModelRef(p.id, "m1"), GenParams()))

        // Wait for the approval prompt, then deny it.
        withTimeout(10_000) {
            while (env.chat.live.value.values.none { t -> t.tools.any { it.status == ToolStatus.AWAITING_APPROVAL } }) delay(30)
        }
        env.chat.respondToApproval("call_1", ApprovalDecision.DENY)
        env.awaitIdle()

        val reply = env.conversations.messages(convId).last { it.role == "assistant" }
        val trace = AppJson.decodeFromString<ToolTrace>(reply.stepsJson!!)
        assertTrue(trace.steps[0].calls[0].isError)
        assertTrue(trace.steps[0].calls[0].result.startsWith("The user declined"))
        assertTrue(reply.content.contains("error=true"))
    }

    private suspend fun Env.addAcmeServer() {
        val now = Clock.now()
        db.mcpServers().upsert(
            McpServerEntity(
                id = "srv", name = "Acme", url = "https://mcp.acme.invalid/mcp", approval = "ALWAYS",
                toolsJson = AppJson.encodeToString(listOf(McpTool("create_issue", description = "Create an issue"))),
                toolsFetchedAt = now, createdAt = now, updatedAt = now,
            ),
        )
    }

    @Test
    fun yoloModeRunsToolsWithoutAsking() = runBlocking {
        val env = Env()
        env.settings.updateSynced { it.copy(yoloMode = true) }
        val p = env.providers.add(ProviderKind.CUSTOM, "Test", "http://localhost", "", emptyMap())
        env.addAcmeServer()

        val prepared = env.tools.prepare(GenParams(), io.dtsoftware.facet.llm.ModelCaps(tools = true))
        assertTrue(prepared.defs.single { it.remoteName == "create_issue" }.needsApproval.not())
        assertEquals(ToolRegistry.YOLO_TOOL_ROUNDS, prepared.maxRounds)

        val client = ScriptedClient(env.providers.config(p), { "mcp_acme_create_issue" }, """{"title":"Bug"}""")
        env.providers.clientOverride = { client }
        val seen = Collections.synchronizedSet(HashSet<ToolStatus>())
        val watcher = env.scope.launch { env.chat.live.collect { m -> m.values.forEach { t -> t.tools.forEach { seen += it.status } } } }
        val convId = env.chat.send(null, "File a bug", emptyList(), io.dtsoftware.facet.domain.NewChatSpec(null, ModelRef(p.id, "m1"), GenParams()))
        env.awaitIdle()
        watcher.cancel()

        // The call ran straight away (the fake server is unreachable, so it fails, but it was never held for approval).
        assertTrue(ToolStatus.AWAITING_APPROVAL !in seen)
        val call = AppJson.decodeFromString<ToolTrace>(env.conversations.messages(convId).last { it.role == "assistant" }.stepsJson!!).steps[0].calls[0]
        assertTrue(!call.result.startsWith("The user declined"))
    }

    @Test
    fun turningOnYoloAnswersAWaitingApproval() = runBlocking {
        val env = Env()
        val p = env.providers.add(ProviderKind.CUSTOM, "Test", "http://localhost", "", emptyMap())
        env.addAcmeServer()
        assertEquals(ToolRegistry.MAX_TOOL_ROUNDS, env.tools.prepare(GenParams(), io.dtsoftware.facet.llm.ModelCaps(tools = true)).maxRounds)
        val client = ScriptedClient(env.providers.config(p), { "mcp_acme_create_issue" }, """{"title":"Bug"}""")
        env.providers.clientOverride = { client }
        val convId = env.chat.send(null, "File a bug", emptyList(), io.dtsoftware.facet.domain.NewChatSpec(null, ModelRef(p.id, "m1"), GenParams()))

        withTimeout(10_000) {
            while (env.chat.live.value.values.none { t -> t.tools.any { it.status == ToolStatus.AWAITING_APPROVAL } }) delay(30)
        }
        env.settings.updateSynced { it.copy(yoloMode = true) }
        env.awaitIdle()

        val call = AppJson.decodeFromString<ToolTrace>(env.conversations.messages(convId).last { it.role == "assistant" }.stepsJson!!).steps[0].calls[0]
        assertTrue(!call.result.startsWith("The user declined"))
    }
}
