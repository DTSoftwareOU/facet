package io.dtsoftware.facet.data.prefs

import android.content.Context
import io.dtsoftware.facet.llm.QuirkStore

/** Persists parameters each model rejected so future requests omit them. */
class PrefsQuirkStore(context: Context) : QuirkStore {
    private val prefs = context.getSharedPreferences("facet_quirks", Context.MODE_PRIVATE)

    private fun key(providerId: String, model: String) = "$providerId|$model"

    override fun dropped(providerId: String, model: String): Set<String> =
        prefs.getStringSet(key(providerId, model), emptySet()) ?: emptySet()

    override fun markDropped(providerId: String, model: String, param: String) {
        val k = key(providerId, model)
        val next = (prefs.getStringSet(k, emptySet()) ?: emptySet()) + param
        prefs.edit().putStringSet(k, next).apply()
    }

    fun clear() = prefs.edit().clear().apply()
}
