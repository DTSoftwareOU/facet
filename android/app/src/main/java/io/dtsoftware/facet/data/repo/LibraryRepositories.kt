package io.dtsoftware.facet.data.repo

import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.db.AssistantEntity
import io.dtsoftware.facet.data.db.FacetDatabase
import io.dtsoftware.facet.data.db.FolderEntity
import io.dtsoftware.facet.data.db.PromptEntity
import io.dtsoftware.facet.data.parseParams
import io.dtsoftware.facet.data.prefs.ModelRef
import io.dtsoftware.facet.llm.GenParams
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/** An assistant (persona): built-in or user-made. */
data class Assistant(
    val id: String,
    val name: String,
    val emoji: String?,
    val iconRes: Int?,
    val colorIndex: Int,
    val instructions: String,
    val model: ModelRef?,
    val params: GenParams?,
    val starters: List<String>,
    val builtin: Boolean,
)

object BuiltinAssistants {
    const val DEFAULT_ID = "builtin.facet"

    val all: List<Assistant> = listOf(
        Assistant(
            DEFAULT_ID, "Facet", null, R.drawable.ic_gem, 0, "", null, null,
            listOf(
                "Explain how HTTPS keeps a connection private",
                "Plan a 3-day trip to Lisbon on a modest budget",
                "Help me write a polite follow-up email",
                "What should I know before adopting a cat?",
            ),
            builtin = true,
        ),
        Assistant(
            "builtin.code", "Code", null, R.drawable.ic_code, 1,
            """
            You are a senior software engineer pairing with the user.
            Write correct, idiomatic, production-quality code and keep explanations short and concrete.
            Always use fenced code blocks with a language tag. When changing existing code, show only what changes unless asked for the full file.
            Point out bugs, security issues, and edge cases you notice. If requirements are ambiguous, state your assumption briefly and proceed.
            """.trimIndent(),
            null, null,
            listOf(
                "Review this function for bugs",
                "Write a Kotlin coroutine that retries with backoff",
                "Explain the difference between a mutex and a semaphore",
                "Convert this Python script to TypeScript",
            ),
            builtin = true,
        ),
        Assistant(
            "builtin.writer", "Writer", null, R.drawable.ic_writer, 2,
            """
            You are an experienced editor and writer.
            Match the user's voice and audience. Prefer plain, specific language over filler. When editing, keep the meaning, tighten the prose, and briefly list the main changes.
            When drafting, ask at most one clarifying question if the goal is unclear; otherwise write a strong first draft.
            """.trimIndent(),
            null, null,
            listOf(
                "Tighten this paragraph without changing its meaning",
                "Draft a short bio for a conference talk",
                "Make this message sound warmer but still professional",
                "Give me five title ideas for this article",
            ),
            builtin = true,
        ),
        Assistant(
            "builtin.tutor", "Tutor", null, R.drawable.ic_tutor, 3,
            """
            You are a patient tutor. Teach for understanding, not just answers.
            Start from what the learner knows, explain one idea at a time with a small example, and check understanding with a short question.
            For exercises, guide with hints before giving the full solution unless the learner asks for it. Use LaTeX for math.
            """.trimIndent(),
            null, null,
            listOf(
                "Teach me derivatives from scratch",
                "Quiz me on Spanish past tense verbs",
                "Why does the moon have phases?",
                "Walk me through how a neural network learns",
            ),
            builtin = true,
        ),
        Assistant(
            "builtin.translator", "Translator", null, R.drawable.ic_languages, 4,
            """
            You are a professional translator. Detect the source language automatically.
            If the user names a target language, translate into it; otherwise translate into English, or from English into the language the user last asked for.
            Preserve meaning, tone, formatting, and Markdown. Output only the translation unless the user asks for notes; add a brief note only when a phrase has no direct equivalent.
            """.trimIndent(),
            null, null,
            listOf(
                "Translate to Spanish: Where is the nearest train station?",
                "Translate this email into formal Japanese",
                "What does \"saudade\" mean?",
                "Translate to French and keep the formatting",
            ),
            builtin = true,
        ),
        Assistant(
            "builtin.analyst", "Analyst", null, R.drawable.ic_analyst, 5,
            """
            You are a rigorous analyst. Structure answers: the conclusion first, then the reasoning and the evidence.
            Show calculations, state assumptions and uncertainty explicitly, and use tables when comparing options. Distinguish facts from estimates.
            """.trimIndent(),
            null, null,
            listOf(
                "Compare renting vs buying with these numbers",
                "Summarize the key risks in this plan",
                "Build a simple unit economics model for a coffee shop",
                "What's the expected value of this decision?",
            ),
            builtin = true,
        ),
    )

