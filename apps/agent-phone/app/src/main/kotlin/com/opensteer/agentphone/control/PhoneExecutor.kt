package com.opensteer.agentphone.control

import com.opensteer.agentphone.runner.PhoneCall
import com.opensteer.agentphone.runner.PhoneOperations
import com.opensteer.agentphone.runner.PhoneRequest
import com.opensteer.agentphone.runner.PhoneWork
import com.opensteer.agentphone.wire.ComputerUseErrorCode
import com.opensteer.agentphone.wire.ComputerUseOutcome
import com.opensteer.agentphone.wire.DisplaySource
import com.opensteer.agentphone.wire.IntegrationsMessage
import com.opensteer.agentphone.wire.IsoTime
import com.opensteer.agentphone.wire.JsonNull
import com.opensteer.agentphone.wire.JsonObject
import com.opensteer.agentphone.wire.jsonObject
import com.opensteer.agentphone.wire.jsonOf
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** An alarm that has not gone off yet, and can be stopped from going off. */
fun interface Alarm {
    fun cancel()
}

/** Alarms on the phone's monotonic clock: `action` runs once `time` is reached, unless its alarm is cancelled first. */
fun interface AlarmClock {
    fun at(time: Long, action: () -> Unit): Alarm
}

/**
 * The phone's alarm clock: one thread, waiting by the same monotonic clock the
 * deadlines are measured on. A cancelled alarm leaves its queue at once, so it
 * holds nothing of the request it was for.
 */
class MonotonicAlarms(private val elapsed: () -> Long) : AlarmClock {
    private val scheduler = ScheduledThreadPoolExecutor(1) { Thread(it, "opensteer-deadlines") }.apply { removeOnCancelPolicy = true }

    override fun at(time: Long, action: () -> Unit): Alarm {
        val scheduled = scheduler.schedule(action, (time - elapsed()).coerceAtLeast(0), TimeUnit.MILLISECONDS)
        return Alarm { scheduled.cancel(false) }
    }

    fun shutdown() {
        scheduler.shutdownNow()
    }
}

/**
 * Runs the desk's work off the runtime thread: observe, act and close one at
 * a time on one thread, the app list on another, and every
 * answer posted back to the runtime thread.
 *
 * Every request runs on its deadline, on the phone's monotonic clock. Work
 * still queued when its time runs out is answered then, by an alarm, while
 * whatever is ahead of it keeps running, because that is when the Host stops
 * waiting; it never runs afterwards. Work that starts spends what is left,
 * less the reply reserve. Whichever comes first — its turn, its deadline or
 * the Host's cancel — claims a request and answers it, and nothing else does.
 *
 * A close is answered the moment it arrives: it withdraws the session's
 * authority there and then, so its session is unusable from that moment, and
 * the cleanup that lets go of the phone follows in turn.
 *
 * The owner's Stop and Pause withdraw authority the same way, with their own
 * reason, from everything already running or queued: a resume cannot revive
 * what a pause stopped. Both end the session holding the phone and stop its
 * Run there for good, reported through one path.
 */
