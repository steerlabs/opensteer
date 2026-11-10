package com.opensteer.phonebrowser

import android.os.SystemClock
import android.text.InputType
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.EditorInfo
import org.json.JSONObject
import java.util.UUID

internal class ViewerInput(private val pool: PhoneBrowserPool, private val emit: (Map<String, Any?>) -> Unit, private val admission: (NativeTab) -> Unit) {
  private data class Paste(val tab: NativeTab, val document: String, val context: String, val epoch: Int, val channel: String, val operation: String, val consumer: String, val size: Int, val deadline: Long, val bytes: java.io.ByteArrayOutputStream = java.io.ByteArrayOutputStream(), var index: Int = 0)
  private val pastes = mutableMapOf<Pair<String, String>, Paste>()
  private val channels = mutableMapOf<String, MutableSet<String>>()
  fun changed(tab: NativeTab) { if (tab.documentId != null && tab.document.isDone) channels[tab.id]?.forEach { emitContext(tab, it) } }
  fun retire(tab: NativeTab) { channels.remove(tab.id); pastes.entries.removeAll { it.value.tab === tab } }
  fun apply(input: ViewerRecord) {
    PhoneBrowserNative.authority?.requireViewer(input.epoch, input.channelId, input.sessionId, true) ?: throw BrowserFailure("forbidden")
    val message = JSONObject(input.message)
    val copied = if (message.optString("type") == "clipboard.copy") {
      val tab = pool.ui(input.epoch) { pool.check(input, true).also(admission) }
      JSONObject(pool.evaluate(tab, input.epoch, "(()=>{const e=document.activeElement;if(e&&e.tagName==='INPUT'&&e.type==='password')return {sensitive:true,text:''};return {sensitive:false,text:e&&typeof e.selectionStart==='number'?e.value.slice(e.selectionStart,e.selectionEnd):String(getSelection())}})()"))
    } else null
    pool.ui(input.epoch) {
      val type = message.optString("type")
      val coordinates = type in setOf("input.pointer", "input.wheel")
      val tab = pool.check(input, true, coordinates)
      admission(tab)
      if (message.has("surfaceId") && message.getString("surfaceId") != tab.id) throw BrowserFailure("forbidden")
      if (coordinates) {
        if (message.optLong("geometryRevision", -1) != tab.geometryRevision) throw BrowserFailure("stale-geometry")
        if (message.has("captureRevision") && tab.frameRevisions[input.channelId]?.contains(message.getLong("captureRevision")) != true) throw BrowserFailure("stale-geometry")
      }
      tab.inputSequences.accept(input.channelId, message.optString("producerId"), NativeIntegers.parse(message.optDouble("inputGeneration",Double.NaN)), NativeIntegers.parse(message.optDouble("inputSequenceStart",Double.NaN)), NativeIntegers.parse(message.optDouble("inputSequence",Double.NaN)))
      channels.getOrPut(tab.id) { mutableSetOf() }.add(input.channelId)
      val browser = tab.view ?: throw BrowserFailure("target-suspended")
      when (type) {
        "input.pointer", "input.cancel" -> {
          if (message.optString("button", "left") !in setOf("left", "none")) throw BrowserFailure("unsupported-operation")
          if (message.optJSONArray("modifiers")?.length()?.let { it > 0 } == true) throw BrowserFailure("unsupported-operation")
          val action = if (type == "input.cancel") MotionEvent.ACTION_CANCEL else when (message.getString("action")) {
            "down" -> MotionEvent.ACTION_DOWN
            "up" -> MotionEvent.ACTION_UP
            "move" -> MotionEvent.ACTION_MOVE
            "leave" -> MotionEvent.ACTION_CANCEL
            else -> throw BrowserFailure("unsupported-operation")
          }
          val x = message.optDouble("x", 0.0); val y = message.optDouble("y", 0.0)
          if (!x.isFinite() || !y.isFinite() || x !in 0.0..1.0 || y !in 0.0..1.0) throw BrowserFailure("invalid-viewport")
          if (action != MotionEvent.ACTION_CANCEL && !pool.canTakeFocus(browser)) throw BrowserFailure("not-actionable")
          val now = SystemClock.uptimeMillis()
          if (action == MotionEvent.ACTION_DOWN) tab.pointerDown = now
          if (action !in setOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_CANCEL) && tab.pointerDown == 0L) throw BrowserFailure("stale-input")
          val event = MotionEvent.obtain(tab.pointerDown.takeIf { it > 0 } ?: now, now, action, (x * browser.width).toFloat(), (y * browser.height).toFloat(), 0)
          event.source = InputDevice.SOURCE_TOUCHSCREEN
          try { if (!browser.dispatchTouchEvent(event)) throw BrowserFailure("outcome-unknown") } finally { event.recycle() }
          if (action in setOf(MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL)) tab.pointerDown = 0
        }
        "input.wheel" -> {
          val x = message.getDouble("x"); val y = message.getDouble("y")
          val dx = message.getDouble("deltaX"); val dy = message.getDouble("deltaY")
          if (listOf(x,y,dx,dy).any { !it.isFinite() } || x !in 0.0..1.0 || y !in 0.0..1.0 || kotlin.math.abs(dx) > 100000 || kotlin.math.abs(dy) > 100000) throw BrowserFailure("invalid-viewport")
          val properties = arrayOf(MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_MOUSE })
          val coords = arrayOf(MotionEvent.PointerCoords().apply {
            this.x = (x * browser.width).toFloat(); this.y = (y * browser.height).toFloat()
            setAxisValue(MotionEvent.AXIS_HSCROLL, (-dx / 64).toFloat()); setAxisValue(MotionEvent.AXIS_VSCROLL, (-dy / 64).toFloat())
          })
          val now = SystemClock.uptimeMillis()
          val event = MotionEvent.obtain(now, now, MotionEvent.ACTION_SCROLL, 1, properties, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_MOUSE, 0)
          try { if (!browser.dispatchGenericMotionEvent(event)) throw BrowserFailure("outcome-unknown") } finally { event.recycle() }
        }
        "clipboard.copy" -> {
          val consumer = message.optString("consumerToken").takeIf { it.isNotEmpty() } ?: throw BrowserFailure("forbidden")
          val operation = message.getString("operationId")
          if (copied == null || copied.getBoolean("sensitive") || sensitive(tab)) throw BrowserFailure("forbidden")
          val bytes = copied.getString("text").toByteArray(Charsets.UTF_8)
          if (bytes.size > 1048576) throw BrowserFailure("too-large")
          val result = mapOf("type" to "clipboard.result", "consumerToken" to consumer, "surfaceId" to tab.id, "operationId" to operation, "outcome" to if (bytes.isEmpty()) "empty" else "copied") + if (bytes.isNotEmpty()) mapOf("items" to listOf(mapOf("type" to "text/plain", "size" to bytes.size))) else emptyMap()
          server(tab, input.channelId, result)
          if (bytes.isNotEmpty()) (0 until (bytes.size+524287)/524288).forEach { index -> val part = bytes.copyOfRange(index*524288, minOf(bytes.size,(index+1)*524288)); server(tab, input.channelId, mapOf("type" to "clipboard.part", "consumerToken" to consumer, "part" to mapOf("operationId" to operation, "index" to index, "data" to android.util.Base64.encodeToString(part, android.util.Base64.NO_WRAP)))) }
        }
        "clipboard.paste-data" -> {
          val items = message.getJSONArray("items")
          if (items.length() != 1 || items.getJSONObject(0).getString("type") != "text/plain") throw BrowserFailure("unsupported-operation")
          val size = items.getJSONObject(0).getInt("size")
          if (size !in 0..1048576) throw BrowserFailure("too-large")
          val consumer = message.optString("consumerToken").takeIf { it.isNotEmpty() } ?: throw BrowserFailure("forbidden")
          val operation = message.getString("operationId")
          val key = input.channelId to operation
          if (pastes.containsKey(key)) throw BrowserFailure("stale-input")
          if (pastes.size >= 8) throw BrowserFailure("too-large")
          val pending = Paste(tab, tab.documentId!!, tab.contextId, input.epoch, input.channelId, operation, consumer, size, SystemClock.elapsedRealtime()+10000)
          pastes[key] = pending
          pool.main.postDelayed({ if (pastes[key] === pending) pastes.remove(key) },10000)
        }
        "clipboard.part" -> {
          val part = message.getJSONObject("part")
          val key = input.channelId to part.getString("operationId")
          val pending = pastes[key] ?: throw BrowserFailure("stale-document")
          if (pending.tab !== tab || pending.document != tab.documentId || pending.context != tab.contextId || pending.epoch != input.epoch || pending.deadline < SystemClock.elapsedRealtime()) { pastes.remove(key); throw BrowserFailure("stale-document") }
          val data = part.getString("data")
          if (data.length > 699052 || part.getInt("index") != pending.index) throw BrowserFailure("invalid-offset")
          val bytes = try { android.util.Base64.decode(data, android.util.Base64.NO_WRAP) } catch (_: Exception) { throw BrowserFailure("forbidden") }
          if (bytes.size > 524288 || pending.bytes.size()+bytes.size > pending.size) throw BrowserFailure("too-large")
          pending.index++; pending.bytes.write(bytes)
          if (pending.bytes.size() == pending.size) {
            pastes.remove(key)
            val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
            val text = try { decoder.decode(java.nio.ByteBuffer.wrap(pending.bytes.toByteArray())).toString() } catch (_: Exception) { throw BrowserFailure("forbidden") }
            if (!connection(tab).commitText(text,1)) throw BrowserFailure("outcome-unknown")
            server(tab,input.channelId,mapOf("type" to "clipboard.result", "consumerToken" to pending.consumer, "surfaceId" to tab.id, "operationId" to pending.operation, "outcome" to "pasted"))
          }
        }
        "clipboard.paste" -> {
          val connection = connection(tab)
          val text = message.getString("text")
          if (text.length > 100000) throw BrowserFailure("too-large")
          if (!connection.commitText(text, 1)) throw BrowserFailure("outcome-unknown")
        }
        "input.text", "input.compose" -> {
          val edit = message.getJSONObject(if (type == "input.text") "edit" else "composition")
          if (edit.getString("contextId") != tab.contextId) throw BrowserFailure("stale-document")
          if (edit.optString("before").isNotEmpty() || edit.optString("after").isNotEmpty()) throw BrowserFailure("unsupported-operation")
          val connection = connection(tab)
          if (edit.getString("contextId") != tab.contextId) throw BrowserFailure("stale-document")
          val text = edit.getString("text")
          if (text.length > 10000) throw BrowserFailure("too-large")
          val accepted = if (type == "input.compose") {
            val start = NativeIntegers.parse(edit.getDouble("selectionStart"),10000).toInt()
            val end = NativeIntegers.parse(edit.getDouble("selectionEnd"),10000).toInt()
            if (start > end || end > text.length) throw BrowserFailure("forbidden")
            if (tab.compositionStart == null) {
              val extracted = connection.getExtractedText(android.view.inputmethod.ExtractedTextRequest(),0) ?: throw BrowserFailure("not-actionable")
              tab.compositionStart = minOf(extracted.selectionStart,extracted.selectionEnd) + extracted.startOffset.coerceAtLeast(0)
            }
            val origin = tab.compositionStart!!
            val applied = connection.setComposingText(text,1) && connection.setSelection(origin+start,origin+end)
            if (text.isEmpty()) { connection.finishComposingText(); tab.compositionStart = null }
            applied
          } else { connection.finishComposingText(); tab.compositionStart = null; connection.commitText(text, 1) }
          if (!accepted) throw BrowserFailure("outcome-unknown")
        }
        "input.command" -> {
          val connection = connection(tab)
          val accepted = when (message.getString("command")) {
            "selectAll" -> connection.performContextMenuAction(android.R.id.selectAll)
            "deleteBackward" -> connection.deleteSurroundingText(1, 0)
            else -> throw BrowserFailure("unsupported-operation")
          }
          if (!accepted) throw BrowserFailure("outcome-unknown")
        }
        "input.key" -> {
          if ((message.optJSONArray("modifiers")?.length() ?: 0) > 0) throw BrowserFailure("unsupported-operation")
          val code = when (message.getString("key")) {
            "Enter" -> KeyEvent.KEYCODE_ENTER
            "Backspace" -> KeyEvent.KEYCODE_DEL
            "Tab" -> KeyEvent.KEYCODE_TAB
            "Escape" -> KeyEvent.KEYCODE_ESCAPE
            "ArrowLeft" -> KeyEvent.KEYCODE_DPAD_LEFT
            "ArrowRight" -> KeyEvent.KEYCODE_DPAD_RIGHT
            "ArrowUp" -> KeyEvent.KEYCODE_DPAD_UP
            "ArrowDown" -> KeyEvent.KEYCODE_DPAD_DOWN
            else -> throw BrowserFailure("unsupported-operation")
          }
          connection(tab)
          val action = when (message.getString("action")) { "down" -> KeyEvent.ACTION_DOWN; "up" -> KeyEvent.ACTION_UP; else -> throw BrowserFailure("unsupported-operation") }
          if (!browser.dispatchKeyEvent(KeyEvent(action, code))) throw BrowserFailure("outcome-unknown")
        }
        else -> throw BrowserFailure("unsupported-operation")
      }
      PhoneBrowserNative.authority?.viewerActor(input.epoch, input.channelId, input.sessionId)?.let { actor ->
        emit(pool.documentRef(tab) + mapOf("type" to "activity", "channelId" to input.channelId, "report" to mapOf("type" to "browser.activity", "actorToken" to actor, "surfaceId" to tab.id, "seq" to message.getLong("inputSequence"), "geometryRevision" to tab.geometryRevision, "pointer" to if (coordinates) mapOf("x" to message.getDouble("x"), "y" to message.getDouble("y")) else null)))
      }
      emitContext(tab, input.channelId)
    }
  }
  private fun server(tab: NativeTab, channel: String, message: Map<String, Any?>) { emit(pool.documentRef(tab) + mapOf("type" to "serverMessage", "channelId" to channel, "message" to message)) }
  private fun sensitive(tab: NativeTab): Boolean {
    val type = tab.editor?.inputType ?: return false
    val variation = type and InputType.TYPE_MASK_VARIATION
    return if (type and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_NUMBER) variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
    else variation in setOf(InputType.TYPE_TEXT_VARIATION_PASSWORD, InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD, InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)
  }
  private fun connection(tab: NativeTab): android.view.inputmethod.InputConnection {
    val browser = tab.view ?: throw BrowserFailure("target-suspended")
    if (!pool.canTakeFocus(browser)) throw BrowserFailure("not-actionable")
    browser.requestFocus()
    return tab.connection ?: browser.onCreateInputConnection(EditorInfo()) ?: throw BrowserFailure("not-actionable")
  }
  private fun emitContext(tab: NativeTab, channel: String) {
    val info = tab.editor
    val variation = info?.inputType?.and(InputType.TYPE_MASK_VARIATION)
    val sensitive = sensitive(tab)
    val field = if (info == null) null else mapOf("kind" to "text", "multiline" to (info.inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE != 0), "sensitive" to sensitive)
    emit(pool.documentRef(tab) + mapOf("type" to "editing", "channelId" to channel, "context" to mapOf("contextId" to tab.contextId, "field" to field, "caret" to null)))
  }
}
