package com.opensteer.remotetextinput

import org.junit.Assert.assertEquals
import org.junit.Test

/** CS4: the hidden field's undo and redo are the far page's own chords. */
class RemoteInputUndoTest {
  @Test fun undoIsControlZAndRedoIsControlShiftZ() {
    fun shape(packet: Map<String, Any?>) = "${packet["type"]} ${packet["key"]} control ${packet["control"]} shift ${packet["shift"]}"
    assertEquals(listOf("keydown z control true shift false", "keyup z control true shift false"), RemoteInputUndo.chord(redo = false).map(::shape))
    assertEquals(listOf("keydown Z control true shift true", "keyup Z control true shift true"), RemoteInputUndo.chord(redo = true).map(::shape))
  }
}
