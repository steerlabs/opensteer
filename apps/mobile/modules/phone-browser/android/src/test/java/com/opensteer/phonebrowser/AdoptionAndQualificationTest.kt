package com.opensteer.phonebrowser

import org.junit.Assert.*
import org.junit.Test

class AdoptionAndQualificationTest {
  private fun adopt(epoch: Int = 3, allocated: Int = 2, state: TabState = TabState.RETAINED,
    session: String = "old", generation: Int = 7, previousSession: String = "old", previousGeneration: Int = 7,
    store: String = "store", requested: String? = "store", guestOwner: String? = null) =
    RetainedTabAdoption.require(epoch, allocated, state, session, generation, previousSession, previousGeneration, store, requested, guestOwner)

  @Test fun reconnectAdoptsOnlyTheExactRetainedAllocationAndStorage() {
    adopt()
    adopt(state = TabState.DISCARDED)
    adopt(requested = null, guestOwner = "old")
    assertThrows(BrowserFailure::class.java) { adopt(epoch = 2) }
    assertThrows(BrowserFailure::class.java) { adopt(epoch = 1) }
    assertThrows(BrowserFailure::class.java) { adopt(state = TabState.LIVE) }
    assertThrows(BrowserFailure::class.java) { adopt(previousSession = "other") }
    assertThrows(BrowserFailure::class.java) { adopt(previousGeneration = 6) }
    assertThrows(BrowserFailure::class.java) { adopt(requested = "other-store") }
    assertThrows(BrowserFailure::class.java) { adopt(requested = null) }
    assertThrows(BrowserFailure::class.java) { adopt(requested = null, guestOwner = "other") }
    assertThrows(BrowserFailure::class.java) { adopt(guestOwner = "old") }
  }

  @Test fun debuggerShutdownFailureOnlyRemovesCdpAndNeverInventsOtherAbilities() {
    val receipts = mapOf("native browser" to true, "native input" to true, "native picture" to true,
      "native staging" to true, "passed" to true, "clipboard denial" to true)
    assertEquals(BrowserQualification(true, true, true, true), BrowserQualification.from(receipts, true, true))
    assertEquals(BrowserQualification(true, true, true, false), BrowserQualification.from(receipts, true, false))
    assertEquals(BrowserQualification(true, true, true, false), BrowserQualification.from(receipts, false, true))
    assertFalse(BrowserQualification.from(receipts - "clipboard denial", true, true).cdpBoundary)
    assertFalse(BrowserQualification.from(receipts - "native input", true, true).sharedControl)
    assertFalse(BrowserQualification.from(receipts - "native picture", true, true).sharedControl)
    assertFalse(BrowserQualification.from(receipts - "native staging", true, true).fileStaging)
    assertEquals(BrowserQualification(false, false, false, false), BrowserQualification.from(emptyMap(), true, true))
  }
}
