package com.opensteer.agentphone.control

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.InputMethod.AccessibilityInputConnection
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.opensteer.agentphone.wire.*
import java.util.UUID
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.TimeUnit

/** Private editor state stays on the phone. Only an epoch, field facts and a picture caret leave it. */
class OwnerEditing(private val service: AccessibilityService, private val device: AccessibilityDevice) {
    data class Clipboard(val outcome: String, val text: String? = null)
    data class Result(val outcome: String = "dispatched", val reason: String? = null, val clipboard: Clipboard? = null)
    private val main = Handler(Looper.getMainLooper())
    private var contextId = UUID.randomUUID().toString()
    private var editor: AccessibilityNodeInfo? = null
    private var selection: Pair<Int, Int>? = null
    private val heldKeys = java.util.concurrent.ConcurrentHashMap<Int, () -> Unit>()

    fun holdsKeys(): Boolean = heldKeys.isNotEmpty()

    /** Releases held keys; if their editor is gone or the main thread is stuck, they are forgotten all the same. */
    fun reset() {
        if (heldKeys.isEmpty()) { invalidate(); return }
        try {
            onMain { valid ->
                check(valid())
                heldKeys.values.forEach { it() }
            }
        } finally {
            heldKeys.clear()
            invalidate()
        }
    }

    @Synchronized fun invalidate() { contextId = UUID.randomUUID().toString() }
    @Synchronized private fun identity(node: AccessibilityNodeInfo?): String {
        val next = node?.let { it.textSelectionStart to it.textSelectionEnd }
        if (node != editor || next != selection) {
            editor = node
            selection = next
            invalidate()
        }
        return contextId
    }
    @Synchronized private fun matches(id: String) = contextId == id
    private fun stale(): Result { invalidate(); return Result("stale", "stale") }
    private fun refused(reason: String) = Result("refused", reason)

