package com.opensteer.remotetextinput

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * CW4, CY10, CZ4: an edit from outside the gate is one input, after its own caret, never a
 * selection first; it takes its place in the gate's order once the text has changed, so nothing
 * typed after it goes before it; its input says what the field holds at its turn; its place is
 * always given back; and it owns only the selection changes it makes itself, outside any turn.
 */
class RemoteInputOutsideEditTest {
  private val gate = RemoteInputGate()
  private val answers = ArrayDeque<Int>()
  private val delivered = mutableListOf<String>()
  private val posted = mutableListOf<() -> Unit>()
  /** The hidden field's text, as the view holds it. */
  private var text = ""
  private val outside = RemoteInputOutsideEdit {
    gate.reserve { mapOf("type" to "input", "inputType" to "insertReplacementText", "value" to text) }
  }

  init {
    gate.deliver = { packet ->
      answers.addLast(packet["id"] as Int)
      val event = packet["event"] as Map<*, *>
      delivered += listOfNotNull(event["type"] as String, event["inputType"] as String?, event["value"] as String?).joinToString(":")
    }
  }
  private fun answerAll() {
    while (answers.isNotEmpty()) gate.respond(mapOf("id" to answers.removeFirst()))
  }
  private fun runPosted() {
    val due = posted.toList()
    posted.clear()
    due.forEach { it() }
  }
  /** A key the keyboard sends through the gate: a beforeinput, its default applied after the answer. */
  private fun typed(character: String) = gate.enqueue {
    gate.event(mapOf("type" to "beforeinput", "inputType" to "insertText")) {
      text += character
      gate.notify(mapOf("type" to "input", "inputType" to "insertText", "value" to text))
    }
  }
  /** Something outside the gate sets the text (TextView's setText, then its caret). */
  private fun outsideSets(value: String) {
    outside.changing(byGate = false) { posted += it }
    text = value
    outside.changed(byGate = false) { posted += it }
  }

  @Test fun anOutsideEditIsOneInputAfterItsCaret() {
    outside.changing(byGate = false) { posted += it }
    assertTrue(outside.ownsSelection(inTurn = false))
    text = "hello"
    outside.changed(byGate = false) { posted += it }
    assertTrue("the caret set after the text is the change's", outside.ownsSelection(inTurn = false))
    assertEquals(emptyList<String>(), delivered)
    runPosted()
    assertEquals(listOf("input:insertReplacementText:hello"), delivered)
    assertFalse(outside.ownsSelection(inTurn = false))
  }

  @Test fun aChangeInTheGateIsNotAnOutsideEdit() {
    outside.changing(byGate = true) { posted += it }
    assertFalse(outside.ownsSelection(inTurn = false))
    outside.changed(byGate = true) { posted += it }
    runPosted()
    assertEquals(emptyList<String>(), delivered)
  }

  @Test fun twoChangesBeforeThePostAreOneInput() {
    outsideSets("a")
    outsideSets("ab")
    runPosted()
    answerAll()
    assertEquals(listOf("input:insertReplacementText:ab"), delivered)
  }

  @Test fun typingAfterAnOutsideEditGoesAfterIt() {
    outsideSets("OUT")
    // The keyboard types before the view's post runs: it waits behind the outside edit.
    typed("a")
    assertEquals(emptyList<String>(), delivered)
    runPosted()
    answerAll()
    assertEquals(listOf("input:insertReplacementText:OUT", "beforeinput:insertText", "input:insertText:OUTa"), delivered)
  }

  @Test fun aSelectionChangeInAGateTurnIsNotTheOutsideEdits() {
    outside.changing(byGate = false) { posted += it }
    assertTrue(outside.ownsSelection(inTurn = false))
    assertFalse("a gate turn's selection is that turn's, reported as ever", outside.ownsSelection(inTurn = true))
  }

  // CZ4: the wedge, by the view going before the post runs. Its place is given back.
  @Test fun aViewThatGoesBeforeThePostGivesThePlaceBack() {
    outsideSets("OUT")
    outside.abandon()
    typed("a")
    answerAll()
    assertEquals(listOf("input:insertReplacementText:OUT", "beforeinput:insertText", "input:insertText:OUTa"), delivered)
    // The post that runs after (or never) changes nothing.
    runPosted()
    assertEquals(3, delivered.size)
  }

  // CZ4: the wedge, by a watcher that threw before the text changed. Nothing was reserved.
  @Test fun aChangeThatNeverFinishedReservesNothing() {
    outside.changing(byGate = false) { posted += it }
    typed("a")
    answerAll()
    assertEquals(listOf("beforeinput:insertText", "input:insertText:a"), delivered)
    runPosted()
    assertFalse("it stops owning the selection", outside.ownsSelection(inTurn = false))
  }

  // CZ4: an outside edit while a key waits for its answer. The text changed under the waiting
  // key, which is applied over it; the outside edit's input, made at its turn, says what the field
  // then holds: both are applied once and the far side ends with what the field holds.
  @Test fun anOutsideEditUnderAWaitingKeyEndsWithWhatTheFieldHolds() {
    typed("a")
    assertEquals(listOf("beforeinput:insertText"), delivered)
    outsideSets("OUT")
    runPosted()
    answerAll()
    assertEquals(listOf("beforeinput:insertText", "input:insertText:OUTa", "input:insertReplacementText:OUTa"), delivered)
    assertEquals("OUTa", text)
  }
}
