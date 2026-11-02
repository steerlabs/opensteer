package com.opensteer.display

import java.util.concurrent.atomic.AtomicInteger

/** Loss can arrive on the view thread while a key is queued on the decoder worker. */
internal class KeyframeFence {
  private val losses = AtomicInteger(1)
  private var admittedLoss = 0
  fun lost() { losses.incrementAndGet() }
  fun captureLoss(): Int = losses.get()
  fun allows(key: Boolean): Boolean = key || admittedLoss == losses.get()
  fun enqueued(key: Boolean, lossAtIngress: Int) { if (key) admittedLoss = lossAtIngress }
}
