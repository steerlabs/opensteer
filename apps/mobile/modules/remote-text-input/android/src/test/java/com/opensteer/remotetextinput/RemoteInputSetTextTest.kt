package com.opensteer.remotetextinput

import org.junit.Assert.assertEquals
import org.junit.Test

/** CZ1: a set-text with nothing editable is refused, never TextView's own outside the gate. */
class RemoteInputSetTextTest {
  @Test fun anEditableFieldTakesItThroughTheGate() {
    assertEquals(RemoteInputSetText.THROUGH_GATE, RemoteInputSetText.of(editable = true))
  }

  @Test fun nothingEditableRefusesIt() {
    assertEquals(RemoteInputSetText.REFUSED, RemoteInputSetText.of(editable = false))
  }
}
