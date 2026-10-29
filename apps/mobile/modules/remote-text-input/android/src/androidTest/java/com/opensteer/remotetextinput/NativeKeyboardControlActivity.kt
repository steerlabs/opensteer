package com.opensteer.remotetextinput

import android.app.Activity
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import java.io.File
import org.json.JSONObject

/** Independent OS keyboard control: no custom InputConnection and no acknowledgement gate. */
class NativeKeyboardControlActivity : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    val input = EditText(this)
    input.contentDescription = "Independent native keyboard control"
    input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    input.imeOptions = EditorInfo.IME_ACTION_NONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI or (if (intent.getBooleanExtra("standard", false)) 0 else EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING)
    val name = intent.getStringExtra("case")?.takeIf { it.matches(Regex("[a-z0-9-]{1,80}")) } ?: "control"
    val output = File(filesDir, "$name.jsonl")
    output.writeText("")
    input.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        output.appendText(JSONObject(mapOf("value" to input.text.toString(), "selectionStart" to input.selectionStart, "selectionEnd" to input.selectionEnd, "composingStart" to BaseInputConnection.getComposingSpanStart(input.text), "composingEnd" to BaseInputConnection.getComposingSpanEnd(input.text))).toString() + "\n")
      }
    })
    setContentView(input)
    input.post { input.requestFocus(); (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(input, InputMethodManager.SHOW_IMPLICIT) }
  }
}
