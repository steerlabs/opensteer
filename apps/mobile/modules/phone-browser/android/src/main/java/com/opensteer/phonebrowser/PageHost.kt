package com.opensteer.phonebrowser

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.ContextMenu
import android.graphics.Color
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import java.util.UUID
import kotlin.math.roundToInt

/**
 * Where the pool presents a page on this phone's screen. While one of its pages is here, and only
 * then, the host lays it out clear of its controls, reports its scroll, reloads it on a pull from
 * the top and offers the platform's menu for a held link. A covered or retained page
 * lives in the pool's own holder, never here, so none of this reaches it.
 */
class PhoneBrowserPoolHost(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val onReady by EventDispatcher()
  val onPageScroll by EventDispatcher()
  var hostId = UUID.randomUUID().toString()
  private var notified = false
  override val shouldUseAndroidLayout = true
  internal val frame = PageFrame(context, this)
  private var page: NativeTab? = null
  private var laidOut: Pair<Int, Int>? = null
  private var edges = 0 to 0
  private var keyboard = 0
  private val person = PersonScroll()
  private var lastScroll: PageScroll? = null
  private var refresh: Refresh? = null
  /**
   * Density-independent top and bottom the page's own controls float over. WebView has no obscured
   * insets, so the page's viewport ends where the controls' whole height begins: what it pins to an
   * edge stays clear of them, and it keeps that size while the bar shrinks and returns.
   */
  var barInsets: Pair<Double, Double>? = null
    set(value) { if (field != value) { field = value; requestLayout() } }
  var pageGestures = false
    set(value) { if (field != value) { field = value; attach() } }
  var pageScroll = false
    set(value) { if (field != value) { field = value; attach() } }

  private data class Refresh(val documentId: String?, var loaded: Boolean = false)

  init {
    addView(frame, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    frame.isEnabled = false
    frame.setProgressBackgroundColorSchemeColor(Color.parseColor("#1d1d1d"))
    frame.setColorSchemeColors(Color.parseColor("#f5f4f2"))
    frame.setOnRefreshListener { pulled() }
    ViewCompat.setOnApplyWindowInsetsListener(this) { view, insets -> typing(insets); ViewCompat.onApplyWindowInsets(view, insets) }
  }

  /**
   * The keyboard is up for a field in the page: it lays out above it, as WebView expects of a
   * window that resizes. The address editor's keyboard leaves the page as it is.
   */
  private fun typing(insets: WindowInsetsCompat) {
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
    val next = if (ime > 0 && page?.view?.hasFocus() == true) {
      val at = IntArray(2).also(::getLocationInWindow)
      (at[1] + height - (rootView.height - ime)).coerceAtLeast(0)
    } else 0
    if (next != keyboard) { keyboard = next; requestLayout() }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    notified = false
    PhoneBrowserPool.current?.register(this)
  }

  override fun onDetachedFromWindow() {
    PhoneBrowserPool.current?.detach(this)
    notified = false
    super.onDetachedFromWindow()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val before = laidOut
    laidOut = width to height
    val bar = barInsets?.let { (it.first * density).roundToInt() to (it.second * density).roundToInt() } ?: (0 to 0)
    val next = bar.first to maxOf(bar.second, keyboard)
    val moved = next != edges
    edges = next
    frame.offset = edges.first
    if (page == null || frame.size == null || moved || PageFollow.follows(before, width to height)) frame.resize(pageSize.first, pageSize.second)
    else frame.relayout()
    PhoneBrowserPool.current?.register(this)
  }

  /** Where a page presented here lays out: the host, less the edges its controls cover. */
  internal val pageSize get() = width to (height - edges.first - edges.second).coerceAtLeast(1)

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    if (page != null) when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> person.touched(true, event.eventTime)
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> person.touched(false, event.eventTime)
    }
    return super.dispatchTouchEvent(event)
  }

  internal fun ready() { if (!notified) { notified = true; onReady(mapOf("hostId" to hostId)) } }

  internal fun present(tab: NativeTab, browser: WebView) {
    page?.view?.let { if (it !== browser) (it.parent as? ViewGroup)?.removeView(it) }
    (browser.parent as? ViewGroup)?.removeView(browser)
    frame.addView(browser, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    page = tab
    tab.presented = this
    attach()
  }

  /** The pool took the page away: parked, covered for an agent, retained, moved or destroyed. */
  internal fun removed(child: View) {
    val tab = page ?: return
    if (tab.view != null && tab.view !== child) return
    (child as? WebView)?.let(::release)
    if (tab.presented === this) tab.presented = null
    page = null
    keyboard = 0
    person.clear()
    lastScroll = null
    refresh = null
    frame.isRefreshing = false
    frame.isEnabled = false
  }

  /** The pool's record of the presented page changed: a load the person started may have ended. */
  internal fun changed(tab: NativeTab) {
    if (page !== tab) return
    refresh?.let { pending ->
      if (tab.loading) pending.loaded = true
      else if (pending.loaded || tab.failed || tab.documentId != pending.documentId) {
        refresh = null
        frame.isRefreshing = false
      }
    }
  }

  /** The page ran out of room above while the person pulled it down. */
  internal fun overscrolled(deltaY: Int, scrollY: Int) {
    if (pageGestures && deltaY < 0 && scrollY <= 0 && person.touching) frame.pulling = true
  }

  private fun attach() {
    val tab = page ?: return
    val browser = tab.view ?: return
    release(browser)
    if (pageScroll) browser.setOnScrollChangeListener { view, _, y, _, _ -> scrolled(view as WebView, y) }
    browser.setOnCreateContextMenuListener { menu, _, _ -> held(menu, browser) }
    frame.isEnabled = pageGestures
    changed(tab)
  }

  private fun release(browser: WebView) {
    browser.setOnScrollChangeListener(null)
    browser.setOnCreateContextMenuListener(null)
    lastScroll = null
    frame.isEnabled = false
    if (refresh != null) { refresh = null; frame.isRefreshing = false }
  }

  private fun scrolled(browser: WebView, y: Int) {
    @Suppress("DEPRECATION") val content = browser.contentHeight * browser.scale.toDouble()
    val sample = PageScroll.of(y, content, browser.height, resources.displayMetrics.density, person.moved(SystemClock.uptimeMillis()))
    if (sample.same(lastScroll)) return
    lastScroll = sample
    onPageScroll(mapOf("y" to sample.y, "end" to sample.end, "person" to sample.person))
  }

  /**
   * The platform's own menu for a held link or image, with what needs nothing of the Host. Text
   * keeps WebView's selection, since no item is added for it.
   */
  private fun held(menu: ContextMenu, browser: WebView) {
    val hit = browser.hitTestResult
    val url = hit.extra?.takeIf { it.startsWith("https://") || it.startsWith("http://") } ?: return
    val image = hit.type == WebView.HitTestResult.IMAGE_TYPE
    if (image || hit.type == WebView.HitTestResult.SRC_ANCHOR_TYPE || hit.type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) {
      menu.setHeaderTitle(url.take(200))
      menu.add(if (image) "Copy image link" else "Copy link").setOnMenuItemClickListener {
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newRawUri(null, Uri.parse(url))); true
      }
      menu.add("Share…").setOnMenuItemClickListener {
        launch(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url), null)); true
      }
      menu.add(if (image) "Open image in browser" else "Open in browser").setOnMenuItemClickListener {
        launch(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)); true
      }
    }
  }

  private fun launch(intent: Intent) {
    try { (appContext.currentActivity ?: return).startActivity(intent) } catch (_: android.content.ActivityNotFoundException) { }
  }

  /** A pull reloads through the pool, as Reload does, so fences and watchers see a navigation. */
  private fun pulled() {
    val tab = page ?: run { frame.isRefreshing = false; return }
    refresh = Refresh(tab.documentId)
    if (PhoneBrowserPool.current?.personReload(tab) != true) { refresh = null; frame.isRefreshing = false }
  }

  private val density get() = resources.displayMetrics.density
}

