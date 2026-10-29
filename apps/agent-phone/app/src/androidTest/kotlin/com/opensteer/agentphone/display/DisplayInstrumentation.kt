package com.opensteer.agentphone.display

import android.app.Instrumentation
import android.content.Intent
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.os.SystemClock
import com.opensteer.agentphone.ui.MainActivity
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Emulator-only acceptance of the production capture. The shell runner changes content, rotation and power.
 * Failures: consent despite a granted op, static start >1000ms, non-IDR after refresh, missing SPS/PPS,
 * letterboxed rotation, protection leaking retired output, wake changing generation, secure pixels or stale tokens.
 * Access units and measured JSON survive in files/display-acceptance for independent decoding and repeatable checks.
 */
class DisplayInstrumentation : Instrumentation() {
    private var arguments = Bundle()
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); this.arguments = arguments ?: Bundle(); start() }
    override fun onStart() {
        val report = Bundle()
        var capture: ProjectionCapture? = null
        try {
            val context = targetContext
            val dir = File(context.filesDir, "display-acceptance").apply { mkdirs() }
            val mode = arguments.getString("mode") ?: "basic"
            if (mode == "runtime") {
                report.putString("result", DisplayRuntimeAcceptance(this).run())
                finish(android.app.Activity.RESULT_OK, report)
                return
            }
            if (mode == "permission") {
                check(!ProjectionRequest.permitted(context))
                val result = ProjectionRequest.acquire(context) { error("Missing grant reached preparation") }
                check(result.isCompletedExceptionally) { "Missing grant launched consent" }
                val json = "{\"passed\":true,\"mode\":\"permission\"}"
                File(dir, "$mode.json").writeText(json); report.putString("result", json)
                finish(android.app.Activity.RESULT_OK, report)
                return
            }
            val frames = LinkedBlockingQueue<EncodedPicture>()
            val firstAvailable = java.util.concurrent.atomic.AtomicLong(-1)
            val started = SystemClock.elapsedRealtime()
            capture = ProjectionRequest.acquire(context) { prepared ->
                prepared.onFrame = { picture ->
                    firstAvailable.compareAndSet(-1, SystemClock.elapsedRealtime())
                    frames.offer(picture)
                }
                prepared.onFailure = { error -> report.putString("captureFailure", error.toString()) }
                java.util.concurrent.CompletableFuture.supplyAsync { prepared.reset(1280, 30, 2_500_000); Unit }
            }.get(15, TimeUnit.SECONDS)
            val source = capture
            val acquisitionMs = SystemClock.elapsedRealtime() - started
            // The dedicated static-start case enforces the 1000ms acceptance target.
            // Recovery cases independently prove a fresh, bounded projection after process loss.
            val startupLimitMs = if (mode == "basic") 1000L else 5000L
            val first = frames.poll((startupLimitMs - (SystemClock.elapsedRealtime() - started)).coerceAtLeast(1), TimeUnit.MILLISECONDS)
                ?: error("Initial frame exceeded ${startupLimitMs}ms (activityGoneMs=$acquisitionMs)")
            val startMs = firstAvailable.get() - started
            check(startMs <= startupLimitMs) { "First frame took ${startMs}ms (activityGoneMs=$acquisitionMs)" }
            check(first.key && first.codec?.startsWith("avc1.") == true)
            check(nalTypes(first.payload).containsAll(listOf(7, 8, 5))) { "Keyframe lacks Annex B SPS/PPS/IDR" }
            File(dir, "$mode-initial.h264").writeBytes(first.payload)
            fun ready(stage: String) { File(dir, "ready").writeText(stage) }
            fun next(ms: Long = 3000): EncodedPicture = frames.poll(ms, TimeUnit.MILLISECONDS) ?: error("No frame in ${ms}ms")
            fun sync() = synchronized(source.gate.lock) { frames.clear(); source.requestSync() }
            var extra = ""
            when (mode) {
                "flow" -> {
                    Thread.sleep(2000)
                    ready("flow")
                    Thread.sleep(400)
                    val requested = java.util.concurrent.CompletableFuture<Long>()
                    val arm = java.util.concurrent.atomic.AtomicBoolean(true)
                    // Request inside a completed output callback while shell swipes continue.
                    // The next drain result, with no older application queue, must be an IDR.
                    source.onFrame = { picture ->
                        if (arm.compareAndSet(true, false)) {
                            frames.clear()
                            val at = SystemClock.elapsedRealtime()
                            source.requestSync()
                            requested.complete(at)
                        } else frames.offer(picture)
                    }
                    val requestAt = requested.get(5, TimeUnit.SECONDS)
                    val key = next(5000)
                    check(key.key && nalTypes(key.payload).contains(5)) { "Next changed frame was not IDR" }
                    check(key.generation == first.generation) { "Refresh reset generation" }
                    val refreshMs = SystemClock.elapsedRealtime() - requestAt
                    var count = 1
                    File(dir, "flow.h264").outputStream().use { out ->
                        out.write(key.payload)
                        val until = SystemClock.elapsedRealtime() + 3000
                        while (SystemClock.elapsedRealtime() < until) frames.poll(100, TimeUnit.MILLISECONDS)?.let { out.write(it.payload); count++ }
                    }
                    check(count >= 5) { "Changing content produced only $count frames" }
                    extra = ",\"frames\":$count,\"refreshNextFrameIdr\":true,\"refreshMs\":$refreshMs,\"generation\":${key.generation}"
                }
                "rotation" -> {
                    ready("rotation")
                    val display = context.getSystemService(DisplayManager::class.java).getDisplay(android.view.Display.DEFAULT_DISPLAY)
                    val size = Point()
                    val until = SystemClock.elapsedRealtime() + 8000
                    do {
                        @Suppress("DEPRECATION")
                        display.getRealSize(size)
                        if (size.x > size.y) break
                        Thread.sleep(50)
                    } while (SystemClock.elapsedRealtime() < until)
                    check(size.x > size.y) { "Shell did not rotate display" }
                    synchronized(source.gate.lock) { frames.clear(); source.reset(1280, 30, 2_500_000) }
                    ready("rotated")
                    val landscape = next(5000)
                    check(landscape.key && landscape.generation > first.generation && landscape.width > landscape.height)
                    check(landscape.width <= 1280)
                    File(dir, "landscape.h264").writeBytes(landscape.payload)
                    extra = ",\"landscape\":\"${landscape.width}x${landscape.height}\",\"generation\":${landscape.generation}"
                }
                "secure" -> {
                    Thread.sleep(1500)
                    sync()
                    context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    val key = next(5000)
                    check(key.key)
                    File(dir, "secure.h264").outputStream().use { out ->
                        out.write(key.payload)
                        val until = SystemClock.elapsedRealtime() + 2500
                        while (SystemClock.elapsedRealtime() < until) frames.poll(100, TimeUnit.MILLISECONDS)?.let { out.write(it.payload) }
                    }
                }
                "power" -> {
                    Thread.sleep(1500); frames.clear()
                    ready("power")
                    val power = context.getSystemService(android.os.PowerManager::class.java)
                    val offUntil = SystemClock.elapsedRealtime() + 5000
                    while (power.isInteractive && SystemClock.elapsedRealtime() < offUntil) Thread.sleep(50)
                    check(!power.isInteractive) { "Screen did not turn off" }
                    val generation = source.gate.generation
                    val onUntil = SystemClock.elapsedRealtime() + 6000
                    while (!power.isInteractive && SystemClock.elapsedRealtime() < onUntil) Thread.sleep(50)
                    check(power.isInteractive) { "Screen did not wake" }
                    frames.clear(); source.requestSync(); ready("awake")
                    val wake = next(5000)
                    check(wake.generation == generation) { "Wake reset encoder" }
                    File(dir, "wake.h264").writeBytes(wake.payload)
                    extra = ",\"wakeGeneration\":${wake.generation}"
                }
                "protection" -> {
                    // Retiring from a real output callback must leave the codec alive until the drain returns.
                    // Releasing it synchronously in protect() makes outputFormat throw here.
                    val retired = java.util.concurrent.CompletableFuture<Unit>()
                    val original = source.onFrame
                    val armed = java.util.concurrent.atomic.AtomicBoolean(true)
                    source.onFrame = {
                        if (armed.compareAndSet(true, false)) try {
                            val encoderField = source.javaClass.getDeclaredField("encoder").apply { isAccessible = true }
                            val encoder = requireNotNull(encoderField.get(source))
                            val codec = encoder.javaClass.getDeclaredField("codec").apply { isAccessible = true }.get(encoder) as android.media.MediaCodec
                            source.protect { frames.clear() }
                            check(Thread.currentThread().name == "opensteer-avc-drain")
                            check(codec.outputFormat.getString(android.media.MediaFormat.KEY_MIME) == "video/avc")
                            retired.complete(Unit)
                        } catch (error: Throwable) { retired.completeExceptionally(error) }
                    }
                    source.requestSync()
                    retired.get(5, TimeUnit.SECONDS)
                    source.onFrame = original
                    source.protect { frames.clear() }
                    Thread.sleep(200)
                    check(frames.isEmpty()) { "Retired encoder published after protection" }
                    synchronized(source.gate.lock) { source.reset(1280, 30, 2_500_000) }
                    ready("protection")
                    val lifted = next(5000)
                    check(lifted.key && lifted.generation > first.generation)
                    File(dir, "lifted.h264").writeBytes(lifted.payload)
                    extra = ",\"liftGeneration\":${lifted.generation},\"drainRetainedCodecUntilReturn\":true"
                }
                "death" -> {
                    ready("death")
                    val kill = File(dir, "kill")
                    val deadline = SystemClock.elapsedRealtime() + 20000
                    while (!kill.exists() && SystemClock.elapsedRealtime() < deadline) Thread.sleep(20)
                    check(kill.exists()) { "Shell did not request process death" }
                    File(dir, "death-pid").writeText(android.os.Process.myPid().toString())
                    android.os.Process.killProcess(android.os.Process.myPid())
                    Thread.sleep(1000)
                    error("Process survived SIGKILL")
                }
            }
            check(!report.containsKey("captureFailure")) { report.getString("captureFailure").orEmpty() }
            val json = "{\"passed\":true,\"mode\":\"$mode\",\"pid\":${android.os.Process.myPid()},\"activityGoneMs\":$acquisitionMs,\"requestToKeyMs\":$startMs,\"encoder\":\"${source.encoderName}\",\"hardware\":${source.hardware}$extra}"
            File(dir, "$mode.json").writeText(json)
            report.putString("result", json)
            source.stop(); capture = null
            finish(android.app.Activity.RESULT_OK, report)
        } catch (error: Throwable) {
            capture?.stop(); capture = null
            report.putString("error", android.util.Log.getStackTraceString(error)); finish(android.app.Activity.RESULT_CANCELED, report)
        } finally { capture?.stop() }
    }
    private fun nalTypes(bytes: ByteArray): List<Int> = (0 until bytes.size - 3).mapNotNull { i ->
        if (bytes[i] == 0.toByte() && bytes[i + 1] == 0.toByte() && bytes[i + 2] == 1.toByte()) bytes[i + 3].toInt() and 31 else null
    }
}
