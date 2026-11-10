package com.opensteer.phonebrowser

import java.util.concurrent.atomic.AtomicInteger

internal class BrowserFailure(val reason: String, message: String = reason) : RuntimeException(message) {
  val code: String get() = when (reason) {
    "unsupported-operation", "target-suspended", "target-closed", "stale-document", "stale-geometry", "ambiguous", "not-found", "not-actionable", "dialog-open", "stale-dialog", "timeout", "forbidden", "too-large", "outcome-unknown" -> reason
    "ambiguous-target" -> "ambiguous"
    "target-not-ready", "file-not-ready" -> "timeout"
    "capture-busy", "invalid-viewport", "invalid-demand", "navigation-failed" -> "not-actionable"
    "stale-input", "stale-presentation", "stale-frame" -> "stale-document"
    "browser-unavailable", "cdp-command-failed" -> "unsupported-operation"
    else -> "forbidden"
  }
}

internal class EpochGate {
  private val value = AtomicInteger()
  val epoch: Int get() = value.get()
  fun adopt(epoch: Int) {
    if (epoch < 0) throw BrowserFailure("stale-epoch")
    while (true) {
      val previous = value.get()
      if (epoch < previous) throw BrowserFailure("stale-epoch")
      if (value.compareAndSet(previous, epoch)) return
    }
  }
  @Synchronized fun advance(): Int {
    if (value.get() == Int.MAX_VALUE) throw BrowserFailure("epoch-exhausted")
    return value.incrementAndGet()
  }
  @Synchronized fun <Result> execute(issued: Int, action: () -> Result): Result {
    if (issued < 0 || issued != value.get()) throw BrowserFailure("stale-epoch")
    return action()
  }
  fun check(issued: Int) = execute(issued) { Unit }
}

internal enum class TabState { LIVE, RETAINED, DISCARDED }

internal object RetainedTabAdoption {
  fun require(epoch: Int, allocationEpoch: Int, state: TabState, session: String, generation: Int,
    previousSession: String, previousGeneration: Int, store: String, requestedStore: String?, guestOwner: String?) {
    if (epoch <= allocationEpoch || state == TabState.LIVE || session != previousSession || generation != previousGeneration ||
      (if (requestedStore == null) guestOwner != previousSession else requestedStore != store || guestOwner != null)) throw BrowserFailure("forbidden")
  }
}

internal data class BrowserQualification(val browser: Boolean, val sharedControl: Boolean, val fileStaging: Boolean, val cdpBoundary: Boolean) {
  companion object {
    fun from(receipts: Map<String, Any?>, release: Boolean, disabled: Boolean): BrowserQualification {
      val browser = receipts["native browser"] == true
      val shared = browser && receipts["native input"] == true && receipts["native picture"] == true
      return BrowserQualification(browser, shared, browser && receipts["native staging"] == true,
        shared && release && disabled && receipts["passed"] == true && receipts["clipboard denial"] == true)
    }
  }
}

internal class PoolLedger(private val liveLimit: Int = 2, private val retainedLimit: Int = 4) {
  private val states = linkedMapOf<String, TabState>()
  private val retained = linkedSetOf<String>()
  fun state(tabId: String) = states[tabId] ?: throw BrowserFailure("target-closed")
  fun create(tabId: String) {
    if (states.containsKey(tabId)) throw BrowserFailure("tab-exists")
    if (states.values.count { it == TabState.LIVE } >= liveLimit) throw BrowserFailure("target-suspended")
    states[tabId] = TabState.LIVE
  }
  fun resume(tabId: String): TabState {
    val previous = state(tabId)
    if (previous != TabState.LIVE && states.values.count { it == TabState.LIVE } >= liveLimit) throw BrowserFailure("target-suspended")
    retained.remove(tabId)
    states[tabId] = TabState.LIVE
    return previous
  }
  fun retain(tabId: String): List<String> {
    state(tabId)
    retained.remove(tabId)
    retained.add(tabId)
    states[tabId] = TabState.RETAINED
    val discarded = mutableListOf<String>()
    while (retained.size > retainedLimit) {
      val oldest = retained.first()
      retained.remove(oldest)
      states[oldest] = TabState.DISCARDED
      discarded.add(oldest)
    }
    return discarded
  }
  fun discard(tabId: String) { state(tabId); retained.remove(tabId); states[tabId] = TabState.DISCARDED }
  fun destroy(tabId: String) { states.remove(tabId); retained.remove(tabId) }
  fun retainedIds() = retained.toList()
}

internal object AnchorMath {
  fun offset(previous: Double, elementTop: Double?, wantedTop: Double, maximum: Double): Double {
    val candidate = if (elementTop != null && elementTop.isFinite()) previous + elementTop - wantedTop else previous
    return candidate.coerceIn(0.0, maximum.coerceAtLeast(0.0))
  }
}

internal object TargetMarkers {
  fun match(marker: String, observed: Map<String, String?>): String {
    val matches = observed.filterValues { it == marker }.keys
    if (matches.size != 1) throw BrowserFailure("ambiguous-target")
    return matches.single()
  }
}

