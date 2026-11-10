package com.opensteer.phonebrowser

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class PhoneBrowserModule : Module() {
  private val gate = EpochGate()
  private val main = Handler(Looper.getMainLooper())
  private val workers = Executors.newFixedThreadPool(4)
  private val ready = CompletableFuture<PhoneBrowserRuntime>()
  @Volatile private var browserOwner: PhoneBrowserRuntime? = null
  override fun definition() = ModuleDefinition {
    Name("PhoneBrowser")
    Events("event")
    OnCreate {
      main.post {
        try {
          val context = appContext.reactContext ?: throw BrowserFailure("browser-unavailable")
          val owner = PhoneBrowserRuntime(context, { appContext.currentActivity }, gate) { event -> sendEvent("event", event) }
          browserOwner = owner
          owner.install().whenComplete { _, error -> if (error == null) ready.complete(owner) else ready.completeExceptionally(error) }
        } catch (error: Throwable) { ready.completeExceptionally(error) }
      }
    }
    OnDestroy { browserOwner?.fence("disposed"); main.post { browserOwner?.close(); browserOwner = null }; workers.shutdownNow() }
    OnActivityEntersBackground { browserOwner?.inactive() }
    OnActivityResult { _, result -> browserOwner?.chrome?.pickerResult(result.requestCode, result.resultCode, result.data) }
    Function("fence") { reason: String ->
      try { (browserOwner ?: throw BrowserFailure("browser-unavailable")).fence(reason) } catch (error: BrowserFailure) { throw NativeBrowserException(error.code) }
    }
    AsyncFunction("initialize") { input: InitializeRecord, promise: Promise -> work(promise) { initialize(input) } }
    AsyncFunction("setForeground") { input: ForegroundRecord, promise: Promise -> priority(input, promise) { setForeground(input) } }
    AsyncFunction("ensureProfile") { input: ProfileRecord, promise: Promise -> work(promise) { ensure(input) } }
    AsyncFunction("listProfiles") { input: DeploymentRecord, promise: Promise -> work(promise) { list(input) } }
    AsyncFunction("eraseProfile") { input: ProfileRecord, promise: Promise -> work(promise) { erase(input) } }
    AsyncFunction("eraseDeployment") { input: DeploymentRecord, promise: Promise -> work(promise) { eraseDeployment(input) } }
    AsyncFunction("createTab") { input: CreateTabRecord, promise: Promise -> work(promise, { owner -> owner.pool.main.post { owner.publishReady(input.tabId) } }) { create(input) } }
    AsyncFunction("destroyTab") { input: TabRef, promise: Promise -> work(promise) { destroy(input) } }
    AsyncFunction("suspendTab") { input: SuspendRecord, promise: Promise -> work(promise) { suspend(input) } }
    AsyncFunction("resumeTab") { input: TabRef, promise: Promise -> work(promise, { owner -> owner.pool.main.post { owner.publishReady(input.tabId) } }) { resume(input) } }
    AsyncFunction("mountTab") { input: MountRecord, promise: Promise -> work(promise) { mount(input) } }
    AsyncFunction("unmountTab") { input: UnmountRecord, promise: Promise -> work(promise) { unmount(input) } }
    AsyncFunction("resizeTab") { input: ResizeRecord, promise: Promise -> work(promise) { resize(input) } }
    AsyncFunction("navigate") { input: NavigateRecord, promise: Promise -> work(promise) { navigate(input) } }
    AsyncFunction("respondDialog") { input: DialogRecord, promise: Promise -> priority(input, promise) { chrome.respond(input) } }
    AsyncFunction("respondUpload") { input: UploadRecord, promise: Promise -> priority(input, promise) { chrome.upload(input) } }
    AsyncFunction("attachAgent") { input: AgentRecord, promise: Promise -> work(promise) { attachAgent(input) } }
    AsyncFunction("detachAgent") { input: DetachAgentRecord, promise: Promise -> priority(input, promise) { detachAgent(input) } }
    AsyncFunction("performAction") { _: Map<String, Any?>, promise: Promise -> promise.reject("unsupported-operation", "Android uses the qualified CDP backend.", null) }
    AsyncFunction("applyViewerInput") { input: ViewerRecord, promise: Promise -> work(promise) { requireReady(input.epoch); this.input.apply(input) } }
    AsyncFunction("setCaptureDemand") { input: DemandRecord, promise: Promise -> priority(input, promise) { requireReady(input.epoch); capture.demand(input) } }
    AsyncFunction("ackFrame") { input: AckRecord, promise: Promise -> priority(input, promise) { capture.ack(input) } }
    AsyncFunction("captureOnce") { input: CaptureRecord, promise: Promise -> work(promise) { requireReady(input.epoch); capture.once(input) } }
    AsyncFunction("authorizeCdp") { input: AuthorizeRecord, promise: Promise -> work(promise) { requireReady(input.epoch); cdp.authorize(input, files) } }
    AsyncFunction("openCdpPipe") { input: OpenPipeRecord, promise: Promise -> work(promise) { requireReady(input.epoch); cdp.open(input) } }
    AsyncFunction("sendCdp") { input: SendCdpRecord, promise: Promise -> work(promise) {
      requireReady(input.epoch)
      if (input.method == "DOM.setFileInputFiles") {
        val paths = input.params["files"] as? List<*> ?: throw BrowserFailure("forbidden")
        if (paths.any { it !is String || !files.contained(input.sessionId, it) }) throw BrowserFailure("forbidden")
      }
      cdp.send(input)
    } }
    AsyncFunction("closeCdpPipe") { input: ClosePipeRecord, promise: Promise -> priority(input, promise) { cdp.close(input.epoch, input.pipeHandle) } }
    AsyncFunction("releaseCdp") { input: ReleaseCdpRecord, promise: Promise -> priority(input, promise) { cdp.release(input.epoch, input.attachmentId) } }
    AsyncFunction("stageChunk") { input: StageRecord, promise: Promise -> work(promise) { requireReady(input.epoch); gate.execute(input.epoch) { files.stage(input) } } }
    AsyncFunction("finishSessionFiles") { input: SessionFilesRecord, promise: Promise -> work(promise) { gate.execute(input.epoch) { files.finish(input.sessionId); downloads.finish(input.sessionId) } } }
    AsyncFunction("cancelDownload") { input: CancelDownloadRecord, promise: Promise -> priority(input, promise) { downloads.cancel(input.sessionId, input.downloadId) } }
    View(PhoneBrowserPoolHost::class) {
      Name("PhoneBrowserHost")
      Events("onReady")
      Prop("hostId") { view: PhoneBrowserPoolHost, id: String -> view.hostId = id; PhoneBrowserPool.current?.register(view) }
    }
    View(PhoneBrowserPicture::class) {
      Name("PhoneBrowserPicture")
      Prop("tabId") { view: PhoneBrowserPicture, id: String -> view.tabId = id; PhoneBrowserPool.current?.picture(view,view.isAttachedToWindow) }
    }
    View(PhoneBrowserDownload::class) {
      Name("PhoneBrowserDownload")
      Prop("downloadId") { view: PhoneBrowserDownload, id: String -> view.downloadId = id }
    }
  }
  private fun work(promise: Promise, afterResolve: (PhoneBrowserRuntime) -> Unit = {}, action: PhoneBrowserRuntime.() -> Any?) {
    val deadline = System.nanoTime() + 30_000_000_000L
    workers.execute {
      try {
        val owner = ready.get(10, TimeUnit.SECONDS)
        promise.resolve(RequestDeadline.within(deadline) { owner.action().let { if (it == Unit) null else it } })
        afterResolve(owner)
      } catch (error: Throwable) { reject(promise, error) }
    }
  }
  private fun priority(input: EpochRecord, promise: Promise, action: PhoneBrowserRuntime.() -> Any?) {
    val deadline = System.nanoTime() + 30_000_000_000L
    main.post {
      try {
        RequestDeadline.check(deadline)
        gate.check(input.epoch)
        val owner = browserOwner ?: throw BrowserFailure("browser-unavailable")
        val result = owner.action()
        if (result is CompletableFuture<*>) result.whenComplete { value,error -> if (error != null) reject(promise,error) else promise.resolve(if (value == Unit) null else value) }
        else promise.resolve(if (result == Unit) null else result)
      } catch (error: Throwable) { reject(promise, error) }
    }
  }
  private fun reject(promise: Promise, error: Throwable) {
    var cause = error
    while (cause is java.util.concurrent.ExecutionException || cause is java.util.concurrent.CompletionException) cause = cause.cause ?: break
    val code = when (cause) { is BrowserFailure -> cause.code; is java.util.concurrent.TimeoutException -> "timeout"; else -> "outcome-unknown" }
    promise.reject(code, if (cause is BrowserFailure) cause.message else code, null)
  }
}

private class NativeBrowserException(code: String) : CodedException(code, code, null)
