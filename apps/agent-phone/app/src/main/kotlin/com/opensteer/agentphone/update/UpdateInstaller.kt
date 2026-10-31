package com.opensteer.agentphone.update

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import com.opensteer.agentphone.BuildConfig
import com.opensteer.agentphone.R
import com.opensteer.agentphone.phone
import com.opensteer.agentphone.runner.PhoneIdentity
import java.io.File

/** The journal is committed before PackageInstaller may replace the process. */
class UpdateInstaller(private val context: Context) {
    private val journal = context.getSharedPreferences("phone-update", Context.MODE_PRIVATE)
    private val installer get() = context.packageManager.packageInstaller

    fun state(): String = journal.getString("state", "idle") ?: "idle"
    fun digest(): String? = journal.getString("sha256", null)

    fun pendingState(identity: PhoneIdentity): String? = state().takeIf {
        journal.getString("scope", null)?.startsWith("${identity.runnerId} ${identity.hostUrl} ") == true &&
            it in setOf("installing", "awaiting-user") && installer.getSessionInfo(journal.getInt("sessionId", -1)) != null
    }

    fun pending(identity: PhoneIdentity, offer: UpdateOffer): Boolean =
        journal.getString("scope", null) == "${identity.runnerId} ${identity.hostUrl} ${offer.sha256}" && pendingState(identity) != null

    fun takeCancelled(identity: PhoneIdentity): Boolean {
        if (state() != "cancelled" || journal.getString("scope", null)?.startsWith("${identity.runnerId} ${identity.hostUrl} ") != true) return false
        check(journal.edit().putString("state", "idle").remove("sessionId").commit()) { "Could not record the cancelled update" }
        return true
    }

    fun begin(identity: PhoneIdentity, offer: UpdateOffer) {
        val scope = "${identity.runnerId} ${identity.hostUrl} ${offer.sha256}"
        val attempts = if (journal.getString("scope", null) == scope) journal.getInt("attempts", 0) else 0
        check(attempts < 3) { "This release already failed three update attempts. Update over USB to try again." }
        check(journal.edit().putString("scope", scope).putInt("attempts", attempts + 1)
            .putString("sha256", offer.sha256).putLong("version", offer.versionCode)
            .putString("state", "downloading").remove("sessionId").commit()) { "Could not save the update attempt" }
    }

    fun verify(file: File, offer: UpdateOffer) {
        check(offer.signer == BuildConfig.AGENT_PHONE_UPDATE_SIGNER) { "The update has a foreign signer" }
        check(offer.minSdk <= Build.VERSION.SDK_INT) { "The update needs a newer Android version" }
        val installed = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        check(offer.versionCode > installed.longVersionCode) { "The update is not newer" }
        check(file.length() == offer.size && file.inputStream().use { input ->
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            val bytes = ByteArray(65_536)
            while (true) { val count = input.read(bytes); if (count < 0) break; digest.update(bytes, 0, count) }
            digest.digest().joinToString("") { "%02x".format(it) } == offer.sha256
        }) { "The update digest or size differs" }
        val archive = context.packageManager.getPackageArchiveInfo(file.absolutePath, PackageManager.GET_SIGNING_CERTIFICATES)
            ?: error("Android could not read the update APK")
        check(archive.packageName == context.packageName && archive.longVersionCode == offer.versionCode && archive.versionName == offer.versionName) { "The APK names another package or version" }
        val info = archive.applicationInfo ?: error("The APK has no application")
        check(info.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0 && info.targetSdkVersion >= 34) { "The update is a debug or obsolete build" }
        for (pkg in listOf(installed, archive)) {
            val signers = pkg.signingInfo?.apkContentsSigners ?: error("The APK has no signing certificate")
            check(signers.size == 1 && UpdateOffer.sha256(signers.single().toByteArray()) == BuildConfig.AGENT_PHONE_UPDATE_SIGNER) { "The APK signer is not the pinned release signer" }
        }
    }

    fun install(file: File, offer: UpdateOffer, stillPaired: () -> Boolean) {
        check(stillPaired()) { "The pairing changed during the update" }
        check(context.packageManager.canRequestPackageInstalls()) { "Allow app updates by running setup again over USB" }
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(offer.size)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        try {
            installer.openSession(sessionId).use { session ->
                file.inputStream().use { input -> session.openWrite("base.apk", 0, offer.size).use { output ->
                    input.copyTo(output)
                    session.fsync(output)
                } }
                check(stillPaired()) { "The pairing changed during the update" }
                check(journal.edit().putInt("sessionId", sessionId).putString("state", "installing").commit()) { "Could not save the install session" }
                val intent = Intent(context, UpdateResultReceiver::class.java).setAction(RESULT)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                session.commit(PendingIntent.getBroadcast(context, sessionId, intent, flags).intentSender)
            }
        } catch (error: Exception) {
            installer.abandonSession(sessionId)
            throw error
        } finally { file.delete() }
    }

    fun failed() {
        journal.edit().putString("state", "failed").commit()
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION)
    }

    fun finishIfInstalled() {
        if (journal.getLong("version", Long.MAX_VALUE) <= context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode) {
            journal.edit().putString("state", "idle").remove("sessionId").commit()
            context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION)
        }
    }

    fun result(intent: Intent) {
        val identity = context.phone.load()
        if (identity == null || journal.getString("scope", "")?.startsWith("${identity.runnerId} ${identity.hostUrl} ") != true) return abandon()
        if (intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -2) != journal.getInt("sessionId", -1)) return
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_SUCCESS -> finishIfInstalled()
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val pending = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return failed()
                journal.edit().putString("state", "awaiting-user").commit()
                pending.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                val manager = context.getSystemService(NotificationManager::class.java)
                manager.createNotificationChannel(NotificationChannel(CHANNEL, "Agent Phone updates", NotificationManager.IMPORTANCE_HIGH))
                val action = PendingIntent.getActivity(context, NOTIFICATION, pending, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                manager.notify(NOTIFICATION, Notification.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle("Update Agent Phone").setContentText("Tap to confirm the Agent Phone update.")
                    .setContentIntent(action).setAutoCancel(true).build())
                // The accessibility service may start activities in the background. The notification remains if Android refuses.
                try { context.startActivity(pending) } catch (error: Exception) { Log.w("AgentPhone", "Open the update notification to continue", error) }
            }
            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                if (state() == "cancelled") return
                journal.edit().putString("state", "cancelled").putInt("attempts", (journal.getInt("attempts", 1) - 1).coerceAtLeast(0)).commit()
                context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION)
            }
            else -> failed()
        }
        if (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE) != PackageInstaller.STATUS_PENDING_USER_ACTION) {
            context.phone.runtime?.connection?.identityChanged()
        }
    }

    fun abandon() {
        val session = journal.getInt("sessionId", -1)
        if (session >= 0) runCatching { installer.abandonSession(session) }
        failed()
    }

    companion object {
        const val RESULT = "com.opensteer.agentphone.UPDATE_RESULT"
        private const val CHANNEL = "agent_phone_update"
        private const val NOTIFICATION = 4
    }
}

class UpdateResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val installer = UpdateInstaller(context)
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            installer.finishIfInstalled()
            context.phone.runtime?.connection?.identityChanged()
            Log.i("AgentPhone", "Agent Phone update installed; reconnecting with saved identity")
        } else if (intent.action == UpdateInstaller.RESULT) installer.result(intent)
    }
}
