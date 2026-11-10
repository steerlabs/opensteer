package com.opensteer.phonebrowser

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebChromeClient
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebSettings
import android.view.inputmethod.InputConnection
import android.view.WindowInsets
import android.os.Build
import android.widget.FrameLayout
import androidx.webkit.WebViewCompat
import androidx.webkit.WebMessageCompat
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

internal data class BrowserAnchor(val marker: String?, val top: Double, val horizontal: Double, val vertical: Double, val viewportWidth: Double = 0.0, val viewportHeight: Double = 0.0)

internal class NativeTab(val id: String, val profileName: String, var url: String, val width: Int, val height: Int) {
  val pageClose = PageClose()
  var lastPicture: Bitmap? = null
  @Volatile var downloadRequestUrl = ""
  @Volatile var downloadRequestMethod = ""
  @Volatile var live = false
  var creating = true
  var published = false
  val pendingEvents = linkedMapOf<String, Map<String, Any?>>()
  var popup = false
  var sessionId = ""
  var allocationEpoch = -1
  var storeHandle = ""
  @Volatile var generation = 1
  var revision = 0L
  var captureRevision = 0L
  var navigationId: String? = null
  var interactive = true
  var targetPath: String? = null
  var committedUrl = "about:blank"
  val frameRevisions = mutableMapOf<String, MutableList<Long>>()
  var title = ""
  var canGoBack = false
  var canGoForward = false
  var contextId = UUID.randomUUID().toString()
  var editor: EditorInfo? = null
  var connection: InputConnection? = null
  var compositionStart: Int? = null
  var pointerDown = 0L
  var geometry: List<Number> = emptyList()
  var rendererGeometry: List<Double> = emptyList()
  var geometryPending = false
  val inputSequences = InputSequences()
  var view: WebView? = null
  @Volatile var documentId: String? = null
  @Volatile var document = CompletableFuture<Unit>()
  var navigationVersion = 0
  var committedVersion = -1
  var hostId: String? = null
  var presentationGeneration = -1
  @Volatile var geometryRevision = 0L
  var loading = false
  var failed = false
  var anchor = BrowserAnchor(null, 0.0, 0.0, 0.0)
  var marker = UUID.randomUUID().toString()
  var ackBridge = ""
  val bootstrap = "https://phone-browser.invalid/blank/" + UUID.randomUUID()
}

