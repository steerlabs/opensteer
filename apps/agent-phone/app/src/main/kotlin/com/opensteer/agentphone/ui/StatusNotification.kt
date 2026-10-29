package com.opensteer.agentphone.ui

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import com.opensteer.agentphone.R
import com.opensteer.agentphone.RuntimeReport
import com.opensteer.agentphone.wire.ConnectionState

/**
 * The ongoing notification: whether agents can use this phone, which task
 * holds it, and a Stop for that task. It is how a person who picks up the
 * phone learns an agent is driving it.
 */
class StatusNotification(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)
    private var shown: List<Any?>? = null

    init {
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, context.getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW),
        )
    }

    fun show(report: RuntimeReport, paused: Boolean) {
        val text = when {
            report.link.connection == ConnectionState.NEEDS_UPDATE -> report.link.issue?.detail ?: context.getString(R.string.state_needs_update)
            paused -> context.getString(R.string.notification_paused)
            report.session != null -> context.getString(R.string.notification_in_use, report.session.title ?: context.getString(R.string.untitled_task))
            report.link.connection == ConnectionState.ONLINE -> context.getString(R.string.notification_ready)
            report.link.connection == ConnectionState.UNPAIRED -> context.getString(R.string.notification_unpaired)
            report.link.connection == ConnectionState.REMOVED -> context.getString(R.string.state_removed)
            else -> report.link.issue?.detail ?: context.getString(R.string.notification_connecting)
        }
        val title = report.deploymentName?.let { context.getString(R.string.status_paired, it) }
            ?: context.getString(R.string.app_name)
        val sessionId = report.session?.id
        val key = listOf(title, text, sessionId)
        if (key == shown) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
        if (sessionId != null) {
            val stop = PendingIntent.getBroadcast(
                context,
                0,
                Intent(context, NotificationActionReceiver::class.java)
                    .setAction(NotificationActionReceiver.STOP)
                    // PendingIntent identity includes data, not extras: an
                    // old notification must keep naming its original task.
                    .setData(Uri.parse("opensteer-agent-phone:stop/$sessionId"))
                    .putExtra(NotificationActionReceiver.SESSION_ID, sessionId),
                PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(Notification.Action.Builder(null, context.getString(R.string.stop_task), stop).build())
        }
        manager.notify(ID, builder.build())
        shown = key
    }

    fun cancel() {
        manager.cancel(ID)
        shown = null
    }

    private companion object {
        const val CHANNEL = "agent_phone_status"
        const val ID = 1
    }
}