    fun context(width: Int, height: Int): JsonObject {
        val node = device.ownerFocusedNode()
        val id = identity(node)
        if (node == null) return jsonObject("contextId" to jsonOf(id), "field" to JsonNull, "caret" to JsonNull)
        val input = node.inputType
        val mode = when (input and InputType.TYPE_MASK_CLASS) {
            InputType.TYPE_CLASS_NUMBER -> if (input and InputType.TYPE_NUMBER_FLAG_DECIMAL != 0) "decimal" else "numeric"
            InputType.TYPE_CLASS_PHONE -> "tel"
            else -> when (input and InputType.TYPE_MASK_VARIATION) {
                InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS, InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS -> "email"
                InputType.TYPE_TEXT_VARIATION_URI -> "url"
                else -> "text"
            }
        }
        val bounds = Rect().also(node::getBoundsInScreen)
        var caret = RectF(bounds)
        val offset = node.textSelectionEnd
        if (offset >= 0 && !sensitive(node) && node.availableExtraData.contains(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY)) {
            val start = (offset - 1).coerceAtLeast(0)
            val args = Bundle().apply {
                putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_START_INDEX, start)
                putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_LENGTH, 1)
            }
            if (node.refreshWithExtraData(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY, args)) {
                @Suppress("DEPRECATION")
                val rect = node.extras.getParcelableArray(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY)?.firstOrNull() as? RectF
                if (rect != null && !rect.isEmpty) caret = RectF(if (offset > 0) rect.right else rect.left, rect.top, rect.right, rect.bottom)
            }
        }
        val w = width.coerceAtLeast(1).toDouble()
        val h = height.coerceAtLeast(1).toDouble()
        return jsonObject("contextId" to jsonOf(id), "field" to jsonObject(
            "kind" to jsonOf("text"), "multiline" to jsonOf(node.isMultiLine), "sensitive" to jsonOf(sensitive(node)), "inputMode" to jsonOf(mode)),
            "caret" to jsonObject("x" to JsonNumber((caret.left / w).coerceIn(0.0, 1.0)), "y" to JsonNumber((caret.top / h).coerceIn(0.0, 1.0)),
                "height" to JsonNumber((caret.height() / h).coerceIn(0.0, 1.0))))
    }

    fun dispatch(event: DisplayInput, expected: AccessibilityNodeInfo?, admit: () -> Unit): Result {
        if (event is DisplayInput.UnsupportedPaste) return refused("unsupported")
        val field = device.ownerFocusedInput(expected, admit) ?: return refused("no-field")
        val node = device.ownerFocusedNode() ?: return refused("no-field")
        if (expected != null && node != expected || device.ownerNode(field) != node) return stale()
        val id = identity(node)
        if (event is DisplayInput.Edit && event.contextId != id || event is DisplayInput.Cut && event.contextId != id) return stale()
        if (Build.VERSION.SDK_INT < 33) {
            if (event is DisplayInput.Copy || event is DisplayInput.Cut || event is DisplayInput.Command || event is DisplayInput.Edit && (event.before.isNotEmpty() || event.after.isNotEmpty())) return refused("unsupported")
            // Android omits selection metadata for empty accessible text. Its only insertion position is zero.
            val emptyCaret = !field.password && field.textLength == 0 && field.selectionStart == -1 && field.selectionEnd == -1
            if (!emptyCaret && (field.selectionStart < 0 || field.selectionStart != field.selectionEnd)) {
                android.util.Log.d("OpensteerDisplay", "Owner editing refused stage=limited-selection")
                return refused("unsupported")
            }
            val accepted = when (event) {
                is DisplayInput.Insert -> device.ownerEdit(field, event.text, 0, admit)
                is DisplayInput.Paste -> device.ownerEdit(field, event.text, 0, admit)
                is DisplayInput.Delete -> device.ownerEdit(field, null, event.count, admit)
                is DisplayInput.Edit -> device.ownerEdit(field, event.text, 0, admit)
                is DisplayInput.Key -> when {
                    event.text != null -> event.action == "up" || device.ownerEdit(field, event.text, 0, admit)
                    event.modifiers.isNotEmpty() -> false
                    event.key == "Backspace" -> event.action == "up" || device.ownerEdit(field, null, 1, admit)
                    event.key == "Enter" -> event.action == "up" || device.ownerEdit(field, "\n", 0, admit)
                    else -> false
                }
                DisplayInput.Submit -> device.imeEnter(field, admit)
                else -> false
            }
            return if (accepted) Result() else {
                android.util.Log.d("OpensteerDisplay", "Owner editing refused stage=limited-effect")
                refused("unsupported")
            }
        }
        return native(node, id, event, admit)
    }

    private fun sensitive(node: AccessibilityNodeInfo): Boolean {
        val type = node.inputType
        val variation = type and InputType.TYPE_MASK_VARIATION
        return node.isPassword || (type and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_TEXT && variation in setOf(
            InputType.TYPE_TEXT_VARIATION_PASSWORD, InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD, InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)) ||
            (type and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
    }

    @android.annotation.TargetApi(33)
    private data class Bound(val ime: OwnerInputMethod, val epoch: Long, val connection: AccessibilityInputConnection, val selectionStart: Int, val selectionEnd: Int)

    private fun <T> onMain(action: (() -> Boolean) -> T): T {
        val deadline = SystemClock.elapsedRealtime() + 1500
        val valid = { SystemClock.elapsedRealtime() < deadline }
        if (Looper.myLooper() == Looper.getMainLooper()) return action(valid)
        val answer = FutureTask { action(valid) }
        main.post(answer)
        return try { answer.get(1500, TimeUnit.MILLISECONDS) }
        catch (timeout: TimeoutException) {
            answer.cancel(false)
            main.removeCallbacks(answer)
            throw timeout
        }
    }

    @android.annotation.TargetApi(33)
    private fun bind(node: AccessibilityNodeInfo, admit: () -> Unit): Bound? {
        val until = SystemClock.elapsedRealtime() + 1000
        do {
            admit()
            val bound = onMain {
                val ime = service.inputMethod as? OwnerInputMethod
                if (ime?.currentInputStarted == true && ime.editor == node && device.ownerFocusedNode() == node)
                    ime.currentInputConnection?.let { Bound(ime, ime.epoch, it, ime.selectionStart, ime.selectionEnd) } else null
            }
            if (bound != null) return bound
            Thread.sleep(10)
        } while (SystemClock.elapsedRealtime() < until)
        return null
    }

    @android.annotation.TargetApi(33)
    private fun native(node: AccessibilityNodeInfo, id: String, event: DisplayInput, admit: () -> Unit): Result {
        if ((event is DisplayInput.Copy || event is DisplayInput.Cut) && sensitive(node)) return Result("refused", "sensitive", Clipboard("refused"))
        val bound = bind(node, admit) ?: run {
            android.util.Log.d("OpensteerDisplay", "Owner editing refused stage=connection-unbound")
            return refused("unsupported")
        }
        val connection = bound.connection
        fun effect(contextBound: Boolean = false, backspace: Boolean = false, verify: () -> Boolean = { true }, action: () -> Unit): Result {
            val handed = AtomicBoolean()
            var previousSelection = -1 to -1
            val result = try { onMain { valid ->
                admit()
                val focused = device.ownerFocusedNode()
                if (bound.ime.epoch != bound.epoch || bound.ime.editor != node || focused != node || contextBound &&
                    (identity(focused) != id || !matches(id) || bound.ime.selectionStart != bound.selectionStart || bound.ime.selectionEnd != bound.selectionEnd)) stale()
                else if (!valid()) refused("unsupported")
                else if (!verify()) stale()
                else {
                    previousSelection = bound.ime.selectionStart to bound.ime.selectionEnd
                    handed.set(true); action(); Result()
                }
            } } catch (_: TimeoutException) {
                // A queued effect is cancelled; a started void Android call can only promise dispatch.
                if (handed.get()) Result() else refused("unsupported")
            }
            if (result.outcome != "dispatched" || !backspace || previousSelection == (0 to 0)) return result
            // Rapid keys can otherwise reach a Compose editor before its prior value recomposes.
            val until = SystemClock.elapsedRealtime() + 1000
            do {
                admit()
                val settled = onMain {
                    if (bound.ime.epoch != bound.epoch || bound.ime.editor != node || device.ownerFocusedNode() != node) -1
                    else if ((bound.ime.selectionStart to bound.ime.selectionEnd) != previousSelection) 1 else 0
                }
                if (settled < 0) return stale()
                if (settled > 0) return result
                Thread.sleep(10)
            } while (SystemClock.elapsedRealtime() < until)
            android.util.Log.d("OpensteerDisplay", "Owner editing refused stage=backspace-unsettled")
            return refused("unsupported")
        }
        return when (event) {
            is DisplayInput.Insert -> effect { connection.commitText(event.text, 1, null) }
            is DisplayInput.Paste -> effect { connection.commitText(event.text, 1, null) }
            is DisplayInput.Delete -> {
                repeat(event.count) {
                    val result = effect(backspace = true) { chord(connection, KeyEvent.KEYCODE_DEL) }
                    if (result.outcome != "dispatched") return result
                }
                Result()
            }
            DisplayInput.Submit -> effect { connection.performEditorAction((bound.ime.currentInputEditorInfo?.imeOptions ?: android.view.inputmethod.EditorInfo.IME_ACTION_UNSPECIFIED) and android.view.inputmethod.EditorInfo.IME_MASK_ACTION) }
            is DisplayInput.Key -> {
                if (event.text != null) {
                    if (event.action == "up") Result() else effect { connection.commitText(event.text, 1, null) }
                } else {
                    val code = keyCode(event) ?: return refused("unsupported")
                    if (sensitive(node) && code in setOf(KeyEvent.KEYCODE_C, KeyEvent.KEYCODE_X) && event.modifiers.any { it == "control" || it == "primary" }) return refused("sensitive")
                    effect(backspace = event.action != "up" && code == KeyEvent.KEYCODE_DEL) {
                        sendKey(connection, key(event.action, code, meta(event.modifiers), event.repeat == true))
                        if (event.action == "up") heldKeys.remove(code)
                        else heldKeys[code] = {
                            if (bound.ime.epoch == bound.epoch && bound.ime.editor == node)
                                sendKey(connection, key("up", code))
                        }
                    }
                }
            }
            is DisplayInput.Command -> {
                val menu = if (event.command == "selectAll") android.R.id.selectAll else null
                if (menu != null) effect { connection.performContextMenuAction(menu) }
                else {
                    val command = command(event.command) ?: return refused("unsupported")
                    effect(backspace = command.first == KeyEvent.KEYCODE_DEL) { chord(connection, command.first, command.second) }
                }
            }
            is DisplayInput.Edit -> {
                val surrounding = connection.getSurroundingText(event.before.length, event.after.length, 0) ?: return stale()
                val text = surrounding.text.toString()
                val start = minOf(surrounding.selectionStart, surrounding.selectionEnd)
                val end = maxOf(surrounding.selectionStart, surrounding.selectionEnd)
                val range = event.before.isNotEmpty() || event.after.isNotEmpty()
                if (start < 0 || end > text.length || range && (start != end || start < event.before.length || end + event.after.length > text.length ||
                    text.substring(start - event.before.length, start) != event.before || text.substring(end, end + event.after.length) != event.after)) return stale()
                val absoluteStart = if (!range) 0 else if (surrounding.offset >= 0) surrounding.offset + start else {
                    // InputConnection's default surrounding-text implementation has no absolute offset.
                    // A refreshed node and the same IME session must agree on its global selection.
                    if (!node.refresh() || bound.selectionStart < 0 || bound.selectionStart != bound.selectionEnd ||
                        node.textSelectionStart != bound.selectionStart || node.textSelectionEnd != bound.selectionEnd) return stale()
                    bound.selectionStart
                }
                if (range && absoluteStart < event.before.length) return stale()
                effect(true) {
                    if (range) connection.setSelection(absoluteStart - event.before.length, absoluteStart + event.after.length)
                    connection.commitText(event.text, 1, null)
                }
            }
            is DisplayInput.Cut -> {
                val surrounding = connection.getSurroundingText(0, 0, 0) ?: return refused("unsupported")
                val start = minOf(surrounding.selectionStart, surrounding.selectionEnd)
                val end = maxOf(surrounding.selectionStart, surrounding.selectionEnd)
                if (start < 0 || end > surrounding.text.length) return stale()
                val absoluteStart = minOf(bound.selectionStart, bound.selectionEnd)
                val absoluteEnd = maxOf(bound.selectionStart, bound.selectionEnd)
                if (absoluteStart < 0 || absoluteEnd - absoluteStart != end - start) return stale()
                if (surrounding.offset >= 0) {
                    if (surrounding.offset + start != absoluteStart || surrounding.offset + end != absoluteEnd) return stale()
                } else if (!node.refresh() || minOf(node.textSelectionStart, node.textSelectionEnd) != absoluteStart ||
                    maxOf(node.textSelectionStart, node.textSelectionEnd) != absoluteEnd) return stale()
                if (start == end) return Result(clipboard = Clipboard("empty"))
                if (end - start > 30000) return Result("refused", "too-large", Clipboard("too-large"))
                val selected = surrounding.text.subSequence(start, end).toString()
                // Recheck the selection on the same bound editor immediately before its one deletion.
                val result = effect(true, verify = {
                    val current = connection.getSurroundingText(0, 0, 0)
                    current != null && current.offset == surrounding.offset &&
                        current.selectionStart == surrounding.selectionStart && current.selectionEnd == surrounding.selectionEnd &&
                        current.text.toString() == surrounding.text.toString() && !sensitive(node)
                }) { connection.commitText("", 1, null) }
                if (result.outcome == "dispatched") result.copy(clipboard = Clipboard("cut", selected)) else result
            }
            DisplayInput.Copy -> {
                val surrounding = connection.getSurroundingText(0, 0, 0) ?: return refused("unsupported")
                val start = minOf(surrounding.selectionStart, surrounding.selectionEnd)
                val end = maxOf(surrounding.selectionStart, surrounding.selectionEnd)
                if (start < 0 || end > surrounding.text.length) return stale()
                val result = effect(true) {}
                if (result.outcome != "dispatched") result
                else if (end - start > 30000) Result("refused", "too-large", Clipboard("too-large"))
                else Result(clipboard = if (start == end) Clipboard("empty") else Clipboard("copied", surrounding.text.subSequence(start, end).toString()))
            }
            else -> refused("unsupported")
        }
    }

    private fun meta(modifiers: List<String>): Int = modifiers.fold(0) { state, modifier -> state or when (modifier) {
        "primary", "control" -> KeyEvent.META_CTRL_ON
        "alt" -> KeyEvent.META_ALT_ON
        "shift" -> KeyEvent.META_SHIFT_ON
        "meta" -> KeyEvent.META_META_ON
        else -> 0
    } }
    private fun key(action: String, code: Int, meta: Int = 0, repeat: Boolean = false): KeyEvent {
        val time = SystemClock.uptimeMillis()
        return KeyEvent(time, time, if (action == "up") KeyEvent.ACTION_UP else KeyEvent.ACTION_DOWN, code, if (repeat) 1 else 0,
            meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, KeyEvent.FLAG_SOFT_KEYBOARD, InputDevice.SOURCE_KEYBOARD)
    }
    @android.annotation.TargetApi(33)
    private fun sendKey(connection: AccessibilityInputConnection, event: KeyEvent) {
        // TextView movement reads Shift from its buffer's modifier state, not the arrow's flags.
        val shift = event.isShiftPressed && event.keyCode !in setOf(KeyEvent.KEYCODE_SHIFT_LEFT, KeyEvent.KEYCODE_SHIFT_RIGHT)
        if (shift) connection.sendKeyEvent(key("down", KeyEvent.KEYCODE_SHIFT_LEFT, event.metaState))
        try { connection.sendKeyEvent(event) }
        finally { if (shift) connection.sendKeyEvent(key("up", KeyEvent.KEYCODE_SHIFT_LEFT, event.metaState and KeyEvent.META_SHIFT_MASK.inv())) }
    }
    @android.annotation.TargetApi(33)
    private fun chord(connection: AccessibilityInputConnection, code: Int, meta: Int = 0) {
        sendKey(connection, key("down", code, meta))
        sendKey(connection, key("up", code, meta))
    }
    private fun keyCode(event: DisplayInput.Key): Int? {
        val physical = mapOf("ShiftLeft" to "SHIFT_LEFT", "ShiftRight" to "SHIFT_RIGHT", "ControlLeft" to "CTRL_LEFT", "ControlRight" to "CTRL_RIGHT",
            "AltLeft" to "ALT_LEFT", "AltRight" to "ALT_RIGHT", "MetaLeft" to "META_LEFT", "MetaRight" to "META_RIGHT",
            "Semicolon" to "SEMICOLON", "Equal" to "EQUALS", "Comma" to "COMMA", "Minus" to "MINUS", "Period" to "PERIOD", "Slash" to "SLASH",
            "Backquote" to "GRAVE", "BracketLeft" to "LEFT_BRACKET", "Backslash" to "BACKSLASH", "BracketRight" to "RIGHT_BRACKET", "Quote" to "APOSTROPHE")
        val name = physical[event.code] ?: when (event.key) {
            "ArrowLeft" -> "DPAD_LEFT"; "ArrowRight" -> "DPAD_RIGHT"; "ArrowUp" -> "DPAD_UP"; "ArrowDown" -> "DPAD_DOWN"
            "Backspace" -> "DEL"; "Delete" -> "FORWARD_DEL"; "Home" -> "MOVE_HOME"; "End" -> "MOVE_END"; "Escape" -> "ESCAPE"
            "PageUp" -> "PAGE_UP"; "PageDown" -> "PAGE_DOWN"; " " -> "SPACE"
            else -> when {
                event.code.startsWith("Key") -> event.code.removePrefix("Key").uppercase()
                event.code.startsWith("Digit") -> event.code.removePrefix("Digit")
                event.code.startsWith("Numpad") -> "NUMPAD_" + event.code.removePrefix("Numpad").uppercase()
                else -> event.key.uppercase()
            }
        }
        return KeyEvent.keyCodeFromString("KEYCODE_$name").takeIf { it != KeyEvent.KEYCODE_UNKNOWN }
    }
    private fun command(name: String): Pair<Int, Int>? {
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
