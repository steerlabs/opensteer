package com.opensteer.phonebrowser

import android.os.Process
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

internal class CdpOwner(private val pool: PhoneBrowserPool, private val emit: (Map<String, Any?>) -> Unit) {
  private data class Pipe(val socket: NativeCdpSocket, val attachment: String, val tab: NativeTab, val epoch: Int, val generation: Int)
  private val permits: CdpPermits = CdpPermits {
    pool.main.post { if (permits.empty() && probes == 0) disable() }
  }
  private val pipes = ConcurrentHashMap<String, Pipe>()
  private val name = "webview_devtools_remote_${Process.myPid()}"
  var dialogOpened: ((NativeTab, String, JSONObject, (Boolean, String?) -> Unit) -> Unit)? = null
  var dialogCancelled: ((NativeTab, String) -> Unit)? = null
  var dialogClosed: ((NativeTab, String) -> Unit)? = null
  @Volatile var qualified = false
  private var probes = 0
  private var debugging = false
  private val shutdownWorker = java.util.concurrent.Executors.newSingleThreadScheduledExecutor()
  @Volatile private var stopping = java.util.concurrent.CompletableFuture.completedFuture(Unit)
  private fun disable() {
    if (BrowserStartup.profiles == null || !debugging) return
    BrowserDebugging.set(false)
    debugging = false
    if (shutdownWorker.isShutdown) return
    val completion = java.util.concurrent.CompletableFuture<Unit>()
    stopping = completion
    val deadline = System.nanoTime()+2_000_000_000L
    val check = object : Runnable {
      override fun run() {
        if (completion.isDone) return
        try {
          nativeHttp(name, "/json")
          if (System.nanoTime() >= deadline) completion.completeExceptionally(BrowserFailure("debugging-still-accessible"))
          else shutdownWorker.schedule(this,10,TimeUnit.MILLISECONDS)
        } catch (_: java.io.IOException) { completion.complete(Unit) }
        catch (error: Throwable) { completion.completeExceptionally(error) }
      }
    }
    shutdownWorker.execute(check)
  }
  private fun beforeEnable() { stopping.get(3,TimeUnit.SECONDS) }
  private fun enable() {
    if (!stopping.isDone || stopping.isCompletedExceptionally) throw BrowserFailure("target-not-ready")
    BrowserDebugging.set(true)
    debugging = true
  }

  @Synchronized fun <T> probe(epoch: Int, action: () -> T): T {
    pool.gate.check(epoch)
    try { beforeEnable() } catch (error: java.util.concurrent.ExecutionException) {
      if ((error.cause as? BrowserFailure)?.reason != "debugging-still-accessible") throw error
      stopping = java.util.concurrent.CompletableFuture.completedFuture(Unit)
    }
    val expired = java.util.concurrent.atomic.AtomicBoolean()
    val timeout = Runnable { expired.set(true); if (permits.empty()) disable() }
    pool.ui(epoch) { probes++; enable(); pool.main.postDelayed(timeout, 30000) }
    return try { awaitNativeDiscovery(name); val result = action(); if (expired.get()) throw BrowserFailure("timeout"); result } finally {
      pool.ui(pool.gate.epoch) { pool.main.removeCallbacks(timeout); probes--; if (probes == 0 && permits.empty()) disable() }
    }
  }

  fun mapBlank(tab: NativeTab) {
    val epoch = pool.gate.epoch
    if (tab.url != "about:blank") throw BrowserFailure("forbidden")
    probe(epoch) {
      val candidates = JSONArray(awaitNativeDiscovery(name))
      val observations = linkedMapOf<String, String?>()
      for (index in 0 until candidates.length()) {
        val target = candidates.getJSONObject(index)
        if (target.optString("type") != "page") continue
        val path = URI(target.getString("webSocketDebuggerUrl")).rawPath
        NativeCdpSocket(name, path).use { socket ->
          val reply = socket.call("Runtime.evaluate", JSONObject().put("expression", "window.__opensteerNativeTarget").put("returnByValue", true))
          observations[path] = reply.optJSONObject("result")?.optJSONObject("result")?.optString("value")
        }
      }
      val path = TargetMarkers.match(tab.marker, observations)
      pool.ui(epoch) {
        if (tab.url != "about:blank" || pool.tabs[tab.id] !== tab) throw BrowserFailure("stale-document")
        if (pool.tabs.values.any { it !== tab && it.targetPath == path }) throw BrowserFailure("ambiguous-target")
        tab.targetPath = path
      }
    }
  }

