package io.dtsoftware.facet

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

class FacetApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
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
