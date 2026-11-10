package com.opensteer.phonebrowser

import org.junit.Assert.*
import org.junit.Test

class BrowserStateTest {
  @Test fun queuedCallsCannotCrossAFence() {
    val gate = EpochGate()
    val issued = gate.epoch
    var mutations = 0
    val queued = { gate.execute(issued) { mutations++ } }
    gate.advance()
    assertEquals("stale-epoch", assertThrows(BrowserFailure::class.java) { queued() }.reason)
    assertEquals(0, mutations)
    gate.execute(gate.epoch) { mutations++ }
    assertEquals(1, mutations)
  }

  @Test fun twoLiveAndFourRetainedAreGlobalBounds() {
    val pool = PoolLedger()
    pool.create("person"); pool.create("actor")
    assertEquals("target-suspended", assertThrows(BrowserFailure::class.java) { pool.create("third") }.reason)
    pool.retain("person")
    pool.create("third")
    assertThrows(BrowserFailure::class.java) { pool.resume("person") }
    assertEquals(TabState.RETAINED, pool.state("person"))
    pool.retain("actor"); pool.retain("third")
    pool.create("fourth"); pool.retain("fourth")
    pool.resume("person"); pool.retain("person")
    pool.create("fifth")
    assertEquals(listOf("actor"), pool.retain("fifth"))
    assertEquals(TabState.DISCARDED, pool.state("actor"))
    assertEquals(listOf("third", "fourth", "person", "fifth"), pool.retainedIds())
    assertEquals(TabState.RETAINED, pool.resume("person"))
  }

  @Test fun anchorsUseElementDisplacementAndClampTheFallback() {
    assertEquals(1050.0, AnchorMath.offset(900.0, 140.0, -10.0, 2000.0), 0.001)
    assertEquals(700.0, AnchorMath.offset(900.0, null, -10.0, 700.0), 0.001)
    assertEquals(0.0, AnchorMath.offset(30.0, -400.0, 10.0, 500.0), 0.001)
    assertEquals(0.0, AnchorMath.offset(30.0, null, 0.0, -5.0), 0.001)
  }

  @Test fun markersNeverGuessFromOtherTargets() {
    assertEquals("owned", TargetMarkers.match("fresh", mapOf("foreign" to null, "owned" to "fresh")))
    assertThrows(BrowserFailure::class.java) { TargetMarkers.match("fresh", mapOf("foreign" to "old")) }
    assertThrows(BrowserFailure::class.java) { TargetMarkers.match("fresh", mapOf("first" to "fresh", "second" to "fresh")) }
  }

  @Test fun captureHasNoWorkWithoutDemandAndOnlyExactAcknowledgementsRestoreCredit() {
    val credit = CaptureCredit()
    assertNull(credit.density())
    credit.demand("viewer", 0.5, true)
    assertEquals(0.5, credit.density()!!, 0.001)
    credit.issue("viewer", "frame")
    assertNull(credit.density())
    assertThrows(BrowserFailure::class.java) { credit.ack("other", "frame") }
    assertThrows(BrowserFailure::class.java) { credit.ack("viewer", "stale") }
    assertNull(credit.density())
    credit.ack("viewer", "frame")
    assertEquals(0.5, credit.density()!!, 0.001)
    credit.stop()
    assertNull(credit.density())
    assertThrows(BrowserFailure::class.java) { credit.ack("viewer", "frame") }
  }
  @Test fun navigationRetiresFrameCreditButKeepsViewerDemand() {
    val credit = CaptureCredit()
    credit.demand("viewer", 0.5, true)
    credit.issue("viewer", "old-document-frame")
    credit.invalidate()
    assertEquals(0.5, credit.density()!!, 0.001)
    assertThrows(BrowserFailure::class.java) { credit.ack("viewer", "old-document-frame") }
    credit.issue("viewer", "new-document-frame")
    assertNull(credit.density())
  }

  @Test fun aSlowViewerCannotConsumeAnotherViewersFrameCredit() {
    val credit = CaptureCredit()
    credit.demand("slow", 1.0, true)
    credit.demand("person", 0.5, true)
    credit.issue("slow", "slow-frame")
    assertEquals("person", credit.channel())
    assertEquals(1.0, credit.density()!!, 0.001)
    credit.issue("person", "person-frame")
    assertNull(credit.channel())
    credit.ack("person", "person-frame")
    assertEquals("person", credit.channel())
    assertThrows(BrowserFailure::class.java) { credit.ack("slow", "person-frame") }
    credit.demand("slow", 1.0, false)
    assertEquals(0.5, credit.density()!!, 0.001)
    assertThrows(BrowserFailure::class.java) { credit.ack("slow", "slow-frame") }
  }

}
