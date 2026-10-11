package io.dtsoftware.facet.domain.tools

import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.AppJson
import io.dtsoftware.facet.core.util.Clock
import io.dtsoftware.facet.core.util.Ids
import io.dtsoftware.facet.data.db.FacetDatabase
import io.dtsoftware.facet.data.db.SkillEntity
import java.io.ByteArrayInputStream
import java.util.zip.ZipInputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

class SkillImportException(message: String) : Exception(message)

data class ParsedSkill(val name: String, val description: String, val body: String)

/**
 * Reads skills in the Agent Skills format: a SKILL.md with YAML frontmatter (`name`, `description`)
 * followed by Markdown instructions, optionally bundled in a .zip with reference files.
 */
object SkillParser {
    private val namePattern = Regex("^[a-z0-9][a-z0-9-]{0,63}$")

    fun parse(markdown: String, fallbackName: String = "skill"): ParsedSkill {
        val text = markdown.replace("\r\n", "\n").trimStart('﻿')
        val fm = Regex("(?s)^---\\n(.*?)\\n---\\s*\\n?(.*)$").find(text)
        val (front, body) = if (fm != null) fm.groupValues[1] to fm.groupValues[2] else "" to text
        val fields = parseFrontmatter(front)
        val heading = Regex("(?m)^#\\s+(.+)$").find(body)?.groupValues?.get(1)?.trim()
        val name = slug(fields["name"] ?: heading ?: fallbackName)
        val description = (fields["description"] ?: body.lineSequence().firstOrNull { it.isNotBlank() && !it.startsWith("#") }.orEmpty())
            .trim().take(1024)
        if (body.isBlank()) throw SkillImportException(Strings.get(R.string.skills_no_instructions))
        return ParsedSkill(name, description.ifBlank { "Use when the task matches $name." }, body.trim())
    }

    /** Minimal YAML for frontmatter: `key: value`, quoted values, and `>` / `|` block scalars. */
    internal fun parseFrontmatter(front: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        val lines = front.lines()
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val m = Regex("^([A-Za-z0-9_-]+):\\s*(.*)$").find(line)
            if (m == null) { i++; continue }
            val key = m.groupValues[1]
            var value = m.groupValues[2].trim()
            if (value == ">" || value == "|" || value == ">-" || value == "|-") {
                val folded = value.startsWith(">")
                val block = ArrayList<String>()
                i++
                while (i < lines.size && (lines[i].startsWith(" ") || lines[i].startsWith("\t") || lines[i].isBlank())) {
                    block += lines[i].trim()
                    i++
                }
                out[key] = if (folded) block.joinToString(" ").trim() else block.joinToString("\n").trim()
                continue
            }
            if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.substring(1, value.length - 1).replace("\\\"", "\"")
            }
            out[key] = value
            i++
        }
        return out
    }

    fun slug(name: String): String {
        val s = name.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').take(64)
        return if (namePattern.matches(s)) s else "skill"
    }
}

/** User skills: stored locally, synced end-to-end encrypted, loaded by models on demand. */
class SkillRepository(private val db: FacetDatabase, private val http: OkHttpClient, private val onLocalChange: () -> Unit) {
    private val dao = db.skills()

    fun observeAll(): Flow<List<SkillEntity>> = dao.observeAll()
    suspend fun all(): List<SkillEntity> = dao.all()
    suspend fun get(id: String): SkillEntity? = dao.get(id)

    suspend fun save(
        id: String?,
        name: String,
        description: String,
        instructions: String,
        resources: List<SkillResource> = emptyList(),
        enabled: Boolean = true,
        alwaysOn: Boolean = false,
        sourceUrl: String? = null,
    ): SkillEntity {
        val now = Clock.now()
        val existing = id?.let { dao.get(it) }
        val taken = dao.all().filter { it.id != existing?.id }.map { it.name }.toSet()
        var slug = SkillParser.slug(name)
        var n = 2
        while (slug in taken) slug = SkillParser.slug(name).take(60) + "-" + n++
        val e = SkillEntity(
            id = existing?.id ?: Ids.new(),
            name = slug,
            description = description.trim().take(1024),
            instructions = instructions.trim(),
            resourcesJson = AppJson.encodeToString(resources),
            enabled = enabled,
            alwaysOn = alwaysOn,
            sourceUrl = sourceUrl ?: existing?.sourceUrl,
            createdAt = existing?.createdAt ?: now,
            updatedAt = now,
        )
        dao.upsert(e)
        onLocalChange()
        return e
    }

    suspend fun setEnabled(id: String, enabled: Boolean) = mutate(id) { it.copy(enabled = enabled) }
    suspend fun setAlwaysOn(id: String, alwaysOn: Boolean) = mutate(id) { it.copy(alwaysOn = alwaysOn) }

    suspend fun delete(id: String) = mutate(id) { it.copy(deleted = true, instructions = "", resourcesJson = "[]") }

    private suspend fun mutate(id: String, transform: (SkillEntity) -> SkillEntity) {
        val e = dao.get(id) ?: return
        dao.upsert(transform(e).copy(updatedAt = Clock.now(), dirty = true))
        onLocalChange()
    }

    fun resources(e: SkillEntity): List<SkillResource> =
        runCatching { AppJson.decodeFromString<List<SkillResource>>(e.resourcesJson) }.getOrDefault(emptyList())

    suspend fun importMarkdown(markdown: String, sourceUrl: String? = null, fallbackName: String = "skill"): SkillEntity {
        val p = SkillParser.parse(markdown, fallbackName)
        return save(null, p.name, p.description, p.body, sourceUrl = sourceUrl)
    }

