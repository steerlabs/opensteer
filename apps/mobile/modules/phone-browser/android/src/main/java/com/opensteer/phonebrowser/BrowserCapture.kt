package com.opensteer.phonebrowser

import android.graphics.Bitmap
import android.graphics.Canvas
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

internal class BrowserCapture(private val pool: PhoneBrowserPool) {
  private val encoder = Executors.newSingleThreadExecutor()
  private val credits = mutableMapOf<String, CaptureCredit>()
  private val busy = AtomicBoolean()
  private var scheduled = false
  private var active = true
  private var turn = 0
  private val tick = Runnable { scheduled = false; captureNext() }

  fun demand(input: DemandRecord) {
    val tab = pool.check(input)
    if (input.maxFps != 8 || input.frameWindow != null && input.frameWindow != 1) throw BrowserFailure("invalid-demand")
    if (input.frames && PhoneBrowserNative.sink == null) throw BrowserFailure("unsupported-operation")
    if (input.frames && pool.ledger.state(tab.id) != TabState.LIVE) throw BrowserFailure("target-suspended")
    if (input.frames) {
      val browser = tab.view ?: throw BrowserFailure("target-suspended")
      CaptureRaster.size(browser.width.toDouble(),browser.height.toDouble(),tab.rendererGeometry.getOrNull(0) ?: browser.width.toDouble()/browser.scale,tab.rendererGeometry.getOrNull(1) ?: browser.height.toDouble()/browser.scale,input.density,true)
    }
    credits.getOrPut(tab.id) { CaptureCredit() }.demand(input.channelId, input.density, input.frames)
    schedule()
  }
  fun ack(input: AckRecord) { pool.check(input); (credits[input.tabId] ?: throw BrowserFailure("stale-frame")).ack(input.channelId, input.token); schedule() }
  private fun schedule() {
    if (!active || scheduled || busy.get() || credits.values.none { it.density() != null }) return
    scheduled = true
    pool.main.postDelayed(tick, 125)
  }
  private fun captureNext() {
    if (!active || busy.get()) return
    val candidates = credits.keys.filter { id -> credits[id]?.density() != null && pool.tabs[id]?.let { pool.ledger.state(id) == TabState.LIVE && it.document.isDone && !it.document.isCompletedExceptionally && it.documentId != null } == true }
    if (candidates.isEmpty()) return
    val id = candidates[turn++ % candidates.size]
    val tab = pool.tabs.getValue(id)
    val credit = credits.getValue(id)
    val channel = credit.channel() ?: return
    if (PhoneBrowserNative.sink == null) { credit.demand(channel, 1.0, false); schedule(); return }
    val token = UUID.randomUUID().toString()
    val density = credit.density() ?: return
    credit.issue(channel, token)
    val epoch = pool.gate.epoch
    encode(tab, epoch, channel, null, token, "jpeg", 0.75, density, null, cssRaster = true).whenComplete { _, error ->
      pool.main.post {
        if (error != null && pool.gate.epoch == epoch) {
          if (error is BrowserFailure && error.reason in setOf("stale-geometry", "capture-busy")) {
            try { credit.ack(channel, token) } catch (_: BrowserFailure) { }
          } else credit.demand(channel, 1.0, false)
        }
        schedule()
      }
    }
  }
  fun once(input: CaptureRecord): String {
    val future = pool.ui(input.epoch) {
      val tab = pool.check(input, true, true)
      if (input.format !in setOf("jpeg", "png") || input.quality != null && (!input.quality!!.isFinite() || input.quality!! !in 0.0..100.0)) throw BrowserFailure("unsupported-operation")
      PhoneBrowserNative.authority?.requireAttachment(input.epoch, input.attachmentId, input.sessionId, input.tabId) ?: throw BrowserFailure("forbidden")
      encode(tab, input.epoch, input.channelId, input.requestId, null, input.format, (input.quality ?: 80.0) / 100.0, 1.0, input.clip, input.attachmentId)
    }
    return try { pool.await(future) } catch (error: Throwable) { future.completeExceptionally(error); throw error }
  }
  private fun encode(tab: NativeTab, epoch: Int, channel: String, request: String?, token: String?, format: String, quality: Double, density: Double, clip: ClipRecord?, attachment: String? = null, cssRaster: Boolean = false): CompletableFuture<String> {
    if (!active || !busy.compareAndSet(false, true)) throw BrowserFailure("capture-busy")
    val result = CompletableFuture<String>()
    try {
      val sink = PhoneBrowserNative.sink ?: throw BrowserFailure("unsupported-operation")
      val browser = tab.view ?: throw BrowserFailure("target-suspended")
      val document = tab.documentId ?: throw BrowserFailure("target-not-ready")
      val geometry = tab.geometryRevision
      val generation = tab.generation
      val renderer = tab.rendererGeometry
      val geometrySnapshot = PhoneBrowserGeometry(renderer.getOrNull(0) ?: browser.width.toDouble()/browser.scale, renderer.getOrNull(1) ?: browser.height.toDouble()/browser.scale,
        renderer.getOrNull(2) ?: 1.0, renderer.getOrNull(3) ?: 0.0, renderer.getOrNull(4) ?: 0.0, renderer.getOrNull(5) ?: 0.0, renderer.getOrNull(6) ?: 0.0,
        browser.width, browser.height, browser.scale.toDouble(), tab.geometry.lastOrNull()?.toInt() ?: 0)
      val cssScale = browser.scale.toDouble().coerceAtLeast(0.01)
      val x = (clip?.x ?: 0.0) * cssScale
      val y = (clip?.y ?: 0.0) * cssScale
      val width = (clip?.width?.times(cssScale) ?: browser.width.toDouble())
      val height = (clip?.height?.times(cssScale) ?: browser.height.toDouble())
      if (listOf(x,y,width,height,density).any { !it.isFinite() } || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > browser.width + 0.01 || y + height > browser.height + 0.01) throw BrowserFailure("invalid-viewport")
      val raster = CaptureRaster.size(width,height,geometrySnapshot.width,geometrySnapshot.height,density,cssRaster)
      val rasterWidth = raster.first
      val rasterHeight = raster.second
      val bitmap = Bitmap.createBitmap(rasterWidth, rasterHeight, Bitmap.Config.ARGB_8888)
      try {
        val canvas = Canvas(bitmap)
        canvas.scale((rasterWidth/width).toFloat(), (rasterHeight/height).toFloat()); canvas.translate(-x.toFloat(), -y.toFloat())
        browser.draw(canvas)
      } catch (error: Throwable) { bitmap.recycle(); throw error }
      val revision = ++tab.captureRevision
      val reference = UUID.randomUUID().toString()
      encoder.execute {
        try {
          val bytes = ByteArrayOutputStream().use { output ->
            if (!bitmap.compress(if (format == "png") Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, (quality * 100).roundToInt(), output)) throw BrowserFailure("capture-failed")
            output.toByteArray()
          }
          if (bytes.size > 7864320) throw BrowserFailure("too-large")
          if (!tab.live) throw BrowserFailure("target-suspended")
          if (result.isDone) throw BrowserFailure("timeout")
          pool.gate.check(epoch)
          if (tab.documentId != document || tab.geometryRevision != geometry || tab.generation != generation) throw BrowserFailure("stale-geometry")
          if (attachment != null) PhoneBrowserNative.authority?.requireAttachment(epoch,attachment,tab.sessionId,tab.id) ?: throw BrowserFailure("forbidden")
          pool.ui(epoch) {
            if (!tab.live || tab.documentId != document || tab.geometryRevision != geometry) throw BrowserFailure("stale-geometry")
            val versions = tab.frameRevisions.getOrPut(channel) { mutableListOf() }
            versions.add(revision); while (versions.size > 2) versions.removeAt(0)
          }
          sink.deliver(PhoneBrowserArtifact(reference, epoch, tab.sessionId, tab.id, generation, document, geometry, revision, rasterWidth, rasterHeight, "image/$format", geometrySnapshot, bytes, channel, request, attachment, token))
          pool.gate.check(epoch)
          result.complete(reference)
        } catch (error: Throwable) { result.completeExceptionally(error) }
        finally { bitmap.recycle(); busy.set(false); pool.main.post { schedule() } }
      }
    } catch (error: Throwable) { busy.set(false); result.completeExceptionally(error) }
    return result
  }
  fun invalidate(tab: NativeTab) { credits[tab.id]?.invalidate() }
  fun committed() { schedule() }
  fun retire(tab: NativeTab) { credits.remove(tab.id)?.stop() }
  fun stop() { active = false; pool.main.removeCallbacks(tick); scheduled = false; credits.values.forEach { it.stop() }; credits.clear() }
  fun foreground(value: Boolean) { if (!value) stop() else { active = true; schedule() } }
  fun close() { stop(); encoder.shutdownNow() }
}
