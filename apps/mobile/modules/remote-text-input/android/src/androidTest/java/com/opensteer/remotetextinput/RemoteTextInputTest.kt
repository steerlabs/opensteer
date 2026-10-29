package com.opensteer.remotetextinput

import android.view.inputmethod.EditorInfo
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test

class RemoteTextInputTest {
  @Test fun composingRegionCommitAndCancellationAreObservedInOrder() {
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      val view = RemoteInputEditText(InstrumentationRegistry.getInstrumentation().targetContext)
      val packets = mutableListOf<Map<String, Any?>>()
      view.deliver = { packets.add(it) }
      val connection = view.onCreateInputConnection(EditorInfo())!!
      connection.commitText("hello", 1)
      assertEquals("", view.text.toString())
      view.respond(mapOf("id" to 1, "preventDefault" to true))
      assertEquals("", view.text.toString())
      connection.setComposingText("한", 1)
      var index = 1
      while (index < packets.size) view.respond(mapOf("id" to packets[index++]["id"]))
      connection.finishComposingText()
      while (index < packets.size) view.respond(mapOf("id" to packets[index++]["id"]))
      assertEquals("한", view.text.toString())
      val events = packets.map { (it["event"] as Map<*, *>)["type"] }
      assertEquals(1, events.count { it == "compositionstart" })
      assertEquals(1, events.count { it == "compositionend" })
    }
  }
  @Test fun contextReplacementEndsTheNativeComposition() {
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      val view = RemoteInputEditText(InstrumentationRegistry.getInstrumentation().targetContext)
      val packets = mutableListOf<Map<String, Any?>>()
      view.deliver = { packets.add(it) }
      var next = 0
      fun drain() { while (next < packets.size) view.respond(mapOf("id" to packets[next++]["id"])) }
      val field = mapOf("kind" to "text", "multiline" to true, "sensitive" to false)
      view.configure(mapOf("contextId" to "first", "field" to field), false)
      val connection = view.onCreateInputConnection(EditorInfo())!!
      connection.setComposingText("に", 1)
      drain()
      assertTrue(android.view.inputmethod.BaseInputConnection.getComposingSpanStart(view.text) >= 0)
      view.configure(mapOf("contextId" to "second", "field" to field), false)
      assertEquals("compositionend", (packets.last()["event"] as Map<*, *>)["type"])
      assertEquals("first", packets.last()["contextId"])
      assertEquals("Reset waits for the old ending acknowledgement", "に", view.text.toString())
      connection.commitText("a", 1)
      drain()
      assertEquals("New-context typing queued behind the ending is preserved", "a", view.text.toString())
      assertEquals(1, packets.count { (it["event"] as Map<*, *>)["type"] == "compositionend" })
      view.finishComposition()
      drain()
      assertEquals("a", view.text.toString())
      assertEquals("second", packets.last()["contextId"])
      connection.setComposingText("한", 1)
      drain()
      connection.finishComposingText()
      drain()
      assertEquals(2, packets.count { (it["event"] as Map<*, *>)["type"] == "compositionend" })
    }
  }
  @Test fun contextReplacementPreservesAnEndingAlreadyAwaitingAcknowledgement() {
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      val view = RemoteInputEditText(InstrumentationRegistry.getInstrumentation().targetContext)
      val packets = mutableListOf<Map<String, Any?>>()
      view.deliver = { packets.add(it) }
      var next = 0
      fun drain() { while (next < packets.size) view.respond(mapOf("id" to packets[next++]["id"])) }
      val field = mapOf("kind" to "text", "multiline" to true, "sensitive" to false)
      view.configure(mapOf("contextId" to "first", "field" to field), false)
      val connection = view.onCreateInputConnection(EditorInfo())!!
      connection.setComposingText("に", 1)
      drain()
      connection.finishComposingText()
      view.configure(mapOf("contextId" to "second", "field" to field), false)
      assertEquals("に", view.text.toString())
      drain()
      assertEquals("", view.text.toString())
      assertEquals(1, packets.count { (it["event"] as Map<*, *>)["type"] == "compositionend" })
      connection.commitText("b", 1)
      drain()
      assertEquals("b", view.text.toString())
    }
  }
  @Test fun sensitiveCopyForwardsOnlyTheIntentForTheTargetsRefusal() {
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      val view = RemoteInputEditText(InstrumentationRegistry.getInstrumentation().targetContext)
      val packets = mutableListOf<Map<String, Any?>>()
      view.deliver = { packets.add(it) }
      var next = 0
      fun drain() { while (next < packets.size) view.respond(mapOf("id" to packets[next++]["id"])) }
      view.configure(mapOf("contextId" to "secret", "field" to mapOf("kind" to "text", "multiline" to false, "sensitive" to true)), false)
      drain()
      view.onTextContextMenuItem(android.R.id.copy)
      drain()
      assertEquals(1, packets.count { (it["event"] as Map<*, *>)["type"] == "copy" })
    }
  }

  @Test fun newContextEditorActionFollowsTheOldCompositionInTheNativeFifo() {
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      for (queuedCommit in listOf(false, true)) {
        val view = RemoteInputEditText(InstrumentationRegistry.getInstrumentation().targetContext)
        val packets = mutableListOf<Map<String, Any?>>()
        view.deliver = { packets.add(it) }
        var next = 0
        fun drain() { while (next < packets.size) view.respond(mapOf("id" to packets[next++]["id"])) }
        val field = mapOf("kind" to "text", "multiline" to false, "sensitive" to false, "enterKeyHint" to "go")
        view.configure(mapOf("contextId" to "first", "field" to field), false)
        val connection = view.onCreateInputConnection(EditorInfo())!!
        connection.setComposingText("hello", 1)
        drain()
        if (queuedCommit) connection.commitText("hello", 1)
        view.configure(mapOf("contextId" to "second", "field" to field), false)
        connection.performEditorAction(EditorInfo.IME_ACTION_GO)
        drain()
        val events = packets.map { it["event"] as Map<*, *> }
        val keys = events.filter { it["type"] == "keydown" || it["type"] == "keyup" }
        assertEquals(listOf("keydown", "keyup"), keys.map { it["type"] })
        assertTrue("New-context Go must be a non-composing Enter action, including behind a queued old commit", keys.all { it["key"] == "Enter" && it["composing"] == false })
        assertTrue(packets.filter { (it["event"] as Map<*, *>)["type"] in listOf("keydown", "keyup") }.all { it["contextId"] == "second" })
        assertEquals(1, events.count { it["type"] == "compositionend" })
        assertTrue(events.indexOfFirst { it["type"] == "compositionend" } < events.indexOfFirst { it["type"] == "keydown" })
      }
    }
  }

}