    fun byId(id: String?): Assistant? = all.firstOrNull { it.id == id }
}

class AssistantRepository(private val db: FacetDatabase, private val onLocalChange: () -> Unit) {
    private val dao = db.assistants()

    fun observeAll(): Flow<List<Assistant>> = dao.observeAll().map { custom -> BuiltinAssistants.all + custom.map { it.toAssistant() } }

    suspend fun get(id: String?): Assistant? {
        if (id == null) return null
        return BuiltinAssistants.byId(id) ?: dao.get(id)?.takeIf { !it.deleted }?.toAssistant()
    }

    suspend fun save(
        id: String?,
        name: String,
        emoji: String,
        colorIndex: Int,
        instructions: String,
        model: ModelRef?,
        params: GenParams?,
        starters: List<String>,
    ): String {
        val now = Clock.now()
        val existing = id?.let { dao.get(it) }
        val entity = AssistantEntity(
            id = existing?.id ?: Ids.new(),
            name = name.trim().ifEmpty { "Assistant" },
            emoji = emoji.ifBlank { "✨" },
            colorIndex = colorIndex,
            instructions = instructions.trim(),
            providerId = model?.providerId,
            modelId = model?.modelId,
            paramsJson = params?.let { AppJson.encodeToString(it) },
            startersJson = AppJson.encodeToString(starters.map { it.trim() }.filter { it.isNotEmpty() }),
            sort = existing?.sort ?: 100,
            createdAt = existing?.createdAt ?: now,
            updatedAt = now,
        )
        dao.upsert(entity)
        onLocalChange()
        return entity.id
    }

    suspend fun delete(id: String) {
        val e = dao.get(id) ?: return
        dao.upsert(e.copy(deleted = true, dirty = true, instructions = "", updatedAt = Clock.now()))
        onLocalChange()
    }

    private fun AssistantEntity.toAssistant() = Assistant(
        id = id,
        name = name,
        emoji = emoji,
        iconRes = null,
        colorIndex = colorIndex,
        instructions = instructions,
        model = if (providerId != null && modelId != null) ModelRef(providerId, modelId) else null,
        params = paramsJson?.let { parseParams(it) },
        starters = runCatching { AppJson.decodeFromString<List<String>>(startersJson) }.getOrDefault(emptyList()),
        builtin = false,
    )
}

class FolderRepository(private val db: FacetDatabase, private val onLocalChange: () -> Unit) {
    private val dao = db.folders()

    fun observeAll(): Flow<List<FolderEntity>> = dao.observeAll()

    suspend fun save(id: String?, name: String, colorIndex: Int): String {
        val now = Clock.now()
        val existing = id?.let { dao.get(it) }
        val e = FolderEntity(
            id = existing?.id ?: Ids.new(),
            name = name.trim().ifEmpty { "Folder" },
            colorIndex = colorIndex,
            sort = existing?.sort ?: 0,
            createdAt = existing?.createdAt ?: now,
            updatedAt = now,
        )
        dao.upsert(e)
        onLocalChange()
        return e.id
    }

    suspend fun delete(id: String) {
        val e = dao.get(id) ?: return
        dao.upsert(e.copy(deleted = true, dirty = true, updatedAt = Clock.now()))
        onLocalChange()
    }
}

class PromptRepository(private val db: FacetDatabase, private val onLocalChange: () -> Unit) {
    private val dao = db.prompts()

    fun observeAll(): Flow<List<PromptEntity>> = dao.observeAll()

    suspend fun save(id: String?, title: String, body: String): String {
        val now = Clock.now()
        val existing = id?.let { dao.get(it) }
        val e = PromptEntity(
            id = existing?.id ?: Ids.new(),
            title = title.trim().ifEmpty { body.take(40) },
            body = body,
            createdAt = existing?.createdAt ?: now,
            updatedAt = now,
        )
        dao.upsert(e)
        onLocalChange()
        return e.id
    }

    suspend fun delete(id: String) {
        val e = dao.get(id) ?: return
        dao.upsert(e.copy(deleted = true, dirty = true, body = "", updatedAt = Clock.now()))
        onLocalChange()
    }
}
