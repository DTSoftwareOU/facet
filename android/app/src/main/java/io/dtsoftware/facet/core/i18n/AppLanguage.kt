package io.dtsoftware.facet.core.i18n

import android.app.Activity
import android.app.LocaleManager
import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.content.res.Resources
import android.os.Build
import android.os.LocaleList
import java.util.Locale

/**
 * The interface language: one of [all], or null to follow the system.
 *
 * Android 13+ keeps the choice itself (per-app language, also under Settings → Apps → Facet AI →
 * Language; res/xml/locales_config.xml lists the languages), localizes the whole app and recreates
 * the activity when it changes. Before Android 13 the choice lives in a private preference:
 * [wrap] applies it to the activity and services, [Strings] to text built outside Compose.
 */
object AppLanguage {
    class Language(val tag: String, val nativeName: String, val rtl: Boolean = false)

    /** Same languages and order as the web and Windows app (client/src/i18n/index.ts). */
    val all: List<Language> = listOf(
        Language("en", "English"),
        Language("zh-CN", "简体中文"),
        Language("hi", "हिन्दी"),
        Language("es", "Español"),
        Language("ar", "العربية", rtl = true),
        Language("fr", "Français"),
        Language("bn", "বাংলা"),
        Language("pt-BR", "Português (Brasil)"),
        Language("ru", "Русский"),
        Language("id", "Bahasa Indonesia"),
        Language("ur", "اردو", rtl = true),
        Language("de", "Deutsch"),
        Language("ja", "日本語"),
        Language("mr", "मराठी"),
        Language("te", "తెలుగు"),
        Language("tr", "Türkçe"),
        Language("ta", "தமிழ்"),
        Language("vi", "Tiếng Việt"),
        Language("ko", "한국어"),
        Language("it", "Italiano"),
    )

    private const val PREFS = "facet_language"
    private const val KEY = "tag"

    /** The language picked for Facet, or null when it follows the system. */
    fun selected(context: Context): String? {
        if (Build.VERSION.SDK_INT >= 33) {
            val locales = context.getSystemService(LocaleManager::class.java)?.applicationLocales ?: return null
            return if (locales.isEmpty) null else match(locales[0].toLanguageTag())
        }
        return stored(context)
    }

    /** Switches the interface to [tag] (null: follow the system) and redraws [activity] in it. */
    fun select(activity: Activity, tag: String?) {
        if (Build.VERSION.SDK_INT >= 33) {
            // Android stores it and recreates the activity with the new configuration.
            activity.getSystemService(LocaleManager::class.java)?.applicationLocales =
                if (tag == null) LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(tag)
        } else {
            prefs(activity).edit().apply { if (tag == null) remove(KEY) else putString(KEY, tag) }.commit()
            activity.recreate()
        }
    }

    /** Before Android 13: [base] in the chosen language, for attachBaseContext of activities and services. */
    fun wrap(base: Context): Context {
        if (Build.VERSION.SDK_INT >= 33) return base
        return localize(base, stored(base))
    }

    /** Android 13+: moves a choice made before an OS upgrade into the system's per-app language. */
    fun migrate(context: Context) {
        if (Build.VERSION.SDK_INT < 33) return
        val tag = prefs(context).getString(KEY, null) ?: return
        val manager = context.getSystemService(LocaleManager::class.java) ?: return
        if (manager.applicationLocales.isEmpty) manager.applicationLocales = LocaleList.forLanguageTags(tag)
        prefs(context).edit().remove(KEY).apply()
    }

    /** The language stored before Android 13 (null: the system's). */
    internal fun stored(context: Context): String? = prefs(context).getString(KEY, null)?.let(::match)

    internal fun localize(base: Context, tag: String?): Context {
        val locale = tag?.let { Locale.forLanguageTag(it) } ?: systemLocale()
        Locale.setDefault(locale)
        if (tag == null) return base
        val config = Configuration(base.resources.configuration)
        config.setLocales(LocaleList(locale))
        config.setLayoutDirection(locale)
        return base.createConfigurationContext(config)
    }

    /** The supported language for a BCP 47 tag: an exact match, then the language alone (pt-PT → pt-BR). */
    fun match(tag: String): String? {
        val t = tag.replace('_', '-').lowercase()
        all.firstOrNull { it.tag.lowercase() == t }?.let { return it.tag }
        val lang = Locale.forLanguageTag(t).language.let { if (it == "in") "id" else it }
        return all.firstOrNull { it.tag.substringBefore('-') == lang }?.tag
    }

    fun nativeName(tag: String?): String? = all.firstOrNull { it.tag == tag }?.nativeName

    private fun systemLocale(): Locale = Resources.getSystem().configuration.locales.let { if (it.isEmpty) Locale.getDefault() else it[0] }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}

/** The activity behind a Compose context (contexts can be wrapped). */
fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}
