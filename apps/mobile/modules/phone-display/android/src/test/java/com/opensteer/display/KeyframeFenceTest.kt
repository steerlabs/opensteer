package com.opensteer.display

import org.junit.Assert.*
import org.junit.Test

class KeyframeFenceTest {
  @Test fun startsAwaitingAKey() {
    val fence = KeyframeFence()
    assertFalse(fence.allows(false))
    fence.enqueued(true, fence.arrive())
    assertTrue(fence.allows(false))
  }

  @Test fun queuedKeyCannotRepairALaterDrop() {
    val fence = KeyframeFence()
    val key = fence.arrive()
    fence.lost(fence.arrive())
    fence.enqueued(true, key)
    assertFalse(fence.allows(false))
    fence.enqueued(true, fence.arrive())
    assertTrue(fence.allows(false))
  }

  @Test fun queuedKeyRepairsAnEarlierQueuedFrameThatFails() {
    val fence = KeyframeFence()
    fence.enqueued(true, fence.arrive())
    fence.lost()
    val delta = fence.arrive()
    val key = fence.arrive()
    // The worker refuses the delta, then admits the key queued behind it.
    fence.lost(delta)
    fence.enqueued(true, key)
    assertTrue(fence.allows(false))
  }

  @Test fun aLossWithoutAFrameNeedsALaterKey() {
    val fence = KeyframeFence()
    val key = fence.arrive()
    fence.lost()
    fence.enqueued(true, key)
    assertFalse(fence.allows(false))
  }
}