  fun authorize(input: AuthorizeRecord, files: SessionFiles): Map<String, String> {
    beforeEnable()
    val result = pool.ui(input.epoch) {
    if (!qualified) throw BrowserFailure("unsupported-operation")
    val authority = PhoneBrowserNative.authority ?: throw BrowserFailure("forbidden")
    val grant = authority.requireCdp(input.epoch, input.channelId, input.actorToken, input.attachmentId)
    authority.withAttachment(input.epoch, grant.attachmentId, grant.sessionId) {
      enable()
      permits.grant(grant.attachmentId, input.epoch, input.channelId)
      mapOf("attachmentId" to grant.attachmentId, "filesRoot" to files.directory(grant.sessionId).absolutePath)
    }
    }
    try { awaitNativeDiscovery(name); pool.gate.check(input.epoch); return result }
    catch (error: Throwable) { RequestDeadline.cleanup { release(pool.gate.epoch, result.getValue("attachmentId")) }; throw error }
  }

  fun open(input: OpenPipeRecord): String {
    val tab = pool.ui(input.epoch) {
      val tab = pool.check(input, true)
      if (pipes.size >= 16) throw BrowserFailure("too-large")
      permits.require(input.attachmentId, input.epoch)
      PhoneBrowserNative.authority?.requireAttachment(input.epoch, input.attachmentId, input.sessionId, input.tabId) ?: throw BrowserFailure("forbidden")
      tab
    }
    val handle = UUID.randomUUID().toString()
    val path = tab.targetPath ?: if (tab.popup) throw BrowserFailure("unsupported-operation", "A page opened this tab and this phone cannot hand it to an agent; open its address in a new tab instead.") else throw BrowserFailure("target-not-ready")
    val socket = NativeCdpSocket(name, path) { event ->
      val pipe = pipes[handle] ?: return@NativeCdpSocket
      val method = event.optString("method")
      if (method.startsWith("Target.") || method == "Page.screencastFrame" || method.isBlank()) return@NativeCdpSocket
      val dialogParameters = JSONObject((event.optJSONObject("params") ?: JSONObject()).toString())
      if (method == "Page.javascriptDialogOpening") {
        pool.main.post {
          if (pipes[handle] === pipe && pipe.epoch == pool.gate.epoch && pipe.tab.documentId != null) dialogOpened?.invoke(pipe.tab,handle,dialogParameters) { accept, text ->
            val params = JSONObject().put("accept",accept)
            if (text != null) params.put("promptText",text)
            pipe.socket.submit("Page.handleJavaScriptDialog",params,gate=pool.gate,epoch=pipe.epoch,authorize = { send ->
              PhoneBrowserNative.authority?.withAttachment(pipe.epoch, pipe.attachment, pipe.tab.sessionId) {
                permits.require(pipe.attachment, pipe.epoch)
                send()
              } ?: throw BrowserFailure("forbidden")
            })
          }
        }
      } else if (method == "Page.javascriptDialogClosed") pool.main.post { dialogClosed?.invoke(pipe.tab,handle) }
      val parameters = event.optJSONObject("params") ?: JSONObject()
      if (method == "Page.javascriptDialogOpening") parameters.remove("defaultPrompt")
      try {
        pool.gate.execute(pipe.epoch) {
          if (!pipe.tab.live || pipe.tab.generation != pipe.generation) throw BrowserFailure("stale-document")
          PhoneBrowserNative.authority?.requireAttachment(pipe.epoch, pipe.attachment, pipe.tab.sessionId, pipe.tab.id) ?: throw BrowserFailure("forbidden")
          emit(mapOf("type" to "cdpEvent", "epoch" to pipe.epoch, "pipeHandle" to handle, "method" to method, "params" to jsonFields(parameters)))
        }
      } catch (_: BrowserFailure) { }
    }
    try {
      pool.ui(input.epoch) {
        pool.check(input, true)
        permits.require(input.attachmentId, input.epoch)
        if (pipes.size >= 16) throw BrowserFailure("too-large")
        pipes[handle] = Pipe(socket, input.attachmentId, tab, input.epoch, tab.generation)
      }
    } catch (error: Throwable) { socket.close(); throw error }
    return handle
  }

