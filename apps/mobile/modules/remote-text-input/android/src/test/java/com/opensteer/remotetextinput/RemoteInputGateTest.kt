package com.opensteer.remotetextinput

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The gate drives the keyboard's commands as RemoteInputEditText queues them. Android's keyboard
 * commands (commitText, deleteSurroundingText) act at the cursor when they are applied, not where
 * it stood when the keyboard sent them, so a burst queued behind late answers lands as typed.
 */
class RemoteInputGateTest {
  private val gate = RemoteInputGate()
  private val answers = ArrayDeque<Int>()
  private val text = StringBuilder()
  private var cursor = 0

  private val events = mutableListOf<Map<*, *>>()
  private var selectionEnd = 0

  init {
    gate.deliver = { packet ->
      answers.addLast(packet["id"] as Int)
      events.add(packet["event"] as Map<*, *>)
    }
  }
  /** A person's touch: the EditText moves its cursor at once; onSelectionChanged reports it. */
  private fun touch(start: Int, end: Int = start) {
    cursor = start
    selectionEnd = end
    gate.notify(mapOf("type" to "selection", "value" to text.toString(), "start" to start, "end" to end))
  }

  /** change(): one beforeinput, its default applied only after the answer, then input. */
  private fun change(action: () -> Unit) = gate.enqueue {
    gate.event(mapOf("type" to "beforeinput")) {
      action()
      gate.notify(mapOf("type" to "input"))
    }
  }
  private fun commitText(typed: String) = change {
    // commitText replaces the selection, or inserts at the cursor, when it is applied.
    val end = maxOf(cursor, selectionEnd)
    text.replace(cursor, end, typed)
    cursor += typed.length
    selectionEnd = cursor
  }
  private fun deleteSurroundingText(before: Int) = change {
    val start = maxOf(0, cursor - before)
    text.delete(start, cursor)
    cursor = start
  }
  private fun answerOne() = answers.removeFirstOrNull()?.let { gate.respond(mapOf("id" to it)) }
  private fun type(typed: String) { commitText(typed); answerAll() }
  private fun answerAll() { while (answers.isNotEmpty()) answerOne() }

  @Test fun aBurstTypedBeforeAnyAnswerLandsAsTyped() {
    for (digit in "0123456789") commitText(digit.toString())
    answerAll()
    assertEquals("0123456789", text.toString())
  }

  @Test fun eachKeystrokeTypedWhileTheOneBeforeWaitsLandsAfterIt() {
    for (digit in "0123456789") { commitText(digit.toString()); answerOne() }
    answerAll()
    assertEquals("0123456789", text.toString())
  }

  @Test fun fiveDeletionsQueuedBehindTenInsertsDeleteFive() {
    for (digit in "0123456789") commitText(digit.toString())
    repeat(5) { deleteSurroundingText(1) }
    answerAll()
    assertEquals("01234", text.toString())
  }

  // The iOS walk's caret variants, on Android's gate: a person's touch is reported, with the text
  // it was made in, before the keystroke typed after it, which lands where the touch put the cursor.
  @Test fun aCaretMovedByTouchIsReportedBeforeTheKeystrokeAndTheKeystrokeLandsThere() {
    for (c in "hello") type(c.toString())
    events.clear()
    touch(0)
    commitText("!")
    answerAll()
    assertEquals(listOf("selection", "beforeinput", "input"), events.map { it["type"] })
    assertEquals(listOf("hello", 0), listOf(events[0]["value"], events[0]["start"]))
    assertEquals("!hello", text.toString())
  }

  @Test fun aSelectionMadeByTouchIsReportedBeforeTheKeystrokeTypedOverIt() {
    for (c in "hello") type(c.toString())
    commitText("a")
    commitText("b")
    answerAll()
    events.clear()
    touch(0, 7)
    commitText("!")
    answerAll()
    assertEquals(listOf("selection", "beforeinput", "input"), events.map { it["type"] })
    assertEquals(listOf("helloab", 0, 7), listOf(events[0]["value"], events[0]["start"], events[0]["end"]))
    assertEquals("!", text.toString())
  }
}