/**
 * The pull-to-refresh frame the presented page sits in, sized by the pool. It takes a pull only
 * once the page itself has run out of room above, as a browser's own pull does, so a page that
 * scrolls an inner panel or handles the drag keeps it.
 */
internal class PageFrame(context: Context, private val host: PhoneBrowserPoolHost) : SwipeRefreshLayout(context) {
  var size: Pair<Int, Int>? = null
    private set
  var offset = 0
  var pulling = false
  private var armed = false

  init { setOnChildScrollUpCallback { _, _ -> !armed } }

  fun resize(width: Int, height: Int) {
    size = width to height
    relayout()
  }

  fun relayout() {
    val (width, height) = size ?: return
    measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    layout(0, offset, width, offset + height)
  }

  override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> { armed = false; pulling = false }
      MotionEvent.ACTION_MOVE -> if (pulling && !armed) {
        armed = true
        val start = MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_DOWN }
        try { super.onInterceptTouchEvent(start) } finally { start.recycle() }
      }
    }
    return super.onInterceptTouchEvent(event)
  }

  override fun onViewRemoved(child: View) {
    super.onViewRemoved(child)
    host.removed(child)
  }

  // The indicator's place is counted at measure; a leaving screen adds and removes views here before the next one.
  override fun getChildDrawingOrder(childCount: Int, i: Int): Int =
    super.getChildDrawingOrder(childCount, i).takeIf { it in 0 until childCount } ?: i
}

class BarInsetsRecord : Record { @Field var top = 0.0; @Field var bottom = 0.0 }