  fun send(input: SendCdpRecord): Any? {
    val pipe = pool.ui(input.epoch) {
      val tab = pool.check(input, true)
      val pipe = pipes[input.pipeHandle] ?: throw BrowserFailure("forbidden")
      permits.require(pipe.attachment, input.epoch)
      PhoneBrowserNative.authority?.requireAttachment(input.epoch, pipe.attachment, input.sessionId, input.tabId) ?: throw BrowserFailure("forbidden")
      if (pipe.tab !== tab || pipe.generation != input.generation) throw BrowserFailure("stale-document")
      if (input.method.startsWith("Target.") || input.method.startsWith("Browser.") || input.method in setOf("Page.startScreencast", "Page.captureScreenshot", "Page.handleJavaScriptDialog", "Page.setWebLifecycleState", "Page.crash")) throw BrowserFailure("unsupported-operation")
      pipe
    }
    val response = pipe.socket.submit(input.method, JSONObject(input.params), gate=pool.gate, epoch=input.epoch, authorize = { send ->
      PhoneBrowserNative.authority?.withAttachment(input.epoch, pipe.attachment, input.sessionId) {
        permits.require(pipe.attachment, input.epoch)
        if (!pipe.tab.live || pipe.tab.generation != input.generation || pipe.tab.documentId != input.documentId) throw BrowserFailure("stale-document")
        send()
      } ?: throw BrowserFailure("forbidden")
    })
    val reply = try { response.get(6, TimeUnit.SECONDS) } catch (_: java.util.concurrent.TimeoutException) { throw BrowserFailure("outcome-unknown") }
    pool.ui(input.epoch) { pool.check(input, true); permits.require(pipe.attachment, input.epoch); PhoneBrowserNative.authority?.requireAttachment(input.epoch, pipe.attachment, input.sessionId, input.tabId) ?: throw BrowserFailure("forbidden") }
    if (reply.has("error")) throw BrowserFailure("cdp-command-failed", reply.getJSONObject("error").optString("message").take(1000))
    return jsonFields(reply.optJSONObject("result") ?: JSONObject())
  }

  fun close(epoch: Int, handle: String) {
    pool.gate.execute(epoch) { pipes.remove(handle)?.also { dialogCancelled?.invoke(it.tab,handle) } }?.socket?.close()
  }
  fun release(epoch: Int, attachment: String): java.util.concurrent.CompletableFuture<Unit> {
    return pool.ui(epoch) {
      pipes.entries.filter { it.value.attachment == attachment }.forEach { pipes.remove(it.key)?.let { pipe -> dialogCancelled?.invoke(pipe.tab,it.key); pipe.socket.close() } }
      permits.remove(attachment)
      if (permits.empty() && probes == 0) disable()
      if (permits.empty()) stopping else java.util.concurrent.CompletableFuture.completedFuture(Unit)
    }
  }
  fun revoke(attachment: String) {
    permits.remove(attachment)
    pipes.entries.filter { it.value.attachment == attachment }.forEach { (handle, pipe) ->
      if (pipes.remove(handle, pipe)) {
        pipe.socket.close()
        pool.main.post { dialogCancelled?.invoke(pipe.tab, handle) }
      }
    }
  }
  fun retire(tab: NativeTab) { pipes.entries.filter { it.value.tab === tab }.forEach { pipes.remove(it.key)?.let { pipe -> dialogCancelled?.invoke(pipe.tab,it.key); pipe.socket.close() } } }
  fun stop() {
    pipes.entries.toList().forEach { (handle,pipe) -> dialogCancelled?.invoke(pipe.tab,handle); pipe.socket.close() }; pipes.clear(); permits.clear()
    disable()
  }
  fun awaitDisabled() { stopping.get(3,TimeUnit.SECONDS) }
  fun whenDisabled() = stopping
  fun close() { stop(); shutdownWorker.shutdown() }
}

internal fun jsonFields(value: JSONObject): Map<String, Any?> = value.keys().asSequence().associateWith { jsonValue(value.get(it)) }
internal fun jsonValue(value: Any?): Any? = when (value) {
  JSONObject.NULL, null -> null
  is JSONObject -> jsonFields(value)
  is JSONArray -> List(value.length()) { jsonValue(value.get(it)) }
  else -> value
}
