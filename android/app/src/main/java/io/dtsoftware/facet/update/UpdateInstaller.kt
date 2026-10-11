package io.dtsoftware.facet.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.pm.PackageInfoCompat
import io.dtsoftware.facet.FacetApp
import java.io.File

/** What Android's package installer reported for a session. */
sealed interface InstallStatus {
    /** Android needs the person to confirm; [intent] opens its confirmation screen. */
    data class NeedsUserAction(val intent: Intent) : InstallStatus
    data object Success : InstallStatus

    /** The person cancelled Android's confirmation. */
    data object Aborted : InstallStatus
    data class Failed(val error: UpdateError) : InstallStatus
}

/** The platform side of installing: permission, APK inspection, and the installer session. */
interface UpdateInstaller {
    /** Whether Facet may install packages ("Install unknown apps" for Facet). */
    fun canRequestInstalls(): Boolean

    /** Reads the package name and versionCode out of an APK, or null if it isn't a readable APK. */
    fun inspect(file: File): ArchiveIdentity?

    /** Hands [file] to Android's installer and returns the session id. Results arrive as [InstallStatus]. */
    fun install(file: File): Int
}

/** [UpdateInstaller] on the PackageInstaller session API (no FileProvider needed). */
class AndroidUpdateInstaller(private val context: Context) : UpdateInstaller {
    override fun canRequestInstalls(): Boolean = context.packageManager.canRequestPackageInstalls()

    override fun inspect(file: File): ArchiveIdentity? {
        val pm = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageArchiveInfo(file.path, PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION") pm.getPackageArchiveInfo(file.path, 0)
        } ?: return null
        return ArchiveIdentity(info.packageName, PackageInfoCompat.getLongVersionCode(info))
    }

    override fun install(file: File): Int {
        val installer = context.packageManager.packageInstaller
        // Leftovers from an earlier attempt (cancelled, or Facet was closed mid-way) would only hold storage.
        installer.mySessions.forEach { runCatching { installer.abandonSession(it.sessionId) } }
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(file.length())
            setInstallReason(PackageManager.INSTALL_REASON_USER)
            // Android 12+ skips the confirmation when Facet installed the current version itself;
            // otherwise the session still asks (STATUS_PENDING_USER_ACTION).
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        try {
            installer.openSession(sessionId).use { session ->
                file.inputStream().use { input ->
                    session.openWrite("facet.apk", 0, file.length()).use { out ->
                        input.copyTo(out, 64 * 1024)
                        session.fsync(out)
                    }
                }
                val intent = Intent(context, InstallResultReceiver::class.java).setAction(InstallResultReceiver.ACTION)
                // The installer adds its status extras to this intent, so it has to be mutable (it's explicit).
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                session.commit(PendingIntent.getBroadcast(context, sessionId, intent, flags).intentSender)
            }
        } catch (e: Exception) {
            runCatching { installer.abandonSession(sessionId) }
            throw e
        }
        return sessionId
    }
}

/** Receives the installer's session status and passes it to the [UpdateManager]. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        val status = when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                if (confirm != null) InstallStatus.NeedsUserAction(confirm) else InstallStatus.Failed(UpdateError.INSTALL)
            }
            PackageInstaller.STATUS_SUCCESS -> InstallStatus.Success
            PackageInstaller.STATUS_FAILURE_ABORTED -> InstallStatus.Aborted
            PackageInstaller.STATUS_FAILURE_CONFLICT -> InstallStatus.Failed(UpdateError.INSTALL_CONFLICT)
            PackageInstaller.STATUS_FAILURE_STORAGE -> InstallStatus.Failed(UpdateError.INSTALL_STORAGE)
            else -> InstallStatus.Failed(UpdateError.INSTALL)
        }
        (context.applicationContext as? FacetApp)?.container?.updates?.onInstallStatus(sessionId, status)
    }

    companion object {
        const val ACTION = "io.dtsoftware.facet.update.INSTALL_STATUS"
    }
}
