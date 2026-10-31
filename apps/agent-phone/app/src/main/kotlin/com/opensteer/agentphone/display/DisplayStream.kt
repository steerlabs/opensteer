package com.opensteer.agentphone.display

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import com.opensteer.agentphone.control.*
import com.opensteer.agentphone.wire.*
import com.opensteer.agentphone.runner.PhoneOperations
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.HttpUrl.Companion.toHttpUrl
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit

/** A media socket and projection belong to one start, independently of the runner's connection loop. */
class DisplayStream(private val context: android.accessibilityservice.AccessibilityService, private val client: OkHttpClient, private val desk: PhoneDesk,
    private val executor: PhoneExecutor, private val device: AccessibilityDevice, private val gestures: AndroidGestures) {
    private val thread = HandlerThread("opensteer-display").apply { start() }
    private val handler = Handler(thread.looper)
    @Volatile private var current: Active? = null
    private class Active(val request: DisplayMessage.Start, val operations: PhoneOperations, val send: (JsonObject) -> Unit) {
        @Volatile var sources = request.sources
        @Volatile var inputSources = request.inputSources.orEmpty()
        @Volatile var personSource: DisplaySource? = null
        var powerSequence = -1L
        var revision = request.revision
        var acquiring = false
        @Volatile var capture: ProjectionCapture? = null
        var socket: WebSocket? = null
        var open = false
        val queue = ArrayDeque<EncodedPicture>()
        var queuedBytes = 0
        var dropped = false
        val window = DisplayWindow(SystemClock::elapsedRealtime)
        val bitrate = DisplayBitrate().apply { if (request.displayProfile == 1) cap(request.maxBitrate) }
        var sequence = 0L
        @Volatile var generation = 0L
        var waitingForKey = true
        var width = 0
        var height = 0
        var rotation = 0
        var sourceWidth = 0
        var sourceHeight = 0
        @Volatile var state = "starting"
        var reason: String? = null
        var encoderErrors = 0
        val input = PersonInputLane.Stream()
        @Volatile var inputAvailable = false
        @Volatile var protected = true
    }
    // Owner lane only: a tap's focus must arrive before the following text can use it.
    private var ownerFocusEditor: android.view.accessibility.AccessibilityNodeInfo? = null
    private val editing = OwnerEditing(context, device)
    private val editingQueued = java.util.concurrent.atomic.AtomicBoolean()
    private val protectionRevision = java.util.concurrent.atomic.AtomicLong()
    private val pumpQueued = java.util.concurrent.atomic.AtomicBoolean()
    private val personLane = PersonInputLane(executor::ownerInput,
        { gestures.scheduler.cancel(producer = GestureScheduler.Producer.PERSON) },
        { done -> gestures.scheduler.cancel(producer = GestureScheduler.Producer.PERSON) {
            executor.ownerInput {
                // The lane waits on done(): a failed key release must never stall the person's next batch.
                try {
                    ownerFocusEditor = null
                    current?.personSource = null
                    runCatching { device.personEdit { editing.reset(); device.clearOwnerText() } }
                        .onFailure { android.util.Log.w("OpensteerDisplay", "Person input reset could not release keys: ${it.javaClass.simpleName}") }
                    publishEditing()
                } finally { done() }
            }
        } })
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            desk.displayChanged(device.display())
            handler.post { desk.windowsChanged(); reconcile() }
        }
    }
    init {
        device.textChanged = ::editingChanged
        device.personKeysHeld = editing::holdsKeys
        context.registerReceiver(receiver, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_USER_PRESENT)
        })
        handler.post(object : Runnable {
            override fun run() {
                runCatching { desk.windowsChanged(); reconcile(); pump() }.onFailure { current?.let(::encoderError) }
                handler.postDelayed(this, 1000)
            }
        })
    }
    fun handle(message: DisplayMessage, hostUrl: String, operations: PhoneOperations, send: (JsonObject) -> Unit) {
        handler.post {
            if (message is DisplayMessage.Control) { control(message, send); return@post }
            if (message !is DisplayMessage.Start && current?.let { it.request.streamId == message.streamId && it.request.fence == message.fence } != true) return@post
            when (message) {
                is DisplayMessage.Start -> start(message, hostUrl, operations, send)
                is DisplayMessage.Stop -> current?.takeIf { it.request.streamId == message.streamId }
                    ?.let { stop(it, "stopped", null) }
                is DisplayMessage.Refresh -> current?.takeIf { it.request.streamId == message.streamId }
                    ?.let { active -> runCatching {
                        active.capture?.let { capture -> synchronized(capture.gate.lock) {
                            clearQueue(active)
                            capture.requestSync()
                        } }
                    }.onFailure { encoderError(active) } }
                is DisplayMessage.Demand -> current?.let { active ->
                    if (message.revision > active.revision) { active.revision = message.revision;
                        if (active.request.displayProfile == 1 && active.bitrate.cap(message.maxBitrate)) runCatching { active.capture?.bitrate(active.bitrate.value) };
                        active.sources = message.sources; active.inputSources = if (active.request.phoneOwnerControl == 1) message.inputSources.orEmpty() else emptyList(); reconcile() }
                }
                is DisplayMessage.Control -> Unit
                is DisplayMessage.Input -> input(message)
                is DisplayMessage.InputReset -> current?.let { active ->
                    if (active.request.sharedInput == 1 && addressNegotiated(active, message.sourceAddressed) && message.source in active.sources) personLane.reset()
                }
                is DisplayMessage.Power -> power(message)
            }
        }
    }
    /** Close the publication fence synchronously with the desk's protection change, before scheduling lifecycle work. */
    fun protectionChanged(protected: Boolean) {
        val revision = if (protected) protectionRevision.incrementAndGet() else protectionRevision.get()
        val active = current
        if (active?.inputAvailable == true && active.sources.none { admitted(active, it, false) }) {
            active.inputAvailable = false
            personLane.reset()
        }
        if (protected && active != null) {
            active.protected = true
            active.capture?.protect { active.protected = true; clearQueue(active) }
            active.inputAvailable = false
            personLane.reset()
            val protectionReason = desk.displayProtection()
            handler.post { if (current === active && active.protected && protectionRevision.get() == revision) state(active, if (protectionReason == "screen-off") "screen-off" else "protected", protectionReason?.takeUnless { it == "screen-off" }) }
        }
        handler.post { reconcile() }
    }
    fun lost() {
        val active = current
        active?.sources = emptyList()
        active?.inputSources = emptyList()
        active?.capture?.protect { clearQueue(active) }
        active?.inputAvailable = false
        personLane.reset()
        handler.post { if (current === active) active?.let { stop(it, "stopped", null) } }
    }
    fun close() {
        // Service teardown runs on main; release IME keys before it waits for worker shutdown.
        editing.reset()
        device.textChanged = {}
        lost()
        context.unregisterReceiver(receiver)
        val done = java.util.concurrent.CountDownLatch(1)
        handler.post { current?.let { stop(it, "stopped", "session-ended") }; done.countDown() }
        done.await(2, TimeUnit.SECONDS)
        thread.quitSafely()
    }
    private fun start(request: DisplayMessage.Start, hostUrl: String, operations: PhoneOperations, send: (JsonObject) -> Unit) {
        if (current?.let { it.request.streamId == request.streamId && it.request.fence == request.fence } == true) return
        current?.let { stop(it, "stopped", null) }
        val active = Active(request, operations, send)
        current = active
        state(active, "starting")
        reconcileSources(active)
        if (!ProjectionRequest.permitted(context)) { stop(active, "failed", "permission-required"); return }
        val url = hostUrl.toHttpUrl().newBuilder().encodedPath("/internal/v1/computer-use/display").query(null).fragment(null).build()
        active.socket = client.newWebSocket(Request.Builder().url(url).header("Authorization", "Bearer ${request.dataTicket}").build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) { handler.post {
                    if (current !== active) webSocket.cancel() else { active.open = true; reconcile() }
                } }
                override fun onMessage(webSocket: WebSocket, text: String) { handler.post {
                    if (current !== active) return@post
                    try {
                        active.window.ack(DisplayWire.ack(text).sequence)
                        if (active.window.needsSync) recover(active)
                        pump()
                    } catch (_: Exception) { stop(active, "failed", "data-socket-failed") }
                } }
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) = failed()
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    val detail = t.message.orEmpty().replace(active.request.dataTicket, "[redacted]")
                        .replace(Regex("(?i)Bearer\\s+\\S+"), "Bearer [redacted]")
                        .replace(Regex("(?:https?|wss?)://\\S+"), "[endpoint]").take(240)
                    val diagnostic = Throwable("${t.javaClass.simpleName}: $detail").apply { stackTrace = t.stackTrace }
                    android.util.Log.w("OpensteerDisplay", "Data socket failed: HTTP ${response?.code ?: "none"}", diagnostic)
                    failed()
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    socketClosed(code, reason); closedBy(code)
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    socketClosed(code, reason); closedBy(code)
                }
                private fun socketClosed(code: Int, reason: String) {
                    val safe = reason.takeIf { it in setOf("", "normal", "going away", "stream-lost", "session-ended", "viewer-gone") } ?: "redacted (${reason.length} chars)"
                    android.util.Log.w("OpensteerDisplay", "Data socket closed: code=$code reason=$safe")
                }
                private fun failed() { handler.post { if (current === active) stop(active, "failed", "data-socket-failed") } }
                /**
                 * The Host ends a stream by closing this socket beside `display.stop`, and the
                 * two arrive in either order: a close it chose is a stop, not a failure.
                 */
                private fun closedBy(code: Int) {
                    when (code) {
                        HOST_ENDED -> handler.post { if (current === active) stop(active, "stopped", null) }
                        HOST_STOPPING -> handler.post { if (current === active) stop(active, "stopped", null) }
                        AUTHORITY_ENDED -> handler.post { if (current === active) stop(active, "stopped", "session-ended") }
                        else -> failed()
                    }
                }
            })
    }
    private fun acquire(active: Active) {
        if (active.acquiring) return
        active.acquiring = true
        executor.acquisition {
            if (current !== active) return@acquisition
            if (desk.displayProtection() != null || !device.display().interactive || device.display().locked || active.sources.isEmpty() || device.display().locked || active.sources.none { active.operations.displayUnavailable(it) == null }) {
                handler.post { active.acquiring = false }; return@acquisition
            }
            val future = ProjectionRequest.acquire(context) { capture ->
                val ready = java.util.concurrent.CompletableFuture<Unit>()
                if (!handler.post { try {
                    if (current !== active) capture.stop() else {
                        active.acquiring = false
                        active.capture = capture
                        capture.onFrame = picture@{ picture ->
                            // This callback and close/drop run under the very same encoder gate lock.
                            if (current === active && !active.protected) {
                                if (active.waitingForKey && !picture.key) return@picture
                                active.waitingForKey = false
                                if (active.queuedBytes + picture.payload.size <= DisplayWire.UNACKED_BYTES) {
                                    active.queue += picture; active.queuedBytes += picture.payload.size
                                } else active.dropped = true
                                queuePump()
                            }
                        }
                        capture.onResize = { handler.post { if (current === active) reconcile() } }
                        capture.onFailure = { error -> handler.post {
                            if (current === active) {
                                if (error is ProjectionCapture.ProjectionEnded) stop(active, "stopped", "projection-ended")
                                else encoderError(active)
                            }
                        } }
                        reconcile()
                    }
                    ready.complete(Unit)
                } catch (error: Exception) { ready.completeExceptionally(error) } }) {
                    capture.stop(); ready.complete(Unit)
                }
                ready
            }
            try {
                val capture = future.get(15, TimeUnit.SECONDS)
                // The activity has gone and the initial Surface is attached before this turn releases agent work.
                device.foreground()
                if (current !== active) capture.stop()
            } catch (error: Exception) {
                future.cancel(false)
                handler.post { if (current === active) stop(active, "failed",
                    if (error.cause is SecurityException) "permission-required" else "projection-ended") }
            }
        }
    }
    private val expiry = Runnable { reconcile() }
    fun authorityChanged() { handler.post { reconcile() } }
    private fun reconcileSources(active: Active) {
        val ended = active.sources.mapNotNull { source -> active.operations.displayUnavailable(source)?.let { source to it } }
        if (ended.isNotEmpty()) {
            active.sources = active.sources.filter { source -> ended.none { it.first == source } }
            for ((source, reason) in ended) active.send(DisplayWire.sourceEnded(active.request.fence, active.request.streamId, source, reason))
        }
        handler.removeCallbacks(expiry)
        active.operations.displayDeadline(active.sources)?.let { deadline -> handler.postDelayed(expiry, (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1)) }
        if (active.personSource?.let { !admitted(active, it, false) } == true) personLane.reset()
        val available = active.sources.any { admitted(active, it, false) }
        if (active.inputAvailable && !available) personLane.reset()
        active.inputAvailable = available
    }
    private fun reconcile() {
        val active = current ?: return
        reconcileSources(active)
        val display = device.display()
        desk.displayChanged(display)
        val protection = desk.displayProtection()
        if (protection != null || active.sources.isEmpty()) {
            if (!active.protected) personLane.reset()
            active.protected = true
            active.capture?.protect { clearQueue(active) }
            state(active, if (protection == "screen-off") "screen-off" else "protected", protection?.takeUnless { it == "screen-off" })
            return
        }
        if (!active.open) return
        if (active.capture == null) { acquire(active); return }
        if (active.protected || active.rotation != display.rotation || active.sourceWidth != display.width || active.sourceHeight != display.height) reset(active)
    }
    private fun reset(active: Active) {
        val revision = protectionRevision.get()
        if (current !== active || !active.open) return
        val display = device.display()
        if (desk.displayProtection() != null || !display.interactive || display.locked || active.sources.isEmpty()) { reconcile(); return }
        val capture = active.capture ?: return
        try {
            synchronized(capture.gate.lock) {
                if (protectionRevision.get() != revision || desk.displayProtection() != null || !device.display().interactive || device.display().locked || active.sources.isEmpty()) return
                capture.protect { clearQueue(active) }
                active.generation = capture.reset(active.request.maxLongSide, active.request.maxFps, active.bitrate.value)
                active.width = capture.width; active.height = capture.height; active.rotation = capture.rotation
                active.sourceWidth = display.width; active.sourceHeight = display.height
                active.waitingForKey = true
                if (protectionRevision.get() != revision) {
                    active.protected = true
                    capture.protect { clearQueue(active) }
                    return
                }
                active.protected = false
            }
            personLane.reset()
            state(active, "starting")
        } catch (_: Exception) { encoderError(active) }
    }
    private fun encoderError(active: Active) {
        if (active.encoderErrors++ == 0) reset(active) else stop(active, "failed", "encoder-failed")
    }
    /** Dropped deltas require an IDR, never a new geometry/privacy generation. */
    private fun recover(active: Active) {
        val capture = active.capture ?: return
        synchronized(capture.gate.lock) {
            if (current !== active || !active.window.needsSync) return
            clearQueue(active)
            active.waitingForKey = true
            active.window.resume()
            capture.requestSync()
        }
    }
    private fun queuePump() {
        if (pumpQueued.compareAndSet(false, true)) handler.post { pumpQueued.set(false); runCatching { pump() }.onFailure { current?.let(::encoderError) } }
    }
    private fun pump() {
        val active = current ?: return
        reconcileSources(active)
        if (active.sources.isEmpty() || desk.displayProtection() != null) { reconcile(); return }
        val capture = active.capture ?: return
        var recover = false
        synchronized(capture.gate.lock) {
            if (active.protected) return
            active.window.check()
            if (active.window.blocked || active.dropped) {
                clearQueue(active)
                if (active.bitrate.congested(SystemClock.elapsedRealtime())) runCatching { capture.bitrate(active.bitrate.value) }
                // A dropped queued picture makes subsequent deltas undecodable, even if the socket itself was healthy.
                if (active.window.needsSync) { recover = true }
                else if (active.dropped && !active.window.blocked) { active.window.block(); recover = active.window.needsSync }
                active.dropped = false
            }
            while (!active.window.blocked && active.queue.isNotEmpty()) {
                val picture = active.queue.removeFirst(); active.queuedBytes -= picture.payload.size
                if (picture.generation != active.generation) continue
                val bytes = DisplayWire.media(DisplayMediaHeader(active.request.streamId, picture.generation, active.sequence,
                    picture.ptsUs, picture.key, picture.codec, picture.width, picture.height), picture.payload)
                if (!active.window.sent(active.sequence, bytes.size)) { clearQueue(active); break }
                if (active.socket?.send(bytes.toByteString()) != true) {
                    handler.post { if (current === active) stop(active, "failed", "data-socket-failed") }; break
                }
                active.sequence++
                active.width = picture.width; active.height = picture.height; active.rotation = picture.rotation
                if (active.state != "screen-off") state(active, "live")
                val now = SystemClock.elapsedRealtime()
                active.bitrate.flow(now)
                val changed = if (active.window.delay >= 250) active.bitrate.congested(now) else active.bitrate.healthy(now)
                if (changed) runCatching { capture.bitrate(active.bitrate.value) }
            }
        }
        if (recover) recover(active)
    }
    private fun clearQueue(active: Active?) { active?.queue?.clear(); if (active != null) active.queuedBytes = 0 }
    private fun state(active: Active, state: String, reason: String? = null) {
        if (active.state == state && active.reason == reason && state != "starting" && state != "live") return
        // Live is sent only for the first picture of each generation.
        if (state == "live" && active.state == "live") return
        android.util.Log.d("OpensteerDisplay", "State ${active.state} -> $state reason=${reason ?: "none"} generation=${active.generation}")
        active.state = state; active.reason = reason
        active.send(DisplayWire.state(active.request.fence, active.request.streamId, state, reason,
            active.generation, active.width, active.height, active.rotation))
        if (state == "live") editingChanged()
    }
    private fun stop(active: Active, state: String, reason: String?) {
        if (current !== active) return
        handler.removeCallbacks(expiry)
        active.inputAvailable = false
        personLane.reset()
        current = null
        active.capture?.protect { clearQueue(active) }
        active.capture?.stop(); active.capture = null
        active.socket?.cancel(); active.socket = null
        state(active, state, reason)
    }
    /** A previous-release Host's Take over: refused with the one reason its viewers show no words for. */
    private fun control(message: DisplayMessage.Control, send: (JsonObject) -> Unit) {
        if (message.action == "acquire") send(DisplayWire.controlState(message.fence, message.sessionId, message.streamId,
            message.controlId, "refused", "released-by-owner"))
    }
    /** Coalesced on the owner lane, with no contents in the context or diagnostics. */
    fun editingChanged() {
        editing.invalidate()
        if (editingQueued.compareAndSet(false, true)) executor.ownerInput {
            editingQueued.set(false)
            publishEditing()
        }
    }
    private fun publishEditing() {
        val active = current ?: return
        if (active.request.sharedInput != 1 || active.request.editingVersion != 1 || active.generation < 1 || active.protected) return
        val context = device.readEditing { editing.context(active.sourceWidth, active.sourceHeight) }
        for (source in active.sources) {
            if (!admitted(active, source, true)) continue
            active.send(DisplayWire.editingContext(active.request.fence, active.request.streamId, (source as? DisplaySource.Task)?.sessionId,
                active.generation, context, source.takeIf { active.request.phoneOwnerControl == 1 }))
        }
    }

    private fun addressNegotiated(active: Active, sourceAddressed: Boolean): Boolean =
        sourceAddressed == (active.request.phoneOwnerControl == 1)

    /** Source liveness and the Host's current write projection are separate fences. */
    private fun admitted(active: Active, source: DisplaySource, touch: Boolean, power: Boolean = false): Boolean =
        current === active && source in active.sources && active.operations.displayUnavailable(source) == null &&
            (if (active.request.phoneOwnerControl == 1) source in active.inputSources else source is DisplaySource.Task) &&
            desk.ownerAdmission((source as? DisplaySource.Task)?.sessionId, touch, power)

    private fun power(message: DisplayMessage.Power) {
        val active = current ?: return
        if (active.request.phoneOwnerControl != 1) return
        if (message.sequence <= active.powerSequence) { active.send(DisplayWire.powerResult(message, false)); return }
        active.powerSequence = message.sequence
        fun apply() {
            var dispatched = false
            try {
                if (admitted(active, message.source, false, power = true)) {
                    if (message.action == "lock") {
                        // Lock is an ordered person-lane barrier, including any agent contact still on the display.
                        val released = java.util.concurrent.CompletableFuture<Unit>()
                        gestures.scheduler.cancel { released.complete(Unit) }
                        released.get(7, TimeUnit.SECONDS)
                        if (admitted(active, message.source, false, power = true))
                            dispatched = context.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN)
                    } else {
                        val budget = Budget(SystemClock::elapsedRealtime, SystemClock.elapsedRealtime() + 7000, Cancellation())
                        dispatched = device.wake(budget) { check(admitted(active, message.source, false, power = true)) } == Effect.DONE
                    }
                }
            } catch (_: Exception) { dispatched = false }
            active.send(DisplayWire.powerResult(message, dispatched))
            handler.post { if (current === active) reconcile() }
        }
        if (message.action == "lock") {
            // A lock that is already refused must not reset another holder's input.
            if (!admitted(active, message.source, false, power = true)) { active.send(DisplayWire.powerResult(message, false)); return }
            // Lane cleanup can wait on rejected cancellation strokes; the lock answers within its bound either way.
            val settled = java.util.concurrent.atomic.AtomicBoolean()
            val expired = Runnable { if (settled.compareAndSet(false, true)) active.send(DisplayWire.powerResult(message, false)) }
            handler.postDelayed(expired, LOCK_BARRIER_MS)
            personLane.reset { if (settled.compareAndSet(false, true)) { handler.removeCallbacks(expired); apply() } }
        } else executor.ownerInput { apply() }
    }

    private fun input(message: DisplayMessage.Input) {
        val active = current ?: return
        if (active.request.sharedInput != 1 || message.controlId != null || !addressNegotiated(active, message.sourceAddressed)) return
        fun receipt(result: OwnerEditing.Result) {
            result.clipboard?.let { clipboard ->
                active.send(DisplayWire.editingReply(message, "clipboard", "sequence" to jsonOf(message.sequence), "outcome" to jsonOf(clipboard.outcome),
                    *(clipboard.text?.let { arrayOf("text" to jsonOf(it)) } ?: emptyArray())))
            }
            active.send(DisplayWire.editingReply(message, "input-result", "sequence" to jsonOf(message.sequence), "outcome" to jsonOf(result.outcome),
                *(result.reason?.let { arrayOf("reason" to jsonOf(it)) } ?: emptyArray())))
        }
        if (active.request.streamId != message.streamId || !admitted(active, message.source, false)) { receipt(OwnerEditing.Result("refused", "unavailable")); return }
        val bytes = message.events.sumOf { event -> when (event) {
            is DisplayInput.Insert -> event.text.length * 2
            is DisplayInput.Paste -> event.text.length * 2
            is DisplayInput.Edit -> (event.text.length + event.before.length + event.after.length) * 2
            else -> 256
        } } + 256
        personLane.submit(active.input, message.sequence, message.geometry, active.generation, bytes, message.events.size,
            { reason -> receipt(OwnerEditing.Result(if (reason == "stale") "stale" else "refused", reason)) }) { valid ->
            if (message.events.count { it is DisplayInput.Copy || it is DisplayInput.Cut } > 1) {
                receipt(OwnerEditing.Result("refused", "unsupported", OwnerEditing.Clipboard("refused"))); return@submit
            }
            fun allowed(touch: Boolean): Boolean = valid() && current === active && active.generation == message.geometry &&
                active.state == "live" && !active.protected &&
                admitted(active, message.source, touch) && valid()
            active.personSource = message.source
            fun point(x: Double, y: Double) = DisplayPoint((x * (active.sourceWidth - 1)).toInt(), (y * (active.sourceHeight - 1)).toInt())
            fun idle() {
                val done = java.util.concurrent.CompletableFuture<Unit>()
                gestures.scheduler.idle { done.complete(Unit) }
                done.get(7, TimeUnit.SECONDS)
            }
            var result = OwnerEditing.Result()
            var clipboardReported = false
            for (event in message.events) {
                if (!allowed(event !is DisplayInput.Nav)) { gestures.scheduler.cancel(producer = GestureScheduler.Producer.PERSON); result = OwnerEditing.Result("refused", "unavailable"); break }
                gestures.scheduler.traffic()
                fun admit(touch: Boolean = true) { check(allowed(touch)) { "Owner input authority ended" } }
                result = try {
                    when (event) {
                        is DisplayInput.Pointer -> {
                            val at = point(event.x, event.y)
                            when (event.phase) {
                                "down" -> {
                                    ownerFocusEditor = device.ownerEditorAt(at)
                                    val started = java.util.concurrent.CompletableFuture<Boolean>()
                                    gestures.scheduler.down(at, { allowed(true) }, onStarted = { started.complete(it) }, time = event.t.toLong())
                                    check(started.get(7, TimeUnit.SECONDS))
                                }
                                "move" -> gestures.scheduler.move(at, event.t.toLong())
                                "up" -> { gestures.scheduler.up(at, event.t.toLong()); idle() }
                                "cancel" -> { gestures.scheduler.cancel(producer = GestureScheduler.Producer.PERSON); idle(); ownerFocusEditor = null }
                            }
                            OwnerEditing.Result()
                        }
                        is DisplayInput.Nav -> {
                            idle(); ownerFocusEditor = null
                            if (device.navigate(Navigation.entries.first { it.wire == event.to }) { admit(false) }) OwnerEditing.Result() else OwnerEditing.Result("refused", "unsupported")
                        }
                        is DisplayInput.Scroll -> {
                            ownerFocusEditor = null
                            gestures.scheduler.scroll(point(event.x, event.y), -event.dx * (active.sourceWidth - 1), -event.dy * (active.sourceHeight - 1),
                                { allowed(true) }, DisplayPoint(active.sourceWidth, active.sourceHeight))
                            OwnerEditing.Result()
                        }
                        else -> {
                            idle()
                            val expected = ownerFocusEditor
                            ownerFocusEditor = null
                            val extended = event !is DisplayInput.Insert && event !is DisplayInput.Delete && event !is DisplayInput.Submit
                            if (extended && active.request.editingVersion != 1 || event is DisplayInput.Cut && active.request.displayCut != 1) OwnerEditing.Result("refused", "unsupported")
                            else device.personEdit { editing.dispatch(event, expected) { admit() } }
                        }
                    }
                } catch (error: Exception) {
                    android.util.Log.d("OpensteerDisplay", "Owner editing exception type=${error.javaClass.simpleName}")
                    // No uncertain operation is retried, including after an app or connection disappears.
                    OwnerEditing.Result("refused", if (allowed(true)) "unsupported" else "unavailable")
                }
                if (result.clipboard != null) {
                    clipboardReported = true;
                    if (active.request.editingVersion == 1) {
                        val clipboard = result.clipboard
                        active.send(DisplayWire.editingReply(message, "clipboard", "sequence" to jsonOf(message.sequence), "outcome" to jsonOf(clipboard.outcome),
                            *(clipboard.text?.let { arrayOf("text" to jsonOf(it)) } ?: emptyArray())))
                    }
                    result = result.copy(clipboard = null)
                }
                if (result.outcome != "dispatched") break
            }
            if (!clipboardReported && message.events.any { it is DisplayInput.Copy || it is DisplayInput.Cut } && result.outcome != "dispatched") result = result.copy(clipboard = OwnerEditing.Clipboard("refused"))
            receipt(result)
            publishEditing()
        }
    }

    private companion object {
        /** How the Host closes the data socket (`displayViewerCloseCodes`) when it ends a stream itself. */
        const val HOST_ENDED = 1000
        const val HOST_STOPPING = 1001
        const val AUTHORITY_ENDED = 4003
        const val LOCK_BARRIER_MS = 7_000L
    }
}
