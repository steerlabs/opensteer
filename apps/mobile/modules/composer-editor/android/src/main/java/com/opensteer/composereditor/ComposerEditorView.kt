// A narrow port of T3 Code's T3ComposerEditorView.kt
// (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., MIT License:
// an EditText that keeps the Markdown source as its text and draws references as chips.
package com.opensteer.composereditor

import android.content.Context
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.Spanned
import android.text.TextWatcher
import android.text.style.TtsSpan
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import androidx.appcompat.widget.AppCompatEditText
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.viewevent.ViewEventCallback
import expo.modules.kotlin.views.ExpoView
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max

private data class ComposerToken(
  val start: Int,
  val end: Int,
  val source: String,
  val label: String,
  val art: String,
  val accessibilityLabel: String,
)

class ComposerEditorView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // React Native ignores the editor's requestLayout(), which makes TextView defer caret scrolls.
  override val shouldUseAndroidLayout = true

  private val editor = ComposerEditText(context)
  private val onComposerChange by EventDispatcher<Map<String, Any>>()
  private val onComposerSelectionChange by EventDispatcher<Map<String, Any>>()
  private val onComposerFocus by EventDispatcher<Map<String, Any>>()
  private val onComposerBlur by EventDispatcher<Map<String, Any>>()
  private val onComposerPasteImages by EventDispatcher<Map<String, Any>>()
  private val onComposerContentSizeChange by EventDispatcher<Map<String, Any>>()
  private val onComposerEmptyBackspace by EventDispatcher<Map<String, Any>>()
  private val density = resources.displayMetrics.density
  private var applying = false
  private var nativeEventCount = 0
  private var generation = 0
  private var tokens: List<ComposerToken> = emptyList()
  private var appliedSpans = ""
  private var spokenSpans: List<TtsSpan> = emptyList()
  private var fontSize = 17f
  private var lineHeightPx = 0
  private var lastContentHeight = -1
  private var colors = ChipColors(Color.WHITE, Color.LTGRAY, Color.DKGRAY, Color.GRAY, Color.GRAY, Color.WHITE)
  var maxBytes = 0L
  var deliverDraftPaste: ((Map<String, Any>) -> Unit)? = null

  init {
    editor.setBackgroundColor(Color.TRANSPARENT)
    editor.gravity = Gravity.TOP or Gravity.START
    editor.includeFontPadding = false
    editor.isSingleLine = false
    editor.minLines = 1
    editor.setPadding(0, 0, 0, 0)
    editor.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
      InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    editor.chips = ::currentChips
    editor.selectionListener = { start, end -> if (!applying) changeSelection(start, end) }
    editor.emptyBackspaceListener = { onComposerEmptyBackspace(emptyMap<String, Any>()) }
    editor.setOnFocusChangeListener { _, focused ->
      if (focused) onComposerFocus(emptyMap<String, Any>()) else onComposerBlur(emptyMap<String, Any>())
    }
    editor.addTextChangedListener(
      object : TextWatcher {
        override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
        override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit
        override fun afterTextChanged(editable: Editable?) {
          if (applying) return
          emit(onComposerChange)
          // The layout reflows after this callback; measure once it has.
          editor.post { emitContentSize() }
        }
      },
    )
    ViewCompat.setOnReceiveContentListener(editor, arrayOf("image/*"), OnReceiveContentListener { _, payload -> receive(payload) })
    var tappedChip: ChipRange? = null
    val taps = GestureDetector(
      context,
      object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(event: MotionEvent) = true
        override fun onSingleTapUp(event: MotionEvent): Boolean {
          tappedChip = chipAt(event.x, event.y)
          return false
        }
      },
    )
    editor.setOnTouchListener { _, event ->
      taps.onTouchEvent(event)
      val chip = tappedChip
      tappedChip = null
      if (event.actionMasked != MotionEvent.ACTION_UP || chip == null || !editor.isEnabled) return@setOnTouchListener false
      // A tap on a chip selects it whole; EditText would otherwise place a caret inside its source.
      val cancel = MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_CANCEL }
      editor.onTouchEvent(cancel)
      cancel.recycle()
      if (!editor.hasFocus()) focusEditor()
      editor.setSelection(chip.start, chip.end)
      true
    }
    editor.addOnLayoutChangeListener { _, left, _, right, _, oldLeft, _, oldRight, _ ->
      if (right - left != oldRight - oldLeft) applySpans(force = true)
      emitContentSize()
    }
    addView(editor, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  // Props

  fun setDocumentJson(json: String) {
    val document = runCatching { JSONObject(json) }.getOrNull() ?: return
    val documentGeneration = document.optInt("generation", 0)
    val isReset = documentGeneration > generation
    val eventCount = document.optInt("eventCount", -1)
    // A parent reset (a send clearing the field) wins over native edits it could not see.
    if (!isReset && eventCount < nativeEventCount) return
    if (isReset) generation = documentGeneration
    // A recreated view continues from JS's revision, or JS would drop every event it sends.
    nativeEventCount = eventCount
    val value = document.optString("value")
    val current = editor.text?.toString().orEmpty()
    if (document.optBoolean("isNativeEcho") && !isReset && current != value) return
    tokens = parseTokens(document.optJSONArray("tokens"))
    val requested = document.optJSONObject("selection")
    val previousStart = editor.selectionStart.coerceAtLeast(0)
    val previousEnd = editor.selectionEnd.coerceAtLeast(0)
    applying = true
    try {
      if (current != value) editor.setText(value)
      applySpans(force = current != value)
      when {
        requested != null -> select(requested.optInt("start", previousStart), requested.optInt("end", previousEnd))
        current != value -> select(previousStart, previousEnd)
      }
    } finally {
      applying = false
    }
    emitContentSize()
  }

  fun setThemeJson(json: String) {
    val theme = runCatching { JSONObject(json) }.getOrNull() ?: return
    fun color(key: String, fallback: Int) = parseColor(theme.optString(key), fallback)
    editor.setTextColor(color("text", Color.WHITE))
    editor.setHintTextColor(color("placeholder", Color.GRAY))
    val tint = color("tint", editor.currentTextColor)
    editor.highlightColor = (tint and 0x00FFFFFF) or (0x52 shl 24)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      editor.textCursorDrawable?.mutate()?.setTint(tint)
      editor.textSelectHandle?.mutate()?.setTint(tint)
      editor.textSelectHandleLeft?.mutate()?.setTint(tint)
      editor.textSelectHandleRight?.mutate()?.setTint(tint)
    }
    colors = ChipColors(
      text = color("chipText", Color.WHITE),
      glyph = color("chipGlyph", Color.LTGRAY),
      fill = color("chipFill", Color.DKGRAY),
      rim = color("chipRim", Color.GRAY),
      edge = color("chipEdge", Color.GRAY),
      selectedRim = color("chipSelectedRim", tint),
    )
    applySpans(force = true)
  }

  fun setPlaceholder(placeholder: String) {
    editor.hint = placeholder
  }

  fun setLabel(label: String) {
    editor.contentDescription = label
  }

  fun setTypography(fontSize: Float, lineHeight: Float, paddingVertical: Float) {
    this.fontSize = fontSize
    // The size arrives already scaled for the person's text size, so it is not scaled again.
    editor.setTextSize(TypedValue.COMPLEX_UNIT_DIP, fontSize)
    lineHeightPx = (lineHeight * density).toInt()
    val fontHeight = editor.paint.fontMetricsInt.let { it.descent - it.ascent }
    editor.setLineSpacing(max(0, lineHeightPx - fontHeight).toFloat(), 1f)
    val padding = (paddingVertical * density).toInt()
    editor.setPadding(0, padding, 0, padding)
    applySpans(force = true)
    emitContentSize()
  }

  fun setEditable(editable: Boolean) {
    editor.isEnabled = editable
    editor.isFocusable = editable
    editor.isFocusableInTouchMode = editable
  }

  fun setAutoFocus(autoFocus: Boolean) {
    if (autoFocus) post { focusEditor() }
  }

  // Commands

  fun focusEditor() {
    editor.requestFocus()
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.showSoftInput(editor, 0)
  }

  fun blurEditor() {
    editor.clearFocus()
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
    imm?.hideSoftInputFromWindow(editor.windowToken, 0)
  }

  fun setSelection(start: Int, end: Int) {
    select(start, end)
  }

  fun readState(): Map<String, Any> = state()

  // Document

  private fun currentChips(): List<ChipRange> {
    val text = editor.text ?: return emptyList()
    return text.getSpans(0, text.length, ComposerChipSpan::class.java)
      .map { ChipRange(text.getSpanStart(it), text.getSpanEnd(it)) }
      .sortedBy { it.start }
  }

  private fun applySpans(force: Boolean) {
    val text = editor.text ?: return
    val valid = ComposerDocument.validChips(text, tokens.map { ChipRange(it.start, it.end) to it.source })
    val drawn = tokens.filter { token -> valid.any { it.start == token.start && it.end == token.end } }
    val key = drawn.joinToString("\u0000") { "${it.start}:${it.end}:${it.label}:${it.art}" }
    // Re-spanning on every keystroke would redraw for nothing; spans move with the text.
    if (!force && key == appliedSpans && currentChips() == valid) return
    appliedSpans = key
    text.getSpans(0, text.length, ComposerChipSpan::class.java).forEach(text::removeSpan)
    spokenSpans.forEach(text::removeSpan)
    val width = (editor.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels).toFloat()
    val textSize = editor.textSize
    spokenSpans = drawn.map { token ->
      text.setSpan(
        ComposerChipSpan(
          label = token.label,
          art = token.art,
          textSize = textSize,
          lineHeight = if (lineHeightPx > 0) lineHeightPx.toFloat() else textSize * 1.4f,
          maximumWidth = width,
          density = density,
          colors = colors,
          isSelected = { start, end -> editor.selectionStart <= start && editor.selectionEnd >= end && editor.selectionStart != editor.selectionEnd },
        ),
        token.start,
        token.end,
        Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
      )
      // TalkBack reads the reference's name, not its Markdown.
      TtsSpan.TextBuilder(token.accessibilityLabel).build().also {
        text.setSpan(it, token.start, token.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
    }
    editor.invalidate()
  }

  private fun select(start: Int, end: Int) {
    val length = editor.text?.length ?: 0
    val (from, to) = ComposerDocument.snapSelection(start.coerceIn(0, length), end.coerceIn(0, length), currentChips())
    // Re-applying an unchanged selection resets the keyboard's suggestions.
    if (editor.selectionStart == from && editor.selectionEnd == to) return
    editor.setSelection(from, to)
  }

  private fun changeSelection(start: Int, end: Int) {
    val (from, to) = ComposerDocument.snapSelection(start, end, currentChips())
    if (from != minOf(start, end) || to != maxOf(start, end)) {
      // Arrow keys and handles cannot rest inside a reference; this moves them out first.
      editor.setSelection(from, to)
      return
    }
    redrawSelectedChips()
    emit(onComposerSelectionChange)
  }

  private var selectedChips: Set<ChipRange> = emptySet()

  /** A selected chip takes the accent rim; re-setting its span repaints its cached text block. */
  private fun redrawSelectedChips() {
    val text = editor.text ?: return
    val start = editor.selectionStart
    val end = editor.selectionEnd
    val next = if (start == end) emptySet() else currentChips().filter { it.start >= start && it.end <= end }.toSet()
    if (next == selectedChips) return
    val changed = (next - selectedChips) + (selectedChips - next)
    selectedChips = next
    text.getSpans(0, text.length, ComposerChipSpan::class.java).forEach { span ->
      val range = ChipRange(text.getSpanStart(span), text.getSpanEnd(span))
      if (range in changed) text.setSpan(span, range.start, range.end, text.getSpanFlags(span))
    }
  }

  private fun chipAt(x: Float, y: Float): ChipRange? {
    val layout = editor.layout ?: return null
    val offset = editor.getOffsetForPosition(x, y)
    val localX = x - editor.totalPaddingLeft + editor.scrollX
    val localY = y - editor.totalPaddingTop + editor.scrollY
    return currentChips().firstOrNull { chip ->
      if (offset < chip.start || offset > chip.end) return@firstOrNull false
      val line = layout.getLineForOffset(chip.start)
      val left = layout.getPrimaryHorizontal(chip.start)
      val right = if (layout.getLineForOffset(chip.end) == line) layout.getPrimaryHorizontal(chip.end) else layout.getLineRight(line)
      localY >= layout.getLineTop(line) && localY <= layout.getLineBottom(line) &&
        localX >= minOf(left, right) && localX <= maxOf(left, right)
    }
  }

  private fun receive(payload: ContentInfoCompat): ContentInfoCompat? {
    val resolver = context.contentResolver
    val split = payload.partition { item -> item.uri?.let { resolver.getType(it)?.startsWith("image/") } == true }
    val images = split.first ?: return split.second
    val uris = (0 until images.clip.itemCount).mapNotNull { images.clip.getItemAt(it).uri }
    val delivery = deliverDraftPaste
    if (delivery != null) {
      val main = Handler(Looper.getMainLooper())
      PastedImages.copy(context.applicationContext, uris, maxBytes, { main.post(it) }, delivery)
    } else {
      PastedImages.copy(context, uris, maxBytes, { post(it) }) { onComposerPasteImages(it) }
    }
    return split.second
  }

  // Events

  private fun state(): Map<String, Any> {
    val text = editor.text
    val start = minOf(editor.selectionStart, editor.selectionEnd).coerceAtLeast(0)
    val end = maxOf(editor.selectionStart, editor.selectionEnd).coerceAtLeast(0)
    return mapOf(
      "value" to text.toString(),
      "selection" to mapOf("start" to start, "end" to end),
      "eventCount" to nativeEventCount,
      "generation" to generation,
      "composing" to (text != null && BaseInputConnection.getComposingSpanStart(text) >= 0),
    )
  }

  /** Caret moves advance the count like edits: a payload computed before one is stale. */
  private fun emit(dispatch: ViewEventCallback<Map<String, Any>>) {
    nativeEventCount += 1
    dispatch(state())
  }

  private fun emitContentSize() {
    val height = (editor.layout?.height ?: 0) + editor.paddingTop + editor.paddingBottom
    if (height == lastContentHeight) return
    lastContentHeight = height
    onComposerContentSizeChange(mapOf("height" to height / density))
  }

  private fun parseTokens(array: JSONArray?): List<ComposerToken> {
    if (array == null) return emptyList()
    return List(array.length()) { index ->
      val token = array.getJSONObject(index)
      ComposerToken(
        start = token.optInt("start"),
        end = token.optInt("end"),
        source = token.optString("source"),
        label = token.optString("label"),
        art = token.optString("art"),
        accessibilityLabel = token.optString("accessibilityLabel"),
      )
    }
  }

  /** `#rrggbb`, `#rrggbbaa` or `rgba(r, g, b, a)`, as the app's theme writes them. */
  private fun parseColor(value: String, fallback: Int): Int = runCatching {
    if (value.startsWith("rgba(")) {
      val parts = value.removePrefix("rgba(").removeSuffix(")").split(",").map { it.trim().toFloat() }
      Color.argb((parts[3] * 255).toInt(), parts[0].toInt(), parts[1].toInt(), parts[2].toInt())
    } else if (value.length == 9 && value.startsWith("#")) {
      // React Native hex colours put alpha last; Android's parser puts it first.
      Color.parseColor("#${value.takeLast(2)}${value.substring(1, 7)}")
    } else {
      Color.parseColor(value)
    }
  }.getOrDefault(fallback)
}

/** An EditText whose keys and IME edits remove or select whole references. */
internal class ComposerEditText(context: Context) : AppCompatEditText(context) {
  var chips: () -> List<ChipRange> = { emptyList() }
  var selectionListener: ((Int, Int) -> Unit)? = null
  var emptyBackspaceListener: (() -> Unit)? = null

  // Keeps autofill services such as SMS verification codes from writing into the draft.
  override fun getAutofillType(): Int = AUTOFILL_TYPE_NONE

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    selectionListener?.invoke(selStart, selEnd)
  }

  private fun deleteChip(backwards: Boolean): Boolean {
    val content = text ?: return false
    val range = ComposerDocument.keyDeletion(selectionStart, selectionEnd, backwards, chips()) ?: return false
    content.delete(range.start.coerceAtLeast(0), range.end.coerceAtMost(content.length))
    return true
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (keyCode == KeyEvent.KEYCODE_DEL && text.isNullOrEmpty()) emptyBackspaceListener?.invoke()
    val handled = when (keyCode) {
      KeyEvent.KEYCODE_DEL -> deleteChip(true)
      KeyEvent.KEYCODE_FORWARD_DEL -> deleteChip(false)
      else -> false
    }
    return handled || super.onKeyDown(keyCode, event)
  }

  // Pasted rich text arrives as its words; Markdown is the only formatting the draft holds.
  override fun onTextContextMenuItem(id: Int): Boolean =
    super.onTextContextMenuItem(if (id == android.R.id.paste) android.R.id.pasteAsPlainText else id)

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val connection = super.onCreateInputConnection(outAttrs) ?: return null
    return object : InputConnectionWrapper(connection, false) {
      override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        if (beforeLength > 0 && text.isNullOrEmpty()) emptyBackspaceListener?.invoke()
        val (before, after) = ComposerDocument.surroundingDeletion(selectionStart, selectionEnd, beforeLength, afterLength, chips())
        return super.deleteSurroundingText(before, after)
      }

      override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
        val content = text ?: return super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
        val start = minOf(selectionStart, selectionEnd)
        val end = maxOf(selectionStart, selectionEnd)
        val before = start - offsetByCodePoints(content, start, -beforeLength)
        val after = offsetByCodePoints(content, end, afterLength) - end
        return deleteSurroundingText(before, after)
      }

      override fun setComposingRegion(start: Int, end: Int): Boolean {
        val (from, to) = ComposerDocument.composingRegion(start, end, selectionStart, chips())
        return super.setComposingRegion(from, to)
      }
    }
  }

  private fun offsetByCodePoints(content: CharSequence, index: Int, count: Int): Int =
    runCatching { Character.offsetByCodePoints(content, index, count) }
      .getOrDefault(if (count < 0) 0 else content.length)
}
