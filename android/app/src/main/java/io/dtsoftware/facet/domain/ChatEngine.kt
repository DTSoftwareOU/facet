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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

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
    val startedAt: Long = Clock.now(),
)

/** What a brand-new chat starts with. */
data class NewChatSpec(val assistantId: String?, val model: ModelRef, val params: GenParams, val folderId: String? = null)

class ChatException(message: String) : Exception(message)

/**
 * Orchestrates conversations: builds provider requests from the visible branch, streams the
 * reply into [live], persists the result, computes cost, and titles new chats.
 * Generations run in the application scope so they survive leaving the screen.
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
) {
    private val _live = MutableStateFlow<Map<String, LiveTurn>>(emptyMap())
    val live: StateFlow<Map<String, LiveTurn>> = _live.asStateFlow()

    private val _active = MutableStateFlow<Set<String>>(emptySet())
    /** Conversation ids with a generation in progress. */
    val active: StateFlow<Set<String>> = _active.asStateFlow()

    /** Emits (conversationId, title, preview) when a reply finishes; used for notifications. */
    var onReplyFinished: ((conversationId: String, title: String, preview: String) -> Unit)? = null

    private val jobs = ConcurrentHashMap<String, Job>()

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

    // ---- public actions ----

    /** Sends a user message. Creates the conversation when [conversationId] is null. Returns the conversation id. */
    suspend fun send(conversationId: String?, text: String, attachmentIds: List<String>, newChat: NewChatSpec?): String {
        val conv = conversationId?.let { conversations.get(it) }
            ?: newChat?.let { spec ->
                conversations.create(spec.assistantId, spec.model.providerId, spec.model.modelId, spec.params, spec.folderId)
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
        val job = scope.launch {
            try {
                generate(conversationId, reply, provider, model)
            } finally {
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

    private suspend fun generate(conversationId: String, reply: MessageEntity, provider: ProviderEntity, model: ModelInfo) {
        val text = StringBuilder()
        val thinking = StringBuilder()
        var thinkingStart: Long? = null
        var thinkingMs = 0L
        var usage: Usage? = null
        var blocks: ProviderBlocks? = null
        var stop: StopReason? = null
        var error: LlmError? = null
        val citations = LinkedHashMap<String, Citation>()
        var servedModel = model.id
        var lastPersist = 0L

        fun endThinking() {
            thinkingStart?.let { thinkingMs += Clock.now() - it }
            thinkingStart = null
        }

        fun publish(transform: (LiveTurn) -> LiveTurn) {
            _live.update { map -> map[reply.id]?.let { map + (reply.id to transform(it)) } ?: map }
        }

        try {
            val request = buildRequest(conversationId, reply, model)
            providers.client(provider).stream(request).collect { ev ->
                when (ev) {
                    is StreamEvent.Started -> servedModel = ev.model
                    is StreamEvent.TextDelta -> {
                        if (thinkingStart != null) endThinking()
                        text.append(ev.text)
                        publish { it.copy(text = text.toString(), thinkingActive = false, thinkingMs = thinkingMs, searching = false) }
                    }
                    is StreamEvent.ThinkingDelta -> {
                        if (thinkingStart == null) thinkingStart = Clock.now()
                        thinking.append(ev.text)
                        publish { it.copy(thinking = thinking.toString(), thinkingActive = true, thinkingStartedAt = it.thinkingStartedAt ?: thinkingStart) }
                    }
                    StreamEvent.ThinkingStarted -> {
                        if (thinkingStart == null) thinkingStart = Clock.now()
                        publish { it.copy(thinkingActive = true, thinkingStartedAt = it.thinkingStartedAt ?: thinkingStart) }
                    }
                    StreamEvent.ThinkingEnded -> {
                        endThinking()
                        publish { it.copy(thinkingActive = false, thinkingMs = thinkingMs) }
                    }
                    is StreamEvent.WebSearch -> publish {
                        it.copy(
                            searching = !ev.done,
                            searchQuery = ev.query ?: it.searchQuery,
                            searchCount = if (!ev.done) it.searchCount + 1 else it.searchCount,
                        )
                    }
                    is StreamEvent.Citations -> {
                        ev.citations.forEach { c -> citations.putIfAbsent(c.url, c) }
                        publish { it.copy(citations = citations.values.toList()) }
                    }
                    is StreamEvent.UsageUpdate -> usage = ev.usage
                    is StreamEvent.Notice -> publish { it.copy(notice = ev.text) }
                    is StreamEvent.Completed -> {
                        stop = ev.stopReason
                        blocks = ev.blocks
                        ev.blocks?.model?.takeIf { it.isNotBlank() }?.let { servedModel = it }
                    }
                    is StreamEvent.Failed -> error = ev.error
                }
                val now = Clock.now()
                if (now - lastPersist > 1_000) {
                    lastPersist = now
                    conversations.updateStreaming(reply.id, text.toString(), thinking.toString().ifEmpty { null })
                }
            }
        } catch (e: CancellationException) {
            endThinking()
            withContext(NonCancellable) {
                finish(reply, text, thinking, thinkingMs, usage, null, citations.values.toList(), servedModel, provider, model, MessageStatus.STOPPED, null)
            }
            throw e
        } catch (e: ChatException) {
            error = LlmError(ErrorKind.BAD_REQUEST, e.message ?: "Couldn't send this message.")
        } catch (e: LlmException) {
            error = e.error
        } catch (e: IOException) {
            error = LlmError(ErrorKind.NETWORK, "Couldn't reach ${provider.label}. Check your connection and try again.")
        } catch (e: Exception) {
            error = LlmError(ErrorKind.UNKNOWN, "Something went wrong: ${e.message ?: e.javaClass.simpleName}")
        }
        endThinking()
        val status = when {
            error != null -> MessageStatus.ERROR
            stop == StopReason.REFUSAL -> MessageStatus.REFUSED
            stop == StopReason.MAX_TOKENS -> MessageStatus.TRUNCATED
            stop == StopReason.CANCELLED -> MessageStatus.STOPPED
            else -> MessageStatus.DONE
        }
        withContext(NonCancellable) {
            finish(reply, text, thinking, thinkingMs, usage, blocks, citations.values.toList(), servedModel, provider, model, status, error)
        }
        if (status == MessageStatus.DONE) {
            val conv = conversations.get(conversationId)
            if (conv != null) {
                onReplyFinished?.invoke(conversationId, conv.title, text.take(160).toString())
                if (!conv.titleSet && settings.synced.value.autoTitle) {
                    scope.launch { runCatching { generateTitle(conversationId) } }
                }
            }
        }
    }

    private suspend fun finish(
        reply: MessageEntity,
        text: CharSequence,
        thinking: CharSequence,
        thinkingMs: Long,
        usage: Usage?,
        blocks: ProviderBlocks?,
        citations: List<Citation>,
        servedModel: String,
        provider: ProviderEntity,
        model: ModelInfo,
        status: MessageStatus,
        error: LlmError?,
    ) {
        val kind = ProviderKind.fromId(provider.kind)
        val price = if (servedModel == model.id) model.pricing ?: pricing.priceFor(kind, servedModel) else pricing.priceFor(kind, servedModel)
        val cost = if (usage != null && price != null) pricing.cost(price, usage) else null
        val current = conversations.message(reply.id) ?: reply
        conversations.updateMessage(
            current.copy(
                content = text.toString(),
                thinking = thinking.toString().ifBlank { null },
                thinkingMs = thinkingMs.takeIf { it > 0 },
                blocksJson = blocks?.let { AppJson.encodeToString(it) },
                citationsJson = citations.takeIf { it.isNotEmpty() }?.let { AppJson.encodeToString(it) },
                modelId = servedModel,
                modelName = if (servedModel == model.id) model.displayName else servedModel,
                status = status.name,
                errorJson = error?.let { AppJson.encodeToString(MessageError(it.kind.name, it.message, it.detail)) },
                usageJson = usage?.let { AppJson.encodeToString(it) },
                costUsd = cost,
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
        for (m in path) {
            val msg = when (m.role) {
                "user" -> ChatMessage(Role.USER, userParts(m, model))
                else -> {
                    val status = runCatching { MessageStatus.valueOf(m.status) }.getOrDefault(MessageStatus.DONE)
                    if (m.content.isBlank() || status == MessageStatus.ERROR || status == MessageStatus.REFUSED) continue
                    val replayable = status == MessageStatus.DONE || status == MessageStatus.TRUNCATED
                    val blocks = if (replayable) m.blocksJson?.let { runCatching { AppJson.decodeFromString<ProviderBlocks>(it) }.getOrNull() } else null
                    ChatMessage(Role.ASSISTANT, listOf(Part.Text(m.content)), blocks)
                }
            }
            val last = messages.lastOrNull()
            if (last != null && last.role == msg.role) {
                messages[messages.lastIndex] = last.copy(parts = last.parts + msg.parts, blocks = null)
            } else {
                messages += msg
            }
        }
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
}
