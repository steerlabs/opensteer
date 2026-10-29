package com.opensteer.agentphone.control

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Typing as a person types: at the cursor, replacing a selection.
 * Failure modes: text appended over a selection, a cursor left before the
 * typed text, a reversed or out-of-range selection, a surrogate pair split.
 */
class TextInputTest {
    @Test
    fun insertsAtTheCursorAndPlacesItAfterTheText() {
        assertEquals(TextInsertion("abXYcd", 4), TextInsertion.insert("abcd", 2, 2, "XY"))
        assertEquals(TextInsertion("aXYd", 3), TextInsertion.insert("abcd", 1, 3, "XY"))
        assertEquals(TextInsertion("aXYd", 3), TextInsertion.insert("abcd", 3, 1, "XY"))
        assertEquals(TextInsertion("abcd😀", 6), TextInsertion.insert("abcd", -1, -1, "😀"))
        assertEquals(TextInsertion("abcdé", 5), TextInsertion.insert("abcd", 9, 9, "é"))
        assertEquals(TextInsertion("😀x😀", 3), TextInsertion.insert("😀😀", 2, 2, "x"))
        assertEquals(TextInsertion("שלוםabc", 4), TextInsertion.insert("abc", 0, 0, "שלום"))
    }
    @Test fun deletesAtCursorAndReplacesSelectionWithoutSplittingSurrogates() {
        assertEquals(TextInsertion("ac", 1), TextInsertion.deleteBackward("abc", 2, 2, 1))
        assertEquals(TextInsertion("ad", 1), TextInsertion.deleteBackward("abcd", 3, 1, 1))
        assertEquals(TextInsertion("ab", 1), TextInsertion.deleteBackward("a😀b", 3, 3, 1))
        assertEquals(TextInsertion("", 0), TextInsertion.deleteBackward("abc", -1, -1, 100))
    }

}
