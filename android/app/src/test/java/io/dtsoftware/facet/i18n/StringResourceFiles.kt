package io.dtsoftware.facet.i18n

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

/** A <string> or <plurals> resource as Android reads it (escapes resolved, whitespace collapsed). */
sealed class StringResource {
    abstract val name: String
    abstract val translatable: Boolean

    data class Text(override val name: String, val text: String, override val translatable: Boolean) : StringResource()

    data class Plural(override val name: String, val items: Map<String, String>, override val translatable: Boolean) : StringResource()
}

/** Reads the app's string resources straight from src/main/res, for tests without Android. */
object StringResourceFiles {
    /** src/main/res, from the app module (Gradle's working directory) or the project root. */
    val resDir: File by lazy {
        listOf(File("src/main/res"), File("app/src/main/res")).firstOrNull { File(it, "values/strings.xml").isFile }
            ?: error("Can't find src/main/res from ${File(".").absolutePath}")
    }

    /** Every string and plural defined in res/[folder] (e.g. "values", "values-de"), by name. */
    fun load(folder: String): Map<String, StringResource> {
        val dir = File(resDir, folder)
        val out = LinkedHashMap<String, StringResource>()
        dir.listFiles { f -> f.name.endsWith(".xml") }.orEmpty().sortedBy { it.name }.forEach { file ->
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
            val root = doc.documentElement
            for (i in 0 until root.childNodes.length) {
                val el = root.childNodes.item(i) as? Element ?: continue
                val name = el.getAttribute("name")
                val translatable = el.getAttribute("translatable") != "false"
                val res = when (el.tagName) {
                    "string" -> StringResource.Text(name, decode(el.textContent), translatable)
                    "plurals" -> {
                        val items = LinkedHashMap<String, String>()
                        val list = el.getElementsByTagName("item")
                        for (j in 0 until list.length) {
                            val item = list.item(j) as Element
                            items[item.getAttribute("quantity")] = decode(item.textContent)
                        }
                        StringResource.Plural(name, items, translatable)
                    }
                    else -> null
                } ?: continue
                check(out.put(name, res) == null) { "$folder: $name is defined twice" }
            }
        }
        return out
    }

    /** Android's string rules: whitespace runs collapse outside "double quotes"; \n, \t, \', \", \\, \@, \?, \uXXXX. */
    fun decode(raw: String): String {
        val sb = StringBuilder()
        var quoted = false
        var space = false
        var i = 0
        while (i < raw.length) {
            val ch = raw[i]
            when {
                ch == '\\' && i + 1 < raw.length -> {
                    val next = raw[i + 1]
                    when (next) {
                        'n' -> sb.append('\n')
                        't' -> sb.append('\t')
                        'u' -> {
                            sb.append(raw.substring(i + 2, i + 6).toInt(16).toChar())
                            i += 4
                        }
                        else -> sb.append(next)
                    }
                    space = false
                    i += 2
                    continue
                }
                ch == '"' -> quoted = !quoted
                !quoted && ch.isWhitespace() -> {
                    if (!space) sb.append(' ')
                    space = true
                    i++
                    continue
                }
                else -> sb.append(ch)
            }
            space = false
            i++
        }
        return if (raw.trim().startsWith('"')) sb.toString() else sb.toString().trim()
    }

    private val formatSpec = Regex("""%(\d+\$)?[-#+ 0,(<]*\d*(\.\d+)?([a-zA-Z%])""")

    /** The format arguments of [text] as "position:conversion" (e.g. "1:s", "2:d"); %% and %n aren't arguments. */
    fun formatArgs(text: String): List<String> {
        var next = 1
        return formatSpec.findAll(text).mapNotNull { m ->
            val conversion = m.groupValues[3]
            if (conversion == "%" || conversion == "n") return@mapNotNull null
            val pos = m.groupValues[1].removeSuffix("$").toIntOrNull() ?: next++
            "$pos:${conversion.lowercase()}"
        }.distinct().sorted().toList()
    }
}
