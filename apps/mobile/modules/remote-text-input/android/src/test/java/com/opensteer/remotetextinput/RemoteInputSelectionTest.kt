package com.opensteer.remotetextinput

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * CR5: the hidden field's selection changes only through the gate. RemoteInputEditText hands
 * every selection change it sees to this decision.
 */
class RemoteInputSelectionTest {
  @Test fun aChangeInAGateTurnIsKeptAndReportedUnlessTheViewMadeIt() {
    val selection = RemoteInputSelection()
    assertEquals(RemoteInputSelection.Outcome.QUIET, selection.changed(7, 7, inGateTurn = true, mutating = true))
    assertEquals(7 to 7, selection.kept)
    // An arrow key's default, run in its gate turn: the person's own keyboard.
    assertEquals(RemoteInputSelection.Outcome.REPORT, selection.changed(6, 6, inGateTurn = true, mutating = false))
    assertEquals(6 to 6, selection.kept)
  }

  @Test fun aChangeOutsideTheGateIsUndoneToWhereTheGateLeftIt() {
    val selection = RemoteInputSelection()
    selection.changed(7, 7, inGateTurn = true, mutating = true)
    // An accessibility long click selecting the word, a drag over the field, a stylus gesture.
    assertEquals(RemoteInputSelection.Outcome.UNDO, selection.changed(0, 7, inGateTurn = false, mutating = false))
    assertEquals(7 to 7, selection.restore(length = 7))
    // The undo's own callback lands where the gate left it, and reports nothing.
    assertEquals(RemoteInputSelection.Outcome.QUIET, selection.changed(7, 7, inGateTurn = false, mutating = true))
    assertEquals(7 to 7, selection.kept)
  }

  @Test fun anUndoNeverReportsAndNeverMovesWhatTheGateKept() {
    val selection = RemoteInputSelection()
    selection.changed(3, 3, inGateTurn = true, mutating = false)
    for ((start, end) in listOf(0 to 0, 1 to 3, 3 to 3, 2 to 2)) {
      val outcome = selection.changed(start, end, inGateTurn = false, mutating = false)
      assertEquals(if (start == 3 && end == 3) RemoteInputSelection.Outcome.QUIET else RemoteInputSelection.Outcome.UNDO, outcome)
      assertEquals(3 to 3, selection.kept)
    }
  }

  @Test fun theViewsOwnChangeOutsideATurnIsKept() {
    // A reset JavaScript sends unasked (answer id 0) is applied outside any gate turn.
    val selection = RemoteInputSelection()
    selection.changed(7, 7, inGateTurn = true, mutating = true)
    assertEquals(RemoteInputSelection.Outcome.QUIET, selection.changed(0, 0, inGateTurn = false, mutating = true))
    assertEquals(0 to 0, selection.kept)
  }

  @Test fun theSelectionGoesBackInsideTheText() {
    val selection = RemoteInputSelection()
    selection.changed(5, 9, inGateTurn = true, mutating = true)
    assertEquals(4 to 4, selection.restore(length = 4))
    assertEquals(5 to 6, selection.restore(length = 6))
  }
}
