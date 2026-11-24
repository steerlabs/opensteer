package com.opensteer.agentphone.control

import android.view.KeyEvent
import com.opensteer.agentphone.wire.DisplayInput

/**
 * What the phone screen's focused app is sent for a viewer's caret-relative input or command, in
 * order: committed text, a key chord, or a context-menu action. OwnerEditing performs each step in
 * the bound editor; this is the whole decision, so a JVM test holds it (OwnerStrokesTest).
 */
internal object OwnerStrokes {
    sealed interface Step
    data class Commit(val text: String) : Step
    data class Chord(val code: Int, val meta: Int) : Step
    data class Menu(val id: Int) : Step

    /** The steps for `event`, or null when the focused app is sent nothing for it. */
    fun of(event: DisplayInput): List<Step>? = when (event) {
        is DisplayInput.Insert -> listOf(Commit(event.text))
        is DisplayInput.Paste -> listOf(Commit(event.text))
        is DisplayInput.Delete -> List(event.count) { Chord(KeyEvent.KEYCODE_DEL, 0) }
        is DisplayInput.Command ->
            if (event.command == "selectAll") listOf(Menu(android.R.id.selectAll))
            else command(event.command)?.let { (code, meta) -> listOf(Chord(code, meta)) }
        else -> null
    }

    /** An editing command as the key chord Android's editors take for it. */
    fun command(name: String): Pair<Int, Int>? {
        val shift = if (name.endsWith("AndModifySelection")) KeyEvent.META_SHIFT_ON else 0
        val plain = name.removeSuffix("AndModifySelection")
        val key = when (plain) {
            "undo", "redo" -> KeyEvent.KEYCODE_Z
            "moveBackward" -> KeyEvent.KEYCODE_DPAD_LEFT; "moveForward" -> KeyEvent.KEYCODE_DPAD_RIGHT
            "moveUp" -> KeyEvent.KEYCODE_DPAD_UP; "moveDown" -> KeyEvent.KEYCODE_DPAD_DOWN
            "moveWordLeft" -> KeyEvent.KEYCODE_DPAD_LEFT; "moveWordRight" -> KeyEvent.KEYCODE_DPAD_RIGHT
            "moveToLeftEndOfLine", "moveToBeginningOfLine", "moveToBeginningOfDocument" -> KeyEvent.KEYCODE_MOVE_HOME
            "moveToRightEndOfLine", "moveToEndOfLine", "moveToEndOfDocument" -> KeyEvent.KEYCODE_MOVE_END
            "moveToBeginningOfParagraph" -> KeyEvent.KEYCODE_DPAD_UP; "moveToEndOfParagraph" -> KeyEvent.KEYCODE_DPAD_DOWN
            "deleteBackward", "deleteWordBackward", "deleteToBeginningOfLine" -> KeyEvent.KEYCODE_DEL
            "deleteForward", "deleteWordForward", "deleteToEndOfLine" -> KeyEvent.KEYCODE_FORWARD_DEL
            else -> return null
        }
        val modifier = when (plain) {
            "undo" -> KeyEvent.META_CTRL_ON
            "redo" -> KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON
            "moveWordLeft", "moveWordRight", "moveToBeginningOfDocument", "moveToEndOfDocument", "moveToBeginningOfParagraph", "moveToEndOfParagraph", "deleteWordBackward", "deleteWordForward" -> KeyEvent.META_CTRL_ON
            "deleteToBeginningOfLine", "deleteToEndOfLine" -> KeyEvent.META_ALT_ON
            else -> 0
        }
        return key to (modifier or shift)
    }
}
