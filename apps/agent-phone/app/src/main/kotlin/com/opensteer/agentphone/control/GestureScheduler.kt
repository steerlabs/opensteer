package com.opensteer.agentphone.control

interface GestureClock {
    fun now(): Long
    fun post(action: () -> Unit)
    fun after(ms: Long, action: () -> Unit)
}
data class GestureSegment(val points: List<DisplayPoint>, val durationMs: Long, val continuing: Boolean, val first: Boolean,
    val cancel: Boolean = false, val delayMs: Long = 0)

/** One serial scheduler owns both the contact and Android's completion chain. */
class GestureScheduler(private val clock: GestureClock, private val dispatch: (GestureSegment, (Boolean) -> Unit) -> Unit) {
    enum class Producer { AGENT, PERSON }
    enum class Result { DONE, INTERRUPTED, PERSON_CONTACT }
    private var producer = Producer.PERSON
    private var contact: Any? = null
    private val agentSegments = ArrayDeque<GestureSegment>()
    private var active = false
    private var inFlight = false
    private var endpoint = DisplayPoint(0, 0)
    private var endpointTime = 0L
    private var moved = false
    private var authority: () -> Boolean = { false }
    private val moves = ArrayList<Pair<DisplayPoint, Long>>()
    private var ending: Pair<DisplayPoint, Long>? = null
    private var cancelling = false
    private var trafficAt = 0L
    private var serial = 0L
    private var dispatchId = 0L
    private var flushScheduled = false
    private val cleaners = ArrayList<() -> Unit>()
    private val idleWaiters = ArrayList<() -> Unit>()
    private var completion: ((Boolean) -> Unit)? = null
    private var success = true
    private var started: ((Boolean) -> Unit)? = null
    private var releaseHold = 0L
    private data class Scroll(val from: DisplayPoint, var dx: Double, var dy: Double, val allowed: () -> Boolean, val bounds: DisplayPoint)
    private var scroll: Scroll? = null

