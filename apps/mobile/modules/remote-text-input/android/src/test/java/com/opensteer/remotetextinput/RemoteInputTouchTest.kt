package com.opensteer.remotetextinput

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A touch on the hidden typing field focuses it and does nothing else: nothing a person cannot see
 * is ever selected by touch, and a long press still offers Paste. RemoteInputEditText hands every
 * touch to this decision and none to TextView, whose own handling selects a word on a double tap
 * or a long press.
 */
class RemoteInputTouchTest {
  private val touch = RemoteInputTouch(longPressMs = 500, slop = 8f)
  private fun tap(at: Long) = listOf(
    touch.onTouch(RemoteInputTouch.Action.DOWN, at, 10f, 10f),
    touch.onTouch(RemoteInputTouch.Action.UP, at + 80, 10f, 10f),
  )

  @Test fun aTapFocusesTheField() {
    assertEquals(listOf(null, RemoteInputTouch.Outcome.FOCUS), tap(0))
  }

  @Test fun aDoubleTapOnlyFocusesTheFieldTwiceAndSelectsNothing() {
    assertEquals(listOf(null, RemoteInputTouch.Outcome.FOCUS, null, RemoteInputTouch.Outcome.FOCUS), tap(0) + tap(150))
  }

  @Test fun aLongPressOffersPasteOnceAndItsDragSelectsNothing() {
    touch.onTouch(RemoteInputTouch.Action.DOWN, 0, 10f, 10f)
    assertEquals(RemoteInputTouch.Outcome.OFFER_PASTE, touch.longPress(500))
    assertEquals(null, touch.onTouch(RemoteInputTouch.Action.MOVE, 600, 120f, 10f))
    assertEquals(null, touch.onTouch(RemoteInputTouch.Action.UP, 700, 120f, 10f))
    assertEquals(null, touch.longPress(800))
  }

  @Test fun aPressThatMovesIsNeitherATapNorALongPress() {
    touch.onTouch(RemoteInputTouch.Action.DOWN, 0, 10f, 10f)
    assertEquals(null, touch.onTouch(RemoteInputTouch.Action.MOVE, 100, 40f, 10f))
    assertEquals(null, touch.longPress(500))
    assertEquals(null, touch.onTouch(RemoteInputTouch.Action.UP, 600, 40f, 10f))
  }

  @Test fun aCancelledPressDoesNothing() {
    touch.onTouch(RemoteInputTouch.Action.DOWN, 0, 10f, 10f)
    assertEquals(null, touch.onTouch(RemoteInputTouch.Action.CANCEL, 100, 10f, 10f))
    assertEquals(null, touch.longPress(500))
  }
}
