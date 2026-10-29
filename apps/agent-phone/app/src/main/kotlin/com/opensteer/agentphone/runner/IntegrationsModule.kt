package com.opensteer.agentphone.runner

import com.opensteer.agentphone.wire.ActParams
import com.opensteer.agentphone.wire.AndroidPhoneWire
import com.opensteer.agentphone.wire.ComputerUseErrorCode
import com.opensteer.agentphone.wire.ComputerUseOutcome
import com.opensteer.agentphone.wire.InstalledAppsParams
import com.opensteer.agentphone.wire.IntegrationsMessage
import com.opensteer.agentphone.wire.IntegrationsWire
import com.opensteer.agentphone.wire.LoginDispatch
import com.opensteer.agentphone.wire.LoginTextReceiver
import com.opensteer.agentphone.wire.OperationStatus
import com.opensteer.agentphone.wire.PhoneOperation
import com.opensteer.agentphone.wire.PhoneStatus
import com.opensteer.agentphone.wire.WireException
import java.util.concurrent.ConcurrentHashMap

/** One computer-use operation, its parameters already read. */
sealed interface PhoneRequest {
    val operation: PhoneOperation

    data class Observe(val includeScreenshot: Boolean) : PhoneRequest {
        override val operation get() = PhoneOperation.OBSERVE
    }

    data class Act(val params: ActParams) : PhoneRequest {
        override val operation get() = PhoneOperation.ACT
    }

    data object Close : PhoneRequest {
        override val operation get() = PhoneOperation.CLOSE
    }

    data class InstalledApps(val params: InstalledAppsParams) : PhoneRequest {
        override val operation get() = PhoneOperation.INSTALLED_APPS
    }
}

/**
 * One request as the phone runs it. `deadline` is on the phone's monotonic
 * clock: when the frame arrived plus the `timeoutMs` the Host gave it, the
 * whole of the time the phone has, queueing included.
 */
data class PhoneCall(
    val requestId: String,
    val sessionId: String,
    val runId: String,
    val threadTitle: String?,
    val request: PhoneRequest,
    val deadline: Long,
    val loginDispatch: LoginDispatch? = null,
)

/** Work started on the phone, which a cancel asks to stop at its next safe point. */
fun interface PhoneWork {
    fun cancel()
}

/** The phone's hands, as the module reaches them. */
interface PhoneOperations {
    /** Starts one operation. `done` is called exactly once, on the runtime thread. */
    fun run(call: PhoneCall, done: (ComputerUseOutcome) -> Unit): PhoneWork

    fun runView(message: IntegrationsMessage.ComputerView, receivedAt: Long, done: (ComputerUseOutcome) -> Unit): PhoneWork

    fun displayUnavailable(source: com.opensteer.agentphone.wire.DisplaySource): String?
    fun displayDeadline(sources: List<com.opensteer.agentphone.wire.DisplaySource>): Long?

    /** The stream ended: no session outlives the connection whose Host held it. */
    fun releaseSessions()
}

/**
 * This phone's `integrations` module: everything on its stream after the
 * welcome. It plays the Node Runner's `ComputerAppModuleHandler`
 * (`apps/runner/src/computer-apps/module-handler.ts`) for a computer whose
 * only app is its own screen.
 *
 * It runs on the runtime thread alone. A slot is held by the work, not by the
 * request: a cancelled act is answered at once, but its slot comes back only
 * when the phone has actually stopped, so cancels can never stack work up.
 * Detaching forgets every request, so work begun for one stream is never
 * answered on the next.
 *
 * The owner's Stops are the exception: each is retained until the Host
 * acknowledges that exact Stop after recording it durably. An unrelated
 * Host frame says nothing about whether the Stop reached it. They are kept
 * in `stops` on disk as well, before they are reported, so the module built
 * after a restart reports them again; a write the disk refused is tried
 * again on the next Stop, stream and status until it is kept.
 *
 * The module is its identity's: the Runs its owner stopped are refused here,
 * and a new pairing's module refuses none of them.
 */
