package io.dtsoftware.facet.i18n

import android.content.Context
import android.view.View
import androidx.activity.ComponentActivity
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.AppLanguage
import io.dtsoftware.facet.core.i18n.Strings
import io.dtsoftware.facet.core.util.Dates
import io.dtsoftware.facet.core.util.Format
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Picking the interface language: Android 13+ per-app language, and the preference before that. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class AppLanguageTest {
    private val app get() = RuntimeEnvironment.getApplication()

    @After
    fun reset() {
        app.getSharedPreferences("facet_language", Context.MODE_PRIVATE).edit().clear().commit()
        Strings.reset()
        java.util.Locale.setDefault(java.util.Locale.US)
    }

    @Test
    fun matchesSystemTagsToSupportedLanguages() {
        assertEquals("en", AppLanguage.match("en-GB"))
        assertEquals("pt-BR", AppLanguage.match("pt-PT"))
        assertEquals("pt-BR", AppLanguage.match("pt_BR"))
        assertEquals("zh-CN", AppLanguage.match("zh-Hans-CN"))
        assertEquals("id", AppLanguage.match("in-ID"))
        assertEquals("id", AppLanguage.match("id"))
        assertEquals("ar", AppLanguage.match("ar-EG"))
        assertNull(AppLanguage.match("xx"))
    }

    @Test
    fun localeConfigListsEveryLanguage() {
        val file = File(StringResourceFiles.resDir, "xml/locales_config.xml")
        val nodes = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(file)
            .getElementsByTagName("locale")
        val tags = (0 until nodes.length).map { (nodes.item(it) as org.w3c.dom.Element).getAttributeNS("http://schemas.android.com/apk/res/android", "name") }
        assertEquals(AppLanguage.all.map { it.tag }, tags)
    }

    @Test
    fun android13KeepsTheChoiceItself() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        assertNull(AppLanguage.selected(app))
        AppLanguage.select(activity, "de")
        assertEquals("de", AppLanguage.selected(app))
        AppLanguage.select(activity, null)
        assertNull(AppLanguage.selected(app))
    }

    @Test
    @Config(sdk = [28])
    fun beforeAndroid13ThePreferenceLocalizesActivitiesAndText() {
        app.getSharedPreferences("facet_language", Context.MODE_PRIVATE).edit().putString("tag", "de").commit()
        assertEquals("de", AppLanguage.selected(app))
        val wrapped = AppLanguage.wrap(app)
        assertEquals("de", wrapped.resources.configuration.locales[0].language)
        assertEquals("Abbrechen", wrapped.getString(R.string.action_cancel))

        Strings.init(app)
        assertEquals("Abbrechen", Strings.get(R.string.action_cancel))
        assertEquals("de", Strings.locale.language)
        assertEquals("1,5 MB", Format.bytes(1_572_864))
        assertEquals("Gerade eben", Dates.relative(System.currentTimeMillis()))
    }

    @Test
    @Config(sdk = [28])
    fun arabicIsRightToLeft() {
        app.getSharedPreferences("facet_language", Context.MODE_PRIVATE).edit().putString("tag", "ar").commit()
        val wrapped = AppLanguage.wrap(app)
        assertEquals(View.LAYOUT_DIRECTION_RTL, wrapped.resources.configuration.layoutDirection)
        assertTrue(AppLanguage.all.single { it.tag == "ar" }.rtl)
    }

    @Test
    @Config(sdk = [28])
    fun followingTheSystemAgainClearsTheChoice() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        AppLanguage.select(activity, "ja")
        assertEquals("ja", AppLanguage.selected(app))
        AppLanguage.select(activity, null)
        assertNull(AppLanguage.selected(app))
        assertEquals(app.resources.configuration.locales[0], AppLanguage.wrap(app).resources.configuration.locales[0])
    }
}
