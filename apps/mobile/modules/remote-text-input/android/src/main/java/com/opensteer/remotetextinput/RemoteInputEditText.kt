package com.opensteer.remotetextinput

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.text.InputType
import android.text.TextWatcher
import android.text.Editable
import android.util.Base64
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.view.inputmethod.TextAttribute
import android.view.inputmethod.CompletionInfo
import android.widget.EditText
import java.io.ByteArrayOutputStream

class RemoteInputEditText(context: Context) : EditText(context) {
  private val gate = RemoteInputGate()
  private var mutating = false
  private var initialized = false
  private var editableField = false
  private var sensitive = false
  private var multiline = false
  private var composingStart = -1
  private var composingEnd = -1
  private var contextId: String? = null
  var deliver: ((Map<String, Any?>) -> Unit)?
    get() = gate.deliver
    set(value) { gate.deliver = value }
  init {
    setBackgroundColor(Color.TRANSPARENT)
    setTextColor(Color.TRANSPARENT)
    setHintTextColor(Color.TRANSPARENT)
    isCursorVisible = false
    contentDescription = "Type into the remote field"
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    gate.apply = { instruction -> applyInstruction(instruction) }
    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
      override fun afterTextChanged(s: Editable?) {
        if (!mutating) gate.notify(mapOf("type" to "input", "inputType" to "insertReplacementText", "composing" to composing(), "proxy" to snapshot()))
      }
    })
    onFocusChangeListener = View.OnFocusChangeListener { _, focused -> if (!focused) gate.notify(mapOf("type" to "blur")) }
    initialized = true
  }
  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    super.onWindowFocusChanged(hasWindowFocus)
    if (initialized && hasWindowFocus) showKeyboard()
  }
  private fun showKeyboard() {
    post {
      if (hasWindowFocus() && editableField && isFocused && showSoftInputOnFocus)
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }
  }
  fun respond(instruction: Map<String, Any?>) = gate.respond(instruction)
  private fun composing(): Boolean = composingStart >= 0 && composingEnd >= composingStart
  private fun snapshot(): Map<String, Any> {
    val state = mutableMapOf<String, Any>("value" to text.toString(), "selectionStart" to minOf(selectionStart, selectionEnd).coerceAtLeast(0), "selectionEnd" to maxOf(selectionStart, selectionEnd).coerceAtLeast(0))
    if (composing()) state["markedRange"] = mapOf("start" to composingStart, "end" to composingEnd)
    return state
  }
  private fun marked(): String = if (composing()) text.toString().substring(composingStart.coerceAtMost(length()), composingEnd.coerceAtMost(length())) else ""
  private fun updateComposition() {
    composingStart = BaseInputConnection.getComposingSpanStart(text)
    composingEnd = BaseInputConnection.getComposingSpanEnd(text)
  }
  private fun applyInstruction(instruction: Map<String, Any?>) {
    if (composing()) return
    val state = instruction["set"] as? Map<*, *> ?: return
    val value = state["value"] as? String ?: return
    val start = (state["selectionStart"] as? Number)?.toInt() ?: return
    val end = (state["selectionEnd"] as? Number)?.toInt() ?: return
    if (start < 0 || end < start || end > value.length) return
    mutating = true
    setText(value)
    setSelection(start, end)
    mutating = false
  }
  fun finishComposition() {
    gate.enqueue {
      if (!composing()) return@enqueue
      val previous = marked()
      mutating = true
      BaseInputConnection.removeComposingSpans(text)
      updateComposition()
      mutating = false
      gate.notify(mapOf("type" to "compositionend", "data" to previous, "proxy" to snapshot()))
      (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).updateSelection(this, selectionStart, selectionEnd, -1, -1)
    }
  }
  private fun change(inputType: String, data: String?, action: () -> Unit) {
    gate.enqueue {
      gate.event(mapOf("type" to "beforeinput", "inputType" to inputType, "data" to data)) {
        val wasComposing = composing()
        val previous = marked()
        mutating = true
        action()
        updateComposition()
        mutating = false
        if (!wasComposing && composing()) gate.notify(mapOf("type" to "compositionstart", "proxy" to snapshot()))
        if (composing()) gate.notify(mapOf("type" to "compositionupdate", "data" to marked(), "proxy" to snapshot()))
        if (wasComposing && !composing()) gate.notify(mapOf("type" to "compositionend", "data" to (data ?: previous), "proxy" to snapshot()))
        gate.notify(mapOf("type" to "input", "inputType" to inputType, "composing" to composing(), "proxy" to snapshot()))
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).updateSelection(this, selectionStart, selectionEnd, composingStart, composingEnd)
      }
    }
  }
  override fun onSelectionChanged(start: Int, end: Int) {
    super.onSelectionChanged(start, end)
    if (initialized && !mutating) gate.notify(mapOf("type" to "selection", "proxy" to snapshot()))
  }
  override fun onCreateInputConnection(info: EditorInfo): InputConnection? {
    val connection = super.onCreateInputConnection(info) ?: return null
    info.imeOptions = info.imeOptions or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
    return object : InputConnectionWrapper(connection, false) {
      override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
        change("insertCompositionText", text.toString()) { super.setComposingText(text, newCursorPosition) }; return true
      }
      override fun setComposingText(text: CharSequence, newCursorPosition: Int, attribute: TextAttribute?): Boolean = setComposingText(text, newCursorPosition)
      override fun setComposingRegion(start: Int, end: Int, attribute: TextAttribute?): Boolean = setComposingRegion(start, end)
      override fun commitText(text: CharSequence, newCursorPosition: Int, attribute: TextAttribute?): Boolean = commitText(text, newCursorPosition)
      override fun commitCompletion(completion: CompletionInfo): Boolean {
        change("insertReplacementText", completion.text.toString()) { super.commitCompletion(completion) }; return true
      }
      override fun replaceText(start: Int, end: Int, text: CharSequence, newCursorPosition: Int, attribute: TextAttribute?): Boolean {
        val replacement = text.toString()
        change("insertReplacementText", replacement) {
          super.finishComposingText()
          super.setSelection(start, end)
          super.commitText(replacement, newCursorPosition)
        }; return true
      }
      override fun setComposingRegion(start: Int, end: Int): Boolean {
        gate.enqueue {
          val wasComposing = composing()
          mutating = true
          super.setComposingRegion(start, end)
          updateComposition()
          mutating = false
          if (!wasComposing && composing()) gate.notify(mapOf("type" to "compositionstart", "proxy" to snapshot()))
          if (composing()) gate.notify(mapOf("type" to "compositionupdate", "data" to marked(), "proxy" to snapshot()))
        }; return true
      }
      override fun finishComposingText(): Boolean {
        gate.enqueue {
          val wasComposing = composing()
          val previous = marked()
          mutating = true
          super.finishComposingText()
          updateComposition()
          mutating = false
          if (wasComposing) gate.notify(mapOf("type" to "compositionend", "data" to previous, "proxy" to snapshot()))
        }; return true
      }
      override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
        val committed = text.toString()
        gate.enqueue {
          val intent = if (composing()) "insertFromComposition" else if (committed == "\n") "insertLineBreak" else "insertText"
          change(intent, committed) { super.commitText(committed, newCursorPosition) }
        }
        return true
      }
      override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        change(if (afterLength > 0 && beforeLength == 0) "deleteContentForward" else "deleteContentBackward", null) { super.deleteSurroundingText(beforeLength, afterLength) }; return true
      }
      override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
        change(if (afterLength > 0 && beforeLength == 0) "deleteContentForward" else "deleteContentBackward", null) { super.deleteSurroundingTextInCodePoints(beforeLength, afterLength) }; return true
      }
      override fun setSelection(start: Int, end: Int): Boolean {
        gate.enqueue {
          mutating = true
          super.setSelection(start, end)
          mutating = false
          gate.notify(mapOf("type" to "selection", "proxy" to snapshot()))
        }; return true
      }
      override fun performContextMenuAction(id: Int): Boolean = this@RemoteInputEditText.onTextContextMenuItem(id)
      override fun sendKeyEvent(event: KeyEvent): Boolean = this@RemoteInputEditText.dispatchKeyEvent(event)
      override fun performEditorAction(actionCode: Int): Boolean {
        dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
        dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
        return true
      }
    }
  }
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (!editableField) return false
    if (event.action != KeyEvent.ACTION_DOWN && event.action != KeyEvent.ACTION_UP) return super.dispatchKeyEvent(event)
    val named = mapOf(KeyEvent.KEYCODE_DEL to "Backspace", KeyEvent.KEYCODE_FORWARD_DEL to "Delete", KeyEvent.KEYCODE_ENTER to "Enter", KeyEvent.KEYCODE_TAB to "Tab", KeyEvent.KEYCODE_ESCAPE to "Escape", KeyEvent.KEYCODE_DPAD_LEFT to "ArrowLeft", KeyEvent.KEYCODE_DPAD_RIGHT to "ArrowRight", KeyEvent.KEYCODE_DPAD_UP to "ArrowUp", KeyEvent.KEYCODE_DPAD_DOWN to "ArrowDown", KeyEvent.KEYCODE_MOVE_HOME to "Home", KeyEvent.KEYCODE_MOVE_END to "End", KeyEvent.KEYCODE_CTRL_LEFT to "Control", KeyEvent.KEYCODE_CTRL_RIGHT to "Control", KeyEvent.KEYCODE_ALT_LEFT to "Alt", KeyEvent.KEYCODE_ALT_RIGHT to "Alt", KeyEvent.KEYCODE_SHIFT_LEFT to "Shift", KeyEvent.KEYCODE_SHIFT_RIGHT to "Shift", KeyEvent.KEYCODE_META_LEFT to "Meta", KeyEvent.KEYCODE_META_RIGHT to "Meta")
    val unicode = event.getUnicodeChar(event.metaState and KeyEvent.META_CTRL_MASK.inv())
    val key = named[event.keyCode] ?: if (unicode > 0 && unicode and KeyCharacterMap.COMBINING_ACCENT != 0) "Dead" else if (unicode > 0) String(Character.toChars(unicode)) else "Unidentified"
    val physical = KeyEvent.keyCodeToString(event.keyCode).removePrefix("KEYCODE_")
    val code = when {
      event.keyCode in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> "Key$physical"
      event.keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> "Digit$physical"
      physical.startsWith("NUMPAD_") -> "Numpad" + (mapOf("ADD" to "Add", "SUBTRACT" to "Subtract", "MULTIPLY" to "Multiply", "DIVIDE" to "Divide", "DOT" to "Decimal", "ENTER" to "Enter", "EQUALS" to "Equal")[physical.removePrefix("NUMPAD_")] ?: physical.removePrefix("NUMPAD_"))
      physical.endsWith("_LEFT") && key in listOf("Control", "Alt", "Meta", "Shift") -> key + "Left"
      physical.endsWith("_RIGHT") && key in listOf("Control", "Alt", "Meta", "Shift") -> key + "Right"
      else -> mapOf("SPACE" to "Space", "MINUS" to "Minus", "EQUALS" to "Equal", "LEFT_BRACKET" to "BracketLeft", "RIGHT_BRACKET" to "BracketRight", "BACKSLASH" to "Backslash", "SEMICOLON" to "Semicolon", "APOSTROPHE" to "Quote", "GRAVE" to "Backquote", "COMMA" to "Comma", "PERIOD" to "Period", "SLASH" to "Slash")[physical] ?: named[event.keyCode] ?: "Unidentified"
    }
    val right = physical.endsWith("_RIGHT")
    val modifier = key in listOf("Control", "Alt", "Meta", "Shift")
    val packet = mapOf("type" to if (event.action == KeyEvent.ACTION_DOWN) "keydown" else "keyup", "key" to key, "code" to code, "alt" to event.isAltPressed, "control" to event.isCtrlPressed, "meta" to event.isMetaPressed, "shift" to event.isShiftPressed, "altGraph" to (event.metaState and KeyEvent.META_ALT_RIGHT_ON != 0 && unicode > 0), "location" to if (modifier) { if (right) 2 else 1 } else if (physical.startsWith("NUMPAD")) 3 else 0, "repeat" to (event.repeatCount > 0))
    val retained = KeyEvent(event)
    // The target owns selection; TextView must not gate clipboard intent on the local mirror.
    val clipboard = if (event.action == KeyEvent.ACTION_DOWN && event.isCtrlPressed && !event.isAltPressed && !event.isMetaPressed) {
      when (key.lowercase()) { "c" -> android.R.id.copy; "x" -> android.R.id.cut; "v" -> android.R.id.paste; else -> null }
    } else null
    gate.enqueue {
      gate.event(packet + ("composing" to composing())) {
        if (clipboard != null) onTextContextMenuItem(clipboard) else super.dispatchKeyEvent(retained)
      }
    }
    return true
  }
  override fun onTextContextMenuItem(id: Int): Boolean {
    when (id) {
      android.R.id.copy -> { gate.notify(mapOf("type" to "copy")); return true }
      android.R.id.cut -> { gate.notify(mapOf("type" to "cut")); return true }
      android.R.id.paste, android.R.id.pasteAsPlainText -> { gate.enqueue { paste() }; return true }
    }
    return super.onTextContextMenuItem(id)
  }
  private fun paste() {
    val clip = (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
    val items = mutableListOf<Map<String, Any>>()
    var total = 0
    fun append(type: String, bytes: ByteArray) {
      total += bytes.size
      if (total <= 16 * 1024 * 1024 && items.size < 16) items.add(mapOf("type" to type, "data" to Base64.encodeToString(bytes, Base64.NO_WRAP)))
    }
    if (clip != null) for (i in 0 until clip.itemCount) {
      val item = clip.getItemAt(i)
      item.text?.let { append("text/plain", it.toString().toByteArray(Charsets.UTF_8)) }
      item.htmlText?.let { append("text/html", it.toByteArray(Charsets.UTF_8)) }
      item.uri?.let { uri ->
        val type = context.contentResolver.getType(uri)
        if (type?.startsWith("image/") == true) {
          try { context.contentResolver.openInputStream(uri)?.use { stream ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(16384)
            while (output.size() <= 16 * 1024 * 1024) {
              val count = stream.read(buffer, 0, minOf(buffer.size, 16 * 1024 * 1024 + 1 - output.size()))
              if (count < 0) break
              output.write(buffer, 0, count)
            }
            append(type, output.toByteArray())
          } } catch (_: Exception) { /* The OS can revoke a provider's clipboard URI. */ }
        }
      }
    }
    gate.notify(mapOf("type" to "paste", "items" to if (total <= 16 * 1024 * 1024) items else emptyList<Map<String, Any>>()))
  }
  fun configure(context: Map<String, Any?>?, focused: Boolean) {
    gate.enqueue {
      if (context?.get("contextId") as? String != contextId) {
        finishComposition()
        // The ending's acknowledgement precedes the reset and new-context input.
        gate.enqueue { applyConfiguration(context, focused) }
      } else {
        applyConfiguration(context, focused)
      }
    }
  }
  private fun applyConfiguration(context: Map<String, Any?>?, focused: Boolean) {
    val nextContext = context?.get("contextId") as? String
    if (nextContext != contextId) {
      contextId = nextContext
      gate.contextId = nextContext
      mutating = true
      setText(""); setSelection(0)
      mutating = false
    }
    val field = context?.get("field") as? Map<*, *>
    editableField = field != null
    sensitive = field?.get("sensitive") == true
    multiline = field?.get("multiline") == true
    val mode = field?.get("inputMode") as? String
    var type = when (mode) {
      "numeric" -> InputType.TYPE_CLASS_NUMBER
      "decimal" -> InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
      "tel" -> InputType.TYPE_CLASS_PHONE
      "email" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
      "url" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
      else -> InputType.TYPE_CLASS_TEXT
    }
    if (sensitive) type = if (mode == "numeric" || mode == "decimal") type or InputType.TYPE_NUMBER_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
    else if (type and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_TEXT) {
      type = type or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
      if (multiline) type = type or InputType.TYPE_TEXT_FLAG_MULTI_LINE
      type = type or when (field?.get("autocapitalize")) {
        "characters" -> InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        "words" -> InputType.TYPE_TEXT_FLAG_CAP_WORDS
        "on", "sentences" -> InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        else -> 0
      }
    }
    if (inputType != type) { mutating = true; inputType = type; mutating = false }
    imeOptions = when (field?.get("enterKeyHint")) {
      "done" -> EditorInfo.IME_ACTION_DONE
      "go" -> EditorInfo.IME_ACTION_GO
      "next" -> EditorInfo.IME_ACTION_NEXT
      "previous" -> EditorInfo.IME_ACTION_PREVIOUS
      "search" -> EditorInfo.IME_ACTION_SEARCH
      "send" -> EditorInfo.IME_ACTION_SEND
      else -> EditorInfo.IME_ACTION_NONE
    }
    showSoftInputOnFocus = editableField && mode != "none"
    val keyboard = this.context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    if (editableField && focused) { requestFocus(); showKeyboard() }
    else { keyboard.hideSoftInputFromWindow(windowToken, 0); clearFocus() }
  }
}
