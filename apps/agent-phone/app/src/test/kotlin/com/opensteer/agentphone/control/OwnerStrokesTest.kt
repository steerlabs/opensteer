package com.opensteer.agentphone.control

import android.view.KeyEvent
import com.opensteer.agentphone.wire.DisplayInput
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * CX2: what the phone screen's focused app is sent. Undo and redo each become exactly one chord,
 * once (the app's own undo); an insertion, a backward deletion (at the start too: one Backspace,
 * the editor does nothing with it) and a move each become what they should.
 */
class OwnerStrokesTest {
    @Test fun undoAndRedoAreEachExactlyOneChordOfTheAppsOwn() {
        assertEquals(listOf(OwnerStrokes.Chord(KeyEvent.KEYCODE_Z, KeyEvent.META_CTRL_ON)), OwnerStrokes.of(DisplayInput.Command("undo")))
        assertEquals(
            listOf(OwnerStrokes.Chord(KeyEvent.KEYCODE_Z, KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON)),
            OwnerStrokes.of(DisplayInput.Command("redo")),
        )
    }

    @Test fun anInsertionADeletionAndAMoveAreWhatTheyShouldBe() {
        assertEquals(listOf(OwnerStrokes.Commit("a")), OwnerStrokes.of(DisplayInput.Insert("a")))
        assertEquals(listOf(OwnerStrokes.Commit("pasted")), OwnerStrokes.of(DisplayInput.Paste("pasted")))
        // A backward deletion, at the start of the text too: one Backspace each, nothing else.
        assertEquals(listOf(OwnerStrokes.Chord(KeyEvent.KEYCODE_DEL, 0)), OwnerStrokes.of(DisplayInput.Delete(1)))
        assertEquals(listOf(OwnerStrokes.Chord(KeyEvent.KEYCODE_DEL, 0)), OwnerStrokes.of(DisplayInput.Command("deleteBackward")))
        assertEquals(List(3) { OwnerStrokes.Chord(KeyEvent.KEYCODE_DEL, 0) }, OwnerStrokes.of(DisplayInput.Delete(3)))
        assertEquals(listOf(OwnerStrokes.Chord(KeyEvent.KEYCODE_DPAD_LEFT, 0)), OwnerStrokes.of(DisplayInput.Command("moveBackward")))
        assertEquals(listOf(OwnerStrokes.Chord(KeyEvent.KEYCODE_DPAD_RIGHT, 0)), OwnerStrokes.of(DisplayInput.Command("moveForward")))
        assertEquals(listOf(OwnerStrokes.Menu(android.R.id.selectAll)), OwnerStrokes.of(DisplayInput.Command("selectAll")))
        assertEquals(null, OwnerStrokes.of(DisplayInput.Command("yank")))
    }
}
