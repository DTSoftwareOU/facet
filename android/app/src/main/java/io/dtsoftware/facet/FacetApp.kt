package io.dtsoftware.facet

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import io.dtsoftware.facet.core.i18n.AppLanguage
import io.dtsoftware.facet.core.i18n.Strings

class FacetApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        Strings.init(this)
        AppLanguage.migrate(this)
        container = AppContainer(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                container.appInForeground = true
                container.sync.setForeground(true)
            }

            override fun onStop(owner: LifecycleOwner) {
                container.appInForeground = false
                container.sync.setForeground(false)
            }
        })
    }
}