class PhoneExecutor(
    private val desk: PhoneDesk,
    private val elapsed: () -> Long,
    private val alarms: AlarmClock,
    private val post: (() -> Unit) -> Unit,
    private val log: (String) -> Unit,
    private val cleanupGestures: (() -> Unit) -> Unit = { it() },
) {
    private val work = PhoneTurns()
    private val ownerInputs = Executors.newSingleThreadExecutor { Thread(it, "opensteer-owner-input") }
    private val reads: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "opensteer-reads") }
    private data class Pending(val owner: Owner, val request: PhoneRequest)
    private val pending = HashMap<String, MutableMap<Cancellation, Pending>>()

    /** One identity's module, captured by its operations facade rather than looked up when a Stop arrives. */
    private class Owner(val stopped: (ActiveSession) -> Unit, val authorityChanged: () -> Unit) { val views = OwnerViewLeases() }

    /** Published before the desk can publish its holder; replaced only by work on the serial executor. */
    private class Holding(val session: ActiveSession, val owner: Owner)

    @Volatile
    private var holding: Holding? = null

    /** Work and teardown from one module retain that module's identity even after the runtime replaces it. */
    fun forOwner(authorityChanged: () -> Unit = {}, stopped: (ActiveSession) -> Unit): PhoneOperations {
        val owner = Owner(stopped, authorityChanged)
        return object : PhoneOperations {
            override fun run(call: PhoneCall, done: (ComputerUseOutcome) -> Unit): PhoneWork = this@PhoneExecutor.run(owner, call, done)

            override fun runView(message: IntegrationsMessage.ComputerView, receivedAt: Long, done: (ComputerUseOutcome) -> Unit): PhoneWork = this@PhoneExecutor.runView(owner, message, receivedAt, done)

            override fun displayUnavailable(source: DisplaySource): String? = when (source) {
                is DisplaySource.Task -> if (holder()?.let { it.owner === owner && it.session.id == source.sessionId } == true && desk.displayTaskLive(source.sessionId)) null else "session-ended"
                is DisplaySource.Owner -> owner.views.unavailable(source.viewId, source.generation, "main", elapsed())?.let { if (it == "expired") "owner-expired" else "owner-ended" }
            }
            override fun displayDeadline(sources: List<DisplaySource>): Long? = sources.filterIsInstance<DisplaySource.Owner>().mapNotNull { owner.views.deadline(it.viewId, it.generation) }.minOrNull()

            override fun releaseSessions() = this@PhoneExecutor.releaseSessions(owner)
        }
    }

    private fun runView(owner: Owner, message: IntegrationsMessage.ComputerView, receivedAt: Long, done: (ComputerUseOutcome) -> Unit): PhoneWork {
        val cancel = Cancellation()
        val budget = Budget(elapsed, receivedAt + message.timeoutMs - REPLY_RESERVE_MS, cancel)
        val generation = message.generation
        val id = message.viewId
        val display = message.display
        val duration = message.leaseDurationMs.coerceAtMost(180_000)
        val expires = receivedAt + duration
        fun ended() = ComputerUseOutcome.Ok(jsonObject(
            "viewId" to jsonOf(id), "generation" to jsonOf(generation),
            "kind" to jsonOf("unavailable"), "reason" to jsonOf("ended"),
        ))
        fun busy() = ComputerUseOutcome.Ok(jsonObject(
            "viewId" to jsonOf(id), "generation" to jsonOf(generation),
            "kind" to jsonOf("unavailable"), "reason" to jsonOf("busy"),
        ))
        fun state(closed: Boolean = false) = ComputerUseOutcome.Ok(jsonObject(
            "viewId" to jsonOf(id), "generation" to jsonOf(generation),
            "state" to jsonOf(if (closed) "closed" else "ready"),
            "captureTargetId" to JsonNull,
        ))
        val valid = when {
            budget.expired -> false
            message.operation == "open" -> owner.views.open(id, generation, display, expires, elapsed())
            message.operation == "renew" -> owner.views.renew(id, generation, display, expires, elapsed())
            message.operation == "close" -> owner.views.close(id, generation)
            else -> false
        }
        owner.authorityChanged()
        post { done(if (budget.expired) busy() else if (valid) state(message.operation == "close") else ended()) }
        return PhoneWork {}
    }

    /** One request from its arrival to its one answer, given by whoever claims it first. */
    private inner class Ticket(val call: PhoneCall, val cancel: Cancellation, private val done: (ComputerUseOutcome) -> Unit) {
        private val claimed = AtomicBoolean(false)

        /** Its deadline's alarm, set before the work can start. */
        @Volatile
        var alarm: Alarm? = null

        fun claim(): Boolean = claimed.compareAndSet(false, true)

        fun answer(outcome: ComputerUseOutcome) {
            alarm?.cancel()
            synchronized(pending) {
                pending[call.sessionId]?.let {
                    it.remove(cancel)
                    if (it.isEmpty()) pending.remove(call.sessionId)
                }
            }
            post { done(outcome) }
        }
    }

    private fun run(owner: Owner, call: PhoneCall, done: (ComputerUseOutcome) -> Unit): PhoneWork {
        val cancel = Cancellation()
        val request = call.request
        if (request == PhoneRequest.Close) {
            // Authority is withdrawn now, even while the cleanup waits behind a
            // gesture; a late close stops only its own session.
            withdraw(owner, call.sessionId, Cancellation.Reason.CANCELLED)
            holder()?.takeIf { it.owner === owner && it.session.id == call.sessionId }
                ?.let { desk.withdraw(call.sessionId) }
            work.execute {
                val current = holder()
                if (current == null || current.owner === owner) desk.close(call.sessionId)
                if (desk.activeSession == null && holding?.owner === owner) holding = null
            }
            post { done(ComputerUseOutcome.Ok(JsonObject(emptyMap()))) }
            return PhoneWork {}
        }
        if (request is PhoneRequest.Act && desk.ownerInControl) {
            post { done(notStarted(Cancellation.Reason.OWNER_CONTROL)) }
            return PhoneWork {}
        }
        synchronized(pending) {
            // The app list belongs to no session, so nothing done to one stops it.
            if (request !is PhoneRequest.InstalledApps) pending.getOrPut(call.sessionId) { HashMap() }[cancel] = Pending(owner, request)
        }
        val ticket = Ticket(call, cancel, done)
        val budget = Budget(elapsed, call.deadline - REPLY_RESERVE_MS, cancel)
        val onReads = request is PhoneRequest.InstalledApps
        ticket.alarm = alarms.at(budget.until) {
            if (ticket.claim()) ticket.answer(ComputerUseOutcome.Failure(ComputerUseErrorCode.FAILED, EXPIRED))
        }
        val turn = { if (ticket.claim()) ticket.answer(start(owner, call, budget)) }
        if (onReads) reads.execute(turn) else work.android(turn)
        return PhoneWork {
            cancel.withdraw(Cancellation.Reason.CANCELLED)
            // Still waiting its turn, it never started, so it is answered and its slot given back now;
            // running, it stops at its next safe point and answers then.
            if (ticket.claim()) ticket.answer(notStarted(Cancellation.Reason.CANCELLED))
        }
    }

    /** Work that has claimed its turn; a withdrawal meanwhile, or the deadline reached this instant, still keeps it from running. */
    private fun start(owner: Owner, call: PhoneCall, budget: Budget): ComputerUseOutcome {
        budget.cancel.reason?.let { return notStarted(it) }
        if (budget.expired) return ComputerUseOutcome.Failure(ComputerUseErrorCode.FAILED, EXPIRED)
        return perform(owner, call, budget)
    }

    private fun notStarted(reason: Cancellation.Reason) = when (reason) {
        Cancellation.Reason.CANCELLED -> ComputerUseOutcome.Failure(ComputerUseErrorCode.FAILED, NOT_STARTED)
        Cancellation.Reason.STOPPED -> ComputerUseOutcome.Failure(ComputerUseErrorCode.STOPPED_BY_USER, PhoneDesk.STOPPED)
        Cancellation.Reason.PAUSED -> ComputerUseOutcome.Failure(ComputerUseErrorCode.STOPPED_BY_USER, PhoneDesk.PAUSED)
        Cancellation.Reason.OWNER_CONTROL -> ComputerUseOutcome.Failure(ComputerUseErrorCode.OWNER_IN_CONTROL, PhoneDesk.OWNER_CONTROL)
    }

    /** Withdraws every request of `sessionId`, or of every session, already running or still queued. */
    private fun withdraw(owner: Owner?, sessionId: String?, reason: Cancellation.Reason) {
        synchronized(pending) {
            val requests = if (sessionId == null) pending.values else listOf(pending[sessionId].orEmpty())
            for (session in requests) {
                for ((cancel, belonging) in session) if (owner == null || owner === belonging.owner) cancel.withdraw(reason)
            }
        }
    }

    /**
     * One operation, answered whatever happens to it: an exception on these
     * threads would end the whole app. Android stopping the accessibility
     * service mid-batch interrupts it, and an act cut short may already have
     * changed the phone.
     */
    private fun perform(owner: Owner, call: PhoneCall, budget: Budget): ComputerUseOutcome = try {
        val session = ActiveSession(call.sessionId, call.runId, call.threadTitle)
        val active = desk.activeSession
        val request = call.request
        if (request !is PhoneRequest.InstalledApps && active != null &&
            (holding?.owner !== owner || active.id == session.id && active.runId != session.runId)
        ) {
            ComputerUseOutcome.Failure(ComputerUseErrorCode.BUSY, "Another task is using this phone.")
        } else {
            // Busy requests cannot overwrite the owner of the current holder.
            if ((request is PhoneRequest.Observe || request is PhoneRequest.Act) &&
                (active == null || active.id == session.id && active.runId == session.runId)
            ) holding = Holding(session, owner)
            when (request) {
                is PhoneRequest.Observe -> desk.observe(session, request.includeScreenshot, budget)
                is PhoneRequest.Act -> desk.act(session, request.params, budget, call.loginDispatch)
                PhoneRequest.Close -> desk.close(call.sessionId)
                is PhoneRequest.InstalledApps -> desk.installedApps(request.params)
            }
        }
    } catch (interrupted: InterruptedException) {
        Thread.currentThread().interrupt()
        broken(call, "The phone stopped its runtime during this request.")
    } catch (error: Exception) {
        val saved = (call.request as? PhoneRequest.Act)?.params?.actions?.any {
            it is com.opensteer.agentphone.wire.PhoneAction.Type && it.text is com.opensteer.agentphone.wire.PhoneText.Saved
        } == true
        log(if (saved) "Computer use act failed while handling saved login text." else "Computer use ${call.request.operation.wire} failed: $error")
        broken(call, "The phone could not complete this request.")
    }

    private fun broken(call: PhoneCall, message: String) = ComputerUseOutcome.Failure(
        if (call.request is PhoneRequest.Act) ComputerUseErrorCode.OUTCOME_UNKNOWN else ComputerUseErrorCode.FAILED,
        message,
    )

    private fun releaseSessions(owner: Owner) {
        owner.views.clear()
        owner.authorityChanged()
        withdraw(owner, null, Cancellation.Reason.CANCELLED)
        work.execute {
            holder()?.takeIf { it.owner === owner }?.let {
                desk.endSession(it.session)
                holding = null
            }
        }
    }

    /** Withdraw only acts; queued observations remain useful while the owner has control. */
    fun takeOver(sessionId: String, done: () -> Unit) {
        synchronized(pending) {
            for ((cancel, entry) in pending[sessionId].orEmpty()) {
                if (entry.request is PhoneRequest.Act) cancel.withdraw(Cancellation.Reason.OWNER_CONTROL)
            }
        }
        controlBarrier(done)
    }

    fun controlBarrier(done: () -> Unit) = work.execute {
        desk.invalidateObservations()
        done()
    }

    fun ownerInput(action: () -> Unit) { ownerInputs.execute(action) }

    /** Projection consent and foreground restoration occupy one serial turn, with a bounded wait. */
    fun acquisition(action: () -> Unit) = work.android(action)

    /** The owner paused or resumed agents; a pause withdraws everything and ends the session holding the phone. */
    fun setPaused(paused: Boolean) {
        desk.paused = paused
        if (!paused) return
        val holder = holder()
        if (holder != null) accept(holder)
        withdraw(null, null, Cancellation.Reason.PAUSED)
        if (holder != null) endStopped(holder)
    }

    /** The owner stopped the session holding the phone; whatever it was doing stops at once. */
    fun stopSession(sessionId: String) {
        val holder = holder() ?: return
        if (holder.session.id != sessionId) return
        accept(holder)
        withdraw(holder.owner, sessionId, Cancellation.Reason.STOPPED)
        endStopped(holder)
    }

    /**
     * The owner's Stop of `accepted`, told first to the identity that admitted
     * its work — which refuses the Run from now on, keeps the Stop and reports
     * it — and then to the desk, so nothing collected meanwhile is shared.
     */
    private fun accept(accepted: Holding) {
        accepted.owner.stopped(accepted.session)
        desk.runStopped()
    }

    /** Captures the active holder together with the immutable module that admitted its work. */
    private fun holder(): Holding? {
        val active = desk.activeSession ?: return null
        val bound = holding ?: return null
        return if (bound.session.id == active.id && bound.session.runId == active.runId && desk.activeSession === active) {
            Holding(active, bound.owner)
        } else null
    }

    /**
     * Ends the holder an accepted Stop captured, in turn. Earlier Close or
     * detach cleanup may already be queued, so cleanup cannot decide whether
     * the Stop happened; it only ends this exact holder.
     */
    private fun endStopped(accepted: Holding) {
        work.afterCurrent {
            val current = holder()
            if (current?.owner === accepted.owner && current.session.id == accepted.session.id && current.session.runId == accepted.session.runId) {
                desk.endSession(current.session)
                holding = null
            }
        }
    }

    /** Interrupts whatever runs: every wait the desk makes is a sleep, which ends at once. */
    fun shutdown() {
        work.shutdownNow()
        reads.shutdownNow()
        ownerInputs.shutdownNow()
        work.awaitTermination(SHUTDOWN_WAIT_MS, TimeUnit.MILLISECONDS)
        reads.awaitTermination(SHUTDOWN_WAIT_MS, TimeUnit.MILLISECONDS)
        ownerInputs.awaitTermination(SHUTDOWN_WAIT_MS, TimeUnit.MILLISECONDS)
    }

    companion object {
        /**
         * Kept back from every request's time for its answer: building the
         * observation's frame, measuring it against the stream's 1 MiB and
         * handing it to the socket, which takes well under this on the
         * slowest phone the app supports. It is the phone's own share; the
         * Host waits 6 s past the same deadline for the answer to cross the
         * network, which no margin here could guarantee.
         */
        const val REPLY_RESERVE_MS = 1_000L
        const val EXPIRED = "The request expired before it ran."
        private const val NOT_STARTED = "The request was cancelled before it ran."
        private const val SHUTDOWN_WAIT_MS = 2_000L
    }
}
