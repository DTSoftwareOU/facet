package io.dtsoftware.facet.core.i18n

import android.content.Context
import android.os.Build
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import java.util.Locale
import java.util.ServiceLoader
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Interface text for code outside Compose (errors, notifications, labels saved with a message), in
 * the app's language. Composables use stringResource() and pluralStringResource() instead.
 *
 * Text sent to models (system prompts, tool schemas, tool results) and log output stay English
 * and don't go through here.
 */
object Strings {
    @Volatile private var app: Context? = null
    @Volatile private var localized: Pair<String?, Context>? = null

    fun init(context: Context) {
        app = context.applicationContext ?: context
        localized = null
        refresh()
    }

    private val _language = MutableStateFlow("")

    /**
     * The current language tag. Flows that bake translated text into state that outlives an
     * activity (ViewModels, repository flows) combine with it, so a language switch redraws them.
     */
    val language: StateFlow<String> = _language.asStateFlow()

    /** Called when the activity starts, which is also after the language changed (the activity is recreated). */
    fun refresh() {
        _language.value = locale.toLanguageTag()
    }

    /** Tests that switch language put things back, so later tests in the same process read English again. */
    internal fun reset() {
        app = null
        localized = null
        _language.value = ""
    }

    /**
     * A context whose resources are in the app's language. Android 13+ localizes the application
     * itself (per-app language); before that, [AppLanguage] keeps the choice and this wraps it.
     */
    val context: Context
        get() {
            val base = app ?: error("Strings.init() hasn't been called")
            if (Build.VERSION.SDK_INT >= 33) return base
            val tag = AppLanguage.stored(base)
            localized?.let { (t, ctx) -> if (t == tag) return ctx }
            return AppLanguage.localize(base, tag).also { localized = tag to it }
        }

    /** The locale for dates and numbers: the app's language, or the system's when it follows the system. */
    val locale: Locale
        get() {
            if (app == null) return Locale.getDefault()
            val locales = context.resources.configuration.locales
            return if (locales.isEmpty) Locale.getDefault() else locales[0]
        }

    /** The app's language reads right to left (Arabic, Urdu). */
    val isRtl: Boolean get() = locale.language in setOf("ar", "ur", "fa", "he", "iw")

    fun get(@StringRes id: Int): String =
        app?.let { context.getString(id) } ?: fallback().get(id, emptyArray())

    fun get(@StringRes id: Int, vararg args: Any): String =
        app?.let { context.getString(id, *args) } ?: fallback().get(id, args)

    /** A count-dependent string; [args] fill its placeholders (usually the count itself). */
    fun plural(@PluralsRes id: Int, count: Int, vararg args: Any): String =
        app?.let { context.resources.getQuantityString(id, count, *args) } ?: fallback().plural(id, count, args)

    /** Plain JVM unit tests have no Android resources; the test sources provide English from res/values. */
    private val source: StringSource? by lazy {
        runCatching { ServiceLoader.load(StringSource::class.java).firstOrNull() }.getOrNull()
    }

    private fun fallback(): StringSource = source ?: error("Strings.init() hasn't been called")
}

/** Resolves string resources without an Android context (plain JVM unit tests). */
interface StringSource {
    fun get(id: Int, args: Array<out Any>): String
    fun plural(id: Int, count: Int, args: Array<out Any>): String
}
