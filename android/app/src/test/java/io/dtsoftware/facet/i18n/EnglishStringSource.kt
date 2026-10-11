package io.dtsoftware.facet.i18n

import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.StringSource
import java.util.Locale

/**
 * English text for Strings.get() in plain JVM unit tests, read from res/values. Registered in
 * META-INF/services, so code under test that builds user-facing text works without Robolectric.
 */
class EnglishStringSource : StringSource {
    private val resources by lazy { StringResourceFiles.load("values") }

    private val names: Map<Int, String> by lazy {
        (R.string::class.java.fields + R.plurals::class.java.fields).associate { it.getInt(null) to it.name }
    }

    private fun resource(id: Int): StringResource =
        resources[names[id] ?: error("No string resource with id $id")] ?: error("${names[id]} isn't in res/values")

    override fun get(id: Int, args: Array<out Any>): String {
        val text = (resource(id) as StringResource.Text).text
        return if (args.isEmpty()) text else String.format(Locale.US, text, *args)
    }

    override fun plural(id: Int, count: Int, args: Array<out Any>): String {
        val items = (resource(id) as StringResource.Plural).items
        val text = (if (count == 1) items["one"] else null) ?: items.getValue("other")
        return String.format(Locale.US, text, *args)
    }
}
