package com.opensteer.display

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.media.MediaCodec
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
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
    // JavaScript reads this before using decodeBytes or the picture view: an
    // older binary has neither, and keeps the base64 and Image paths.
    Constant("binaryPresentationVersion") { 1 }
    // The first view stays the module's default view, which older JavaScript requires by module name.
    View(PhoneDisplayView::class) {
      Events("onReady", "onNeedsKeyframe")
      OnViewDestroys { view: PhoneDisplayView -> view.destroy() }
      AsyncFunction("reset") { view: PhoneDisplayView, epoch: String -> view.reset(epoch) }
      AsyncFunction("decode") { view: PhoneDisplayView, frame: FramePacket, promise: Promise ->
        val data = frame.data
        if (data.length > 5_592_408) promise.resolve(false)
        else view.decode(FrameMetadata(frame), promise) { Base64.decode(data, Base64.NO_WRAP) }
      }
      // Expo copies the Uint8Array into a ByteArray once, on the JavaScript thread.
      AsyncFunction("decodeBytes") { view: PhoneDisplayView, bytes: ByteArray, metadata: FrameMetadata, promise: Promise ->
        if (bytes.size > 4_194_306) promise.resolve(false) else view.decode(metadata, promise) { bytes }
      }
    }
    View(PhoneDisplayPictureView::class) {
      Name("PhoneDisplayPicture")
      Events("onCleared")
      OnViewDestroys { view: PhoneDisplayPictureView -> view.destroy() }
      AsyncFunction("clear") { view: PhoneDisplayPictureView, generation: Int -> view.clear(generation) }
      AsyncFunction("present") { view: PhoneDisplayPictureView, bytes: ByteArray, metadata: PictureMetadata, promise: Promise ->
        view.present(bytes, metadata.request()) { promise.resolve(it.wire) }
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

class FrameMetadata() : Record {
  @Field var epoch: String = ""
  @Field var width: Int = 0
  @Field var height: Int = 0
  @Field var pts: Double = 0.0
  @Field var key: Boolean = false
  @Field var replayed: Boolean = false
  constructor(packet: FramePacket) : this() {
    epoch = packet.epoch; width = packet.width; height = packet.height
    pts = packet.pts; key = packet.key; replayed = packet.replayed
  }
}

class PictureMetadata : Record {
  @Field var generation: Int = 0
  @Field var fence: String = ""
  @Field var width: Int = 0
  @Field var height: Int = 0
  @Field var regionWidth: Double = 0.0
  @Field var regionHeight: Double = 0.0
  @Field var upscale: Boolean = true
  @Field var cornerRadius: Double = 0.0
  fun request() = PictureRequest(generation, fence, width, height, regionWidth, regionHeight, upscale, cornerRadius)
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
  /** [read] runs on the decoder thread, so base64 is decoded only for a frame the codec can take. */
  fun decode(frame: FrameMetadata, promise: Promise, read: () -> ByteArray) {
    val wanted = frame.epoch; val width = frame.width; val height = frame.height
    val pts = frame.pts.toLong(); val key = frame.key; val replayed = frame.replayed
    if (wanted != epoch || !available || !visible || !attached) {
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
          val format = MediaFormat.createVideoFormat("video/avc", width, height)
          // The first AVC decoder may not take this size (the emulator's starts at 96 × 96) and then never outputs.
          val decoder = MediaCodec.createByCodecName(requireNotNull(decoders.findDecoderForFormat(format)))
          try {
            decoder.configure(format.apply { setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 4 * 1_048_576) }, surface.holder.surface, null, 0)
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
        val bytes = read()
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

  private companion object {
    val decoders by lazy { MediaCodecList(MediaCodecList.REGULAR_CODECS) }
  }
}

/**
 * A browser picture surface: deliveries decode off the main thread and only
 * the newest finished bitmap replaces the one shown. Pixels live only in this
 * view, and clear before anything else may aim input at them.
 */
class PhoneDisplayPictureView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val onCleared by EventDispatcher()
  private val thread = HandlerThread("opensteer-picture-decoder").apply { start() }
  private val worker = Handler(thread.looper)
  private val main = Handler(Looper.getMainLooper())
  private val queue = PictureQueue<ByteArray>()
  // A picture that never draws loses its pixels, so JavaScript stops aiming at them.
  private val picture = PictureSurface(context) { onCleared(mapOf("generation" to queue.generation)) }
  private var attached = false
  private var visible = true
  private var destroyed = false
  init { addView(picture) }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    picture.layout(0, 0, width, height)
  }
  private val showing get() = attached && visible && !destroyed
  fun clear(generation: Int) {
    queue.clear(generation)
    picture.show(null, null)
  }
  /** Leaves the generation alone: the same deliveries may draw once the view is shown again. */
  private fun blank() {
    queue.clear(queue.generation)
    if (picture.show(null, null)) onCleared(mapOf("generation" to queue.generation))
  }
  fun present(bytes: ByteArray, request: PictureRequest, settle: (PictureOutcome) -> Unit) {
    val receipt = PictureReceipt(settle)
    if (!showing) { receipt(PictureOutcome.DROPPED); return }
    queue.submit(request, bytes, receipt)?.let(::decode)
  }
  private fun decode(job: PictureQueue.Job<ByteArray>) {
    worker.post {
      val bitmap = runCatching { decodeBitmap(job.payload, job.request.width, job.request.height) }.getOrNull()
      main.post {
        val (shown, next) = queue.complete(bitmap != null)
        if (shown != null && bitmap != null) {
          if (showing) picture.show(bitmap, shown.request, shown.receipt)
          else shown.receipt(PictureOutcome.DROPPED)
        }
        next?.let(::decode)
      }
    }
  }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); attached = true }
  override fun onDetachedFromWindow() {
    attached = false; blank()
    super.onDetachedFromWindow()
  }
  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    visible = visibility == View.VISIBLE
    if (!visible) blank()
  }
  fun destroy() {
    destroyed = true
    queue.clear(queue.generation)
    picture.show(null, null)
    thread.quitSafely()
  }

  private companion object {
    /** A raster other than the one declared is never shown: input geometry follows the declaration. */
    fun decodeBitmap(bytes: ByteArray, width: Int, height: Int): Bitmap? {
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
      if (bounds.outWidth != width || bounds.outHeight != height) return null
      return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.takeIf { it.width == width && it.height == height }
    }
  }
}

