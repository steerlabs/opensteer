package com.opensteer.display

import android.content.Context
import android.graphics.Color
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import java.util.concurrent.atomic.AtomicInteger

class PhoneDisplayModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PhoneDisplay")
    View(PhoneDisplayView::class) {
      Events("onReady", "onNeedsKeyframe")
      OnViewDestroys { view: PhoneDisplayView -> view.destroy() }
      AsyncFunction("reset") { view: PhoneDisplayView, epoch: String -> view.reset(epoch) }
      AsyncFunction("decode") { view: PhoneDisplayView, frame: FramePacket, promise: Promise ->
        view.decode(frame.epoch, frame.data, frame.width, frame.height, frame.pts.toLong(), frame.key, frame.replayed, promise)
      }
    }
  }
}

class FramePacket : Record {
  @Field var epoch: String = ""
  @Field var data: String = ""
  @Field var width: Int = 0
  @Field var height: Int = 0
  @Field var pts: Double = 0.0
  @Field var key: Boolean = false
  @Field var replayed: Boolean = false
}

class PhoneDisplayView(context: Context, appContext: AppContext) : ExpoView(context, appContext), SurfaceHolder.Callback {
  val onReady by EventDispatcher()
  val onNeedsKeyframe by EventDispatcher()
  private val surface = SurfaceView(context)
  private val cover = View(context).apply { setBackgroundColor(Color.BLACK) }
  private val thread = HandlerThread("opensteer-display-decoder").apply { start() }
  private val worker = Handler(thread.looper)
  private val pending = AtomicInteger()
  @Volatile private var epoch = ""
  @Volatile private var available = false
  @Volatile private var attached = true
  @Volatile private var visible = true
  @Volatile private var revision = 0L
  private var codec: MediaCodec? = null
  private val output = HashMap<Long, Boolean>()
  @Volatile private var pictureWidth = 0
  @Volatile private var pictureHeight = 0
  private var initialized = false
  private val drain = object : Runnable {
    override fun run() {
      val decoder = codec ?: return
      try { drainOutput(decoder) } catch (_: Exception) { release() }
      if (codec != null) worker.postDelayed(this, 10)
    }
  }
  init {
    addView(surface); addView(cover)
    surface.holder.addCallback(this)
    initialized = true
  }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    layoutPicture()
  }
  private fun layoutPicture() {
    val scale = if (pictureWidth > 0 && pictureHeight > 0) minOf(width.toDouble() / pictureWidth, height.toDouble() / pictureHeight) else 1.0
    val fittedWidth = if (pictureWidth > 0) (pictureWidth * scale).toInt() else width
    val fittedHeight = if (pictureHeight > 0) (pictureHeight * scale).toInt() else height
    val x = (width - fittedWidth) / 2; val y = (height - fittedHeight) / 2
    surface.layout(x, y, x + fittedWidth, y + fittedHeight); cover.layout(0, 0, width, height)
  }
  fun reset(next: String) {
    epoch = next
    revision++
    cover.visibility = View.VISIBLE
    worker.post { release() }
  }
  private fun release() {
    codec?.let { runCatching { it.stop() }; runCatching { it.release() } }
    codec = null
    output.clear()
    worker.removeCallbacks(drain)
  }
  fun decode(wanted: String, base64: String, width: Int, height: Int, pts: Long, key: Boolean, replayed: Boolean, promise: Promise) {
    if (wanted != epoch || !available || !visible || !attached || base64.length > 5_592_408) {
      promise.resolve(false); return
    }
    if (pending.incrementAndGet() > 4) { pending.decrementAndGet(); promise.resolve(false); return }
    val stamp = revision
    worker.post {
      try {
        if (wanted != epoch || stamp != revision || !available || !visible || !attached) { promise.resolve(false); return@post }
        if (codec == null) {
          if (!key) { promise.resolve(false); return@post }
          pictureWidth = width; pictureHeight = height
          // React Native owns the parent layout pass; requesting one does not
          // reliably relayout these Android children when codec geometry arrives.
          post { layoutPicture() }
          val decoder = MediaCodec.createDecoderByType("video/avc")
          try {
            decoder.configure(MediaFormat.createVideoFormat("video/avc", width, height).apply { setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 4 * 1_048_576) }, surface.holder.surface, null, 0)
            decoder.setOnFrameRenderedListener({ _, _, _ -> post {
              if (wanted == epoch && stamp == revision && available && visible && attached && cover.visibility != View.GONE) { cover.visibility = View.GONE; onReady(mapOf("epoch" to wanted, "width" to width, "height" to height)) }
            } }, worker)
            decoder.start(); codec = decoder
            worker.post(drain)
          } catch (error: Exception) { decoder.release(); throw error }
        }
        val decoder = requireNotNull(codec)
        drainOutput(decoder)
        // Replay can arrive faster than output. Wait on this decoder worker before resetting it.
        if (output.size >= 4) drainOutput(decoder, 500_000)
        if (output.size >= 4) { release(); promise.resolve(false); return@post }
        val index = decoder.dequeueInputBuffer(10_000)
        if (index < 0) { promise.resolve(false); return@post }
        val bytes = Base64.decode(base64, Base64.NO_WRAP)
        val buffer = requireNotNull(decoder.getInputBuffer(index))
        if (bytes.size > buffer.capacity()) { release(); promise.resolve(false); return@post }
        buffer.clear(); buffer.put(bytes)
        output[pts] = !replayed
        decoder.queueInputBuffer(index, 0, bytes.size, pts, 0)
        drainOutput(decoder)
        promise.resolve(true)
      } catch (_: Exception) { release(); promise.resolve(false) }
      finally { pending.decrementAndGet() }
    }
  }
  private fun drainOutput(decoder: MediaCodec, firstTimeoutUs: Long = 0) {
    var timeout = firstTimeoutUs
    val info = MediaCodec.BufferInfo()
    while (true) {
      val index = decoder.dequeueOutputBuffer(info, timeout)
      timeout = 0
      if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue
      if (index < 0) return
      val render = output.remove(info.presentationTimeUs) == true && available && visible && attached
      decoder.releaseOutputBuffer(index, render)
    }
  }
  override fun surfaceCreated(holder: SurfaceHolder) {
    available = true
    onNeedsKeyframe(mapOf("epoch" to epoch))
  }
  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit
  override fun surfaceDestroyed(holder: SurfaceHolder) { available = false; reset(epoch) }
  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    visible = visibility == View.VISIBLE
    if (initialized && !visible) reset(epoch)
  }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); attached = true }
  fun destroy() { attached = false; reset(""); worker.post { thread.quitSafely() } }
  override fun onDetachedFromWindow() {
    attached = false; reset(epoch)
    super.onDetachedFromWindow()
  }
}
