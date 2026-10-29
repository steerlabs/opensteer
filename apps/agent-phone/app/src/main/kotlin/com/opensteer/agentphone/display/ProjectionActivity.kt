package com.opensteer.agentphone.display

import android.app.Activity
import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.view.WindowManager
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/** Only in-process requests can receive a projection; neither tokens nor requests survive process death. */
object ProjectionRequest {
    private class Request(val result: CompletableFuture<ProjectionCapture>, val prepare: (ProjectionCapture) -> CompletableFuture<Unit>) {
        val gone = CompletableFuture<Unit>()
        @Volatile var activity: Activity? = null
    }
    private val main = Handler(Looper.getMainLooper())
    private val pending = ConcurrentHashMap<String, Request>()
    @Suppress("DEPRECATION")
    fun permitted(context: Context): Boolean = context.getSystemService(AppOpsManager::class.java)
        .unsafeCheckOpNoThrow("android:project_media", Process.myUid(), context.packageName) == AppOpsManager.MODE_ALLOWED
    fun acquire(context: Context, prepare: (ProjectionCapture) -> CompletableFuture<Unit>): CompletableFuture<ProjectionCapture> {
        val future = CompletableFuture<ProjectionCapture>()
        if (!permitted(context)) { future.completeExceptionally(SecurityException("PROJECT_MEDIA is not allowed")); return future }
        val id = UUID.randomUUID().toString()
        val request = Request(future, prepare)
        pending[id] = request
        future.whenComplete { _, _ -> pending.remove(id, request); finish(request) }
        try {
            context.startActivity(Intent(context, ProjectionActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION).putExtra("request", id))
        } catch (error: Exception) { future.completeExceptionally(error) }
        return future
    }
    fun exists(id: String): Boolean = pending.containsKey(id)
    fun attach(id: String, activity: Activity) { pending[id]?.activity = activity }
    fun activityGone(id: String) { pending[id]?.gone?.complete(Unit) }
    private fun finish(request: Request) { main.post { request.activity?.finish() } }
    fun complete(id: String, capture: ProjectionCapture) {
        val request = pending[id]
        if (request == null) { capture.stop(); return }
        try {
            request.prepare(capture).whenComplete { _, error ->
                if (error != null) { request.result.completeExceptionally(error); capture.stop() }
                else if (request.result.isDone) capture.stop()
                else request.gone.thenRun { if (!request.result.complete(capture)) capture.stop() }
                finish(request)
            }
        } catch (error: Exception) { request.result.completeExceptionally(error); capture.stop(); finish(request) }
    }
    fun fail(id: String, error: Throwable) { pending[id]?.result?.completeExceptionally(error) }
}

/** No content or input: the setup-granted app op bypasses the system consent UI. */
class ProjectionActivity : Activity() {
    private var request = ""
    companion object { @Volatile var showing = false; private set }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showing = true
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
        request = intent.getStringExtra("request") ?: ""
        if (!ProjectionRequest.exists(request) || !ProjectionRequest.permitted(this)) {
            ProjectionRequest.fail(request, SecurityException("PROJECT_MEDIA is not allowed")); finish(); return
        }
        ProjectionRequest.attach(request, this)
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(getSystemService(MediaProjectionManager::class.java).createScreenCaptureIntent(), 1)
        } catch (error: Exception) { ProjectionRequest.fail(request, error); finish() }
    }
    override fun onDestroy() {
        showing = false
        super.onDestroy()
        Handler(Looper.getMainLooper()).post { ProjectionRequest.activityGone(request) }
    }

    @Deprecated("Android activity result bridge")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode == RESULT_OK && data != null && ProjectionRequest.exists(request)) {
            try {
                startForegroundService(Intent(this, ProjectionService::class.java).putExtra("request", request)
                    .putExtra("code", resultCode).putExtra("data", data))
                // Keep this transparent window until the initial Surface is attached. Its removal
                // then composes the initial picture even when the underlying app is completely static.
                return
            } catch (error: Exception) { ProjectionRequest.fail(request, error) }
        } else ProjectionRequest.fail(request, SecurityException("Screen capture was not granted"))
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }
}
