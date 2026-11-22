package com.opensteer.remotetextinput

import android.os.SystemClock
import android.view.MotionEvent
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
}
