package com.opensteer.phonebrowser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

internal class QualificationProbe(private val context: Context, private val pool: PhoneBrowserPool, private val cdp: CdpOwner) {
  val receipts = linkedMapOf<String, Any?>()
  fun runNative(profiles: NativeProfiles, deployment: String, runner: String) {
    val epoch = pool.gate.epoch
    var tab: NativeTab? = null
    var entry: ProfileEntry? = null
    val files = SessionFiles(context)
    val nonce = UUID.randomUUID().toString()
    val address = "https://phone-native-qualification.invalid/$nonce"
    try {
      entry = pool.await(pool.ui(epoch) {
        profiles.ensure(ProfileBinding(deployment, runner, profiles.manifest.storageInstanceId, UUID.randomUUID().toString(), UUID.randomUUID().toString()), false, true, pool.gate, epoch)
      })
      pool.fixture = { url -> if (url == address) """<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native qualification</title><input id="text"><script>window.trusted=[];document.addEventListener('input',e=>trusted.push(e.isTrusted));</script>""" else null }
      val current = pool.create(epoch, "native-probe-$nonce", entry.name, 720, 960)
      tab = current
      pool.navigate(epoch, current.id, address)
      check(JSONObject(pool.evaluate(current, epoch, "({ready:document.title==='Native qualification'})")).getBoolean("ready"))
      receipts["native browser"] = true
      ability("native input") {
        val editorReady = CompletableFuture<android.view.inputmethod.InputConnection>()
        val previous = pool.onEditingContextChanged
        fun observe(changed: NativeTab) {
          if (changed === current && changed.editor?.inputType?.let { it != android.text.InputType.TYPE_NULL } == true)
            changed.connection?.let { editorReady.complete(it) }
        }
        pool.ui(epoch) {
          pool.onEditingContextChanged = { changed -> previous?.invoke(changed); observe(changed) }
          current.view?.requestFocus() ?: throw BrowserFailure("target-suspended")
        }
        try {
          val point = JSONObject(pool.evaluate(current, epoch, "(()=>{const r=document.querySelector('#text').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth}})()"))
          pool.ui(epoch) {
            val view = current.view ?: throw BrowserFailure("target-suspended")
            val scale = view.width / point.getDouble("width")
            val now = android.os.SystemClock.uptimeMillis()
            for (action in listOf(android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_UP)) {
              val event = android.view.MotionEvent.obtain(now, now, action, (point.getDouble("x") * scale).toFloat(), (point.getDouble("y") * scale).toFloat(), 0)
              event.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
              try { check(view.dispatchTouchEvent(event)) } finally { event.recycle() }
            }
          }
          pool.ui(epoch) { observe(current) }
          val connection = editorReady.get(3, TimeUnit.SECONDS)
          pool.ui(epoch) { check(connection.commitText("native fixture", 1)) }
          val edited = JSONObject(pool.evaluate(current, epoch, "({value:document.querySelector('#text').value,trusted:trusted.length>0&&trusted.every(Boolean)})"))
          check(edited.getString("value") == "native fixture" && edited.getBoolean("trusted"))
        } finally {
          pool.ui(pool.gate.epoch) { pool.onEditingContextChanged = previous }
        }
      }
      ability("native picture") {
        pool.ui(epoch) {
          val view = current.view ?: throw BrowserFailure("target-suspended")
          val bitmap = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
          try {
            view.draw(android.graphics.Canvas(bitmap))
            val bytes = java.io.ByteArrayOutputStream()
            check(bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 75, bytes) && bytes.size() > 0)
          } finally { bitmap.recycle() }
        }
      }
      ability("native staging") {
        val staged = StageRecord().apply { sessionId = nonce; fileId = UUID.randomUUID().toString(); name = "fixture.txt"; data = "Zml4dHVyZQ=="; size = 7 }
        check(files.stage(staged)["complete"] == true)
        check(File(files.choose(nonce, listOf(staged.fileId)).single().first.path!!).readText() == "fixture")
      }
    } catch (error: Throwable) {
      receipts["native failure"] = if (error is BrowserFailure) error.reason else error.javaClass.simpleName
    } finally {
      files.close(); pool.fixture = null
      pool.ui(pool.gate.epoch) {
        tab?.let { pool.destroyNow(it.id) }
        entry?.let { profiles.endGuest(it.handle) { name -> pool.tabs.values.filter { it.profileName == name }.map { it.id }.forEach(pool::destroyNow) } }
      }
    }
  }
  private fun ability(name: String, action: () -> Unit) {
    try { action(); receipts[name] = true }
    catch (error: Throwable) { receipts[name] = false; receipts["$name failure"] = if (error is BrowserFailure) error.reason else error.javaClass.simpleName }
  }
  fun run(profiles: NativeProfiles, deployment: String, runner: String): Boolean {
    return try { cdp.probe(pool.gate.epoch) { runFixture(profiles, deployment, runner) } }
    catch (error: Throwable) { receipts["passed"] = false; receipts["failure"] = error.javaClass.simpleName; false }
  }
  private fun runFixture(profiles: NativeProfiles, deployment: String, runner: String): Boolean {
    val epoch = pool.gate.epoch
    var tab: NativeTab? = null
    var entry: ProfileEntry? = null
    val nonce = UUID.randomUUID().toString()
    val base = "https://phone-qualification.invalid/$nonce"
    val upload = File(context.noBackupFilesDir, "phone-browser/probe-$nonce.txt")
    try {
      entry = pool.await(pool.ui(epoch) {
        profiles.ensure(ProfileBinding(deployment, runner, profiles.manifest.storageInstanceId, UUID.randomUUID().toString(), UUID.randomUUID().toString()), false, true, pool.gate, epoch)
      })
      pool.fixture = { url -> when (url) {
        "$base/frame" -> "<!doctype html><title>Fixture frame</title><body>frame</body>"
        "https://cross.phone-qualification.invalid/$nonce" -> "<!doctype html><title>Cross fixture</title><body>frame</body>"
        "$base/page", "$base/next" -> """<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qualification</title><input id="text" aria-label="Fixture text"><input id="file" type="file"><button id="button">Fixture button</button><iframe src="$base/frame"></iframe><iframe src="https://cross.phone-qualification.invalid/$nonce"></iframe><script>window.trusted=[];document.addEventListener('input',e=>trusted.push(e.isTrusted));</script>"""
        else -> null
      } }
      tab = pool.create(epoch, "probe-$nonce", entry.name, 720, 960)
      cdp.mapBlank(tab)
      val target = tab.targetPath ?: throw BrowserFailure("target-not-ready")
      val current = tab
      cdp.probe(epoch) {
        val name = "webview_devtools_remote_${android.os.Process.myPid()}"
        val version = JSONObject(nativeHttp(name, "/json/version"))
        receipts["discovery/version"] = version.optString("Protocol-Version")
        val contextReplay = CompletableFuture<Unit>()
        NativeCdpSocket(name, URI(version.getString("webSocketDebuggerUrl")).rawPath) { event -> if (event.optString("method") == "Runtime.executionContextCreated" && event.has("sessionId")) contextReplay.complete(Unit) }.use { browser ->
          val attached = command(browser, "Target.attachToTarget", JSONObject().put("targetId", target.substringAfterLast('/')).put("flatten", true)).getString("sessionId")
          command(browser, "Runtime.enable", session = attached)
          contextReplay.get(3, TimeUnit.SECONDS)
          val value = command(browser, "Runtime.evaluate", JSONObject().put("expression", "21*2").put("returnByValue", true), attached)
          check(value.getJSONObject("result").getInt("value") == 42)
          command(browser, "Target.detachFromTarget", JSONObject().put("sessionId", attached))
          receipts["flattened context routing"] = true
        }
        val dialog = CompletableFuture<Unit>()
        val chooser = CompletableFuture<JSONObject>()
        NativeCdpSocket(name, target) { event ->
          when (event.optString("method")) {
            "Page.javascriptDialogOpening" -> dialog.complete(Unit)
            "Page.fileChooserOpened" -> chooser.complete(event.getJSONObject("params"))
          }
        }.use { page ->
          command(page, "Runtime.enable"); command(page, "Page.enable"); command(page, "DOM.enable"); command(page, "Accessibility.enable")
          pool.navigate(epoch, current.id, "$base/page")
          command(page, "Runtime.evaluate", JSONObject().put("expression", "new Promise(r=>document.readyState==='complete'?r(true):addEventListener('load',()=>r(true),{once:true}))").put("awaitPromise", true))
          val objectId = command(page, "Runtime.evaluate", JSONObject().put("expression", "({answer:42})")).getJSONObject("result").getString("objectId")
          command(page, "Runtime.getProperties", JSONObject().put("objectId", objectId))
          val answer = command(page, "Runtime.callFunctionOn", JSONObject().put("objectId", objectId).put("functionDeclaration", "function(){return this.answer}").put("returnByValue", true))
          check(answer.getJSONObject("result").getInt("value") == 42)
          command(page, "Runtime.releaseObject", JSONObject().put("objectId", objectId))
          val document = command(page, "DOM.getDocument").getJSONObject("root").getInt("nodeId")
          val input = command(page, "DOM.querySelector", JSONObject().put("nodeId", document).put("selector", "#text")).getInt("nodeId")
          val resolved = command(page, "DOM.resolveNode", JSONObject().put("nodeId", input)).getJSONObject("object").getString("objectId")
          command(page, "Runtime.releaseObject", JSONObject().put("objectId", resolved))
          val ax = command(page, "Accessibility.queryAXTree", JSONObject().put("nodeId", input).put("accessibleName", "Fixture text"))
          check(ax.getJSONArray("nodes").length() > 0)
          check(command(page, "Accessibility.getFullAXTree").getJSONArray("nodes").length() > 0)
          command(page, "DOMSnapshot.captureSnapshot", JSONObject().put("computedStyles", JSONArray()))
          command(page, "Target.setAutoAttach", JSONObject().put("autoAttach", true).put("waitForDebuggerOnStart", false).put("flatten", true))
          command(page, "Runtime.evaluate", JSONObject().put("expression", "document.querySelector('#text').focus()"))
          command(page, "Input.dispatchMouseEvent", JSONObject().put("type", "mouseMoved").put("x", 2).put("y", 2))
          command(page, "Input.dispatchTouchEvent", JSONObject().put("type", "touchStart").put("touchPoints", JSONArray().put(JSONObject().put("x", 3).put("y", 3))))
          command(page, "Input.dispatchTouchEvent", JSONObject().put("type", "touchEnd").put("touchPoints", JSONArray()))
          command(page, "Runtime.evaluate", JSONObject().put("expression", "document.querySelector('#text').focus()"))
          command(page, "Input.dispatchKeyEvent", JSONObject().put("type", "keyDown").put("key", "a").put("code", "KeyA").put("windowsVirtualKeyCode", 65))
          command(page, "Input.dispatchKeyEvent", JSONObject().put("type", "keyUp").put("key", "a").put("code", "KeyA").put("windowsVirtualKeyCode", 65))
          command(page, "Input.imeSetComposition", JSONObject().put("text", "fixture").put("selectionStart", 7).put("selectionEnd", 7))
          command(page, "Input.insertText", JSONObject().put("text", "qualified"))
          val edited = evaluate(page, "({value:document.querySelector('#text').value,trusted:trusted.every(Boolean)&&trusted.length>0})")
          check(edited.getString("value") == "qualified" && edited.getBoolean("trusted"))
          receipts["trusted input"] = true
          upload.writeText("content-free fixture")
          val fileNode = command(page, "DOM.querySelector", JSONObject().put("nodeId", document).put("selector", "#file")).getInt("nodeId")
          command(page, "Page.setInterceptFileChooserDialog", JSONObject().put("enabled", true))
          command(page, "Runtime.evaluate", JSONObject().put("expression", "document.querySelector('#file').click()").put("userGesture", true))
          chooser.get(3, TimeUnit.SECONDS)
          command(page, "DOM.setFileInputFiles", JSONObject().put("nodeId", fileNode).put("files", JSONArray().put(upload.absolutePath)))
          check(evaluate(page, "({count:document.querySelector('#file').files.length})").getInt("count") == 1)
          command(page, "Page.setInterceptFileChooserDialog", JSONObject().put("enabled", false))
          val script = command(page, "Page.addScriptToEvaluateOnNewDocument", JSONObject().put("source", "window.__qualification=123")).getString("identifier")
          val pendingDialog = page.submit("Runtime.evaluate", JSONObject().put("expression", "alert('content-free fixture')"))
          dialog.get(3, TimeUnit.SECONDS)
          command(page, "Page.handleJavaScriptDialog", JSONObject().put("accept", true))
          pendingDialog.get(3, TimeUnit.SECONDS)
          command(page, "Emulation.setDeviceMetricsOverride", JSONObject().put("width", 320).put("height", 480).put("deviceScaleFactor", 0).put("mobile", true))
          command(page, "Emulation.setFocusEmulationEnabled", JSONObject().put("enabled", true))
          command(page, "Emulation.clearDeviceMetricsOverride")
          command(page, "Emulation.setFocusEmulationEnabled", JSONObject().put("enabled", false))
          val before = current.document
          command(page, "Page.navigate", JSONObject().put("url", "$base/next"))
          pool.ui(epoch) { if (current.document === before) pool.retireDocument(current) }
          pool.await(current.document)
          check(evaluate(page, "({marker:window.__qualification})").getInt("marker") == 123)
          command(page, "Page.removeScriptToEvaluateOnNewDocument", JSONObject().put("identifier", script))
          command(page, "Page.getNavigationHistory")
          val reload = current.document
          command(page, "Page.reload")
          pool.ui(epoch) { if (current.document === reload) pool.retireDocument(current) }
          pool.await(current.document)
          command(page, "Runtime.evaluate", JSONObject().put("expression", "new Promise(r=>document.readyState==='complete'?r(true):addEventListener('load',()=>r(true),{once:true}))").put("awaitPromise", true))
          command(page, "Page.stopLoading")
          val frames = command(page, "Page.getFrameTree").getJSONObject("frameTree")
          val frameId = frames.getJSONObject("frame").getString("id")
          val world = command(page, "Page.createIsolatedWorld", JSONObject().put("frameId", frameId).put("worldName", "qualification")).getInt("executionContextId")
          val security = evaluate(page, "({same:document.querySelector('iframe').contentDocument.body.textContent==='frame',cross:(()=>{try{document.querySelectorAll('iframe')[1].contentWindow.document;return false}catch(e){return e.name==='SecurityError'}})()})")
          check(security.getBoolean("same") && security.getBoolean("cross"))
          for (isolated in listOf(false, true)) for (gesture in listOf(false,true)) for (method in listOf("Runtime.evaluate", "Runtime.callFunctionOn")) for (operation in listOf("readText", "read", "paste")) {
            val body = when(operation) {
              "paste" -> "return {denied:document.execCommand('paste')===false}"
              else -> "try{await navigator.clipboard.$operation();return {denied:false}}catch(e){return {denied:e.name==='NotAllowedError'}}"
            }
            val params = JSONObject().put("returnByValue", true).put("awaitPromise", true).put("userGesture", gesture)
            if (method == "Runtime.evaluate") { params.put("expression", "(async()=>{$body})()"); if (isolated) params.put("contextId", world) }
            else { params.put("functionDeclaration", "async function(){$body}"); if (isolated) params.put("executionContextId", world) else params.put("objectId", command(page, "Runtime.evaluate", JSONObject().put("expression", "globalThis")).getJSONObject("result").getString("objectId")) }
            val denial = command(page, method, params).getJSONObject("result").getJSONObject("value").getBoolean("denied")
            check(denial) { "clipboard gate failed" }
          }
          receipts["clipboard denial"] = true
        }
      }
      receipts["passed"] = true
      return true
    } catch (error: Throwable) {
      receipts["passed"] = false
      receipts["failure"] = if (error is BrowserFailure) "${error.reason}: ${error.message}" else "${error.javaClass.simpleName}: ${error.message?.take(200)}"
      return false
    } finally {
      upload.delete()
      pool.fixture = null
      val cleanupEpoch = pool.gate.epoch
      pool.ui(cleanupEpoch) {
        tab?.let { pool.destroyNow(it.id) }
        entry?.let { profiles.endGuest(it.handle) { name -> pool.tabs.values.filter { it.profileName == name }.map { it.id }.forEach(pool::destroyNow) } }
      }
    }
  }
  private fun command(socket: NativeCdpSocket, method: String, params: JSONObject = JSONObject(), session: String? = null): JSONObject {
    val response = socket.call(method, params, session)
    if (response.has("error")) { receipts[method] = jsonFields(response.getJSONObject("error")); throw BrowserFailure("probe-failed", method) }
    receipts[method] = true
    return response.getJSONObject("result")
  }
  private fun evaluate(socket: NativeCdpSocket, expression: String): JSONObject = command(socket, "Runtime.evaluate", JSONObject().put("expression", expression).put("returnByValue", true)).getJSONObject("result").getJSONObject("value")
}
