package io.dtsoftware.facet.i18n

import io.dtsoftware.facet.core.i18n.AppLanguage
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every language has every string, with the same format arguments as the English text and the
 * plural forms the language needs; and no text uses a dash as punctuation (house style).
 */
class StringResourcesTest {
    private val english = StringResourceFiles.load("values")

    /** Resource folder for each language in AppLanguage.all (Indonesian keeps Android's legacy "in" code). */
    private fun folder(tag: String): String {
        val parts = tag.split('-')
        val lang = if (parts[0] == "id") "in" else parts[0]
        return if (parts.size > 1) "values-$lang-r${parts[1]}" else "values-$lang"
    }

    private val languages = AppLanguage.all.map { it.tag }.filter { it != "en" }

    /** CLDR cardinal plural categories of each language (the same set the web catalogs use). */
    private val pluralCategories = mapOf(
        "zh-CN" to setOf("other"), "ja" to setOf("other"), "ko" to setOf("other"), "vi" to setOf("other"), "id" to setOf("other"),
        "hi" to setOf("one", "other"), "bn" to setOf("one", "other"), "mr" to setOf("one", "other"), "te" to setOf("one", "other"),
        "ta" to setOf("one", "other"), "ur" to setOf("one", "other"), "de" to setOf("one", "other"), "tr" to setOf("one", "other"),
        "es" to setOf("one", "many", "other"), "fr" to setOf("one", "many", "other"), "it" to setOf("one", "many", "other"),
        "pt-BR" to setOf("one", "many", "other"), "ru" to setOf("one", "few", "many", "other"),
        "ar" to setOf("zero", "one", "two", "few", "many", "other"),
    )

    @Test
    fun englishIsComplete() {
        assertTrue("Expected the interface text in res/values", english.size > 400)
        val plurals = english.values.filterIsInstance<StringResource.Plural>()
        val bad = plurals.filter { it.items.keys != setOf("one", "other") }.map { "${it.name}: ${it.items.keys}" }
        assertEquals("English plurals need exactly one and other", emptyList<String>(), bad)
    }

    @Test
    fun everyLanguageHasAFolderAndPluralRules() {
        assertEquals(languages.toSet(), pluralCategories.keys)
        val folders = StringResourceFiles.resDir.listFiles { f -> f.isDirectory && f.name.startsWith("values-") && File(f, "strings.xml").isFile }
            .orEmpty().map { it.name }.toSet()
        assertEquals(languages.map(::folder).toSet(), folders)
    }

    @Test
    fun everyLanguageHasEveryString() {
        val problems = mutableListOf<String>()
        val wanted = english.values.filter { it.translatable }.associateBy { it.name }
        for (tag in languages) {
            val dir = folder(tag)
            val translated = StringResourceFiles.load(dir)
            wanted.keys.filter { it !in translated }.forEach { problems += "$dir: missing $it" }
            translated.keys.filter { it !in wanted }.forEach { problems += "$dir: $it isn't an English string (or isn't translatable)" }
            for ((name, source) in wanted) {
                val target = translated[name] ?: continue
                problems += compare(dir, tag, source, target)
            }
        }
        assertEquals(problems.joinToString("\n"), 0, problems.size)
    }

    private fun compare(dir: String, tag: String, source: StringResource, target: StringResource): List<String> {
        val where = "$dir/${source.name}"
        return when (source) {
            is StringResource.Text -> {
                if (target !is StringResource.Text) return listOf("$where: should be a <string>")
                val out = mutableListOf<String>()
                if (target.text.isBlank()) out += "$where: empty"
                val want = StringResourceFiles.formatArgs(source.text)
                val got = StringResourceFiles.formatArgs(target.text)
                if (want != got) out += "$where: format arguments $got instead of $want"
                out
            }
            is StringResource.Plural -> {
                if (target !is StringResource.Plural) return listOf("$where: should be <plurals>")
                val out = mutableListOf<String>()
                val needed = pluralCategories.getValue(tag)
                if (target.items.keys != needed) out += "$where: plural forms ${target.items.keys} instead of $needed"
                // Every form keeps the text arguments; the count (%d) may be left out ("one file").
                val english = source.items.values.flatMap { StringResourceFiles.formatArgs(it) }.toSet()
                val required = english.filterNot { it.endsWith(":d") }.toSet()
                target.items.forEach { (quantity, text) ->
                    val got = StringResourceFiles.formatArgs(text).toSet()
                    if (text.isBlank()) out += "$where[$quantity]: empty"
                    if (!english.containsAll(got) || !got.containsAll(required)) out += "$where[$quantity]: format arguments $got instead of $english"
                }
                out
            }
        }
    }

    @Test
    fun noDashesAsPunctuation() {
        val problems = mutableListOf<String>()
        val folders = StringResourceFiles.resDir.listFiles { f -> f.isDirectory && (f.name == "values" || f.name.startsWith("values-")) }.orEmpty()
        for (dir in folders) {
            if (dir.listFiles { f -> f.name.startsWith("strings") }.isNullOrEmpty()) continue
            StringResourceFiles.load(dir.name).values.forEach { res ->
                val texts = when (res) {
                    is StringResource.Text -> listOf(res.text)
                    is StringResource.Plural -> res.items.values.toList()
                }
                texts.filter { "\u2014" in it || " \u2013 " in it }.forEach { problems += "${dir.name}/${res.name}: $it" }
            }
        }
        assertEquals("Rewrite these without an em dash (or a spaced en dash):\n" + problems.joinToString("\n"), 0, problems.size)
    }

    @Test
    fun formatArgumentsAreNumbered() {
        // Translations may reorder arguments, so any string with two or more needs %1$s, %2$s….
        val bad = english.values.flatMap { res ->
            val texts = when (res) {
                is StringResource.Text -> listOf(res.text)
                is StringResource.Plural -> res.items.values.toList()
            }
            texts.filter { t -> StringResourceFiles.formatArgs(t).size > 1 && Regex("""%[-#+ 0,(]*\d*(\.\d+)?[sdf]""").containsMatchIn(t) }.map { "${res.name}: $it" }
        }
        assertEquals(bad.joinToString("\n"), 0, bad.size)
    }
}