    /** Imports a .zip containing SKILL.md (at the root or in one folder) plus text reference files. */
    suspend fun importZip(bytes: ByteArray, sourceUrl: String? = null): SkillEntity = withContext(Dispatchers.IO) {
        val files = LinkedHashMap<String, String>()
        var total = 0
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                if (entry.isDirectory) continue
                val path = entry.name.replace('\\', '/').trimStart('/')
                if (path.contains("..") || path.startsWith("__MACOSX") || path.split('/').any { it.startsWith(".") }) continue
                val data = zip.readBytes()
                if (data.size > MAX_FILE || !isText(path, data)) continue
                total += data.size
                if (total > MAX_TOTAL) throw SkillImportException(Strings.get(R.string.skills_too_large, MAX_TOTAL / 1024))
                files[path] = data.toString(Charsets.UTF_8)
            }
        }
        val skillPath = files.keys.filter { it.substringAfterLast('/').equals("SKILL.md", ignoreCase = true) }.minByOrNull { it.count { c -> c == '/' } }
            ?: throw SkillImportException(Strings.get(R.string.skills_no_skill_md))
        val root = skillPath.substringBeforeLast('/', "")
        val prefix = if (root.isEmpty()) "" else "$root/"
        val p = SkillParser.parse(files.getValue(skillPath), root.substringAfterLast('/').ifBlank { "skill" })
        val resources = files.filterKeys { it != skillPath && it.startsWith(prefix) }
            .map { (k, v) -> SkillResource(k.removePrefix(prefix), v) }
        save(null, p.name, p.description, p.body, resources, sourceUrl = sourceUrl)
    }

    /** Imports from a URL to a SKILL.md / .md file or a .zip. GitHub "blob" links are converted to raw. */
    suspend fun importUrl(url: String): SkillEntity = withContext(Dispatchers.IO) {
        val raw = toRaw(url.trim())
        val req = Request.Builder().url(raw).header("User-Agent", "Facet").build()
        val bytes = http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw SkillImportException(Strings.get(R.string.skills_download_failed, resp.code))
            val body = resp.body.bytes()
            if (body.size > MAX_TOTAL * 4) throw SkillImportException(Strings.get(R.string.skills_file_too_large))
            body
        }
        if (raw.endsWith(".zip", ignoreCase = true) || (bytes.size > 4 && bytes[0] == 'P'.code.toByte() && bytes[1] == 'K'.code.toByte())) {
            importZip(bytes, url)
        } else {
            val name = raw.substringAfterLast('/').substringBeforeLast('.').takeUnless { it.equals("SKILL", true) }
                ?: raw.substringBeforeLast('/').substringAfterLast('/')
            importMarkdown(bytes.toString(Charsets.UTF_8), url, name)
        }
    }

    private fun toRaw(url: String): String {
        val gh = Regex("^https://github\\.com/([^/]+)/([^/]+)/blob/(.+)$").find(url)
        return if (gh != null) "https://raw.githubusercontent.com/${gh.groupValues[1]}/${gh.groupValues[2]}/${gh.groupValues[3]}" else url
    }

    private fun isText(path: String, data: ByteArray): Boolean {
        val ext = path.substringAfterLast('.', "").lowercase()
        if (ext in setOf("png", "jpg", "jpeg", "gif", "webp", "pdf", "ttf", "otf", "woff", "woff2", "zip", "gz", "jar", "so", "bin", "exe")) return false
        return data.take(4096).none { it == 0.toByte() }
    }

    companion object {
        const val MAX_FILE = 200 * 1024
        const val MAX_TOTAL = 1024 * 1024

        /** Starter skills users can add with one tap. */
        val EXAMPLES = listOf(
            ParsedSkill(
                "meeting-notes",
                "Turn rough notes or a transcript into clear meeting notes with decisions and action items. Use when the user shares meeting notes, a call transcript, or asks for a recap.",
                """
                # Meeting notes

                Produce notes with these sections, in this order:

                1. **Summary**: two or three sentences on what the meeting was for and what came out of it.
                2. **Decisions**: a bulleted list. Each decision in one line, in the past tense.
                3. **Action items**: a table with columns Owner, Task, Due. Use "Unassigned" or "No date" when the notes don't say.
                4. **Open questions**: anything raised but not resolved.

                Keep the participants' wording for decisions. Don't invent owners or dates. If the notes are too thin for a section, write "None recorded."
                """.trimIndent(),
            ),
            ParsedSkill(
                "code-review",
                "Review code changes for bugs, security issues and maintainability, with concrete fixes. Use when the user shares a diff, a pull request, or asks for a code review.",
                """
                # Code review

                Review in this order and stop to flag anything severe first:

                1. **Correctness**: logic errors, off-by-one, null handling, concurrency, error paths.
                2. **Security**: injection, secrets in code, unsafe deserialization, missing authorization checks.
                3. **Performance**: unnecessary work in loops, N+1 queries, unbounded memory.
                4. **Readability**: naming, dead code, comments that contradict the code.

                For each finding give: severity (High/Medium/Low), the file and line if known, why it matters, and a corrected snippet. End with a one-line verdict. Don't pad the review with praise.
                """.trimIndent(),
            ),
            ParsedSkill(
                "trip-planner",
                "Plan trips day by day with realistic travel times, budgets and booking tips. Use when the user asks for an itinerary, a travel plan, or what to do in a place.",
                """
                # Trip planner

                Ask at most one question if the dates, budget or interests are missing; otherwise assume sensible defaults and say what you assumed.

                Plan by neighborhood to minimize transit. For each day give morning, afternoon and evening, with walking or transit time between stops. Include one food recommendation per day, typical prices in local currency, and anything that needs booking ahead. Finish with a short packing list for the season.
                """.trimIndent(),
            ),
        )
    }
}
