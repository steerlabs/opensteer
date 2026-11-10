package com.opensteer.phonebrowser

import android.app.Activity
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Looper
import android.os.Message
import android.webkit.WebView
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors

internal class PhoneBrowserRuntime(
  private val context: Context,
  private val activity: () -> Activity?,
  val gate: EpochGate,
  private val emit: (Map<String, Any?>) -> Unit
) : ComponentCallbacks2 {
  val pool = PhoneBrowserPool(context, activity, gate) { name, fields -> publish(fields + mapOf("type" to name)) }
  val files = SessionFiles(context)
  val cdp = CdpOwner(pool, ::publish)
  val capture = BrowserCapture(pool)
  val chrome = BrowserChrome(pool, activity, files, ::publish, ::popup)
  val downloads = BrowserDownloads(context, pool, activity, ::publish)
  val input = ViewerInput(pool, ::publish) { tab -> if (chrome.hasDialog(tab)) throw BrowserFailure("dialog-open") }
  private val popupWorker = Executors.newSingleThreadExecutor()
  private val runtimeId = UUID.randomUUID().toString()
  private var deploymentId: String? = null
  private var runnerId: String? = null
  @Volatile var foreground = true
  @Volatile private var initialized = false
  private var bindingEpoch = -1
  private val probe = QualificationProbe(context, pool, cdp)
  private val generations = mutableMapOf<String, Int>()

  init {
    cdp.dialogOpened = chrome::protocolDialog
    cdp.dialogClosed = chrome::protocolClosed
    cdp.dialogCancelled = chrome::cancelProtocol
    PhoneBrowserNative.fence = ::fence
    PhoneBrowserNative.currentEpoch = { gate.epoch }
    PhoneBrowserNative.qualificationEvidence = ::qualificationEvidence
    PhoneBrowserPool.current = pool
    context.registerComponentCallbacks(this)
    pool.onConstruct = { tab, view -> chrome.install(tab, view); downloads.install(tab, view) }
    pool.onSuspended = { tab -> tab.frameRevisions.clear(); chrome.retire(tab); capture.retire(tab); cdp.retire(tab) }
    pool.onDocumentRetired = { tab -> chrome.retire(tab); capture.invalidate(tab) }
    pool.onTabRemoved = { tab ->
      downloads.retire(tab)
      val profiles = BrowserStartup.profiles
      if (profiles != null && profiles.guestActive(tab.storeHandle) && pool.tabs.values.none { it.storeHandle == tab.storeHandle }) profiles.endGuest(tab.storeHandle, ::closeProfile)
    }
    pool.onCommitted = { capture.committed() }
    pool.onViewDestroyed = { tab -> chrome.retire(tab); capture.retire(tab); cdp.retire(tab); input.retire(tab) }
    pool.onEditingContextChanged = { tab -> input.changed(tab) }
    pool.onRendererGone = { tabs -> emit(mapOf("type" to "rendererGone", "epoch" to gate.epoch, "tabs" to tabs.map(pool::ref))) }
    pool.blankCommitted = { tab -> if (cdp.qualified) cdp.mapBlank(tab) }
  }

  private fun publish(event: Map<String, Any?>) {
    val tab = (event["tabId"] as? String)?.let { pool.tabs[it] }
    if (tab != null && (tab.creating || !tab.published) && event["type"] != "popup") {
      tab.pendingEvents[event["type"] as String] = event
    } else emit(event)
  }
  fun publishReady(tabId: String) {
    val tab = pool.tabs[tabId] ?: return
    tab.published = true
    val events = tab.pendingEvents.values.sortedBy { ((it["metadata"] as? Map<*, *>)?.get("revision") as? Number)?.toLong() ?: Long.MAX_VALUE }
    tab.pendingEvents.clear()
    events.filter { it["epoch"] == gate.epoch }.forEach(emit)
  }
  @Synchronized fun initialize(input: InitializeRecord): Map<String, Any?> {
    gate.check(input.epoch)
    if (input.deploymentId.isBlank() || input.runnerId.isBlank()) throw BrowserFailure("forbidden")
    if (deploymentId != null && (deploymentId != input.deploymentId || runnerId != input.runnerId)) {
      val oldEntries = BrowserStartup.profiles?.manifest?.all()?.filter { it.binding.deploymentId == deploymentId } ?: emptyList()
      if (input.epoch <= bindingEpoch || pool.tabs.isNotEmpty() || oldEntries.any { it.deletionId == null }) throw BrowserFailure("forbidden")
    }
    bindingEpoch = input.epoch
    deploymentId = input.deploymentId; runnerId = input.runnerId
    if (BrowserStartup.profiles != null) downloads.bind(input.deploymentId)
    val profiles = BrowserStartup.profiles
    if (!initialized && profiles != null && foreground) {
      cdp.qualified = probe.run(profiles, input.deploymentId, input.runnerId)
      cdp.awaitDisabled()
      gate.check(input.epoch)
      initialized = true
    }
    return mapOf("platform" to "android", "runtimeId" to runtimeId, "storageInstanceId" to (profiles?.manifest?.storageInstanceId ?: ""),
      "browser" to (BrowserStartup.reason == null && foreground), "sharedControl" to (BrowserStartup.reason == null && foreground), "agentActions" to false,
      "cdpBoundary" to cdp.qualified, "fileStaging" to (BrowserStartup.reason == null))
  }
  fun qualificationEvidence(): Map<String, Any?> = mapOf("providerVersion" to BrowserStartup.providerVersion, "reason" to BrowserStartup.reason, "commands" to probe.receipts.toMap(), "release" to BrowserDebugging.release)
  fun requireReady(epoch: Int) {
    gate.check(epoch)
    if (!initialized || BrowserStartup.reason != null) throw BrowserFailure("browser-unavailable")
    if (!foreground) throw BrowserFailure("foreground-required")
  }
  private fun profiles(): NativeProfiles = BrowserStartup.profiles ?: throw BrowserFailure("browser-unavailable")
  fun ensure(input: ProfileRecord): String {
    val deadline = RequestDeadline.current()
    requireReady(input.epoch)
    val binding = input.binding.binding()
    PhoneBrowserNative.authority?.requireAllocation(input.epoch, input.allocationPermit, null, null, binding.fields()) ?: throw BrowserFailure("forbidden")
    if (binding.deploymentId != deploymentId || binding.runnerId != runnerId) throw BrowserFailure("forbidden")
    val entry = pool.await(pool.ui(input.epoch) { profiles().ensure(binding, input.initialized, false, gate, input.epoch) { gate.check(input.epoch); RequestDeadline.check(deadline) } })
    gate.check(input.epoch)
    return entry.handle
  }
  fun list(input: DeploymentRecord): List<Map<String, Any?>> = pool.ui(input.epoch) {
    if (input.deploymentId != deploymentId) throw BrowserFailure("forbidden")
    profiles().list(input.deploymentId)
  }
  fun erase(input: ProfileRecord): String {
    gate.check(input.epoch)
    val binding = input.binding.binding()
    if (binding.deploymentId != deploymentId || binding.runnerId != runnerId) throw BrowserFailure("forbidden")
    try { UUID.fromString(input.deletionId) } catch (_: Exception) { throw BrowserFailure("forbidden") }
    val response = pool.await(pool.ui(input.epoch) { profiles().erase(binding, input.deletionId, ::closeProfile) })
    gate.check(input.epoch)
    return response.getValue("state")
  }
  fun eraseDeployment(input: DeploymentRecord): List<Map<String, Any?>> {
    gate.check(input.epoch)
    if (input.deploymentId != deploymentId) throw BrowserFailure("forbidden")
    val entries = pool.ui(input.epoch) { profiles().manifest.all().filter { it.binding.deploymentId == input.deploymentId } }
    for (entry in entries) pool.await(pool.ui(input.epoch) { profiles().erase(entry.binding, entry.deletionId ?: UUID.randomUUID().toString(), ::closeProfile) })
    files.close()
    downloads.erase()
    return list(input)
  }
  private fun closeProfile(name: String) { pool.tabs.values.filter { it.profileName == name }.map { it.id }.forEach { id -> pool.destroyNow(id) } }
  fun create(input: CreateTabRecord): Map<String, Any?> {
    val deadline = RequestDeadline.current()
    requireReady(input.epoch)
    if (input.state !in setOf("live", "retained") || input.sessionId.isBlank() || input.tabId.isBlank()) throw BrowserFailure("forbidden")
    if (input.viewport.width !in 1..8192 || input.viewport.height !in 1..8192) throw BrowserFailure("invalid-viewport")
    input.url?.takeUnless { it == "about:blank" }?.let(::validateBrowserUrl)
    PhoneBrowserNative.authority?.requireAllocation(input.epoch, input.allocationPermit, input.sessionId, input.storeHandle) ?: throw BrowserFailure("forbidden")
    val profile = if (input.storeHandle != null) pool.ui(input.epoch) { profiles().serving(input.storeHandle!!) } else {
      pool.await(pool.ui(input.epoch) { profiles().ensure(ProfileBinding(deploymentId!!, runnerId!!, profiles().manifest.storageInstanceId, UUID.randomUUID().toString(), UUID.randomUUID().toString()), false, true, gate, input.epoch) { gate.check(input.epoch); RequestDeadline.check(deadline) } })
    }
    if (profile.binding.deploymentId != deploymentId || profile.binding.runnerId != runnerId) throw BrowserFailure("forbidden")
    val tab = pool.create(input.epoch, input.tabId, profile.name, (input.viewport.width * context.resources.displayMetrics.density).toInt(), (input.viewport.height * context.resources.displayMetrics.density).toInt(), sessionId = input.sessionId, storeHandle = profile.handle)
    try {
      pool.ui(input.epoch) {
        val generation = (generations[input.tabId] ?: 0) + 1
        generations[input.tabId] = generation; tab.generation = generation
        tab.navigationId = input.navigationId
      }
      input.url?.takeUnless { it == "about:blank" }?.let { pool.navigate(input.epoch, tab.id, it) }
      if (input.state == "retained") pool.retain(input.epoch, tab.id, false)
      return pool.ui(input.epoch) { tab.creating = false; pool.metadata(tab) }
    } catch (error: Throwable) {
      RequestDeadline.cleanup { pool.ui(gate.epoch) { pool.destroyNow(tab.id) } }
      if (profile.guest) RequestDeadline.cleanup { pool.ui(gate.epoch) { profiles().endGuest(profile.handle, ::closeProfile) } }
      throw error
    }
  }
  fun destroy(input: TabRef) {
    pool.ui(input.epoch) { pool.check(input).also { generations[it.id] = it.generation; pool.destroyNow(it.id) } }
  }
  fun suspend(input: SuspendRecord) {
    requireReady(input.epoch)
    pool.ui(input.epoch) { pool.check(input) }
    when (input.state) {
      "retained" -> if (pool.ui(input.epoch) { pool.ledger.state(input.tabId) } == TabState.LIVE) pool.retain(input.epoch, input.tabId)
      "discarded" -> pool.ui(input.epoch) { pool.discard(input.tabId) }
      else -> throw BrowserFailure("unsupported-operation")
    }
  }
  fun resume(input: TabRef): Map<String, Any?> {
    requireReady(input.epoch)
    pool.ui(input.epoch) { val tab = pool.check(input); profiles().serving(tab.storeHandle) }
    pool.resume(input.epoch, input.tabId)
    return pool.ui(input.epoch) { pool.metadata(pool.tabs.getValue(input.tabId)) }
  }
  fun mount(input: MountRecord): Map<String, Any?> {
    requireReady(input.epoch)
    pool.ui(input.epoch) { pool.check(input); if (input.presentationGeneration < 0) throw BrowserFailure("stale-presentation") }
    pool.mount(input.epoch, input.tabId, input.hostId, input.presentationGeneration)
    return pool.ui(input.epoch) { val tab = pool.check(input); tab.interactive = input.interactive; tab.view?.isEnabled = input.interactive; pool.changed(tab); pool.metadata(tab) }
  }
  fun unmount(input: UnmountRecord) {
    pool.ui(input.epoch) {
      val tab = pool.check(input)
      if (input.presentationGeneration < tab.presentationGeneration) throw BrowserFailure("stale-presentation")
      tab.presentationGeneration = input.presentationGeneration
    }
    if (pool.ui(input.epoch) { pool.ledger.state(input.tabId) } == TabState.LIVE) pool.cover(input.epoch, input.tabId)
  }
  fun resize(input: ResizeRecord): Map<String, Any?> {
    requireReady(input.epoch)
    if (input.width !in 1..8192 || input.height !in 1..8192) throw BrowserFailure("invalid-viewport")
    pool.ui(input.epoch) { pool.check(input, true, true) }
    pool.resize(input.epoch, input.tabId, (input.width * context.resources.displayMetrics.density).toInt(), (input.height * context.resources.displayMetrics.density).toInt()) { pool.check(input, true, true) }
    return pool.ui(input.epoch) { pool.metadata(pool.tabs.getValue(input.tabId)) }
  }
  fun navigate(input: NavigateRecord) {
    requireReady(input.epoch)
    pool.ui(input.epoch) {
      val tab = pool.check(input, true)
      val browser = tab.view!!
      tab.navigationId = input.navigationId
      when (input.kind) {
        "go" -> { val url = validateBrowserUrl(input.url ?: throw BrowserFailure("invalid-url")); pool.retireDocument(tab); browser.loadUrl(url) }
        "back" -> if (browser.canGoBack()) { pool.retireDocument(tab); browser.goBack() }
        "forward" -> if (browser.canGoForward()) { pool.retireDocument(tab); browser.goForward() }
        "reload" -> { pool.retireDocument(tab); if (input.ignoreCache) browser.clearCache(false); browser.reload() }
        "stop" -> { browser.stopLoading(); tab.loading = false; pool.changed(tab) }
        else -> throw BrowserFailure("unsupported-operation")
      }
    }
  }
  private fun popup(opener: NativeTab, message: Message): Boolean {
    if (!foreground || pool.ledger.state(opener.id) != TabState.LIVE) return false
    val epoch = gate.epoch
    val childId = UUID.randomUUID().toString()
    val child = try { pool.popup(epoch, childId, opener, message) } catch (_: BrowserFailure) { return false }
    popupWorker.execute {
      try {
        pool.await(child.document)
        pool.ui(epoch) {
          child.creating = false; child.published = true; child.pendingEvents.clear()
          emit(pool.ref(child) + mapOf("type" to "popup", "openerId" to opener.id, "metadata" to pool.metadata(child)))
        }
      } catch (_: Throwable) { pool.main.post { if (pool.tabs[childId] === child) pool.destroyNow(childId) } }
    }
    return true
  }
  fun fence(reason: String): Int {
    val active = foreground
    val epoch = gate.advance()
    pool.ui(epoch) {
      stop(); pool.tabs.values.filter { it.creating || !it.published }.map { it.id }.forEach(pool::destroyNow); pool.foreground(false)
      foreground = active
      if (active) { pool.foreground(true); capture.foreground(true); downloads.foreground(true) }
    }
    return epoch
  }
  fun stop() { foreground = false; capture.stop(); chrome.stop(); cdp.stop(); downloads.stop() }
  fun setForeground(input: ForegroundRecord): CompletableFuture<Unit> {
    pool.ui(input.epoch) {
      foreground = input.active
      if (!input.active) stop()
      pool.foreground(input.active); capture.foreground(input.active); downloads.foreground(input.active)
      if (input.active) BrowserStartup.profiles?.flush()
    }
    return if (!input.active) cdp.whenDisabled() else CompletableFuture.completedFuture(Unit)
  }
  fun inactive() {
    if (chrome.pickerActive) { foreground = false; capture.stop(); chrome.cancelDialogs(); cdp.stop(); pool.foreground(false) } else { foreground = false; fence("background") }
  }
  override fun onTrimMemory(level: Int) {
    pool.main.post {
      val critical = level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL && level < ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN || level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE
      pool.trim(critical)
      emit(mapOf("type" to "memoryPressure", "epoch" to gate.epoch, "level" to if (critical) "critical" else "warning"))
    }
  }
  override fun onLowMemory() = onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_COMPLETE)
  override fun onConfigurationChanged(configuration: Configuration) { pool.tabs.values.forEach(pool::changedGeometry) }
  fun close() {
    stop(); pool.tabs.keys.toList().forEach(pool::destroyNow); cdp.close(); capture.close(); files.close(); downloads.close(); popupWorker.shutdownNow(); pool.close()
    context.unregisterComponentCallbacks(this)
    if (PhoneBrowserPool.current === pool) {
      PhoneBrowserPool.current = null
      PhoneBrowserNative.fence = null; PhoneBrowserNative.currentEpoch = null; PhoneBrowserNative.qualificationEvidence = null
      PhoneBrowserNative.authority = null; PhoneBrowserNative.sink = null
    }
  }
}
