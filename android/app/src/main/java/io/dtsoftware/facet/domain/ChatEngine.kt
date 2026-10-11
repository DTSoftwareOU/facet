package io.dtsoftware.facet.domain

import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.AttachmentRef
import io.dtsoftware.facet.data.MessageError
import io.dtsoftware.facet.data.MessageTree
import io.dtsoftware.facet.data.attachments
import io.dtsoftware.facet.data.db.ConversationEntity
import io.dtsoftware.facet.data.db.MessageEntity
import io.dtsoftware.facet.data.db.MessageStatus
import io.dtsoftware.facet.data.db.ProviderEntity
import io.dtsoftware.facet.data.parseParams
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.data.prefs.SettingsStore
import io.dtsoftware.facet.data.repo.Assistant
import io.dtsoftware.facet.data.repo.AssistantRepository
import io.dtsoftware.facet.data.repo.AttachmentStore
import io.dtsoftware.facet.data.repo.ConversationRepository
import io.dtsoftware.facet.data.repo.ProviderRepository
import io.dtsoftware.facet.domain.tools.PreparedTools
import io.dtsoftware.facet.domain.tools.ToolCallRecord
import io.dtsoftware.facet.domain.tools.ToolContext
import io.dtsoftware.facet.domain.tools.ToolKind
import io.dtsoftware.facet.domain.tools.ToolOutcome
import io.dtsoftware.facet.domain.tools.ToolRegistry
import io.dtsoftware.facet.domain.tools.ToolStep
import io.dtsoftware.facet.domain.tools.ToolTrace
import io.dtsoftware.facet.llm.ChatMessage
import io.dtsoftware.facet.llm.ChatRequest
import io.dtsoftware.facet.llm.Citation
import io.dtsoftware.facet.llm.ErrorKind
import io.dtsoftware.facet.llm.GenParams
import io.dtsoftware.facet.llm.LlmError
import io.dtsoftware.facet.llm.LlmException
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.Part
import io.dtsoftware.facet.llm.PricingCatalog
import io.dtsoftware.facet.llm.ProviderBlocks
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.llm.Role
import io.dtsoftware.facet.llm.StopReason
import io.dtsoftware.facet.llm.StreamEvent
import io.dtsoftware.facet.llm.Usage
import io.dtsoftware.facet.sync.SyncEngine
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull

enum class ToolStatus { PREPARING, AWAITING_APPROVAL, RUNNING, DONE, ERROR, DENIED }

enum class ApprovalDecision { ALLOW, ALWAYS, DENY }

/** A tool call as shown while a reply streams (and rebuilt from [ToolTrace] afterwards). */
data class ToolActivity(
    val id: String,
    val name: String,
    val kind: ToolKind,
    val label: String,
    val status: ToolStatus,
    val argumentsJson: String = "",
    val result: String? = null,
    val serverName: String? = null,
    /** The tool's own name on its MCP server or PC (the model may see it renamed). */
    val remoteName: String? = null,
)

/** In-flight state of a streaming assistant turn, overlaid on the stored message by the UI. */
data class LiveTurn(
    val messageId: String,
    val conversationId: String,
    val text: String = "",
    val thinking: String = "",
    val thinkingActive: Boolean = false,
    val thinkingStartedAt: Long? = null,
    val thinkingMs: Long = 0,
    val searchQuery: String? = null,
    val searching: Boolean = false,
    val searchCount: Int = 0,
    val citations: List<Citation> = emptyList(),
    val notice: String? = null,
    val tools: List<ToolActivity> = emptyList(),
    /** Media created by tools during this reply. */
    val attachments: List<io.dtsoftware.facet.data.AttachmentRef> = emptyList(),
    val startedAt: Long = Clock.now(),
)

/** What a brand-new chat starts with, including the PC and folder it works in, if any. */
data class NewChatSpec(
    val assistantId: String?,
    val model: ModelRef,
    val params: GenParams,
    val folderId: String? = null,
    val computerHost: String? = null,
    val computerFolder: String? = null,
)

class ChatException(message: String) : Exception(message)

/**
 * Orchestrates conversations: builds provider requests from the visible branch, runs the tool loop
 * (search, skills, MCP), streams the reply into [live], persists the result, computes cost, and
 * titles new chats. Generations run in the application scope so they survive leaving the screen.
 */
