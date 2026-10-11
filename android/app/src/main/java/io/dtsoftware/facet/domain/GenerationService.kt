package io.dtsoftware.facet.domain

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import io.dtsoftware.facet.FacetApp
import io.dtsoftware.facet.MainActivity
import io.dtsoftware.facet.R
import io.dtsoftware.facet.core.i18n.Strings
import kotlinx.coroutines.launch

/**
 * Keeps the process alive while replies stream, so long reasoning runs finish even when
 * Facet is in the background. Stops itself as soon as no generation is active.
 */
class GenerationService : LifecycleService() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        val notification = Notifications.progress(this)
        runCatching {
            ServiceCompat.startForeground(
                this, Notifications.PROGRESS_ID, notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
            )
        }.onFailure { stopSelf(); return START_NOT_STICKY }
        val engine = (application as FacetApp).container.chat
        lifecycleScope.launch {
            engine.active.collect { active ->
                if (active.isEmpty()) {
                    ServiceCompat.stopForeground(this@GenerationService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
        }
        return START_NOT_STICKY
    }

    companion object {
        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, GenerationService::class.java)) }
        }
    }
}

object Notifications {
    const val CHANNEL_PROGRESS = "generation"
    const val CHANNEL_READY = "replies"
    const val PROGRESS_ID = 1001

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_PROGRESS, Strings.get(R.string.notification_channel_progress), NotificationManager.IMPORTANCE_MIN).apply {
                description = Strings.get(R.string.notification_channel_progress_description)
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_READY, Strings.get(R.string.notification_channel_ready), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = Strings.get(R.string.notification_channel_ready_description)
            },
        )
    }

    private fun openApp(context: Context, conversationId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            conversationId?.let { putExtra(MainActivity.EXTRA_CONVERSATION, it) }
        }
        return PendingIntent.getActivity(
            context, conversationId?.hashCode() ?: 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    fun progress(context: Context): Notification =
        NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(Strings.get(R.string.notification_progress_title))
            .setContentText(Strings.get(R.string.notification_progress_text))
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(openApp(context, null))
            .build()

    fun replyReady(context: Context, conversationId: String, title: String, preview: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val n = NotificationCompat.Builder(context, CHANNEL_READY)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title.ifBlank { Strings.get(R.string.notification_reply_ready) })
            .setContentText(preview.replace(Regex("[#*`>_]"), "").trim())
            .setStyle(NotificationCompat.BigTextStyle().bigText(preview.replace(Regex("[#*`>_]"), "").trim()))
            .setAutoCancel(true)
            .setContentIntent(openApp(context, conversationId))
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(conversationId.hashCode(), n) }
    }
}
