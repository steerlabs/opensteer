package com.opensteer.remotetextinput

import android.text.InputType

internal fun remoteInputType(field: Map<*, *>?, keyboardMayReplaceText: Boolean = true): Int {
  val mode = field?.get("inputMode") as? String
  var type = when (mode) {
    "numeric" -> InputType.TYPE_CLASS_NUMBER
    "decimal" -> InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
    "tel" -> InputType.TYPE_CLASS_PHONE
    "email" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
    "url" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
    else -> InputType.TYPE_CLASS_TEXT
  }
  if (field?.get("sensitive") == true) type = if (mode == "numeric" || mode == "decimal") type or InputType.TYPE_NUMBER_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
  else if (type and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_TEXT) {
    if (keyboardMayReplaceText) type = type or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    if (field?.get("multiline") == true) type = type or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    type = type or when (field?.get("autocapitalize")) {
      "characters" -> InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
      "words" -> InputType.TYPE_TEXT_FLAG_CAP_WORDS
      "on", "sentences" -> InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      else -> 0
    }
  }
  if (!keyboardMayReplaceText && type and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_TEXT)
    type = type or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
  return type
}