internal class CaptureCredit {
  private val demands = mutableMapOf<String, Double>()
  private val outstanding = mutableMapOf<String, String>()
  fun demand(channelId: String, density: Double, frames: Boolean) {
    if (!density.isFinite() || density <= 0.0 || density > 4.0) throw BrowserFailure("invalid-demand")
    if (frames) demands[channelId] = density else {
      demands.remove(channelId)
      outstanding.remove(channelId)
    }
  }
  fun channel(): String? = demands.keys.firstOrNull { !outstanding.containsKey(it) }
  fun density(): Double? = if (channel() != null) demands.values.maxOrNull() else null
  fun issue(channelId: String, token: String) {
    if (!demands.containsKey(channelId) || outstanding.containsKey(channelId)) throw BrowserFailure("capture-busy")
    val density = demands.remove(channelId)!!
    demands[channelId] = density
    outstanding[channelId] = token
  }
  fun ack(channelId: String, token: String) {
    if (outstanding[channelId] != token) throw BrowserFailure("stale-frame")
    outstanding.remove(channelId)
  }
  fun invalidate() { outstanding.clear() }
  fun stop() { demands.clear(); outstanding.clear() }
}

internal class InputSequences {
  private data class Lane(val generation: Long, val sequence: Long)
  private val lanes = mutableMapOf<Pair<String, String>, Lane>()
  fun accept(channel: String, message: Map<String, Any?>) {
    val sequence = NativeIntegers.parse((message["inputSequence"] as? Number)?.toDouble() ?: Double.NaN)
    accept(channel, message["producerId"] as? String ?: throw BrowserFailure("forbidden"),
      NativeIntegers.parse((message["inputGeneration"] as? Number)?.toDouble() ?: Double.NaN),
      if (message["inputSequenceStart"] == null) sequence else NativeIntegers.parse((message["inputSequenceStart"] as? Number)?.toDouble() ?: Double.NaN),
      sequence)
  }
  fun accept(channel: String, producer: String, generation: Long, start: Long, sequence: Long) {
    if (producer.isBlank() || generation < 0 || start < 0 || sequence < start) throw BrowserFailure("forbidden")
    val key = channel to producer
    val old = lanes[key]
    if (old != null && (generation < old.generation || generation == old.generation && start <= old.sequence)) throw BrowserFailure("stale-input")
    lanes[key] = Lane(generation, sequence)
  }
  fun clear() = lanes.clear()
}

internal class CdpPermits(private val onEmpty: () -> Unit = {}) {
  private val values = mutableMapOf<String, Pair<Int, String>>()
  @Synchronized fun grant(id: String, epoch: Int, channel: String) { values[id] = epoch to channel }
  @Synchronized fun require(id: String, epoch: Int): String {
    val permit = values[id] ?: throw BrowserFailure("forbidden")
    if (permit.first != epoch) throw BrowserFailure("stale-epoch")
    return permit.second
  }
  @Synchronized fun remove(id: String) { if (values.remove(id) != null && values.isEmpty()) onEmpty() }
  @Synchronized fun empty() = values.isEmpty()
  @Synchronized fun clear() { val hadValues = values.isNotEmpty(); values.clear(); if (hadValues) onEmpty() }
}

internal object RequestDeadline {
  private val deadline = ThreadLocal<Long>()
  fun current(): Long = deadline.get() ?: (System.nanoTime() + 30_000_000_000L)
  fun check(value: Long = current()) { if (System.nanoTime() >= value) throw BrowserFailure("timeout") }
  fun remaining(value: Long = current()): Long { check(value); return ((value-System.nanoTime())/1_000_000).coerceAtLeast(1).coerceAtMost(10000) }
  fun <T> within(value: Long, action: () -> T): T {
    val previous = deadline.get()
    deadline.set(value)
    return try { check(value); action() } finally { if (previous == null) deadline.remove() else deadline.set(previous) }
  }
  fun <T> cleanup(action: () -> T): T = within(System.nanoTime() + 10_000_000_000L, action)
}

internal object NativeIntegers {
  fun parse(value: Double, maximum: Long = 9007199254740991L): Long {
    if (!value.isFinite() || value < 0 || value % 1.0 != 0.0 || value > maximum.toDouble()) throw BrowserFailure("forbidden")
    return value.toLong()
  }
}

internal object CaptureRaster {
  fun size(nativeWidth: Double, nativeHeight: Double, cssWidth: Double, cssHeight: Double, density: Double, css: Boolean): Pair<Int,Int> {
    val width = (if (css) cssWidth else nativeWidth)*density
    val height = (if (css) cssHeight else nativeHeight)*density
    if (listOf(width,height,density).any { !it.isFinite() } || width <= 0 || height <= 0) throw BrowserFailure("invalid-demand")
    if (width > 7680 || height > 4320) throw BrowserFailure("too-large")
    val w = Math.round(width).toInt().coerceAtLeast(1); val h = Math.round(height).toInt().coerceAtLeast(1)
    if (w !in 1..7680 || h !in 1..4320 || w.toLong()*h > 16777216) throw BrowserFailure("too-large")
    return w to h
  }
}

internal object DownloadCookies {
  fun maySend(documentUrl: String, downloadUrl: String): Boolean = try {
    val source = java.net.URI(documentUrl); val target = java.net.URI(downloadUrl)
    fun port(uri: java.net.URI) = if (uri.port >= 0) uri.port else if (uri.scheme.equals("https",true)) 443 else 80
    source.scheme?.lowercase() in setOf("http","https") && source.scheme.equals(target.scheme,true) && source.host != null && source.host.equals(target.host,true) && port(source) == port(target)
  } catch (_: Exception) { false }
}
