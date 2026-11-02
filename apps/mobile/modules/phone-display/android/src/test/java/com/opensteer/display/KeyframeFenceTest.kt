package com.opensteer.display

import org.junit.Assert.*
import org.junit.Test

class KeyframeFenceTest {
  @Test fun queuedKeyCannotRepairALaterDrop() {
    val fence = KeyframeFence()
    assertFalse(fence.allows(false))
    val queuedKey = fence.captureLoss()
    fence.lost()
    fence.enqueued(true, queuedKey)
    assertFalse(fence.allows(false))
    assertTrue(fence.allows(true))
    fence.enqueued(true, fence.captureLoss())
    assertTrue(fence.allows(false))
    fence.lost()
    fence.enqueued(false, fence.captureLoss())
    assertFalse(fence.allows(false))
  }
}
