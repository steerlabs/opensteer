package com.opensteer.display

/** What became of one delivered picture. JavaScript returns the delivery's receipt on every outcome. */
enum class PictureOutcome(val wire: String) { PRESENTED("presented"), FAILED("failed"), DROPPED("dropped") }

/** One delivered picture as JavaScript describes it. */
data class PictureRequest(
  /** The view's clear generation the delivery was sent for; an older one never draws. */
  val generation: Int,
  /** Pictures sharing a fence share input geometry; a newer one under another fence supersedes a decode in progress. */
  val fence: String,
  /** The encoded raster, which the decoded image must match exactly. */
  val width: Int,
  val height: Int,
  /** The page region the raster shows, laid out with aspect-fit. */
  val regionWidth: Double,
  val regionHeight: Double,
  /** A cropped capture keeps native size rather than growing past it. */
  val upscale: Boolean,
  val cornerRadius: Double,
) {
  /** Where the raster draws inside a view of this size, centred as [left, top, right, bottom]; null when either is empty. */
  fun rect(viewWidth: Double, viewHeight: Double): DoubleArray? {
    if (!listOf(viewWidth, viewHeight, width.toDouble(), height.toDouble(), regionWidth, regionHeight).all { it.isFinite() && it > 0 }) return null
    val scale = minOf(if (upscale) Double.POSITIVE_INFINITY else 1.0, viewWidth / regionWidth, viewHeight / regionHeight)
    val fittedWidth = regionWidth * scale
    val fittedHeight = regionHeight * scale
    val left = (viewWidth - fittedWidth) / 2
    val top = (viewHeight - fittedHeight) / 2
    return doubleArrayOf(left, top, left + fittedWidth, top + fittedHeight)
  }
}

/** Settles one delivery once; later calls do nothing. */
class PictureReceipt(settle: (PictureOutcome) -> Unit) {
  private var settle: ((PictureOutcome) -> Unit)? = settle
  operator fun invoke(outcome: PictureOutcome) {
    val current = settle
    settle = null
    current?.invoke(outcome)
  }
}

/**
 * One view's deliveries: at most one decoding and the newest waiting, so
 * memory stays bounded at the shown bitmap, one decoding and one encoded
 * picture. Confined to the main thread; decoding happens elsewhere.
 */
class PictureQueue<Payload> {
  class Job<Payload>(val request: PictureRequest, val payload: Payload, val receipt: PictureReceipt)

  var generation = 0
    private set
  /** Stays true after a clear until the abandoned decode returns, so two never run together. */
  private var running = false
  private var decoding: Job<Payload>? = null
  private var pending: Job<Payload>? = null

  /** Takes a delivery and returns the job to decode now, if the decoder is free. */
  fun submit(request: PictureRequest, payload: Payload, receipt: PictureReceipt): Job<Payload>? {
    if (request.generation != generation) { receipt(PictureOutcome.DROPPED); return null }
    val job = Job(request, payload, receipt)
    if (running) {
      pending?.receipt?.invoke(PictureOutcome.DROPPED)
      pending = job
      return null
    }
    running = true
    decoding = job
    return job
  }

  /** The running decode returned: [Pair.first] draws now and then settles presented; [Pair.second] decodes next. */
  fun complete(decoded: Boolean): Pair<Job<Payload>?, Job<Payload>?> {
    running = false
    var shown: Job<Payload>? = null
    decoding?.let { finished ->
      decoding = null
      when {
        !decoded -> finished.receipt(PictureOutcome.FAILED)
        finished.request.generation != generation || pending.let { it != null && it.request.fence != finished.request.fence } ->
          finished.receipt(PictureOutcome.DROPPED)
        else -> shown = finished
      }
    }
    val next = pending ?: return shown to null
    pending = null
    running = true
    decoding = next
    return shown to next
  }

  /** Drops every delivery not yet shown; only [next] may draw afterwards. */
  fun clear(next: Int) {
    generation = next
    decoding?.receipt?.invoke(PictureOutcome.DROPPED)
    decoding = null
    pending?.receipt?.invoke(PictureOutcome.DROPPED)
    pending = null
  }
}
