package com.opensteer.remotetextinput

import android.app.Activity
import android.os.Bundle
import android.graphics.Color
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Button
import android.content.ClipData
import android.content.ClipboardManager
import java.io.File
import org.json.JSONObject

/** Records real IME calls into the production proxy; it never injects InputConnection calls. */
class NativeKeyboardRecorderActivity : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.WHITE) }
    val status = TextView(this).apply { text = "Tap the proxy and use the keyboard"; textSize = 18f }
    val input = RemoteInputEditText(this)
    input.contentDescription = "Native proxy recorder"
    layout.addView(status)
    layout.addView(input, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 240))
    setContentView(layout)
    val caseName = intent.getStringExtra("case")?.takeIf { it.matches(Regex("[a-z0-9-]{1,80}")) } ?: "native"
    val output = File(filesDir, "$caseName.jsonl")
    output.writeText("")
    var count = 0
    input.deliver = { packet ->
      output.appendText(JSONObject(packet).toString() + "\n")
      count++
      status.text = "Recorded $count native events"
      input.post { input.respond(mapOf("id" to packet["id"])) }
    }
    var field = 1
    fun configure() {
      val context = mapOf("contextId" to "00000000-0000-4000-8000-${field.toString().padStart(12, '0')}", "field" to mapOf("kind" to "text", "multiline" to (intent.getStringExtra("field") != "go"), "sensitive" to false, "autocapitalize" to "none", "enterKeyHint" to if (intent.getStringExtra("field") == "go") "go" else "enter"), "caret" to null)
      output.appendText(JSONObject(mapOf("context" to context)).toString() + "\n")
      input.configure(context, true)
    }
    layout.addView(Button(this).apply {
      text = "Next remote field"
      setOnClickListener { field++; configure() }
    })
    layout.addView(Button(this).apply {
      text = "Seed system clipboard"
      setOnClickListener {
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("fixture", "clipboard 👩‍💻"))
        input.requestFocus()
      }
    })
    input.post { configure() }
  }
}