class IntegrationsModule(
    private val outbox: StreamOutbox,
    private val phone: PhoneOperations,
    private val stops: StopJournal,
    private val paused: () -> Boolean,
    private val log: (String) -> Unit,
    private val display: (com.opensteer.agentphone.wire.DisplayMessage) -> Unit = {},
    private val displayAvailable: () -> Boolean = { false },
    private val displayLost: () -> Unit = {},
) {
    private class InFlight(val operation: PhoneOperation) {
        var work: PhoneWork? = null
    }

    private val inFlight = HashMap<String, InFlight>()
    private val viewInFlight = HashMap<String, InFlight>()

    /** Stopped sessions and Runs the Host has not acknowledged recording, in the order they stopped. */
    private val unreported = LinkedHashMap<String, String>().apply {
        for (stop in stops.load()) put(stop.sessionId, stop.runId)
    }

    /** Whether `unreported` is on disk as it is now. */
    private var kept = true

    /**
     * Every Run this identity's owner stopped, refused under any session: the
     * ones kept from before a restart, then each Stop as it is accepted. Read
     * from the executor's threads.
     */
    private val refused: MutableSet<String> = ConcurrentHashMap.newKeySet<String>().apply { addAll(unreported.values) }

    fun refuses(runId: String): Boolean = runId in refused

    /** Of those, the ones sent on the attached stream. */
    private val sent = HashSet<String>()
    private var executing = 0
    private var lastStatus: List<OperationStatus>? = null

    private var loginReceiver: LoginTextReceiver? = null
    private var hostClock: HostClock? = null

    fun attach(stream: ModuleStream, loginText: Boolean = false, hostClock: HostClock? = null) {
        detach()
        if (loginText) {
            val clock = requireNotNull(hostClock)
            loginReceiver = LoginTextReceiver.generate(stream.fence.auxiliaryStreamId, stream.fence.fence.connectionGeneration, clock::now)
            this.hostClock = clock
        }
        outbox.attach(stream)
        refreshStatus()
        reportStops()
    }

    fun detach() {
        loginReceiver?.invalidate()
        loginReceiver = null
        hostClock = null
        if (outbox.attached == null) return
        displayLost()
        outbox.detach()
        lastStatus = null
        // Sent on a stream that is gone, they may never have arrived: the next stream carries them again.
        sent.clear()
        for (entry in inFlight.values) entry.work?.cancel()
        for (entry in viewInFlight.values) entry.work?.cancel()
        viewInFlight.clear()
        inFlight.clear()
        phone.releaseSessions()
    }

    /** Sends the status when it differs from the last one this stream was told; also when a Stop still waits for the disk. */
    fun refreshStatus() {
        if (!kept) keep()
        val status = PhoneStatus.operations(paused())
        if (status == lastStatus) return
        if (outbox.send { IntegrationsWire.status(it, status, displayAvailable(), loginReceiver?.key) }) lastStatus = status
    }

    fun sessionStopped(sessionId: String, runId: String) {
        refused += runId
        if (unreported.put(sessionId, runId) != runId || !kept) keep()
        reportStops()
    }

    /** Writes what is unrecorded to disk, saying when the disk refuses it and when it takes it again. */
    private fun keep() {
        val written = stops.save(unreported.map { (sessionId, runId) -> PendingStop(sessionId, runId) })
        if (written != kept) {
            log(if (written) "The owner's Stops are kept on disk again." else "The owner's Stops could not be written to disk; trying again.")
        }
        kept = written
    }

    private fun reportStops() {
        for ((sessionId, runId) in unreported) {
            if (sessionId !in sent && outbox.send { IntegrationsWire.computerUseStopped(it, sessionId, runId) }) sent += sessionId
        }
    }

    /** `receivedAt` is when the frame arrived, on the phone's monotonic clock. */
    fun handle(message: IntegrationsMessage, receivedAt: Long) {
        when (message) {
            is com.opensteer.agentphone.wire.DisplayMessage -> display(message)
            is IntegrationsMessage.Invoke -> outbox.send { IntegrationsWire.invokeUnsupported(it, message.requestId) }
            is IntegrationsMessage.ComputerView -> computerView(message, receivedAt)
            is IntegrationsMessage.ComputerUse -> computerUse(message, receivedAt)
            is IntegrationsMessage.Cancel -> cancel(message.requestId)
            is IntegrationsMessage.StopRecorded -> {
                if (unreported[message.sessionId] == message.runId) {
                    unreported.remove(message.sessionId)
                    sent.remove(message.sessionId)
                    keep()
                }
            }
            is IntegrationsMessage.McpOpen -> outbox.send { IntegrationsWire.mcpUnapproved(it, message.sessionId) }
            // No MCP session was ever opened here, so there is nothing to carry or close.
            is IntegrationsMessage.McpMessage, is IntegrationsMessage.McpClose -> Unit
        }
    }

    private fun computerView(message: IntegrationsMessage.ComputerView, receivedAt: Long) {
        if (outbox.attached == null || inFlight.containsKey(message.requestId) || viewInFlight.containsKey(message.requestId)) return
        val entry = InFlight(PhoneOperation.CLOSE)
        viewInFlight[message.requestId] = entry
        entry.work = phone.runView(message, receivedAt) { outcome ->
            if (viewInFlight[message.requestId] === entry) {
                viewInFlight.remove(message.requestId)
                outbox.send { fence ->
                    val frame = IntegrationsWire.computerViewResult(fence, message.requestId, outcome)
                    if (IntegrationsWire.fits(frame)) frame else IntegrationsWire.computerViewResult(fence, message.requestId, refusal(ComputerUseErrorCode.FAILED, "The picture was too large."))
                }
            }
        }
    }

    private fun computerUse(message: IntegrationsMessage.ComputerUse, receivedAt: Long) {
        if (outbox.attached == null) return
        if (inFlight.containsKey(message.requestId)) {
            log("Ignoring a duplicate computer use request ${message.requestId}")
            return
        }
        if (message.definitionId == null) {
            return answer(message.requestId, PhoneOperation.OBSERVE, refusal(ComputerUseErrorCode.UNSUPPORTED, MAC_FRAME))
        }
        val request = try {
            read(message)
        } catch (error: WireException) {
            // The frame itself was the Host's to send; only this request's parameters are unreadable.
            return answer(
                message.requestId,
                PhoneOperation.OBSERVE,
                refusal(ComputerUseErrorCode.FAILED, "This phone could not read the request: ${error.message}".take(MAX_MESSAGE_LENGTH)),
            )
        }
        val operation = request.operation
        if (operation == PhoneOperation.ACT && message.access != "read-write") {
            return answer(message.requestId, operation, refusal(ComputerUseErrorCode.PERMISSION_REQUIRED, READ_ONLY))
        }
        if (occupiesSlot(operation) && executing >= IntegrationsWire.MAX_CONCURRENT) {
            return answer(message.requestId, operation, refusal(ComputerUseErrorCode.FAILED, CAPACITY))
        }
        if (occupiesSlot(operation)) executing += 1
        val entry = InFlight(operation)
        inFlight[message.requestId] = entry
        val dispatch = loginReceiver?.let { receiver ->
            LoginDispatch(receiver, message.runId, message.sessionId, message.requestId, requireNotNull(hostClock).host(receivedAt + message.timeoutMs))
        }
        val call = PhoneCall(message.requestId, message.sessionId, message.runId, message.threadTitle, request, receivedAt + message.timeoutMs, dispatch)
        entry.work = phone.run(call) { outcome ->
            if (occupiesSlot(operation)) executing -= 1
            if (inFlight[message.requestId] === entry) {
                inFlight.remove(message.requestId)
                answer(message.requestId, operation, outcome)
            }
        }
    }

    private fun read(message: IntegrationsMessage.ComputerUse): PhoneRequest = when (message.operation) {
        "observe" -> PhoneRequest.Observe(AndroidPhoneWire.decodeObserveParams(message.params))
        "act" -> PhoneRequest.Act(AndroidPhoneWire.decodeActParams(message.params).also { params ->
            val context = params.loginContext
            if (context != null && (context.runId != message.runId || context.actId != message.requestId)) {
                throw WireException("Saved login text does not match the authenticated dispatch.")
            }
        })
        "close" -> PhoneRequest.Close.also { AndroidPhoneWire.decodeEmptyParams(message.params) }
        "installed_apps" -> PhoneRequest.InstalledApps(AndroidPhoneWire.decodeInstalledAppsParams(message.params))
        else -> throw WireException("${message.operation} is not an Android phone operation")
    }

    /**
     * A cancel is answered at once: the Host has already answered its caller.
     * An act may have done part of its work, so it is never called a failure
     * anyone would repeat.
     */
    private fun cancel(requestId: String) {
        val view = viewInFlight.remove(requestId)
        if (view != null) {
            view.work?.cancel()
            outbox.send { IntegrationsWire.computerViewResult(it, requestId, refusal(ComputerUseErrorCode.FAILED, "The request was cancelled.")) }
            return
        }
        val entry = inFlight.remove(requestId) ?: return
        entry.work?.cancel()
        answer(
            requestId,
            entry.operation,
            if (entry.operation == PhoneOperation.ACT) {
                refusal(ComputerUseErrorCode.OUTCOME_UNKNOWN, "The actions may already have taken effect.")
            } else {
                refusal(ComputerUseErrorCode.FAILED, "The request was cancelled.")
            },
        )
    }

    /**
     * Sends one answer. An answer the stream cannot carry is replaced by what
     * an agent can do about it: an act may have happened whatever its
     * observation weighed, and a look can be asked for again.
     */
    private fun answer(requestId: String, operation: PhoneOperation, outcome: ComputerUseOutcome) {
        val sent = outbox.send { fence ->
            val frame = IntegrationsWire.computerUseResult(fence, requestId, outcome)
            if (IntegrationsWire.fits(frame)) {
                frame
            } else {
                val replacement = when (operation) {
                    PhoneOperation.ACT -> refusal(
                        ComputerUseErrorCode.OUTCOME_UNKNOWN,
                        "The observation after these actions was too large to return.",
                    )
                    PhoneOperation.OBSERVE -> refusal(ComputerUseErrorCode.FAILED, "The observation was too large; observe again.")
                    else -> refusal(ComputerUseErrorCode.FAILED, "The phone's answer was too large to return.")
                }
                IntegrationsWire.computerUseResult(fence, requestId, replacement)
            }
        }
        if (!sent) log("A computer use answer for $requestId found its stream gone")
    }

    private fun refusal(code: ComputerUseErrorCode, message: String) = ComputerUseOutcome.Failure(code, message)

    /** `close` gives the phone back and `capture` has its own cap, so neither waits behind work. */
    private fun occupiesSlot(operation: PhoneOperation) = operation != PhoneOperation.CLOSE

    private companion object {
        /** `ComputerUseErrorSchema`'s limit on a refusal's sentence. */
        const val MAX_MESSAGE_LENGTH = 1_000
        const val MAC_FRAME = "This is an Android phone; it has no Mac apps to operate."
        const val READ_ONLY = "This task may look at the phone but not operate it."
        // Not `busy`: that says another task holds the phone, and the Host tells the model so.
        const val CAPACITY = "The phone is already handling as many requests as it can; try again when one finishes."
    }
}
