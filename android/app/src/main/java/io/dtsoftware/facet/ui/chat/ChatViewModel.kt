package io.dtsoftware.facet.ui.chat

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.data.MessageTree
import io.dtsoftware.facet.data.db.AttachmentEntity
import io.dtsoftware.facet.data.db.ConversationEntity
import io.dtsoftware.facet.data.db.MessageEntity
import io.dtsoftware.facet.data.parseParams
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.data.repo.Assistant
import io.dtsoftware.facet.data.repo.BuiltinAssistants
import io.dtsoftware.facet.data.repo.ProviderModels
import io.dtsoftware.facet.domain.ChatException
import io.dtsoftware.facet.domain.LiveTurn
import io.dtsoftware.facet.domain.NewChatSpec
import io.dtsoftware.facet.llm.GenParams
import io.dtsoftware.facet.llm.ModelInfo
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.remote.AgentImport
import io.dtsoftware.facet.remote.CodingAgent
import io.dtsoftware.facet.remote.RemoteHost
import io.dtsoftware.facet.remote.RemoteHosts
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** One visible message in the selected branch, with its branch position and live overlay. */
data class ThreadItem(
    val message: MessageEntity,
    val live: LiveTurn?,
    val siblingIds: List<String>,
    val siblingIndex: Int,
)

/** The model selected for the current (or next) chat. */
data class ModelChoice(
    val providerId: String,
    val providerLabel: String,
    val kind: ProviderKind,
    val model: ModelInfo,
)

data class ChatUiState(
    val conversation: ConversationEntity? = null,
    val thread: List<ThreadItem> = emptyList(),
    val generating: Boolean = false,
    val model: ModelChoice? = null,
    val assistant: Assistant = BuiltinAssistants.all.first(),
    val params: GenParams = GenParams(),
    val catalog: List<ProviderModels> = emptyList(),
    val cost: Double = 0.0,
    val loaded: Boolean = false,
    /** A BYOK search backend is configured (lets tool-capable models search). */
    val searchAvailable: Boolean = false,
    val mcpServers: List<io.dtsoftware.facet.data.db.McpServerEntity> = emptyList(),
    val skillCount: Int = 0,
    val pc: PcState = PcState(),
)

/**
 * The PCs this device can use, and the one this chat (or the new chat being written) works on: the PC it
 * chose, or for a chat that hasn't chosen, the one online now ([RemoteHosts.pickAutomatic]).
 * Nothing PC-related shows unless a PC is online or the chat chose one.
 */
data class PcState(
    /** Online PCs, with or without remote use switched on. */
    val hosts: List<RemoteHost> = emptyList(),
    /** The chat's stored PC: a hostId, null (automatic) or [RemoteHosts.NO_PC]. */
    val hostId: String? = null,
    /** The chat's folder on that PC, if one was picked. */
    val folder: String? = null,
    /** The PC the chat uses now, when it's online: the chosen one, or the automatic one. */
    val host: RemoteHost? = null,
    /** That PC's name, also when a chosen PC is offline (null if this device never saw it). */
    val name: String? = null,
) {
    /** The chat said "Don't use a PC". */
    val off: Boolean get() = hostId == RemoteHosts.NO_PC
    /** The chat chose a PC. */
    val bound: Boolean get() = hostId != null && !off
    /** The chat uses a PC now: one it chose (online or not), or an online one automatically. */
    val usesPc: Boolean get() = bound || (!off && host != null)
    val visible: Boolean get() = hosts.isNotEmpty() || bound
    /** The chat's PC is online and lets this device use it. */
    val ready: Boolean get() = host?.remote == true
    /** The folder tools run in: the chat's, else the PC's default. */
    val workingFolder: String? get() = (if (bound) folder else null) ?: host?.defaultFolder

    /** The PC that folder and session commands act on: the chat's PC when it's ready. */
    val target: RemoteHost?
        get() = host?.takeIf { it.remote }
}

/** Draft state for a chat that hasn't been sent yet. */
private data class NewChatDraft(
    val assistantId: String = BuiltinAssistants.DEFAULT_ID,
    val model: ModelRef? = null,
    val params: GenParams? = null,
    val computerHost: String? = null,
    val computerFolder: String? = null,
)

class ChatViewModel(private val c: AppContainer) : ViewModel() {
    private val conversationId = MutableStateFlow<String?>(null)
    private val newDraft = MutableStateFlow(NewChatDraft())

