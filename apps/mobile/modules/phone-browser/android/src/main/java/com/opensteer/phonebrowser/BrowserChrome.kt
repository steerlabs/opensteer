package com.opensteer.phonebrowser

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Message
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import java.util.UUID

internal class BrowserChrome(
  private val pool: PhoneBrowserPool,
  private val activity: () -> Activity?,
  private val files: SessionFiles,
  private val emit: (Map<String, Any?>) -> Unit,
  private val popup: (NativeTab, Message) -> Boolean
) {
  private data class Dialog(val id: String, val tab: NativeTab, val document: String, var completion: (Boolean, String?) -> Unit, val epoch: Int, var default: String? = null, var pipe: String? = null, var ui: AlertDialog? = null)
  private data class Chooser(val id: String, val tab: NativeTab, val document: String, val epoch: Int, val callback: ValueCallback<Array<Uri>>, val params: WebChromeClient.FileChooserParams)
  private val dialogs = mutableMapOf<String, Dialog>()
  private val choosers = mutableMapOf<String, Chooser>()
  private var picker: Chooser? = null
  val pickerActive get() = picker != null
  companion object { const val PICKER_CODE = 53179 }

  fun install(tab: NativeTab, browser: WebView) {
    browser.webChromeClient = object : WebChromeClient() {
      override fun onReceivedTitle(view: WebView, title: String?) { if (view !== tab.view) return; tab.title = if (view.url == tab.bootstrap) "" else (title ?: "").take(10000); pool.changed(tab) }
      override fun onProgressChanged(view: WebView, progress: Int) { if (view !== tab.view) return; tab.loading = progress < 100; pool.changed(tab) }
      override fun onPermissionRequest(request: PermissionRequest) = request.deny()
      override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) = callback.invoke(origin, false, false)
      override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult) = dialog(tab, view, "alert", message, result)
      override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult) = dialog(tab, view, "confirm", message, result)
      override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String, result: JsPromptResult) = dialog(tab, view, "prompt", message, result, defaultValue)
      override fun onJsBeforeUnload(view: WebView, url: String, message: String, result: JsResult) = dialog(tab, view, "beforeunload", message, result)
      override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean = view === tab.view && popup(tab, resultMsg)
      override fun onCloseWindow(window: WebView) { if (window === tab.view) pool.destroyNow(tab.id) }
      override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
        if (view !== tab.view) { callback.onReceiveValue(null); return true }
        cancelChooser(tab)
        val document = tab.documentId
        if (document == null || !tab.document.isDone) { callback.onReceiveValue(null); return true }
        val chooser = Chooser(UUID.randomUUID().toString(), tab, document, pool.gate.epoch, callback, params)
        choosers[tab.id] = chooser
        emit(pool.documentRef(tab) + mapOf("type" to "upload", "chooserId" to chooser.id, "accept" to params.acceptTypes.toList(), "multiple" to (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)))
        if (tab.hostId != null && tab.interactive) {
          try {
            if (picker != null) throw BrowserFailure("picker-busy")
            picker = chooser
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
              .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
            val accept = params.acceptTypes.filter { it.contains('/') && !it.contains(';') }
            if (accept.isNotEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, accept.toTypedArray())
            (activity() ?: throw BrowserFailure("foreground-required")).startActivityForResult(intent, PICKER_CODE)
          } catch (_: Exception) { cancelChooser(tab) }
        }
        return true
      }
    }
  }

  private fun dialog(tab: NativeTab, view: WebView, type: String, message: String, result: JsResult, default: String? = null): Boolean {
    if (!pool.isForeground || pool.ledger.state(tab.id) != TabState.LIVE || tab.view !== view) { result.cancel(); return true }
    val document = tab.documentId
    if (document == null || !tab.document.isDone) { result.cancel(); return true }
    val existing = dialogs[tab.id]
    if (existing != null && existing.document == document) {
      existing.completion = { accept, text -> if (!accept) result.cancel() else if (result is JsPromptResult) result.confirm(text ?: "") else result.confirm() }
      existing.default = default
      return true
    }
    cancelDialog(tab)
    val pending = Dialog(UUID.randomUUID().toString(), tab, document, { accept, text ->
      if (!accept) result.cancel() else if (result is JsPromptResult) result.confirm(text ?: "") else result.confirm()
    }, pool.gate.epoch, default)
    return present(pending,type,message)
  }

  private fun present(pending: Dialog, type: String, message: String): Boolean {
    val tab = pending.tab
    dialogs[tab.id] = pending
    emit(pool.documentRef(tab) + mapOf("type" to "dialog", "dialog" to mapOf("id" to pending.id, "type" to type, "message" to message.take(10000), "surfaceId" to tab.id)))
    if (tab.hostId != null && tab.interactive) {
      val owner = activity() ?: return true
      val text = if (type == "prompt") android.widget.EditText(owner).apply { setText(pending.default ?: "") } else null
      val builder = AlertDialog.Builder(owner).setMessage(message.take(10000)).setPositiveButton(android.R.string.ok) { _, _ -> personAnswer(pending, true, text?.text?.toString()) }
        .setOnCancelListener { personAnswer(pending, false, null) }
      if (type != "alert") builder.setNegativeButton(android.R.string.cancel) { _, _ -> personAnswer(pending, false, null) }
      if (text != null) builder.setView(text)
      pending.ui = builder.create().also { it.show() }
    }
    return true
  }

  private fun personAnswer(pending: Dialog, accept: Boolean, text: String?) { try { complete(pending, accept, text) } catch (_: BrowserFailure) { } }
  private fun complete(pending: Dialog, accept: Boolean, text: String?) {
    if (dialogs[pending.tab.id] !== pending) throw BrowserFailure("stale-dialog")
    if (pool.gate.epoch != pending.epoch || pending.tab.documentId != pending.document) { cancelDialog(pending.tab); throw BrowserFailure("stale-dialog") }
    dialogs.remove(pending.tab.id)
    pending.ui?.dismiss()
    pending.completion(accept, text ?: pending.default)
    emit(pool.documentRef(pending.tab) + mapOf("type" to "dialog", "dialog" to null, "dialogId" to pending.id))
  }
  fun protocolDialog(tab: NativeTab, pipe: String, params: org.json.JSONObject, completion: (Boolean, String?) -> Unit) {
    if (!pool.isForeground || pool.ledger.state(tab.id) != TabState.LIVE || tab.documentId == null || !tab.document.isDone) { completion(false,null); return }
    val existing = dialogs[tab.id]
    if (existing != null && existing.document == tab.documentId) { existing.pipe = pipe; return }
    cancelDialog(tab)
    val kind = params.optString("type")
    if (kind !in setOf("alert", "confirm", "prompt", "beforeunload")) { completion(false,null); return }
    present(Dialog(UUID.randomUUID().toString(), tab, tab.documentId!!, completion, pool.gate.epoch, params.optString("defaultPrompt"), pipe),kind,params.optString("message"))
  }
  fun cancelProtocol(tab: NativeTab, pipe: String) { if (dialogs[tab.id]?.pipe == pipe) cancelDialog(tab) }
  fun cancelDialogs() { dialogs.values.map { it.tab }.toList().forEach(::cancelDialog) }
  fun protocolClosed(tab: NativeTab, pipe: String) {
    val pending = dialogs[tab.id]?.takeIf { it.pipe == pipe } ?: return
    dialogs.remove(tab.id); pending.ui?.dismiss()
    emit(pool.documentRef(tab) + mapOf("type" to "dialog", "dialog" to null, "dialogId" to pending.id))
  }
  fun hasDialog(tab: NativeTab) = dialogs.containsKey(tab.id)
  fun respond(input: DialogRecord) {
    val tab = pool.check(input, true)
    val pending = dialogs[tab.id]?.takeIf { it.id == input.dialogId } ?: throw BrowserFailure("stale-dialog")
    complete(pending, input.accept, input.promptText)
  }
  fun upload(input: UploadRecord): List<Map<String, Any>> {
    val tab = pool.check(input, true)
    val pending = choosers[tab.id]?.takeIf { it.id == input.chooserId && it.document == tab.documentId && it.epoch == input.epoch } ?: throw BrowserFailure("stale-document")
    if (pending.params.mode != WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE && input.stagedFileIds.size > 1) throw BrowserFailure("too-large")
    val chosen = files.choose(input.sessionId, input.stagedFileIds)
    choosers.remove(tab.id)
    if (picker === pending) picker = null
    pending.callback.onReceiveValue(chosen.map { it.first }.toTypedArray())
    return chosen.mapIndexed { i, file -> mapOf("fileId" to input.stagedFileIds[i], "name" to file.second, "size" to file.third) }
  }
  fun pickerResult(code: Int, result: Int, data: Intent?) {
    if (code != PICKER_CODE) return
    val pending = picker ?: return
    picker = null
    if (choosers[pending.tab.id] !== pending) return
    choosers.remove(pending.tab.id)
    val current = pool.gate.epoch == pending.epoch && pending.tab.documentId == pending.document && pool.tabs[pending.tab.id] === pending.tab
    val selected = if (current && result == Activity.RESULT_OK) {
      val clips = data?.clipData
      if (clips != null) Array(clips.itemCount.coerceAtMost(32)) { clips.getItemAt(it).uri } else data?.data?.let { arrayOf(it) }
    } else null
    pending.callback.onReceiveValue(selected?.filter { it.scheme == "content" }?.toTypedArray())
  }
  private fun cancelDialog(tab: NativeTab) {
    val old = dialogs.remove(tab.id) ?: return
    old.ui?.dismiss(); old.completion(false, null)
    emit(pool.ref(tab) + mapOf("type" to "dialog", "documentId" to old.document, "geometryRevision" to tab.geometryRevision, "dialog" to null, "dialogId" to old.id))
  }
  private fun cancelChooser(tab: NativeTab) { choosers.remove(tab.id)?.let { if (picker === it) picker = null; it.callback.onReceiveValue(null) } }
  fun retire(tab: NativeTab) { cancelDialog(tab); cancelChooser(tab) }
  fun stop() { dialogs.values.map { it.tab }.toList().forEach(::cancelDialog); choosers.values.map { it.tab }.toList().forEach(::cancelChooser) }
}
