package com.opensteer.phonebrowser

import org.junit.Assert.*
import org.junit.Test

class IntegerBoundaryTest {
  @Test fun fractionsAndUnsafeNumbersCannotBecomeAnAuthorizedEpochOrRevision() {
    assertEquals(7L, NativeIntegers.parse(7.0))
    for (value in listOf(-1.0, 0.5, 7.9, Double.NaN, Double.POSITIVE_INFINITY, 9007199254740992.0)) {
      assertThrows(BrowserFailure::class.java) { NativeIntegers.parse(value) }
    }
    assertThrows(BrowserFailure::class.java) { NativeIntegers.parse(2147483648.0, Int.MAX_VALUE.toLong()) }
  }
}