internal class PhoneBrowserPool(
  private val context: Context,
  private val activity: () -> Activity?,
  val gate: EpochGate,
  private val emit: (String, Map<String, Any?>) -> Unit
) {
  val main = Handler(Looper.getMainLooper())
  val ledger = PoolLedger()
  val tabs = linkedMapOf<String, NativeTab>()
  private val hosts = mutableMapOf<String, PhoneBrowserPoolHost>()
  private val hostReady = mutableMapOf<String, CompletableFuture<Unit>>()
  private val pictures = linkedSetOf<PhoneBrowserPicture>()
  private var covered: FrameLayout? = null
  private var foreground = true
  val isForeground get() = foreground
  private var pictureScheduled = false
  private data class RendererWait(val tab: NativeTab, val documentId: String?, val epoch: Int, val ready: CompletableFuture<Unit>)
  private val rendererWaits = mutableMapOf<String, RendererWait>()
  var onConstruct: ((NativeTab, WebView) -> Unit)? = null
  var onEditingContextChanged: ((NativeTab) -> Unit)? = null
  var onCommitted: (() -> Unit)? = null
  var onDocumentRetired: ((NativeTab) -> Unit)? = null
  var onSuspended: ((NativeTab) -> Unit)? = null
  var onTabRemoved: ((NativeTab) -> Unit)? = null
  var onViewDestroyed: ((NativeTab) -> Unit)? = null
  var onRendererGone: ((List<NativeTab>) -> Unit)? = null
  var blankCommitted: ((NativeTab) -> Unit)? = null
  var fixture: ((String) -> String?)? = null

  fun register(host: PhoneBrowserPoolHost) {
    hosts[host.hostId] = host
    if (host.isAttachedToWindow && host.width > 0 && host.height > 0) {
      hostReady.getOrPut(host.hostId) { CompletableFuture() }.complete(Unit)
      host.ready()
    }
  }

  fun detach(host: PhoneBrowserPoolHost) {
    if (hosts[host.hostId] !== host) return
    hostReady[host.hostId] = CompletableFuture()
    tabs.values.filter { it.view?.parent === host }.forEach { moveCovered(it) }
  }

  fun <Result> ui(epoch: Int, action: () -> Result): Result {
    val response = CompletableFuture<Result>()
    val deadline = RequestDeadline.current()
    val run = Runnable {
      try { response.complete(gate.execute(epoch) { RequestDeadline.within(deadline) { if (response.isDone) throw BrowserFailure("timeout"); action() } }) }
      catch (error: Throwable) { response.completeExceptionally(error) }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) run.run() else main.post(run)
    return try { await(response) } catch (error: Throwable) { response.completeExceptionally(error); throw error }
  }

  fun <Result> await(future: CompletableFuture<Result>): Result {
    return try { future.get(RequestDeadline.remaining(), TimeUnit.MILLISECONDS) }
    catch (error: java.util.concurrent.TimeoutException) { throw BrowserFailure("timeout") }
    catch (error: java.util.concurrent.ExecutionException) { throw error.cause ?: BrowserFailure("native-failure") }
  }

  fun evaluate(tab: NativeTab, epoch: Int, script: String): String {
    val document = tab.document
    await(document)
    val documentId = tab.documentId ?: throw BrowserFailure("target-not-ready")
    val response = CompletableFuture<String>()
    ui(epoch) {
      if (tab.document !== document || tab.documentId != documentId) throw BrowserFailure("stale-document")
      tab.view?.evaluateJavascript(script) { value ->
        try {
          gate.check(epoch)
          if (tab.document !== document || tab.documentId != documentId) throw BrowserFailure("stale-document")
          response.complete(value)
        } catch (error: Throwable) { response.completeExceptionally(error) }
      } ?: throw BrowserFailure("target-suspended")
    }
    return await(response)
  }

  fun create(epoch: Int, tabId: String, profile: String, width: Int, height: Int, url: String? = null, sessionId: String = "", storeHandle: String = ""): NativeTab {
    val tab = ui(epoch) {
      ledger.create(tabId)
      NativeTab(tabId, profile, "about:blank", width, height).also {
        it.live = true; it.sessionId = sessionId; it.storeHandle = storeHandle; it.allocationEpoch = epoch
        tabs[tabId] = it
        try { construct(it) } catch (error: Throwable) { destroyView(it); tabs.remove(tabId); ledger.destroy(tabId); throw error }
      }
    }
    try {
      await(tab.document)
      evaluate(tab, epoch, "window.__opensteerNativeTarget=${JSONObject.quote(tab.marker)}")
      blankCommitted?.invoke(tab)
      gate.check(epoch)
      if (url != null) navigate(epoch, tab.id, url)
      return tab
    } catch (error: Throwable) {
      val cleaned = CompletableFuture<Unit>()
      main.post { if (tabs[tabId] === tab) { destroyView(tab); tabs.remove(tabId); ledger.destroy(tabId) }; cleaned.complete(Unit) }
      await(cleaned)
      throw error
    }
  }

  private fun construct(tab: NativeTab, loadBlank: Boolean = true, coveredPlace: Boolean = true) {
    if (tab.storeHandle.isNotEmpty()) {
      val serving = BrowserStartup.profiles?.serving(tab.storeHandle) ?: throw BrowserFailure("profile-missing")
      if (serving.name != tab.profileName) throw BrowserFailure("forbidden")
    }
    BrowserStartup.firstViewCreated = true
    tab.marker = UUID.randomUUID().toString()
    tab.documentId = null
    tab.navigationVersion++
    val browser = object : WebView(context) {
      override fun onScrollChanged(x: Int, y: Int, oldX: Int, oldY: Int) { super.onScrollChanged(x, y, oldX, oldY); changedGeometry(tab) }
      override fun onSizeChanged(w: Int, h: Int, oldW: Int, oldH: Int) { super.onSizeChanged(w, h, oldW, oldH); changedGeometry(tab) }
      override fun onApplyWindowInsets(insets: WindowInsets): WindowInsets { changedGeometry(tab); return super.onApplyWindowInsets(insets) }
      override fun onCreateInputConnection(info: EditorInfo): InputConnection? {
        val connection = super.onCreateInputConnection(info)
        tab.compositionStart = null
        tab.connection = connection
        tab.editor = if (connection == null) null else info
        tab.contextId = UUID.randomUUID().toString()
        if (tab.documentId != null && tab.document.isDone) onEditingContextChanged?.invoke(tab)
        return connection
      }
    }
    tab.view = browser
    WebViewCompat.setProfile(browser, tab.profileName)
    tab.ackBridge = "__opensteerFrame_" + UUID.randomUUID().toString().replace("-", "")
    WebViewCompat.addWebMessageListener(browser, tab.ackBridge, setOf("*"), WebViewCompat.WebMessageListener { source, message, _, mainFrame, _ ->
      if (!mainFrame || source !== tab.view || message.type != WebMessageCompat.TYPE_STRING) return@WebMessageListener
      val token = message.data ?: return@WebMessageListener
      if (token == "geometry") { observeGeometry(tab); return@WebMessageListener }
      if (token == "focus") {
        tab.connection?.finishComposingText(); tab.connection = null; tab.editor = null; tab.compositionStart = null
        tab.contextId = UUID.randomUUID().toString(); onEditingContextChanged?.invoke(tab)
        return@WebMessageListener
      }
      if (token.length > 64) return@WebMessageListener
      val pending = rendererWaits[token] ?: return@WebMessageListener
      if (pending.tab !== tab) return@WebMessageListener
      rendererWaits.remove(token)
      try {
        gate.check(pending.epoch)
        if (tab.documentId != pending.documentId) throw BrowserFailure("stale-document")
        pending.ready.complete(Unit)
      } catch (error: Throwable) { pending.ready.completeExceptionally(error) }
    })
    browser.settings.javaScriptEnabled = true
    browser.settings.domStorageEnabled = true
    browser.settings.allowFileAccess = false
    browser.settings.allowContentAccess = false
    browser.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
    browser.settings.setGeolocationEnabled(false)
    browser.settings.setSupportMultipleWindows(true)
    browser.settings.javaScriptCanOpenWindowsAutomatically = false
    browser.settings.setSupportZoom(true)
    browser.settings.builtInZoomControls = true
    browser.settings.displayZoomControls = false
    browser.settings.useWideViewPort = true
    browser.settings.loadWithOverviewMode = true
    browser.viewTreeObserver.addOnGlobalLayoutListener { if (tab.view === browser) changedGeometry(tab) }
    browser.settings.mediaPlaybackRequiresUserGesture = true
    browser.setBackgroundColor(Color.WHITE)
    onConstruct?.invoke(tab, browser)
    browser.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        if (request.isForMainFrame) { tab.downloadRequestUrl = request.url.toString(); tab.downloadRequestMethod = request.method }
        val content = if (request.url.toString() == tab.bootstrap) "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><title></title>"
          else fixture?.invoke(request.url.toString()) ?: return null
        return WebResourceResponse("text/html", "UTF-8", ByteArrayInputStream(content.toByteArray()))
      }
      override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        if (tabs[tab.id] !== tab || tab.view !== view) return
        if (tab.document.isDone) retireDocument(tab)
        tab.loading = true
        tab.failed = false
      }
      override fun onPageCommitVisible(view: WebView, url: String) {
        if (tabs[tab.id] !== tab || tab.view !== view) return
        if (tab.committedVersion == tab.navigationVersion) return
        tab.committedVersion = tab.navigationVersion
        if (tab.document.isCompletedExceptionally) tab.document = CompletableFuture()
        tab.documentId = UUID.randomUUID().toString()
        tab.url = if (url == tab.bootstrap) "about:blank" else url
        tab.committedUrl = tab.url
        tab.geometryRevision++
        tab.document.complete(Unit)
        val bridge = JSONObject.quote(tab.ackBridge)
        view.evaluateJavascript("""(()=>{const channel=window[$bridge];const changed=()=>channel.postMessage('geometry');addEventListener('resize',changed,{passive:true});addEventListener('scroll',changed,{passive:true});if(window.visualViewport){visualViewport.addEventListener('resize',changed,{passive:true});visualViewport.addEventListener('scroll',changed,{passive:true})}addEventListener('focusin',()=>channel.postMessage('focus'));addEventListener('focusout',()=>channel.postMessage('focus'));changed()})()""", null)
        onCommitted?.invoke(); schedulePictures()
        changed(tab, "documentChanged")
        if (!tab.failed) tab.navigationId?.let { id -> changed(tab, "navigationCommitted", mapOf("navigationId" to id)); tab.navigationId = null }
      }
      override fun onPageFinished(view: WebView, url: String) {
        if (tabs[tab.id] !== tab || tab.view !== view) return
        tab.loading = false
        tab.canGoBack = view.canGoBack()
        tab.canGoForward = view.canGoForward()
        changed(tab, "tabChanged")
      }
      override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
        if (tab.view !== view) return
        if (url != tab.bootstrap) tab.url = url
        tab.canGoBack = view.canGoBack(); tab.canGoForward = view.canGoForward()
        changed(tab, "tabChanged")
      }
      override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (!request.isForMainFrame || tab.view !== view) return
        tab.failed = true; tab.loading = false; tab.navigationId = null
        tab.document.completeExceptionally(BrowserFailure("navigation-failed"))
        changed(tab, "tabChanged")
      }
      override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) { changedGeometry(tab) }
      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        if (tab.view !== view) return true
        val affected = listOf(tab)
        affected.forEach { destroyView(it); ledger.discard(it.id); changed(it, "tabChanged") }
        onRendererGone?.invoke(affected)
        return true
      }
    }
    tab.view = browser
    if (coveredPlace) moveCovered(tab)
    tab.document = CompletableFuture()
    tab.loading = true
    if (loadBlank) browser.loadUrl(tab.bootstrap)
  }

  fun popup(epoch: Int, tabId: String, opener: NativeTab, message: android.os.Message): NativeTab = ui(epoch) {
    ledger.create(tabId)
    val tab = NativeTab(tabId, opener.profileName, "about:blank", opener.view?.width ?: opener.width, opener.view?.height ?: opener.height)
    tab.live = true; tab.popup = true; tab.sessionId = opener.sessionId; tab.storeHandle = opener.storeHandle; tab.allocationEpoch = epoch
    tabs[tabId] = tab
    try {
      construct(tab, false)
      val transport = message.obj as? WebView.WebViewTransport ?: throw BrowserFailure("unsupported-operation")
      transport.webView = tab.view
      message.sendToTarget()
      tab
    } catch (error: Throwable) { destroyNow(tabId); throw error }
  }

  fun navigate(epoch: Int, tabId: String, url: String) {
    val tab = live(tabId)
    await(tab.document)
    ui(epoch) {
      retireDocument(tab)
      tab.loading = true
      tab.view!!.loadUrl(url)
    }
    await(tab.document)
    gate.check(epoch)
  }

  fun canTakeFocus(browser: WebView): Boolean {
    val owner = activity() ?: return false
    if (!owner.window.decorView.hasWindowFocus()) return false
    val focused = owner.currentFocus ?: return true
    var current: View? = focused
    while (current != null) { if (current === browser) return true; current = current.parent as? View }
    return !focused.isShown || !focused.onCheckIsTextEditor()
  }

  fun live(tabId: String): NativeTab {
    val tab = tabs[tabId] ?: throw BrowserFailure("target-closed")
    if (ledger.state(tabId) != TabState.LIVE || tab.view == null) throw BrowserFailure("target-suspended")
    return tab
  }

  fun anchor(epoch: Int, tab: NativeTab): BrowserAnchor {
    val marker = UUID.randomUUID().toString()
    val observed = JSONObject(evaluate(tab, epoch, """(()=>{const element=document.elementFromPoint(Math.min(innerWidth-1,20),Math.min(innerHeight-1,2));if(element)element.setAttribute('data-opensteer-anchor',${JSONObject.quote(marker)});return {found:!!element,top:element?element.getBoundingClientRect().top:0,horizontal:scrollX,vertical:scrollY,width:innerWidth,height:innerHeight}})()"""))
    return BrowserAnchor(if (observed.getBoolean("found")) marker else null, observed.getDouble("top"), observed.getDouble("horizontal"), observed.getDouble("vertical"), observed.getDouble("width"), observed.getDouble("height")).also { tab.anchor = it }
  }

  fun rendererSignal(epoch: Int, tab: NativeTab, script: (String) -> String): CompletableFuture<Unit> {
    val token = UUID.randomUUID().toString()
    val ready = CompletableFuture<Unit>()
    val expiration = Runnable { ready.completeExceptionally(BrowserFailure("timeout")) }
    main.postDelayed(expiration,10000)
    ready.whenComplete { _, _ -> main.removeCallbacks(expiration); main.post { rendererWaits.remove(token) } }
    ui(epoch) { rendererWaits[token] = RendererWait(tab, tab.documentId, epoch, ready) }
    evaluate(tab,epoch,script(token))
    return ready
  }

  private fun armResize(epoch: Int, tab: NativeTab, anchor: BrowserAnchor): CompletableFuture<Unit> = rendererSignal(epoch,tab) { token ->
    """(()=>{const resized=()=>{if(Math.abs(innerWidth-${anchor.viewportWidth})<0.1&&Math.abs(innerHeight-${anchor.viewportHeight})<0.1)return;window.removeEventListener('resize',resized);visualViewport.removeEventListener('resize',resized);requestAnimationFrame(()=>window[${JSONObject.quote(tab.ackBridge)}].postMessage(${JSONObject.quote(token)}))};window.addEventListener('resize',resized);visualViewport.addEventListener('resize',resized);return true})()"""
  }

  private fun visual(epoch: Int, tab: NativeTab) {
    val ready = CompletableFuture<Unit>()
    ui(epoch) {
      tab.view!!.postVisualStateCallback(SystemClock.uptimeMillis(), object : WebView.VisualStateCallback() {
        override fun onComplete(requestId: Long) { ready.complete(Unit) }
      })
      tab.view!!.invalidate()
    }
    await(ready)
    gate.check(epoch)
  }

  fun restore(epoch: Int, tab: NativeTab, anchor: BrowserAnchor) {
    visual(epoch, tab)
    val selector = "[data-opensteer-anchor='${anchor.marker}']"
    val position = JSONObject().put("top", anchor.top).put("vertical", anchor.vertical).put("horizontal", anchor.horizontal)
    evaluate(tab, epoch, """(()=>{const saved=$position;const element=document.querySelector(${JSONObject.quote(selector)});const beforeTop=element&&element.getClientRects().length?element.getBoundingClientRect().top:null;const beforeScroll=scrollY;const maximum=Math.max(0,document.documentElement.scrollHeight-innerHeight);const vertical=Math.max(0,Math.min(maximum,beforeTop===null?saved.vertical:scrollY+beforeTop-saved.top));const horizontal=Math.max(0,Math.min(saved.horizontal,document.documentElement.scrollWidth-innerWidth));scrollTo(horizontal,vertical);return {beforeTop,beforeScroll,wantedTop:saved.top,vertical,afterScroll:scrollY,afterTop:element?element.getBoundingClientRect().top:null,width:innerWidth,height:innerHeight,viewportTop:visualViewport.offsetTop,viewportPageTop:visualViewport.pageTop,viewportScale:visualViewport.scale}})()""")
    ui(epoch) { tab.geometryRevision++ }
    visual(epoch, tab)
  }

  fun mount(epoch: Int, tabId: String, hostId: String, generation: Int) {
    await(ui(epoch) { hostReady.getOrPut(hostId) { CompletableFuture() } })
    val tab = ui(epoch) {
      val tab = tabs[tabId] ?: throw BrowserFailure("target-closed")
      if (generation < tab.presentationGeneration) throw BrowserFailure("stale-presentation")
      tab
    }
    val hadView = ui(epoch) { tab.view != null }
    if (hadView) await(tab.document)
    val anchor = if (hadView) anchor(epoch, tab) else tab.anchor
    val document = tab.document
    val changedSize = ui(epoch) {
      val host = hosts[hostId] ?: throw BrowserFailure("host-not-ready")
      tab.view?.width != host.width || tab.view?.height != host.height
    }
    val viewport = if (changedSize && hadView) armResize(epoch, tab, anchor) else null
    revive(epoch, tabId) {
      if (hadView && (tab.document !== document || !document.isDone || document.isCompletedExceptionally)) throw BrowserFailure("stale-document")
      if (generation < tab.presentationGeneration) throw BrowserFailure("stale-presentation")
      val host = hosts[hostId] ?: throw BrowserFailure("host-not-ready")
      if (!host.isAttachedToWindow) throw BrowserFailure("host-not-ready")
      val browser = tab.view!!
      detachView(browser)
      host.addView(browser, android.widget.LinearLayout.LayoutParams(-1, -1))
      size(browser, host.width, host.height)
      tab.hostId = hostId
      tab.presentationGeneration = generation
    }
    if (viewport != null) await(viewport)
    ui(epoch) { if (generation != tab.presentationGeneration || tab.hostId != hostId) throw BrowserFailure("stale-presentation") }
    if (changedSize || !hadView) restore(epoch, tab, anchor)
    ui(epoch) { schedulePictures() }
  }

  fun retain(epoch: Int, tabId: String, captureAnchor: Boolean = true) {
    val tab = live(tabId)
    ui(epoch) { onSuspended?.invoke(tab) }
    if (captureAnchor) anchor(epoch, tab) else ui(epoch) {
      val browser = tab.view!!; val scale = browser.scale.toDouble().coerceAtLeast(0.01)
      tab.anchor = BrowserAnchor(null,0.0,browser.scrollX/scale,browser.scrollY/scale,browser.width/scale,browser.height/scale)
    }
    ui(epoch) {
      detachView(tab.view!!)
      tab.hostId = null; tab.live = false
      ledger.retain(tabId).forEach { discarded -> destroyView(tabs.getValue(discarded)) }
    }
  }

  fun resume(epoch: Int, tabId: String) {
    revive(epoch, tabId, ::moveCovered)
    val tab = live(tabId)
    restore(epoch, tab, tab.anchor)
    ui(epoch) { schedulePictures() }
  }

  private fun revive(epoch: Int, tabId: String, place: (NativeTab) -> Unit) {
    val tab = tabs[tabId] ?: throw BrowserFailure("target-closed")
    val restoreUrl = tab.url
    val originalGeneration = tab.generation
    try {
    val previous = ui(epoch) {
      if (!foreground) throw BrowserFailure("foreground-required")
      ledger.resume(tabId).also {
        tab.live = true
        if (it == TabState.DISCARDED) { tab.creating = true; tab.generation++; tab.document = CompletableFuture(); construct(tab, coveredPlace = false) }
        place(tab)
      }
    }
    if (previous == TabState.DISCARDED) {
      await(tab.document)
      evaluate(tab, epoch, "window.__opensteerNativeTarget=${JSONObject.quote(tab.marker)}")
      blankCommitted?.invoke(tab)
      if (restoreUrl != "about:blank") navigate(epoch, tabId, restoreUrl)
    }
    ui(epoch) { tab.creating = false }
    } catch (error: Throwable) {
      RequestDeadline.cleanup { ui(gate.epoch) {
        if (tabs[tabId] === tab) {
          destroyView(tab); ledger.discard(tabId); tab.url = restoreUrl; tab.generation = originalGeneration
          tab.creating = false; tab.pendingEvents.clear()
        }
      } }
      throw error
    }
  }

  fun cover(epoch: Int, tabId: String) { val tab = live(tabId); anchor(epoch, tab); ui(epoch) { moveCovered(tab) } }

  fun park(epoch: Int, tabId: String) = ui(epoch) {
    val tab = tabs[tabId] ?: throw BrowserFailure("target-closed")
    tab.view?.let(::detachView)
    tab.hostId = null
  }

  private fun moveCovered(tab: NativeTab) {
    if (!foreground) throw BrowserFailure("foreground-required")
    val browser = tab.view ?: return
    val root = covered ?: FrameLayout(context).also { holder ->
      val decor = activity()?.window?.decorView as? ViewGroup ?: throw BrowserFailure("foreground-required")
      decor.addView(holder, 0, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      covered = holder
    }
    detachView(browser)
    val slot = FrameLayout(context)
    root.addView(slot, FrameLayout.LayoutParams(browser.width.takeIf { it > 0 } ?: tab.width, browser.height.takeIf { it > 0 } ?: tab.height))
    slot.addView(browser, FrameLayout.LayoutParams(-1, -1))
    slot.addView(View(context).apply { setBackgroundColor(Color.BLACK) }, FrameLayout.LayoutParams(-1, -1))
    size(browser, browser.width.takeIf { it > 0 } ?: tab.width, browser.height.takeIf { it > 0 } ?: tab.height)
    slot.measure(View.MeasureSpec.makeMeasureSpec(browser.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(browser.height, View.MeasureSpec.EXACTLY))
    slot.layout(0, 0, browser.width, browser.height)
    tab.hostId = null
  }

  fun resize(epoch: Int, tabId: String, width: Int, height: Int, validate: () -> Unit = {}) {
    val tab = live(tabId)
    val anchor = anchor(epoch, tab)
    val changedSize = ui(epoch) { tab.view!!.width != width || tab.view!!.height != height }
    val viewport = if (changedSize) armResize(epoch, tab, anchor) else null
    ui(epoch) { validate(); size(tab.view!!, width, height); tab.geometryRevision++ }
    if (viewport != null) await(viewport)
    restore(epoch, tab, anchor)
  }

  private fun size(view: WebView, width: Int, height: Int) {
    if (width <= 0 || height <= 0) throw BrowserFailure("invalid-viewport")
    view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
    view.layout(0, 0, width, height)
  }


  fun ref(tab: NativeTab): Map<String, Any?> = mapOf("epoch" to gate.epoch, "sessionId" to tab.sessionId, "tabId" to tab.id, "generation" to tab.generation)
  fun documentRef(tab: NativeTab) = ref(tab) + mapOf("documentId" to tab.documentId, "geometryRevision" to tab.geometryRevision)
  fun metadata(tab: NativeTab): Map<String, Any?> = mapOf(
    "generation" to tab.generation, "revision" to tab.revision, "documentId" to (tab.documentId ?: ""),
    "geometryRevision" to tab.geometryRevision, "captureRevision" to tab.captureRevision,
    "title" to tab.title, "url" to tab.url, "loading" to tab.loading, "navigationFailed" to tab.failed,
    "canGoBack" to tab.canGoBack, "canGoForward" to tab.canGoForward,
    "width" to (tab.rendererGeometry.getOrNull(0)?.roundToInt() ?: ((tab.view?.width ?: tab.width) / (tab.view?.scale?.toDouble() ?: 1.0).coerceAtLeast(0.01)).roundToInt()),
    "height" to (tab.rendererGeometry.getOrNull(1)?.roundToInt() ?: ((tab.view?.height ?: tab.height) / (tab.view?.scale?.toDouble() ?: 1.0).coerceAtLeast(0.01)).roundToInt()),
    "viewportScale" to (tab.rendererGeometry.getOrNull(2) ?: 1.0), "offsetX" to (tab.rendererGeometry.getOrNull(3) ?: 0.0), "offsetY" to (tab.rendererGeometry.getOrNull(4) ?: 0.0), "scrollX" to (tab.rendererGeometry.getOrNull(5) ?: 0.0), "scrollY" to (tab.rendererGeometry.getOrNull(6) ?: 0.0),
    "keyboardHeight" to (tab.geometry.lastOrNull() ?: 0), "nativeWidth" to (tab.view?.width ?: tab.width), "nativeHeight" to (tab.view?.height ?: tab.height))

  fun changed(tab: NativeTab, name: String = "tabChanged", extra: Map<String, Any?> = emptyMap()) {
    if (tabs[tab.id] !== tab) return
    tab.revision++
    emit(name, ref(tab) + mapOf("metadata" to metadata(tab)) + extra)
  }

  fun changedGeometry(tab: NativeTab) {
    val browser = tab.view ?: return
    val keyboard = if (Build.VERSION.SDK_INT >= 30) browser.rootWindowInsets?.getInsets(WindowInsets.Type.ime())?.bottom ?: 0 else {
      val visible = android.graphics.Rect(); browser.getWindowVisibleDisplayFrame(visible)
      (browser.rootView.height - visible.bottom).coerceAtLeast(0)
    }
    val geometry = listOf<Number>(browser.width, browser.height, browser.scale, browser.scrollX, browser.scrollY, keyboard)
    if (geometry == tab.geometry) return
    tab.geometry = geometry
    tab.geometryRevision++
    changed(tab, "geometry")
  }

  private fun observeGeometry(tab: NativeTab) {
    if (tab.geometryPending || tab.documentId == null || !tab.document.isDone || tab.document.isCompletedExceptionally) return
    val browser = tab.view ?: return
    val document = tab.document
    val documentId = tab.documentId
    tab.geometryPending = true
    browser.postOnAnimation {
      if (tab.view !== browser || tab.document !== document || tab.documentId != documentId) { tab.geometryPending = false; return@postOnAnimation }
      browser.evaluateJavascript("(()=>{const v=visualViewport;return [v?v.width:innerWidth,v?v.height:innerHeight,v?v.scale:1,v?v.offsetLeft:0,v?v.offsetTop:0,scrollX,scrollY]})()") { value ->
        tab.geometryPending = false
        if (tab.view !== browser || tab.document !== document || tab.documentId != documentId) return@evaluateJavascript
        try {
          if (value.length > 1024) return@evaluateJavascript
          val array = org.json.JSONArray(value)
          if (array.length() != 7) return@evaluateJavascript
          val next = List(7) { array.getDouble(it) }
          if (next.any { !it.isFinite() || kotlin.math.abs(it) > 100000000 } || next[0] <= 0 || next[1] <= 0 || next[2] <= 0) return@evaluateJavascript
          if (next != tab.rendererGeometry) { tab.rendererGeometry = next; tab.geometryRevision++; changed(tab, "geometry") }
        } catch (_: Exception) { }
      }
    }
  }

  fun check(ref: TabRef, document: Boolean = false, geometry: Boolean = false): NativeTab {
    gate.check(ref.epoch)
    val tab = tabs[ref.tabId] ?: throw BrowserFailure("target-closed")
    if (tab.creating) throw BrowserFailure("target-not-ready")
    if (ref.sessionId != tab.sessionId) throw BrowserFailure("forbidden")
    if (ref.generation != tab.generation) throw BrowserFailure("stale-document")
    if (document) {
      if (ledger.state(tab.id) != TabState.LIVE) throw BrowserFailure("target-suspended")
      if (!tab.document.isDone || tab.document.isCompletedExceptionally || tab.documentId == null) throw BrowserFailure("target-not-ready")
      val issued = ref as? DocumentRef ?: throw BrowserFailure("stale-document")
      NativeIntegers.parse(issued.encodedGeometryRevision)
      if (issued.documentId != tab.documentId) throw BrowserFailure("stale-document")
      if (geometry && issued.geometryRevision != tab.geometryRevision) throw BrowserFailure("stale-geometry")
    }
    return tab
  }

  fun retireDocument(tab: NativeTab) {
    tab.frameRevisions.clear()
    onDocumentRetired?.invoke(tab)
    rendererWaits.filterValues { it.tab === tab }.keys.toList().forEach { rendererWaits.remove(it)?.ready?.completeExceptionally(BrowserFailure("stale-document")) }
    tab.document.completeExceptionally(BrowserFailure("stale-document"))
    tab.document = CompletableFuture()
    if (tab.pointerDown != 0L) {
      val now = SystemClock.uptimeMillis()
      val cancel = android.view.MotionEvent.obtain(tab.pointerDown, now, android.view.MotionEvent.ACTION_CANCEL, 0f, 0f, 0)
      try { tab.view?.dispatchTouchEvent(cancel) } finally { cancel.recycle(); tab.pointerDown = 0 }
    }
    tab.connection?.finishComposingText(); tab.connection = null; tab.editor = null; tab.compositionStart = null
    tab.contextId = UUID.randomUUID().toString()
    tab.rendererGeometry = emptyList(); tab.geometryPending = false
    tab.failed = false
    tab.navigationVersion++
  }

  fun downloadStarted(tab: NativeTab) {
    if (!tab.document.isDone && tab.documentId != null) {
      tab.document.complete(Unit); tab.loading = false; tab.navigationId = null
      onCommitted?.invoke(); changed(tab)
    }
  }

  fun discard(tabId: String) {
    val tab = tabs[tabId] ?: throw BrowserFailure("target-closed")
    destroyView(tab); ledger.discard(tabId); changed(tab)
  }

  fun foreground(active: Boolean) {
    foreground = active
    if (!active) {
      rendererWaits.values.forEach { it.ready.completeExceptionally(BrowserFailure("forbidden")) }; rendererWaits.clear()
      tabs.values.filter { ledger.state(it.id) == TabState.LIVE }.forEach {
        it.live = false; onSuspended?.invoke(it)
        it.connection?.finishComposingText(); it.connection = null; it.inputSequences.clear()
        it.view?.let { browser ->
          val scale = browser.scale.toDouble().coerceAtLeast(0.01)
          it.anchor = BrowserAnchor(null, 0.0, browser.scrollX / scale, browser.scrollY / scale, browser.width / scale, browser.height / scale)
          detachView(browser)
        }; it.hostId = null
        ledger.retain(it.id).forEach { id -> destroyView(tabs.getValue(id)) }
      }
    } else schedulePictures()
  }

  fun trim(critical: Boolean) {
    ledger.retainedIds().forEach(::discard)
    if (critical) tabs.values.filter { ledger.state(it.id) == TabState.LIVE && it.hostId == null }.map { it.id }.forEach(::discard)
  }

  fun picture(view: PhoneBrowserPicture, attached: Boolean) {
    if (attached) { pictures.add(view); tabs[view.tabId]?.lastPicture?.let(view::present) } else pictures.remove(view)
    schedulePictures()
  }

  private fun schedulePictures() {
    if (pictureScheduled || !foreground || pictures.none { picture -> tabs[picture.tabId]?.let { it.live && it.document.isDone && !it.document.isCompletedExceptionally } == true }) return
    pictureScheduled = true
    main.postDelayed({
      pictureScheduled = false
      if (!foreground) return@postDelayed
      pictures.toList().forEach { picture ->
        val tab = tabs[picture.tabId]
        val browser = tab?.view
        if (tab != null && browser != null && ledger.state(tab.id) == TabState.LIVE && tab.document.isDone && picture.width > 0 && picture.height > 0) {
          val bitmap = Bitmap.createBitmap(picture.width, picture.height, Bitmap.Config.ARGB_8888)
          val canvas = Canvas(bitmap)
          canvas.scale(picture.width.toFloat() / browser.width, picture.height.toFloat() / browser.height)
          browser.draw(canvas)
          tab.lastPicture = bitmap
          picture.present(bitmap)

        }
      }
      schedulePictures()
    }, 125)
  }

  fun destroy(epoch: Int, tabId: String) = ui(epoch) { destroyNow(tabId) }

  fun destroyNow(tabId: String) {
    val removed = tabs.remove(tabId)
    removed?.let { destroyView(it) }
    ledger.destroy(tabId)
    removed?.let { onTabRemoved?.invoke(it) }
    pictures.filter { it.tabId == tabId }.forEach { it.clear() }
  }

  private fun destroyView(tab: NativeTab) {
    tab.live = false; tab.frameRevisions.clear()
    onViewDestroyed?.invoke(tab)
    tab.targetPath = null
    tab.connection?.finishComposingText(); tab.connection = null; tab.editor = null; tab.compositionStart = null
    tab.inputSequences.clear()
    rendererWaits.filterValues { it.tab === tab }.keys.toList().forEach { rendererWaits.remove(it)?.ready?.completeExceptionally(BrowserFailure("target-closed")) }
    tab.document.completeExceptionally(BrowserFailure("target-closed"))
    val browser = tab.view
    browser?.let(::detachView)
    browser?.destroy()
    tab.view = null
    tab.documentId = null
    tab.hostId = null
  }

  private fun detachView(browser: WebView) {
    val parent = browser.parent as? ViewGroup
    parent?.removeView(browser)
    if (parent?.parent === covered) covered?.removeView(parent)
  }

  fun close() {
    foreground = false
    pictures.clear()
    tabs.values.forEach(::destroyView)
    tabs.clear()
    covered?.let { (it.parent as? ViewGroup)?.removeView(it) }
    covered = null
  }

  companion object { var current: PhoneBrowserPool? = null }
}

class PhoneBrowserPoolHost(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val onReady by EventDispatcher()
  var hostId = UUID.randomUUID().toString()
  private var notified = false
  override val shouldUseAndroidLayout = true
  override fun onAttachedToWindow() { super.onAttachedToWindow(); notified = false; PhoneBrowserPool.current?.register(this) }
  override fun onDetachedFromWindow() { PhoneBrowserPool.current?.detach(this); notified = false; super.onDetachedFromWindow() }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    for (index in 0 until childCount) {
      getChildAt(index).measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
      getChildAt(index).layout(0, 0, width, height)
    }
    PhoneBrowserPool.current?.register(this)
  }
  internal fun ready() { if (!notified) { notified = true; onReady(mapOf("hostId" to hostId)) } }
}

class PhoneBrowserPicture(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  var tabId = ""
  private var bitmap: Bitmap? = null
  private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
  init { setWillNotDraw(false) }
  override fun onAttachedToWindow() { super.onAttachedToWindow(); PhoneBrowserPool.current?.picture(this, true) }
  override fun onDetachedFromWindow() { PhoneBrowserPool.current?.picture(this, false); bitmap = null; super.onDetachedFromWindow() }
  internal fun present(next: Bitmap) { bitmap = next; invalidate() }
  internal fun clear() { bitmap = null; invalidate() }
  override fun onDraw(canvas: Canvas) { super.onDraw(canvas); bitmap?.let { canvas.drawBitmap(it, null, android.graphics.Rect(0, 0, width, height), paint) } }
}
