package com.opensteer.display

import java.util.concurrent.atomic.AtomicLong

/**
 * Frames are numbered as they arrive, on the view thread, and decoded later in
 * that order on the decoder worker. A key repairs every loss numbered before
 * it and none after: not a frame dropped behind it while it waited, nor a loss
 * with no frame of its own, which takes the next number.
 */
internal class KeyframeFence {
  private val arrived = AtomicLong(0)
  private val lostThrough = AtomicLong(0)
  @Volatile private var repairedThrough = -1L
  fun arrive(): Long = arrived.incrementAndGet()
  fun lost(frame: Long = arrive()) { lostThrough.accumulateAndGet(frame, ::maxOf) }
  fun allows(key: Boolean): Boolean = key || repairedThrough >= lostThrough.get()
  fun enqueued(key: Boolean, frame: Long) { if (key && frame > repairedThrough) repairedThrough = frame }
}
