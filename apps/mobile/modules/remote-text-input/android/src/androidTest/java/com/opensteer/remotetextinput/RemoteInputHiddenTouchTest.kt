package com.opensteer.remotetextinput

import android.graphics.RectF
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.text.Selection
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.HandwritingGesture
import android.view.inputmethod.InputConnection
import android.view.inputmethod.SelectGesture
import android.view.inputmethod.EditorInfo
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * On a device only (nothing on the development Mac runs it): a double tap on the hidden typing
 * field, whose text nobody sees, selects nothing, so the next character is typed after the text
 * rather than replacing a word. The owner's manual check is the same: on an Android phone,
 * double-tap the typing capsule, type a character: nothing is replaced.
 */
class RemoteInputHiddenTouchTest {
  @Test fun aDoubleTapOnTheHiddenFieldSelectsNothingSoTypingReplacesNothing() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      val view = RemoteInputEditText(instrumentation.targetContext)
      val packets = mutableListOf<Map<String, Any?>>()
      var next = 0
      view.deliver = { packets.add(it) }
      fun drain() { while (next < packets.size) view.respond(mapOf("id" to packets[next++]["id"])) }
      view.configure(mapOf("contextId" to "page", "field" to mapOf("kind" to "text", "sensitive" to false)), false)
      drain()
      view.layout(0, 0, 600, 120)
      val connection = view.onCreateInputConnection(EditorInfo())!!
      connection.commitText("helloab", 1)
      drain()
      val beforeTaps = packets.size
      val now = SystemClock.uptimeMillis()
      for (tap in 0 until 2) {
        val at = now + tap * 120L
        view.dispatchTouchEvent(MotionEvent.obtain(at, at, MotionEvent.ACTION_DOWN, 40f, 60f, 0))
        view.dispatchTouchEvent(MotionEvent.obtain(at, at + 40, MotionEvent.ACTION_UP, 40f, 60f, 0))
      }
      assertEquals(view.text.length, view.selectionStart)
      assertEquals(view.selectionStart, view.selectionEnd)
      assertEquals(0, packets.drop(beforeTaps).count { (it["event"] as Map<*, *>)["type"] == "selection" })
      connection.commitText("!", 1)
      drain()
      assertEquals("helloab!", view.text.toString())
      assertFalse(view.isSuggestionsEnabled)
      assertTrue(view.onTextContextMenuItem(android.R.id.selectAll))
      assertEquals(view.selectionStart, view.selectionEnd)
    }
  }

  /**
   * CR5, on a device only: every other door that could select in the hidden field selects nothing
   * and reports nothing. Never run on a device or emulator yet.
   */
  @Test fun noDoorButTheGateChangesTheHiddenFieldsSelection() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      val view = RemoteInputEditText(instrumentation.targetContext)
      val packets = mutableListOf<Map<String, Any?>>()
      var next = 0
      view.deliver = { packets.add(it) }
      fun drain() { while (next < packets.size) view.respond(mapOf("id" to packets[next++]["id"])) }
      view.configure(mapOf("contextId" to "page", "field" to mapOf("kind" to "text", "sensitive" to false)), false)
      drain()
      view.layout(0, 0, 600, 120)
      val connection = view.onCreateInputConnection(EditorInfo())!!
      connection.commitText("helloab", 1)
      drain()
      val before = packets.size
      fun unmoved(door: String) {
        assertEquals("$door moved the selection start", 7, view.selectionStart)
        assertEquals("$door moved the selection end", 7, view.selectionEnd)
      }
      // An accessibility service's long click.
      assertTrue(view.performLongClick())
      unmoved("performLongClick")
      // Accessibility selection and granularity moves, extending the selection.
      assertFalse(view.performAccessibilityAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 0)
        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, 7)
      }))
      unmoved("ACTION_SET_SELECTION")
      assertFalse(view.performAccessibilityAction(AccessibilityNodeInfo.ACTION_PREVIOUS_AT_MOVEMENT_GRANULARITY, Bundle().apply {
        putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_MOVEMENT_GRANULARITY_INT, AccessibilityNodeInfo.MOVEMENT_GRANULARITY_WORD)
        putBoolean(AccessibilityNodeInfo.ACTION_ARGUMENT_EXTEND_SELECTION_BOOLEAN, true)
      }))
      unmoved("ACTION_PREVIOUS_AT_MOVEMENT_GRANULARITY")
      // The text menu's selecting items.
      for (id in listOf(android.R.id.startSelectingText, android.R.id.selectAll, android.R.id.replaceText, android.R.id.textAssist)) {
        assertTrue(view.onTextContextMenuItem(id))
        unmoved("menu item $id")
      }
      // A secondary click.
      assertTrue(view.performContextClick(40f, 60f))
      unmoved("performContextClick")
      // A drag over the field is refused at its start, so no location ever reaches it.
      // DragEvent has no public constructor: the rule below holds whatever a drag would set.
      // The rule itself: a selection set outside the gate, as a drag location or a stylus gesture
      // sets it, is undone at once.
      Selection.setSelection(view.text, 0, 5)
      unmoved("a selection set outside the gate")
      // A stylus gesture through the input connection, on Android 14 and later.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        assertFalse(view.isAutoHandwritingEnabled)
        var result = -1
        val gesture: HandwritingGesture = SelectGesture.Builder().setGranularity(HandwritingGesture.GRANULARITY_WORD).setSelectionArea(RectF(0f, 0f, 600f, 120f)).build()
        connection.performHandwritingGesture(gesture, { it.run() }) { result = it }
        assertEquals(InputConnection.HANDWRITING_GESTURE_RESULT_UNSUPPORTED, result)
        unmoved("SelectGesture")
      }
      assertEquals(0, packets.drop(before).count { (it["event"] as Map<*, *>)["type"] == "selection" })
      // The person's keyboard still moves the caret, through the gate.
      connection.setSelection(3, 3)
      drain()
      assertEquals(3, view.selectionStart)
      assertEquals(1, packets.drop(before).count { (it["event"] as Map<*, *>)["type"] == "selection" })
      connection.commitText("!", 1)
      drain()
      assertEquals("hel!loab", view.text.toString())
    }
  }
}
