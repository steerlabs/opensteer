package com.opensteer.remotetextinput

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** CW4: an edit from outside the gate is one input, after its own caret, never a selection first. */
class RemoteInputOutsideEditTest {
  @Test fun anAccessibilitySetTextIsOneInputAfterItsCaret() {
    val sent = mutableListOf<String>()
    val posted = mutableListOf<() -> Unit>()
    val outside = RemoteInputOutsideEdit { sent += "input" }
    // TextView.performAccessibilityAction(ACTION_SET_TEXT): setText (the selection to the start),
    // then setSelection(text.length), all before the view's post runs.
    outside.changing(byGate = false)
    assertTrue(outside.ownsSelection())
    outside.changed(byGate = false) { posted += it }
    assertTrue("the caret ACTION_SET_TEXT sets after the text is the change's", outside.ownsSelection())
    assertEquals(emptyList<String>(), sent)
    posted.forEach { it() }
    assertEquals(listOf("input"), sent)
    assertFalse(outside.ownsSelection())
  }

  @Test fun aChangeInTheGateIsNotAnOutsideEdit() {
    val sent = mutableListOf<String>()
    val outside = RemoteInputOutsideEdit { sent += "input" }
    outside.changing(byGate = true)
    assertFalse(outside.ownsSelection())
    outside.changed(byGate = true) { it() }
    assertEquals(emptyList<String>(), sent)
  }

  @Test fun twoChangesBeforeThePostAreOneInput() {
    val sent = mutableListOf<String>()
    val posted = mutableListOf<() -> Unit>()
    val outside = RemoteInputOutsideEdit { sent += "input" }
    repeat(2) {
      outside.changing(byGate = false)
      outside.changed(byGate = false) { posted += it }
    }
    posted.forEach { it() }
    assertEquals(listOf("input"), sent)
  }
}
