package com.opensteer.agentphone.control

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** All streaming continuations run on this thread, including their authority checks and completion callbacks. */
class AndroidGestures(private val service: AccessibilityService) {
    private val thread = HandlerThread("opensteer-gestures").apply { start() }
    private val handler = Handler(thread.looper)
    private val clock = object : GestureClock {
        override fun now() = SystemClock.elapsedRealtime()
        override fun post(action: () -> Unit) { handler.post(action) }
        override fun after(ms: Long, action: () -> Unit) { handler.postDelayed(action, ms) }
    }
    private var stroke: GestureDescription.StrokeDescription? = null
    val scheduler = GestureScheduler(clock) { segment, done ->
        val path = Path().apply {
            moveTo(segment.points.first().x.toFloat(), segment.points.first().y.toFloat())
            segment.points.drop(1).forEach { lineTo(it.x.toFloat(), it.y.toFloat()) }
        }
        val next = if (segment.first || segment.cancel) GestureDescription.StrokeDescription(path, segment.delayMs, segment.durationMs, segment.continuing)
            else requireNotNull(stroke).continueStroke(path, segment.delayMs, segment.durationMs, segment.continuing)
        stroke = next
        val gesture = GestureDescription.Builder().addStroke(next).build()
        var answered = false
        fun answer(ok: Boolean) { if (!answered) { answered = true; done(ok) } }
        val accepted = service.dispatchGesture(gesture, object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription) = answer(true)
            override fun onCancelled(gestureDescription: GestureDescription) = answer(false)
        }, handler)
        if (!accepted) answer(false)
        // A missing platform callback must not strand contact cleanup forever.
        handler.postDelayed({ answer(false) }, segment.delayMs + segment.durationMs + 1000)
    }
    fun after(ms: Long, action: () -> Unit) { handler.postDelayed(action, ms) }

    fun close() {
        val released = CompletableFuture<Unit>()
        scheduler.cancel { released.complete(Unit) }
        runCatching { released.get(1500, TimeUnit.MILLISECONDS) }
        thread.quitSafely()
    }
}
