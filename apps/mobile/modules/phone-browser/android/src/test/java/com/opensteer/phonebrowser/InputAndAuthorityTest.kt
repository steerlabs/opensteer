package com.opensteer.phonebrowser

import org.junit.Assert.*
import org.junit.Test

class InputAndAuthorityTest {
  @Test fun inputLanesRejectDuplicatesAndRetiredGenerationsBeforeSubmission() {
    val lane = InputSequences()
    lane.accept("channel", "producer", 2, 10, 10)
    assertThrows(BrowserFailure::class.java) { lane.accept("channel", "producer", 2, 10, 10) }
    assertThrows(BrowserFailure::class.java) { lane.accept("channel", "producer", 1, 11, 11) }
    lane.accept("channel", "producer", 2, 11, 11)
    assertThrows(BrowserFailure::class.java) { lane.accept("channel", "producer", 2, 11, 12) }
    lane.accept("channel", "producer", 3, 4, 4)
    assertThrows(BrowserFailure::class.java) { lane.accept("channel", "producer", 2, 10, 12) }
  }

  @Test fun hostInputPacketsAcceptAbsentAndCoalescedSequenceStartsButNotMalformedNumbers() {
    val lane = InputSequences()
    val pointer = mapOf("type" to "input.pointer", "producerId" to "producer", "inputGeneration" to 0.0,
      "inputSequence" to 1.0, "action" to "down", "button" to "left", "x" to 0.15, "y" to 0.015)
    lane.accept("channel", pointer)
    lane.accept("channel", pointer + mapOf("action" to "up", "inputSequence" to 2.0))
    lane.accept("channel", pointer + mapOf("type" to "clipboard.paste", "inputSequence" to 3.0, "text" to "viewer typed"))
    lane.accept("channel", pointer + mapOf("inputSequenceStart" to 4.0, "inputSequence" to 6.0))
    assertThrows(BrowserFailure::class.java) { lane.accept("channel", pointer + mapOf("inputSequenceStart" to 6.0, "inputSequence" to 8.0)) }
    for (value in listOf(null, 7.5, Double.NaN, Double.POSITIVE_INFINITY, -1.0))
      assertThrows(BrowserFailure::class.java) { lane.accept("channel", pointer + ("inputSequence" to value)) }
    assertThrows(BrowserFailure::class.java) { lane.accept("channel", pointer + mapOf("inputSequenceStart" to 7.5, "inputSequence" to 8.0)) }
    lane.accept("channel", pointer + mapOf("inputGeneration" to 1.0, "inputSequence" to 1.0))
    assertThrows(BrowserFailure::class.java) { lane.accept("channel", pointer + ("inputSequence" to 7.0)) }
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