/**
 * Draws the one shown bitmap into its aspect-fit rect. A picture settles as
 * presented only when it is actually drawn, so input never aims at one that
 * was replaced or cleared first. A view that does not draw it within a bounded
 * wait drops it and removes its pixels, so it can never appear later without
 * a receipt that describes it.
 */
private class PictureSurface(context: Context, private val abandoned: () -> Unit) : View(context) {
  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val clip = Path()
  private val target = RectF()
  private var bitmap: Bitmap? = null
  private var request: PictureRequest? = null
  private var undrawn: PictureReceipt? = null
  private val abandon = Runnable { if (show(null, null)) abandoned() }
  /** Returns whether a picture was on screen before. */
  fun show(next: Bitmap?, nextRequest: PictureRequest?, receipt: PictureReceipt? = null): Boolean {
    val had = bitmap != null
    settle(PictureOutcome.DROPPED)
    bitmap = next
    request = nextRequest
    undrawn = receipt
    if (receipt != null) postDelayed(abandon, 1_000)
    invalidate()
    return had
  }
  private fun settle(outcome: PictureOutcome) {
    removeCallbacks(abandon)
    undrawn?.invoke(outcome)
    undrawn = null
  }
  override fun onDraw(canvas: Canvas) {
    val shown = bitmap ?: return
    // Laid out in density-independent pixels, as React Native lays out the page around it.
    val density = resources.displayMetrics.density
    // An empty view leaves the receipt to the bounded wait: a later layout may still draw it.
    val rect = request?.rect(width / density.toDouble(), height / density.toDouble()) ?: return
    target.set(rect[0].toFloat() * density, rect[1].toFloat() * density, rect[2].toFloat() * density, rect[3].toFloat() * density)
    val radius = (request?.cornerRadius ?: 0.0).toFloat() * density
    canvas.save()
    if (radius > 0) {
      clip.reset(); clip.addRoundRect(target, radius, radius, Path.Direction.CW)
      canvas.clipPath(clip)
    }
    canvas.drawBitmap(shown, null, target, paint)
    canvas.restore()
    settle(PictureOutcome.PRESENTED)
  }
}