    fun down(point: DisplayPoint, allowed: () -> Boolean, watchdog: Boolean = true, holdMs: Long = 1,
        done: ((Boolean) -> Unit)? = null, onStarted: ((Boolean) -> Unit)? = null, time: Long? = null,
        producer: Producer = Producer.PERSON, contact: Any? = null, contended: () -> Unit = {}) = clock.post {
        fun start() {
            if (active || inFlight || !runCatching(allowed).getOrDefault(false)) {
                if (producer == Producer.AGENT && this.producer == Producer.PERSON && active) contended()
                onStarted?.invoke(false); done?.invoke(false); return
            }
            begin(point, allowed, time ?: clock.now(), producer, contact)
            completion = done; started = onStarted
            emit(GestureSegment(listOf(point), holdMs.coerceAtLeast(1), true, true))
            if (watchdog) watch(serial)
        }
        if (producer == Producer.PERSON && active && this.producer == Producer.AGENT) cancel { start() }
        else start()
    }
    /**
     * Whole agent gestures share the continued-contact coordinator, including taps and swipes.
     * `admit` decides the whole gesture once; `authority` is asked again before each later stroke,
     * such as a double tap's second, and needs no time beyond what is left of the gesture.
     */
    fun agent(segments: List<GestureSegment>, admit: () -> Unit, done: (Result) -> Unit, refused: (Exception) -> Unit = { throw it },
        authority: () -> Boolean = { true }) = clock.post {
        if (active || inFlight) { done(if (producer == Producer.PERSON) Result.PERSON_CONTACT else Result.INTERRUPTED); return@post }
        try { admit() } catch (error: Exception) { refused(error); return@post }
        val first = segments.first()
        begin(first.points.first(), authority, clock.now(), Producer.AGENT)
        completion = { done(if (it) Result.DONE else Result.INTERRUPTED) }
        agentSegments.addAll(segments.drop(1))
        emit(first)
    }
    private fun begin(point: DisplayPoint, allowed: () -> Boolean, time: Long, producer: Producer = Producer.PERSON, contact: Any? = null) {
        this.producer = producer; this.contact = contact
        serial++; active = true; authority = allowed; endpoint = point; endpointTime = time; moved = false; trafficAt = clock.now(); success = true
    }
    fun traffic() = clock.post { trafficAt = clock.now() }
    fun move(point: DisplayPoint, time: Long? = null, producer: Producer = Producer.PERSON, contact: Any? = null) = clock.post {
        if (!owns(producer, contact) || ending != null || cancelling) return@post
        trafficAt = clock.now()
        if (moves.size == 64) moves.removeAt(0)
        val at = time ?: clock.now()
        if (!moved && point != endpoint) { endpointTime = maxOf(endpointTime, at - 32); moved = true }
        moves += point to at
        scheduleFlush()
    }
    fun up(point: DisplayPoint, time: Long? = null, producer: Producer = Producer.PERSON, contact: Any? = null) = clock.post {
        if (!owns(producer, contact)) return@post
        trafficAt = clock.now(); ending = point to (time ?: clock.now())
        pump()
    }
    fun idle(done: () -> Unit) = clock.post { if (!active && !inFlight) done() else idleWaiters += done }
    private fun owns(producer: Producer, contact: Any?) = active && this.producer == producer && this.contact === contact
    fun cancel(producer: Producer? = null, contact: Any? = null, done: () -> Unit = {}) = clock.post {
        if (producer != Producer.AGENT) scroll = null
        if (producer != null && (!active || this.producer != producer || contact != null && this.contact !== contact)) { done(); return@post }
        if (!active && !inFlight) { done(); return@post }
        cleaners += done; success = false; cancelling = true; moves.clear(); ending = null; agentSegments.clear()
        pump()
    }
    /** Small wheel deltas share one swipe; deltas arriving during it survive for the next swipe. */
    fun scroll(from: DisplayPoint, dx: Double, dy: Double, allowed: () -> Boolean, bounds: DisplayPoint = DisplayPoint(Int.MAX_VALUE, Int.MAX_VALUE)) = clock.post {
        val pending = scroll
        if (pending == null) scroll = Scroll(from, dx, dy, allowed, bounds) else { pending.dx += dx; pending.dy += dy }
        startScroll()
    }
    private fun startScroll() {
        if (active || inFlight) return
        val pending = scroll ?: return
        if (!runCatching(pending.allowed).getOrDefault(false)) { scroll = null; return }
        if (kotlin.math.hypot(pending.dx, pending.dy) < 8) return
        val to = DisplayPoint((pending.from.x + pending.dx).toInt().coerceIn(0, pending.bounds.x - 1),
            (pending.from.y + pending.dy).toInt().coerceIn(0, pending.bounds.y - 1))
        pending.dx -= to.x - pending.from.x; pending.dy -= to.y - pending.from.y
        scroll = if (to == pending.from) null else pending
        if (to == pending.from) return
        begin(pending.from, pending.allowed, clock.now())
        ending = to to (endpointTime + 300)
        releaseHold = 100
        emit(GestureSegment(listOf(pending.from, to), 300, true, true))
        endpointTime += 300
    }
    private fun scheduleFlush() {
        if (flushScheduled) return
        flushScheduled = true
        val expected = serial
        clock.after(32) { if (serial == expected) { flushScheduled = false; pump() } }
    }
    private fun watch(expected: Long) {
        // The wire has no keepalive while still: allow long-press-then-drag, but bound a stranded contact.
        val delay = (5000 - (clock.now() - trafficAt)).coerceAtLeast(1)
        clock.after(delay) {
            if (!active || serial != expected) return@after
            if (clock.now() - trafficAt >= 5000) { success = false; cancelling = true; moves.clear(); pump() }
            else watch(expected)
        }
    }
    private fun pump() {
        if (inFlight || !active) return
        if (!runCatching(authority).getOrDefault(false)) { success = false; cancelling = true; moves.clear() }
        if (cancelling) {
            // A fresh off-display stroke cancels Android's continued contact, without an UP on its target.
            emit(GestureSegment(listOf(DisplayPoint(100000, 100000)), 1, false, true, cancel = true))
        } else if (ending != null || !flushScheduled && moves.isNotEmpty()) {
            val end = ending
            val pending = moves.toList() + listOfNotNull(end)
            moves.clear()
            val points = listOf(endpoint) + pending.map { it.first }.filterIndexed { i, p -> i != pending.lastIndex || p != endpoint || pending.size > 1 }
            val time = pending.last().second
            val moving = points.any { it != endpoint }
            val duration = if (moving) (time - endpointTime).coerceAtLeast(32) else releaseHold.coerceAtLeast(1)
            endpointTime = time
            if (moving || end != null) emit(GestureSegment(points.ifEmpty { listOf(endpoint) }, duration, end == null, false))
        }
    }
    private fun emit(segment: GestureSegment) {
        inFlight = true
        val expected = ++dispatchId
        endpoint = segment.points.last()
        fun answer(ok: Boolean) = clock.post {
            if (!inFlight || expected != dispatchId) return@post
            inFlight = false
            success = success && ok
            if (!ok) {
                cancelling = true; moves.clear(); ending = null; agentSegments.clear()
                // Never acknowledge cleanup until Android has completed a release-only stroke.
                if (segment.cancel) clock.after(1000) { pump() } else pump()
            } else if (cancelling && !segment.cancel) pump()
            else if (!segment.continuing) {
                if (agentSegments.isEmpty()) finish()
                else if (runCatching(authority).getOrDefault(false)) emit(agentSegments.removeFirst())
                else { success = false; finish() }
            }
            else {
                if (segment.first) { val callback = started; started = null; callback?.invoke(true) }
                pump()
            }
        }
        try { dispatch(segment, ::answer) } catch (_: Exception) { answer(false) }
    }
    private fun finish() {
        active = false; moves.clear(); ending = null; cancelling = false; flushScheduled = false; releaseHold = 0; agentSegments.clear(); contact = null
        started?.invoke(false); started = null
        val answer = completion; completion = null
        answer?.invoke(success)
        val callbacks = cleaners.toList(); cleaners.clear(); callbacks.forEach { it() }
        startScroll()
        if (!active) { val waiters = idleWaiters.toList(); idleWaiters.clear(); waiters.forEach { it() } }
    }
}
