package com.opensteer.remotetextinput

import org.junit.Assert.assertEquals
import org.junit.Test

/** CY10: what a multiple key event is, so that all of it goes through the gate. */
class RemoteInputMultipleKeyTest {
  @Test fun aStringOfCharactersIsTypedWhole() {
    assertEquals(RemoteInputMultipleKey.Insert("日本"), RemoteInputMultipleKey.of(unknown = true, repeatCount = 0, characters = "日本"))
  }

  @Test fun aKeyRepeatedIsEachPressInTurn() {
    assertEquals(RemoteInputMultipleKey.Presses(3), RemoteInputMultipleKey.of(unknown = false, repeatCount = 3, characters = null))
  }

  @Test fun nothingToTypeIsNothing() {
    assertEquals(RemoteInputMultipleKey.Nothing, RemoteInputMultipleKey.of(unknown = true, repeatCount = 0, characters = null))
    assertEquals(RemoteInputMultipleKey.Nothing, RemoteInputMultipleKey.of(unknown = false, repeatCount = 0, characters = null))
  }
}
