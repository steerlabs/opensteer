package com.opensteer.remotetextinput

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * CW4, CY10: an edit from outside the gate is one input, after its own caret, never a selection
 * first; it takes its place in the gate's order when it arrives, so nothing typed after it goes
 * before it; and it owns only the selection changes it makes itself, outside any gate turn.
 */
class RemoteInputOutsideEditTest {
  private val gate = RemoteInputGate()
  private val answers = ArrayDeque<Int>()
  private val delivered = mutableListOf<String>()
  private val posted = mutableListOf<() -> Unit>()
  private val outside = RemoteInputOutsideEdit { gate.reserve { mapOf("type" to "input", "inputType" to "insertReplacementText") } }

  init {
    gate.deliver = { packet ->
      answers.addLast(packet["id"] as Int)
      val event = packet["event"] as Map<*, *>
      delivered += listOfNotNull(event["type"] as String, event["inputType"] as String?).joinToString(":")
    }
  }
  private fun answerAll() {
    while (answers.isNotEmpty()) gate.respond(mapOf("id" to answers.removeFirst()))
  }
  /** An edit the keyboard sends through the gate: a beforeinput, then its input. */
  private fun typed() = gate.enqueue { gate.event(mapOf("type" to "beforeinput", "inputType" to "insertText")) { gate.notify(mapOf("type" to "input", "inputType" to "insertText")) } }

  @Test fun anAccessibilitySetTextIsOneInputAfterItsCaret() {
    // TextView.performAccessibilityAction(ACTION_SET_TEXT): setText (the selection to the start),
    // then setSelection(text.length), all before the view's post runs.
    outside.changing(byGate = false)
    assertTrue(outside.ownsSelection(inTurn = false))
    outside.changed(byGate = false) { posted += it }
    assertTrue("the caret ACTION_SET_TEXT sets after the text is the change's", outside.ownsSelection(inTurn = false))
    assertEquals(emptyList<String>(), delivered)
    posted.forEach { it() }
    assertEquals(listOf("input:insertReplacementText"), delivered)
    assertFalse(outside.ownsSelection(inTurn = false))
  }

  @Test fun aChangeInTheGateIsNotAnOutsideEdit() {
    outside.changing(byGate = true)
    assertFalse(outside.ownsSelection(inTurn = false))
    outside.changed(byGate = true) { it() }
    assertEquals(emptyList<String>(), delivered)
  }

  @Test fun twoChangesBeforeThePostAreOneInput() {
    repeat(2) {
      outside.changing(byGate = false)
      outside.changed(byGate = false) { posted += it }
    }
    posted.forEach { it() }
    answerAll()
    assertEquals(listOf("input:insertReplacementText"), delivered)
  }

  @Test fun typingAfterAnOutsideEditGoesAfterIt() {
    outside.changing(byGate = false)
    outside.changed(byGate = false) { posted += it }
    // The keyboard types before the view's post runs: it waits behind the outside edit.
    typed()
    assertEquals(emptyList<String>(), delivered)
    posted.forEach { it() }
    answerAll()
    assertEquals(listOf("input:insertReplacementText", "beforeinput:insertText", "input:insertText"), delivered)
  }

  @Test fun anOutsideEditBehindWaitingTypingKeepsItsPlace() {
    typed()
    outside.changing(byGate = false)
    outside.changed(byGate = false) { posted += it }
    posted.forEach { it() }
    typed()
    answerAll()
    assertEquals(
      listOf("beforeinput:insertText", "input:insertText", "input:insertReplacementText", "beforeinput:insertText", "input:insertText"),
      delivered,
    )
  }

  @Test fun aSelectionChangeInAGateTurnIsNotTheOutsideEdits() {
    outside.changing(byGate = false)
    assertTrue(outside.ownsSelection(inTurn = false))
    assertFalse("a gate turn's selection is that turn's, reported as ever", outside.ownsSelection(inTurn = true))
  }
}
