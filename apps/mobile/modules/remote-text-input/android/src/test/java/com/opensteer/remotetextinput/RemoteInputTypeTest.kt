package com.opensteer.remotetextinput

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Test

class RemoteInputTypeTest {
  private val modes = mapOf(
    "text" to InputType.TYPE_CLASS_TEXT,
    "email" to (InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS),
    "url" to (InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI),
    "numeric" to InputType.TYPE_CLASS_NUMBER,
    "decimal" to (InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL),
    "tel" to InputType.TYPE_CLASS_PHONE,
    "search" to InputType.TYPE_CLASS_TEXT,
    "none" to InputType.TYPE_CLASS_TEXT,
    "unknown" to InputType.TYPE_CLASS_TEXT,
  )
  private val capitalizations = mapOf(
    "none" to 0,
    "characters" to InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS,
    "words" to InputType.TYPE_TEXT_FLAG_CAP_WORDS,
    "on" to InputType.TYPE_TEXT_FLAG_CAP_SENTENCES,
    "sentences" to InputType.TYPE_TEXT_FLAG_CAP_SENTENCES,
  )

  @Test fun rangeEditingKeepsExistingInputTypesAndBasicOnlyDisablesReplacements() {
    for ((mode, base) in modes) {
      for (sensitive in listOf(false, true)) {
        for (multiline in listOf(false, true)) {
          for ((capitalization, capitalFlags) in capitalizations) {
            val field = mapOf("inputMode" to mode, "sensitive" to sensitive, "multiline" to multiline, "autocapitalize" to capitalization)
            val password = if (mode == "numeric" || mode == "decimal") base or InputType.TYPE_NUMBER_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            val textClass = base and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_TEXT
            val layoutFlags = capitalFlags or (if (multiline) InputType.TYPE_TEXT_FLAG_MULTI_LINE else 0)
            val expected = if (sensitive) password else if (textClass) base or layoutFlags or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT else base
            val label = "$mode sensitive=$sensitive multiline=$multiline capitalization=$capitalization"
            assertEquals(label, expected, remoteInputType(field))
            assertEquals(label, expected, remoteInputType(field, true))
            val noReplacements = if (expected and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_TEXT)
              (expected and InputType.TYPE_TEXT_FLAG_AUTO_CORRECT.inv()) or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS else expected
            assertEquals(label, noReplacements, remoteInputType(field, false))
          }
        }
      }
    }
    assertEquals(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT, remoteInputType(null))
    assertEquals(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, remoteInputType(null, false))
  }
}