class ChatEngine(
    private val scope: CoroutineScope,
    private val conversations: ConversationRepository,
    private val providers: ProviderRepository,
    private val assistants: AssistantRepository,
    private val attachments: AttachmentStore,
    private val settings: SettingsStore,
    private val pricing: PricingCatalog,
    private val sync: SyncEngine,
    private val tools: ToolRegistry,
    private val mcpAutoApprove: suspend (serverId: String, tool: String) -> Unit = { _, _ -> },
) {
    private val _live = MutableStateFlow<Map<String, LiveTurn>>(emptyMap())
    val live: StateFlow<Map<String, LiveTurn>> = _live.asStateFlow()

    private val _active = MutableStateFlow<Set<String>>(emptySet())
    /** Conversation ids with a generation in progress. */
    val active: StateFlow<Set<String>> = _active.asStateFlow()

    /** Emits (conversationId, title, preview) when a reply finishes; used for notifications. */
    var onReplyFinished: ((conversationId: String, title: String, preview: String) -> Unit)? = null

    private val jobs = ConcurrentHashMap<String, Job>()
    private val approvals = ConcurrentHashMap<String, CompletableDeferred<ApprovalDecision>>()
    /** PC tools the user allowed for the rest of a chat ("conversationId/toolName"). */
    private val chatApprovals: MutableSet<String> = ConcurrentHashMap.newKeySet()

    init {
        // Turning on YOLO mode (here or on another device) also answers approvals already waiting.
        scope.launch {
            settings.synced.map { it.yoloMode }.distinctUntilChanged().collect { yolo ->
                if (yolo) approvals.keys.toList().forEach { respondToApproval(it, ApprovalDecision.ALLOW) }
            }
        }
    }

    fun isGenerating(conversationId: String) = conversationId in _active.value

    /** Test hook: shows [turn] as if it were streaming. */
    @androidx.annotation.VisibleForTesting
    internal fun showLiveForTest(turn: LiveTurn) {
        _live.update { it + (turn.messageId to turn) }
        _active.update { it + turn.conversationId }
    }

    fun stop(conversationId: String) {
        jobs[conversationId]?.cancel()
    }

    /** Answers a pending tool approval shown in the chat. */
    fun respondToApproval(callId: String, decision: ApprovalDecision) {
        approvals.remove(callId)?.complete(decision)
    }

    // ---- public actions ----

    /** Sends a user message. Creates the conversation when [conversationId] is null. Returns the conversation id. */
    suspend fun send(conversationId: String?, text: String, attachmentIds: List<String>, newChat: NewChatSpec?): String {
        val conv = conversationId?.let { conversations.get(it) }
            ?: newChat?.let { spec ->
                conversations.create(
                    spec.assistantId, spec.model.providerId, spec.model.modelId, spec.params, spec.folderId,
                    spec.computerHost, spec.computerFolder,
                )
            }
            ?: throw ChatException("Choose a model to start chatting.")
        if (isGenerating(conv.id)) throw ChatException("Wait for the current reply to finish, or stop it.")
        val tree = MessageTree(conversations.messages(conv.id))
        val parent = tree.activePath(conv.currentLeafId).lastOrNull()
        val refs = attachmentIds.mapNotNull { attachments.get(it) }.map { AttachmentStore.ref(it) }
        if (refs.isNotEmpty()) attachments.commit(attachmentIds, conv.id)
        val now = Clock.now()
        val user = MessageEntity(
            id = Ids.new(),
            conversationId = conv.id,
            parentId = parent?.id,
            role = "user",
            content = text.trim(),
            attachmentsJson = refs.takeIf { it.isNotEmpty() }?.let { AppJson.encodeToString(it) },
            createdAt = now,
            updatedAt = now,
        )
        conversations.insertMessage(user)
        if (!conv.titleSet && parent == null) {
            val provisional = text.trim().lineSequence().firstOrNull().orEmpty().take(48).ifBlank { refs.firstOrNull()?.name ?: "New chat" }
            conversations.update(conv.id) { it.copy(title = provisional) }
        }
        startReply(conv.id, user)
        return conv.id
    }

    /** Generates a new sibling reply for [assistantMessageId], optionally on a different model. */
    suspend fun regenerate(assistantMessageId: String, model: ModelRef? = null) {
        val target = conversations.message(assistantMessageId) ?: return
        val parentId = target.parentId ?: return
        val user = conversations.message(parentId) ?: return
        if (model != null) conversations.setModel(target.conversationId, model.providerId, model.modelId)
        startReply(target.conversationId, user)
    }

    /** Replaces a user message with an edited copy (a new branch) and generates a reply. */
    suspend fun editAndResend(userMessageId: String, newText: String) {
        val original = conversations.message(userMessageId) ?: return
        if (isGenerating(original.conversationId)) throw ChatException("Wait for the current reply to finish, or stop it.")
        val now = Clock.now()
        val edited = original.copy(id = Ids.new(), content = newText.trim(), createdAt = now, updatedAt = now, dirty = true)
        conversations.insertMessage(edited)
        startReply(original.conversationId, edited)
    }

    /** Asks the model to continue a reply that hit the output limit. */
    suspend fun continueReply(conversationId: String) {
        val conv = conversations.get(conversationId) ?: return
        val leaf = MessageTree(conversations.messages(conversationId)).activePath(conv.currentLeafId).lastOrNull() ?: return
        val now = Clock.now()
        val user = MessageEntity(
            id = Ids.new(), conversationId = conversationId, parentId = leaf.id, role = "user",
            content = "Continue exactly where you left off.", createdAt = now, updatedAt = now,
        )
        conversations.insertMessage(user)
        startReply(conversationId, user)
    }

    /** Selects a sibling branch and follows it to its newest leaf. */
    suspend fun switchBranch(conversationId: String, siblingId: String) {
        val tree = MessageTree(conversations.messages(conversationId))
        conversations.setCurrentLeaf(conversationId, tree.latestLeaf(siblingId))
    }

    // ---- generation ----

    private suspend fun startReply(conversationId: String, user: MessageEntity) {
        val conv = conversations.get(conversationId) ?: return
        val (provider, model) = resolveModel(conv)
        val now = Clock.now()
        val reply = MessageEntity(
            id = Ids.new(),
            conversationId = conversationId,
            parentId = user.id,
            role = "assistant",
            providerId = provider.id,
            modelId = model.id,
            modelName = model.displayName,
            status = MessageStatus.STREAMING.name,
            createdAt = now + 1,
            updatedAt = now + 1,
        )
        conversations.insertMessage(reply)
        conversations.update(conversationId, touchActivity = true) { it.copy(currentLeafId = reply.id) }
        settings.updateLocal { it.copy(lastProviderId = provider.id, lastModelId = model.id) }

        _live.update { it + (reply.id to LiveTurn(reply.id, conversationId)) }
        _active.update { it + conversationId }
        // A chat that works on a PC keeps the relay stream open for the whole reply, also in the background.
        val releaseStream = if (conv.computerHost != null) sync.holdStream() else null
        val job = scope.launch {
            try {
                generate(conversationId, reply, provider, model)
            } finally {
                releaseStream?.invoke()
                jobs.remove(conversationId)
                _active.update { it - conversationId }
                _live.update { it - reply.id }
            }
        }
        jobs[conversationId] = job
    }

    private suspend fun resolveModel(conv: ConversationEntity): Pair<ProviderEntity, ModelInfo> {
        val provider = conv.providerId?.let { providers.get(it) }?.takeIf { !it.deleted && it.enabled }
            ?: throw ChatException("The provider for this chat was removed. Pick another model.")
        val modelId = conv.modelId ?: throw ChatException("Choose a model to continue.")
        return provider to providers.modelInfo(provider, modelId)
    }

    /** Mutable state of one reply across its tool steps. */
    private class ReplyState {
        val allText = StringBuilder()
        var stepText = StringBuilder()
        val thinking = StringBuilder()
        var thinkingStart: Long? = null
        var thinkingMs = 0L
        var usageBase = Usage()
        var stepUsage: Usage? = null
        var blocks: ProviderBlocks? = null
        var stop: StopReason? = null
        var error: LlmError? = null
        val citations = LinkedHashMap<String, Citation>()
        val attachments = ArrayList<io.dtsoftware.facet.data.AttachmentRef>()
        val activities = LinkedHashMap<String, ToolActivity>()
        val steps = ArrayList<ToolStep>()
        var servedModel: String = ""

        fun endThinking() {
            thinkingStart?.let { thinkingMs += Clock.now() - it }
            thinkingStart = null
        }

        val usage: Usage? get() = stepUsage?.let { usageBase + it } ?: usageBase.takeIf { it.inputTokens + it.outputTokens > 0 }
    }

    private suspend fun generate(conversationId: String, reply: MessageEntity, provider: ProviderEntity, model: ModelInfo) {
        val st = ReplyState().apply { servedModel = model.id }
        var lastPersist = 0L

        fun publish(transform: (LiveTurn) -> LiveTurn) {
            _live.update { map -> map[reply.id]?.let { map + (reply.id to transform(it)) } ?: map }
        }

        fun publishTools() = publish {
            it.copy(
                tools = st.activities.values.toList(),
                citations = st.citations.values.toList(),
                attachments = synchronized(st.attachments) { st.attachments.toList() },
            )
        }

        try {
            val base = buildRequest(conversationId, reply, model)
            val prepared: PreparedTools = runCatching { tools.prepare(base.params, model.caps, conversations.get(conversationId)) }
                .getOrDefault(PreparedTools(emptyList(), null))
            val system = listOfNotNull(base.system, prepared.systemAddendum).joinToString("\n\n").ifBlank { null }
            var messages = base.messages
            var round = 0
            val client = providers.client(provider)

            while (true) {
                val request = base.copy(system = system, messages = messages, tools = prepared.defs.map { it.spec })
                val calls = ArrayList<StreamEvent.ToolCallReady>()
                st.stepText = StringBuilder()
                st.stop = null
                st.blocks = null
                st.stepUsage = null
                val textPrefix = st.allText.toString()

                client.stream(request).collect { ev ->
                    when (ev) {
                        is StreamEvent.Started -> st.servedModel = ev.model
                        is StreamEvent.TextDelta -> {
                            if (st.thinkingStart != null) st.endThinking()
                            st.stepText.append(ev.text)
                            val shown = joinText(textPrefix, st.stepText.toString())
                            publish { it.copy(text = shown, thinkingActive = false, thinkingMs = st.thinkingMs, searching = false) }
                        }
                        is StreamEvent.ThinkingDelta -> {
                            if (st.thinkingStart == null) st.thinkingStart = Clock.now()
                            st.thinking.append(ev.text)
                            publish { it.copy(thinking = st.thinking.toString(), thinkingActive = true, thinkingStartedAt = it.thinkingStartedAt ?: st.thinkingStart) }
                        }
                        StreamEvent.ThinkingStarted -> {
                            if (st.thinkingStart == null) st.thinkingStart = Clock.now()
                            publish { it.copy(thinkingActive = true, thinkingStartedAt = it.thinkingStartedAt ?: st.thinkingStart) }
                        }
                        StreamEvent.ThinkingEnded -> {
                            st.endThinking()
                            publish { it.copy(thinkingActive = false, thinkingMs = st.thinkingMs) }
                        }
                        is StreamEvent.WebSearch -> publish {
                            it.copy(
                                searching = !ev.done,
                                searchQuery = ev.query ?: it.searchQuery,
                                searchCount = if (!ev.done) it.searchCount + 1 else it.searchCount,
                            )
                        }
                        is StreamEvent.Citations -> {
                            ev.citations.forEach { c -> st.citations.putIfAbsent(c.url, c) }
                            publish { it.copy(citations = st.citations.values.toList()) }
                        }
                        is StreamEvent.UsageUpdate -> st.stepUsage = ev.usage
                        is StreamEvent.Notice -> publish { it.copy(notice = ev.text) }
                        is StreamEvent.ToolCallStarted -> {
                            val def = prepared.byName[ev.name]
                            st.activities[ev.id] = ToolActivity(
                                ev.id, ev.name, def?.kind ?: ToolKind.MCP, preparingLabel(def?.kind, def?.serverName, def?.remoteName ?: ev.name),
                                ToolStatus.PREPARING, serverName = def?.serverName, remoteName = def?.remoteName,
                            )
                            publishTools()
                        }
                        is StreamEvent.ToolCallReady -> {
                            calls += ev
                            val def = prepared.byName[ev.name]
                            val existing = st.activities[ev.id]
                            st.activities[ev.id] = (existing ?: ToolActivity(ev.id, ev.name, def?.kind ?: ToolKind.MCP, preparingLabel(def?.kind, def?.serverName, def?.remoteName ?: ev.name), ToolStatus.PREPARING, serverName = def?.serverName, remoteName = def?.remoteName))
                                .copy(argumentsJson = ev.argumentsJson, label = runningLabel(def, ev.argumentsJson))
                            publishTools()
                        }
                        is StreamEvent.Completed -> {
                            st.stop = ev.stopReason
                            st.blocks = ev.blocks
                            ev.blocks?.model?.takeIf { it.isNotBlank() }?.let { st.servedModel = it }
                        }
                        is StreamEvent.Failed -> st.error = ev.error
                    }
                    val now = Clock.now()
                    if (now - lastPersist > 1_000) {
                        lastPersist = now
                        conversations.updateStreaming(reply.id, joinText(textPrefix, st.stepText.toString()), st.thinking.toString().ifEmpty { null })
                    }
                }

                st.usageBase = st.usage ?: st.usageBase
                st.stepUsage = null
                st.allText.setLength(0)
                st.allText.append(joinText(textPrefix, st.stepText.toString()))

                if (st.error != null || st.stop != StopReason.TOOL_USE || calls.isEmpty()) break
                val roundLimit = if (settings.synced.value.yoloMode) ToolRegistry.YOLO_TOOL_ROUNDS else ToolRegistry.MAX_TOOL_ROUNDS
                if (round >= roundLimit) {
                    publish { it.copy(notice = "Stopped after $roundLimit rounds of tool use.") }
                    st.stop = StopReason.END
                    break
                }
                round++

                val records = coroutineScope {
                    calls.map { call -> async { runTool(call, prepared, st, reply) { publishTools() } } }.awaitAll()
                }
                st.steps += ToolStep(st.stepText.toString(), records, st.blocks)
                val assistantParts = buildList<Part> {
                    st.stepText.toString().takeIf { it.isNotBlank() }?.let { add(Part.Text(it)) }
                    calls.forEach { add(Part.ToolCall(it.id, it.name, it.argumentsJson)) }
                }
                messages = messages +
                    ChatMessage(Role.ASSISTANT, assistantParts, st.blocks) +
                    ChatMessage(Role.USER, records.map { Part.ToolResult(it.id, it.name, it.result, it.isError) })
                conversations.updateStreaming(reply.id, st.allText.toString(), st.thinking.toString().ifEmpty { null })
            }
        } catch (e: CancellationException) {
            st.endThinking()
            withContext(NonCancellable) { finish(reply, st, provider, model, MessageStatus.STOPPED, includeFinalBlocks = false) }
            throw e
        } catch (e: ChatException) {
            st.error = LlmError(ErrorKind.BAD_REQUEST, e.message ?: "Couldn't send this message.")
        } catch (e: LlmException) {
            st.error = e.error
        } catch (e: IOException) {
            st.error = LlmError(ErrorKind.NETWORK, "Couldn't reach ${provider.label}. Check your connection and try again.")
        } catch (e: Exception) {
            st.error = LlmError(ErrorKind.UNKNOWN, "Something went wrong: ${e.message ?: e.javaClass.simpleName}")
        }
        st.endThinking()
        val status = when {
            st.error != null -> MessageStatus.ERROR
            st.stop == StopReason.REFUSAL -> MessageStatus.REFUSED
            st.stop == StopReason.MAX_TOKENS -> MessageStatus.TRUNCATED
            st.stop == StopReason.CANCELLED -> MessageStatus.STOPPED
            else -> MessageStatus.DONE
        }
        withContext(NonCancellable) { finish(reply, st, provider, model, status, includeFinalBlocks = true) }
        if (status == MessageStatus.DONE) {
            val conv = conversations.get(conversationId)
            if (conv != null) {
                onReplyFinished?.invoke(conversationId, conv.title, st.allText.take(160).toString())
                if (!conv.titleSet && settings.synced.value.autoTitle) {
                    scope.launch { runCatching { generateTitle(conversationId) } }
                }
            }
        }
    }

    /** Runs one tool call (after approval when required) and records it. */
    private suspend fun runTool(
        call: StreamEvent.ToolCallReady,
        prepared: PreparedTools,
        st: ReplyState,
        reply: MessageEntity,
        onUpdate: () -> Unit,
    ): ToolCallRecord {
        val def = prepared.byName[call.name]
        fun update(transform: (ToolActivity) -> ToolActivity) {
            synchronized(st.activities) { st.activities[call.id]?.let { st.activities[call.id] = transform(it) } }
            onUpdate()
        }
        if (def == null) {
            val msg = "There is no tool named \"${call.name}\". Use only the tools provided."
            update { it.copy(status = ToolStatus.ERROR, result = msg) }
            return ToolCallRecord(call.id, call.name, ToolKind.MCP.name, call.name, call.argumentsJson, msg, true)
        }
        val approvedForChat = def.kind == ToolKind.COMPUTER && "${reply.conversationId}/${def.spec.name}" in chatApprovals
        if (def.needsApproval && !settings.synced.value.yoloMode && !approvedForChat) {
            update { it.copy(status = ToolStatus.AWAITING_APPROVAL) }
            val pending = CompletableDeferred<ApprovalDecision>()
            approvals[call.id] = pending
            if (settings.synced.value.yoloMode) respondToApproval(call.id, ApprovalDecision.ALLOW)
            val decision = pending.await()
            if (decision == ApprovalDecision.ALWAYS && def.kind == ToolKind.MCP) runCatching { mcpAutoApprove(def.serverId!!, def.remoteName!!) }
            // "Allow for this chat": the same PC tool runs without asking for the rest of this chat (until Facet restarts).
            if (decision == ApprovalDecision.ALWAYS && def.kind == ToolKind.COMPUTER) chatApprovals += "${reply.conversationId}/${def.spec.name}"
            if (decision == ApprovalDecision.DENY) {
                val msg = "The user declined this tool call. Don't retry it; continue without it or ask the user how to proceed."
                update { it.copy(status = ToolStatus.DENIED, result = msg) }
                return ToolCallRecord(call.id, call.name, def.kind.name, runningLabel(def, call.argumentsJson), call.argumentsJson, msg, true, serverName = def.serverName)
            }
        }
        update { it.copy(status = ToolStatus.RUNNING) }
        val start = Clock.now()
        val timeoutMs = when (def.kind) {
            ToolKind.MEDIA -> MEDIA_TOOL_TIMEOUT_MS
            ToolKind.COMPUTER -> COMPUTER_TOOL_TIMEOUT_MS
            else -> TOOL_TIMEOUT_MS
        }
        val outcome = try {
            val ctx = ToolContext(reply.conversationId, call.id) { progress -> update { it.copy(label = progress) } }
            withTimeout(timeoutMs) { tools.execute(def, call.argumentsJson, ctx) }
        } catch (e: CancellationException) {
            if (e is kotlinx.coroutines.TimeoutCancellationException) {
                ToolOutcome("The tool timed out after " + (if (timeoutMs >= 60_000) "${timeoutMs / 60_000} min." else "${timeoutMs / 1000} s."), true)
            } else throw e
        } catch (e: Exception) {
            ToolOutcome(e.message ?: "The tool failed.", true)
        }
        val result = outcome.content.let { if (it.length > ToolRegistry.MAX_RESULT_CHARS) it.take(ToolRegistry.MAX_RESULT_CHARS) + "\n\n[Output truncated.]" else it }
        synchronized(st.citations) { outcome.citations.forEach { c -> st.citations.putIfAbsent(c.url, c) } }
        synchronized(st.attachments) { st.attachments += outcome.attachments }
        val label = outcome.label ?: runningLabel(def, call.argumentsJson, done = true)
        update { it.copy(status = if (outcome.isError) ToolStatus.ERROR else ToolStatus.DONE, label = label, result = result.take(2_000)) }
        return ToolCallRecord(call.id, call.name, def.kind.name, label, call.argumentsJson, result, outcome.isError, Clock.now() - start, def.serverName)
    }

    private fun preparingLabel(kind: ToolKind?, serverName: String?, name: String) = when (kind) {
        ToolKind.SEARCH -> "Searching the web"
        ToolKind.FETCH -> "Reading a page"
        ToolKind.SKILL -> "Loading a skill"
        ToolKind.COMPUTER -> io.dtsoftware.facet.domain.tools.PcTools.label(name, "{}", done = false)
        else -> if (serverName != null) "$serverName: $name" else name
    }

    private fun runningLabel(def: io.dtsoftware.facet.domain.tools.ToolDef?, args: String, done: Boolean = false): String {
        val obj = runCatching { AppJson.parseToJsonElement(args).let { it as kotlinx.serialization.json.JsonObject } }.getOrNull()
        fun s(k: String) = (obj?.get(k) as? kotlinx.serialization.json.JsonPrimitive)?.content.orEmpty()
        return when (def?.kind) {
            ToolKind.SEARCH -> (if (done) "Searched" else "Searching") + " “${s("query").take(60)}”"
            ToolKind.FETCH -> (if (done) "Read " else "Reading ") + (runCatching { java.net.URI(s("url")).host?.removePrefix("www.") }.getOrNull() ?: "a page")
            ToolKind.SKILL -> if (s("name").isNotBlank()) (if (done) "Used skill " else "Using skill ") + s("name") else (if (done) "Read " else "Reading ") + s("path")
            ToolKind.MCP -> "${def.serverName}: ${def.remoteName}"
            ToolKind.MEDIA -> (if (done) "Created " else "Creating ") + when (def.output) {
                io.dtsoftware.facet.llm.ModelOutput.IMAGE -> "an image"
                io.dtsoftware.facet.llm.ModelOutput.VIDEO -> "a video"
                io.dtsoftware.facet.llm.ModelOutput.SPEECH -> "speech"
                io.dtsoftware.facet.llm.ModelOutput.MUSIC -> "music"
                else -> "media"
            }
            ToolKind.COMPUTER -> io.dtsoftware.facet.domain.tools.PcTools.label(def.remoteName ?: def.spec.name, args, done)
            null -> "Tool"
        }
    }

    private fun joinText(prefix: String, step: String): String = when {
        prefix.isBlank() -> step
        step.isBlank() -> prefix
        else -> prefix.trimEnd() + "\n\n" + step.trimStart()
    }

    private suspend fun finish(
        reply: MessageEntity,
        st: ReplyState,
        provider: ProviderEntity,
        model: ModelInfo,
        status: MessageStatus,
        includeFinalBlocks: Boolean,
    ) {
        val kind = ProviderKind.fromId(provider.kind)
        val served = st.servedModel.ifBlank { model.id }
        val price = if (served == model.id) model.pricing ?: pricing.priceFor(kind, served) else pricing.priceFor(kind, served)
        val usage = st.usage
        val cost = if (usage != null && price != null) pricing.cost(price, usage) else null
        val current = conversations.message(reply.id) ?: reply
        val text = st.allText.toString().ifBlank { st.stepText.toString() }
        val trace = st.steps.takeIf { it.isNotEmpty() }?.let { ToolTrace(it, st.stepText.toString()) }
        val err = st.error
        conversations.updateMessage(
            current.copy(
                content = text,
                thinking = st.thinking.toString().ifBlank { null },
                thinkingMs = st.thinkingMs.takeIf { it > 0 },
                blocksJson = if (includeFinalBlocks) st.blocks?.let { AppJson.encodeToString(it) } else null,
                citationsJson = st.citations.values.toList().takeIf { it.isNotEmpty() }?.let { AppJson.encodeToString(it) },
                modelId = served,
                modelName = if (served == model.id) model.displayName else served,
                status = status.name,
                errorJson = err?.let { AppJson.encodeToString(MessageError(it.kind.name, it.message, it.detail)) },
                usageJson = usage?.let { AppJson.encodeToString(it) },
                costUsd = cost,
                stepsJson = trace?.let { AppJson.encodeToString(it) },
                attachmentsJson = synchronized(st.attachments) { st.attachments.toList() }.takeIf { it.isNotEmpty() }
                    ?.let { AppJson.encodeToString(it) } ?: current.attachmentsJson,
            ),
        )
        conversations.update(reply.conversationId, touchActivity = true) { it }
    }

    /** Builds the provider request from the visible branch ending at [reply]'s parent. */
    private suspend fun buildRequest(conversationId: String, reply: MessageEntity, model: ModelInfo): ChatRequest {
        val conv = conversations.get(conversationId) ?: throw ChatException("This chat no longer exists.")
        val all = conversations.messages(conversationId)
        val tree = MessageTree(all)
        val path = tree.pathTo(reply.parentId ?: throw ChatException("Nothing to reply to."))
        val messages = ArrayList<ChatMessage>()
        fun add(msg: ChatMessage) {
            val last = messages.lastOrNull()
            val hasToolParts = { m: ChatMessage -> m.parts.any { it is Part.ToolCall || it is Part.ToolResult } }
            if (last != null && last.role == msg.role && !hasToolParts(last) && !hasToolParts(msg)) {
                messages[messages.lastIndex] = last.copy(parts = last.parts + msg.parts, blocks = null)
            } else {
                messages += msg
            }
        }
        for (m in path) {
            if (m.role == "user") {
                add(ChatMessage(Role.USER, userParts(m, model)))
                continue
            }
            val status = runCatching { MessageStatus.valueOf(m.status) }.getOrDefault(MessageStatus.DONE)
            if (status == MessageStatus.ERROR || status == MessageStatus.REFUSED) continue
            val trace = m.stepsJson?.let { runCatching { AppJson.decodeFromString<ToolTrace>(it) }.getOrNull() }
            val replayable = status == MessageStatus.DONE || status == MessageStatus.TRUNCATED
            val blocks = if (replayable) m.blocksJson?.let { runCatching { AppJson.decodeFromString<ProviderBlocks>(it) }.getOrNull() } else null
            if (trace != null) {
                for (step in trace.steps) {
                    val parts = buildList<Part> {
                        step.text.takeIf { it.isNotBlank() }?.let { add(Part.Text(it)) }
                        step.calls.forEach { add(Part.ToolCall(it.id, it.name, it.argumentsJson)) }
                    }
                    add(ChatMessage(Role.ASSISTANT, parts, step.blocks))
                    add(ChatMessage(Role.USER, step.calls.map { Part.ToolResult(it.id, it.name, it.result, it.isError) }))
                }
                if (trace.finalText.isNotBlank()) add(ChatMessage(Role.ASSISTANT, listOf(Part.Text(trace.finalText)), blocks))
            } else {
                if (m.content.isBlank()) continue
                add(ChatMessage(Role.ASSISTANT, listOf(Part.Text(m.content)), blocks))
            }
        }
        // A reply cut off mid-tool-loop can leave the history ending on an assistant tool call; models need a result.
        val assistant = assistants.get(conv.assistantId)
        return ChatRequest(
            model = model.id,
            system = buildSystem(conv, assistant),
            messages = messages,
            params = parseParams(conv.paramsJson),
            caps = model.caps,
            modelMaxOutput = model.maxOutput,
        )
    }

    private suspend fun userParts(m: MessageEntity, model: ModelInfo): List<Part> {
        val parts = ArrayList<Part>()
        for (ref in m.attachments()) parts += attachmentPart(ref, model)
        if (m.content.isNotBlank()) parts += Part.Text(m.content)
        if (parts.isEmpty()) parts += Part.Text("(empty message)")
        return parts
    }

    private suspend fun attachmentPart(ref: AttachmentRef, model: ModelInfo): Part {
        sync.ensureLocal(ref.id)
        val bytes = attachments.bytes(ref.id)
            ?: return Part.Text("[Attachment \"${ref.name}\" isn't available on this device yet.]")
        return when (ref.kind) {
            "image" -> if (model.caps.vision) Part.Image(ref.mimeType, bytes)
            else Part.Text("[Image \"${ref.name}\" attached, but ${model.displayName} can't view images.]")
            "pdf" -> if (model.caps.pdf) Part.Document(ref.mimeType, ref.name, bytes)
            else Part.Text("[PDF \"${ref.name}\" attached, but ${model.displayName} can't read PDFs. Try a Claude, GPT, or Gemini model.]")
            else -> {
                val content = bytes.toString(Charsets.UTF_8)
                val lang = ref.name.substringAfterLast('.', "")
                Part.Text("File: ${ref.name}\n```$lang\n$content\n```")
            }
        }
    }

    private fun buildSystem(conv: ConversationEntity, assistant: Assistant?): String {
        val prefs = settings.synced.value
        val parts = ArrayList<String>()
        assistant?.instructions?.takeIf { it.isNotBlank() }?.let(parts::add)
        parts += "Your replies are rendered as GitHub-flavored Markdown, including tables, fenced code blocks with language tags, and LaTeX math between \$…\$ or \$\$…\$\$."
        val date = Instant.ofEpochMilli(conv.createdAt).atZone(ZoneId.systemDefault()).toLocalDate()
        parts += "The conversation started on $date."
        if (prefs.customInstructionsEnabled) {
            prefs.aboutMe.takeIf { it.isNotBlank() }?.let { parts += "About the user:\n$it" }
            prefs.responseStyle.takeIf { it.isNotBlank() }?.let { parts += "How the user wants you to respond:\n$it" }
        }
        conv.systemPrompt?.takeIf { it.isNotBlank() }?.let { parts += it }
        return parts.joinToString("\n\n")
    }

    // ---- titles ----

    private suspend fun generateTitle(conversationId: String) {
        val conv = conversations.get(conversationId) ?: return
        if (conv.titleSet) return
        val path = MessageTree(conversations.messages(conversationId)).activePath(conv.currentLeafId)
        val firstUser = path.firstOrNull { it.role == "user" } ?: return
        val firstReply = path.firstOrNull { it.role == "assistant" && it.content.isNotBlank() }
        val ref = settings.synced.value.titleModel
        val provider = (ref?.providerId ?: conv.providerId)?.let { providers.get(it) }?.takeIf { !it.deleted && it.enabled } ?: return
        val modelId = if (ref != null && ref.providerId == provider.id) ref.modelId else conv.modelId ?: return
        val model = providers.modelInfo(provider, modelId)
        val transcript = buildString {
            append("User: ").append(firstUser.content.take(1500))
            if (firstUser.attachments().isNotEmpty()) append(" [with attachments: ").append(firstUser.attachments().joinToString { it.name }).append(']')
            firstReply?.let { append("\n\nAssistant: ").append(it.content.take(1500)) }
        }
        val request = ChatRequest(
            model = model.id,
            system = "You write short, specific titles for chat conversations. Reply with the title only: 2 to 6 words in the conversation's language, no quotes, no trailing punctuation, no emoji.",
            messages = listOf(ChatMessage(Role.USER, listOf(Part.Text("$transcript\n\nWrite the title.")))),
            params = GenParams(showThinking = false),
            caps = model.caps,
            utility = true,
        )
        val out = StringBuilder()
        withTimeoutOrNull(30_000) {
            providers.client(provider).stream(request).collect { ev -> if (ev is StreamEvent.TextDelta) out.append(ev.text) }
        }
        val title = out.toString().lineSequence().firstOrNull { it.isNotBlank() }.orEmpty()
            .trim().trim('"', '\'', '“', '”', '*', '#', ' ').removeSuffix(".").take(60)
        if (title.isNotBlank()) conversations.update(conversationId) { it.copy(title = title, titleSet = true) }
    }

    companion object {
        const val TOOL_TIMEOUT_MS = 130_000L
        /** Video and long music can take several minutes. */
        const val MEDIA_TOOL_TIMEOUT_MS = 12 * 60_000L
        /** A PC's commands have their own timeouts; the relay call waits up to 15 minutes (docs/REMOTE.md). */
        const val COMPUTER_TOOL_TIMEOUT_MS = 16 * 60_000L
    }
}

private operator fun Usage.plus(o: Usage) = Usage(
    inputTokens + o.inputTokens,
    outputTokens + o.outputTokens,
    cacheReadTokens + o.cacheReadTokens,
    cacheWriteTokens + o.cacheWriteTokens,
    reasoningTokens + o.reasoningTokens,
)