    private val _attachments = MutableStateFlow<List<AttachmentEntity>>(emptyList())
    val attachments: StateFlow<List<AttachmentEntity>> = _attachments.asStateFlow()

    private val _events = MutableSharedFlow<ChatEvent>(extraBufferCapacity = 8)
    val events: SharedFlow<ChatEvent> = _events.asSharedFlow()

    val currentId: StateFlow<String?> = conversationId.asStateFlow()

    private val conversationFlow = conversationId.flatMapLatest { id -> if (id == null) flowOf(null) else c.conversations.observeConversation(id) }
    private val messagesFlow = conversationId.flatMapLatest { id -> if (id == null) flowOf(emptyList()) else c.conversations.observeMessages(id) }
    private val costFlow = conversationId.flatMapLatest { id -> if (id == null) flowOf(0.0) else c.conversations.observeCost(id) }

    private val toolsFlow = combine(
        c.providers.observeAll(),
        c.mcp.observeAll(),
        c.skills.observeAll(),
    ) { providers, servers, skills ->
        Triple(providers.any { it.enabled && io.dtsoftware.facet.domain.tools.SearchKind.isSearch(it.kind) }, servers.filter { it.enabled }, skills.count { it.enabled })
    }

    private val baseState: StateFlow<ChatUiState> = combine(
        combine(conversationFlow, messagesFlow, c.chat.live, c.chat.active, costFlow) { conv, msgs, live, active, cost ->
            Quint(conv, msgs, live, active, cost)
        },
        c.providers.observeCatalog(),
        c.assistants.observeAll(),
        newDraft,
        c.settings.synced,
    ) { q, catalog, assistants, draft, synced ->
        val conv = q.conv?.takeIf { !it.deleted }
        val tree = MessageTree(q.msgs)
        val path = tree.activePath(conv?.currentLeafId)
        val thread = path.map { m ->
            val sibs = tree.siblings(m)
            ThreadItem(m, q.live[m.id], sibs.map { it.id }, sibs.indexOfFirst { it.id == m.id }.coerceAtLeast(0))
        }
        val assistantId = conv?.assistantId ?: draft.assistantId
        val assistant = assistants.firstOrNull { it.id == assistantId } ?: BuiltinAssistants.all.first()
        val ref = when {
            conv?.providerId != null && conv.modelId != null -> ModelRef(conv.providerId, conv.modelId)
            else -> draft.model ?: defaultModel(catalog, assistant, synced.defaultModel)
        }
        val choice = ref?.let { r ->
            catalog.firstOrNull { it.provider.id == r.providerId }?.let { pm ->
                val info = pm.models.firstOrNull { it.id == r.modelId } ?: ModelInfo(r.modelId, r.modelId)
                ModelChoice(pm.provider.id, pm.provider.label, pm.kind, info)
            }
        }
        val params = if (conv != null) parseParams(conv.paramsJson) else draft.params ?: assistant.params ?: synced.defaultParams
        ChatUiState(
            conversation = conv,
            thread = thread,
            generating = conv != null && conv.id in q.active,
            model = choice,
            assistant = assistant,
            params = params,
            catalog = catalog,
            cost = q.cost,
            loaded = true,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ChatUiState())

    val state: StateFlow<ChatUiState> = combine(baseState, toolsFlow, c.remote.hosts, c.remote.knownNames, newDraft) { s, (search, servers, skills), hosts, names, draft ->
        val conv = s.conversation
        val hostId = if (conv != null) conv.computerHost else draft.computerHost
        // A chat that hasn't chosen a PC uses the one online now.
        val using = when (hostId) {
            null -> c.remote.automatic(hosts)?.hostId
            RemoteHosts.NO_PC -> null
            else -> hostId
        }
        val pc = PcState(
            hosts = hosts.values.sortedBy { it.name.lowercase() },
            hostId = hostId,
            folder = if (conv != null) conv.computerFolder else draft.computerFolder,
            host = using?.let { hosts[it] },
            name = using?.let { hosts[it]?.name ?: names[it] },
        )
        s.copy(searchAvailable = search, mcpServers = servers, skillCount = skills, pc = pc)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ChatUiState())

    private data class Quint(
        val conv: ConversationEntity?,
        val msgs: List<MessageEntity>,
        val live: Map<String, LiveTurn>,
        val active: Set<String>,
        val cost: Double,
    )

    private fun defaultModel(catalog: List<ProviderModels>, assistant: Assistant, synced: ModelRef?): ModelRef? {
        // A saved choice counts only if its provider is on and the model isn't hidden.
        fun valid(r: ModelRef?) = r?.takeIf { ref ->
            catalog.any { pm ->
                pm.provider.id == ref.providerId && ref.modelId !in pm.hidden &&
                    (pm.models.isEmpty() || pm.models.any { it.id == ref.modelId })
            }
        }
        val local = c.settings.local.value
        return valid(assistant.model)
            ?: valid(synced)
            ?: valid(if (local.lastProviderId != null && local.lastModelId != null) ModelRef(local.lastProviderId, local.lastModelId) else null)
            ?: catalog.firstNotNullOfOrNull { pm ->
                val visible = pm.models.filter { it.id !in pm.hidden }
                val fav = visible.firstOrNull { it.id in pm.favorites } ?: visible.firstOrNull()
                fav?.let { ModelRef(pm.provider.id, it.id) }
            }
    }

    // ---- navigation ----

    fun open(id: String) {
        if (conversationId.value == id) return
        conversationId.value = id
        clearDraftAttachments()
    }

    fun newChat(assistantId: String? = null) {
        conversationId.value = null
        newDraft.value = NewChatDraft(assistantId = assistantId ?: BuiltinAssistants.DEFAULT_ID)
    }

    // ---- composer ----

    fun send(text: String): Boolean {
        val s = state.value
        if (text.isBlank() && _attachments.value.isEmpty()) return false
        if (s.generating) return false
        val model = s.model ?: run {
            _events.tryEmit(ChatEvent.Message(Strings.get(R.string.chat_error_no_model)))
            return false
        }
        val atts = _attachments.value
        _attachments.value = emptyList()
        viewModelScope.launch {
            try {
                val spec = if (s.conversation == null) {
                    NewChatSpec(
                        s.assistant.id, ModelRef(model.providerId, model.model.id), s.params,
                        computerHost = s.pc.hostId, computerFolder = s.pc.folder,
                    )
                } else {
                    null
                }
                val id = c.chat.send(s.conversation?.id, text, atts.map { it.id }, spec)
                if (conversationId.value == null) conversationId.value = id
                _events.emit(ChatEvent.Sent)
            } catch (e: ChatException) {
                _events.emit(ChatEvent.Message(e.message ?: Strings.get(R.string.chat_error_send)))
                _attachments.value = atts
            }
        }
        return true
    }

    fun stop() {
        state.value.conversation?.id?.let { c.chat.stop(it) }
    }

    fun addAttachments(uris: List<Uri>) {
        viewModelScope.launch {
            for (uri in uris.take(10)) {
                runCatching { c.attachments.import(uri) }
                    .onSuccess { a -> _attachments.update { it + a } }
                    .onFailure { _events.emit(ChatEvent.Message(it.message ?: Strings.get(R.string.chat_error_attach))) }
            }
        }
    }

    fun removeAttachment(id: String) {
        _attachments.update { list -> list.filterNot { it.id == id } }
        viewModelScope.launch { c.attachments.discardDraft(id) }
    }

    private fun clearDraftAttachments() {
        val drafts = _attachments.value
        _attachments.value = emptyList()
        viewModelScope.launch { drafts.forEach { c.attachments.discardDraft(it.id) } }
    }

    // ---- model & params ----

    fun selectModel(ref: ModelRef) {
        val conv = state.value.conversation
        if (conv != null) {
            viewModelScope.launch { c.conversations.setModel(conv.id, ref.providerId, ref.modelId) }
        } else {
            newDraft.update { it.copy(model = ref) }
        }
        c.settings.updateLocal { it.copy(lastProviderId = ref.providerId, lastModelId = ref.modelId) }
    }

    fun updateParams(params: GenParams) {
        val conv = state.value.conversation
        if (conv != null) {
            viewModelScope.launch { c.conversations.setParams(conv.id, params) }
        } else {
            newDraft.update { it.copy(params = params) }
        }
    }

    fun setSystemPrompt(prompt: String) {
        val conv = state.value.conversation ?: return
        viewModelScope.launch { c.conversations.setSystemPrompt(conv.id, prompt) }
    }

    // ---- PC ----

    /**
     * Binds the chat to [hostId] and [folder] on it, to no PC ([RemoteHosts.NO_PC]), or back to automatic (null).
     * A new chat gets them when it's created.
     */
    fun setPc(hostId: String?, folder: String?) {
        hostId?.let { c.remote.markUsed(it) }
        val conv = state.value.conversation
        if (conv != null) {
            viewModelScope.launch { c.conversations.setComputer(conv.id, hostId, folder) }
        } else {
            newDraft.update { it.copy(computerHost = hostId, computerFolder = folder?.takeIf { hostId != null }) }
        }
    }

    /**
     * Continues a Claude Code or Codex session: a new chat with its messages, on the same PC and folder,
     * with the composer's model, which then opens. Throws [io.dtsoftware.facet.remote.RemoteException] or
     * [IllegalArgumentException] with a message for the user.
     */
    suspend fun continueSession(agent: CodingAgent, hostId: String, folder: String, sessionId: String): Boolean {
        val session = c.remote.readAgentSession(hostId, agent.id, folder, sessionId)
        val s = state.value
        val (conversation, messages) = AgentImport.build(
            session, agent, hostId, folder,
            s.model?.let { ModelRef(it.providerId, it.model.id) }, s.params, io.dtsoftware.facet.core.util.Clock.now(),
        )
        c.conversations.insertWithMessages(conversation, messages)
        conversationId.value = conversation.id
        clearDraftAttachments()
        return session.truncated
    }

    // ---- message actions ----

    fun regenerate(messageId: String, ref: ModelRef? = null) = launchCatching { c.chat.regenerate(messageId, ref) }
    fun edit(messageId: String, text: String) = launchCatching { c.chat.editAndResend(messageId, text) }
    fun continueReply() = state.value.conversation?.id?.let { id -> launchCatching { c.chat.continueReply(id) } }
    fun switchBranch(siblingId: String) = state.value.conversation?.id?.let { id -> launchCatching { c.chat.switchBranch(id, siblingId) } }
    fun deleteMessage(message: MessageEntity) = launchCatching { c.conversations.deleteMessage(message) }

    fun rename(title: String) = state.value.conversation?.id?.let { id -> launchCatching { c.conversations.rename(id, title) } }
    fun togglePin() = state.value.conversation?.let { conv -> launchCatching { c.conversations.setPinned(conv.id, !conv.pinned) } }

    fun deleteConversation() {
        val id = state.value.conversation?.id ?: return
        c.chat.stop(id)
        newChat()
        launchCatching { c.conversations.delete(id) }
    }

    fun exportMarkdown(): String? {
        val s = state.value
        val conv = s.conversation ?: return null
        val you = Strings.get(R.string.chat_export_you)
        val assistant = Strings.get(R.string.chat_export_assistant)
        return buildString {
            append("# ").append(conv.title).append("\n\n")
            s.thread.forEach { item ->
                val m = item.message
                append("**").append(if (m.role == "user") you else m.modelName ?: assistant).append("**\n\n")
                append(m.content.trim()).append("\n\n---\n\n")
            }
        }
    }

    fun exportJson(): String? {
        val s = state.value
        val conv = s.conversation ?: return null
        val json = kotlinx.serialization.json.buildJsonObject {
            put("title", kotlinx.serialization.json.JsonPrimitive(conv.title))
            put("createdAt", kotlinx.serialization.json.JsonPrimitive(conv.createdAt))
            put(
                "messages",
                kotlinx.serialization.json.buildJsonArray {
                    s.thread.forEach { item ->
                        add(
                            kotlinx.serialization.json.buildJsonObject {
                                put("role", kotlinx.serialization.json.JsonPrimitive(item.message.role))
                                item.message.modelId?.let { put("model", kotlinx.serialization.json.JsonPrimitive(it)) }
                                put("content", kotlinx.serialization.json.JsonPrimitive(item.message.content))
                                put("createdAt", kotlinx.serialization.json.JsonPrimitive(item.message.createdAt))
                            },
                        )
                    }
                },
            )
        }
        return AppJson.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), json)
    }

    private fun launchCatching(block: suspend () -> Unit) = viewModelScope.launch {
        try {
            block()
        } catch (e: ChatException) {
            _events.emit(ChatEvent.Message(e.message ?: Strings.get(R.string.chat_error_generic)))
        }
    }

    suspend fun thumbnail(id: String, px: Int) = c.attachments.thumbnail(id, px)
}

sealed interface ChatEvent {
    data object Sent : ChatEvent
    data class Message(val text: String) : ChatEvent
}
