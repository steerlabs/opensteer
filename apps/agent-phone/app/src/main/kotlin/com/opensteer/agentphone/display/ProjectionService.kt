package com.opensteer.agentphone.display

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjectionManager
import android.os.IBinder
import com.opensteer.agentphone.R

/** Foreground lifetime is exactly the lifetime of a fresh capture token. Never restarted with an old Intent. */
class ProjectionService : Service() {
    private var capture: ProjectionCapture? = null
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val request = intent?.getStringExtra("request") ?: return START_NOT_STICKY.also { stopSelf() }
        try {
            val notifications = getSystemService(NotificationManager::class.java)
            notifications.createNotificationChannel(NotificationChannel("phone-display", "Live phone display", NotificationManager.IMPORTANCE_LOW))
            startForeground(20, Notification.Builder(this, "phone-display").setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Showing this phone's screen in Opensteer").setOngoing(true).build(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
            if (!ProjectionRequest.exists(request)) { stopSelf(); return START_NOT_STICKY }
            capture?.stop()
            @Suppress("DEPRECATION")
            val data = intent.getParcelableExtra<Intent>("data") ?: error("Missing capture result")
            val projection = getSystemService(MediaProjectionManager::class.java).getMediaProjection(intent.getIntExtra("code", 0), data)
                ?: error("No projection")
            val started = ProjectionCapture(this, projection) {
                ProjectionRequest.fail(request, ProjectionCapture.ProjectionEnded())
                stopSelf(startId)
            }
            capture = started
            ProjectionRequest.complete(request, started)
        } catch (error: Exception) { ProjectionRequest.fail(request, error); stopSelf(startId) }
        return START_NOT_STICKY
    }
    override fun onDestroy() { val old = capture; capture = null; old?.stop(); super.onDestroy() }
}
