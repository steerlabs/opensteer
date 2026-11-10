package com.opensteer.phonebrowser

import org.junit.Assert.*
import org.junit.Test

class InputAndAuthorityTest {
  @Test fun inputLanesRejectDuplicatesAndRetiredGenerationsBeforeSubmission() {
    val lane = InputSequences()
    lane.accept("channel", "producer", 2, 10, 10)
    assertThrows(BrowserFailure::class.java) { lane.accept("channel", "producer", 2, 10, 10) }
    assertThrows(BrowserFailure::class.java) { lane.accept("channel", "producer", 1, 11, 11) }
    lane.accept("channel", "producer", 2, 10, 11)
    lane.accept("channel", "producer", 3, 4, 4)
    assertThrows(BrowserFailure::class.java) { lane.accept("channel", "producer", 2, 10, 12) }
  }

  @Test fun authorityCannotBeInferredFromGlobalDebuggingOrAStringHandle() {
    val permits = CdpPermits()
    assertThrows(BrowserFailure::class.java) { permits.require("guessed", 0) }
    permits.grant("verified", 4, "channel")
    assertThrows(BrowserFailure::class.java) { permits.require("verified", 3) }
    assertEquals("channel", permits.require("verified", 4))
    permits.clear()
    assertThrows(BrowserFailure::class.java) { permits.require("verified", 4) }
  }
}
