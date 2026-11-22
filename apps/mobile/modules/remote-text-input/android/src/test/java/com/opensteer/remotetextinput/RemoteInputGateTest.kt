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

  init {
    gate.deliver = { packet -> answers.addLast(packet["id"] as Int) }
  }

  /** change(): one beforeinput, its default applied only after the answer, then input. */
  private fun change(action: () -> Unit) = gate.enqueue {
    gate.event(mapOf("type" to "beforeinput")) {
      action()
      gate.notify(mapOf("type" to "input"))
    }
  }
  private fun commitText(typed: String) = change { text.insert(cursor, typed); cursor += typed.length }
  private fun deleteSurroundingText(before: Int) = change {
    val start = maxOf(0, cursor - before)
    text.delete(start, cursor)
    cursor = start
  }
  private fun answerOne() = answers.removeFirstOrNull()?.let { gate.respond(mapOf("id" to it)) }
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
}
