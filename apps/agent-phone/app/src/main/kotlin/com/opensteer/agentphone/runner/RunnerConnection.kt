package com.opensteer.agentphone.runner

import com.opensteer.agentphone.wire.AuxiliaryFence
import com.opensteer.agentphone.wire.AuxiliaryHandshake
import com.opensteer.agentphone.wire.ConnectionState
import com.opensteer.agentphone.wire.HostMessage
import com.opensteer.agentphone.wire.HostTarget
import com.opensteer.agentphone.wire.IntegrationsMessage
import com.opensteer.agentphone.wire.IntegrationsWire
import com.opensteer.agentphone.wire.Issue
import com.opensteer.agentphone.wire.IssueCode
import com.opensteer.agentphone.wire.IsoTime
import com.opensteer.agentphone.wire.JsonObject
import com.opensteer.agentphone.wire.JsonText
import com.opensteer.agentphone.wire.ProtocolError
import com.opensteer.agentphone.wire.RunnerDescriptor
import com.opensteer.agentphone.wire.RunnerFence
import com.opensteer.agentphone.wire.RunnerWire
import com.opensteer.agentphone.wire.StreamFrame
import com.opensteer.agentphone.wire.WireException
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.Random
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** What the connection needs from the runtime that owns it. All calls arrive on the runtime thread. */
interface ConnectionOwner {
    /** The identity the connection now works for, or null for none; the owner builds its module and relay for it. */
    fun useIdentity(identity: PhoneIdentity?)

    /** The module for the identity last given to `useIdentity`. */
    val module: IntegrationsModule

    fun linkChanged(target: HostTarget?, connection: ConnectionState, issue: Issue?)

    /** Whether the connection is connecting, serving or backing off, which needs the CPU awake, or has given up until setup acts. */
    fun keepAwake(needed: Boolean)

    /** Called after every event the runtime thread handled, so the owner can publish what changed. */
    fun settled()
}

/**
 * What the connection keeps across restarts: the identity it works for, and
 * whether Opensteer removed this phone, which the phone keeps saying until it
 * is set up again. Setup writes the same record from another thread, so every
 * change is conditional on what is stored.
 */
interface PhoneRecord {
    /** Throws when the stored identity cannot be read. */
    fun load(): PhoneIdentity?

    /** Stores `next` only if `expected` is still stored: an unpairing in between wins. */
    fun replace(expected: PhoneIdentity, next: PhoneIdentity): Boolean

    /** Erases `expected` and its keys if it is still the stored identity, and remembers that Opensteer removed it. */
    fun removeIfCurrent(expected: PhoneIdentity): Boolean

    val removed: Boolean
}

/**
 * The runtime thread: this phone's one connection to its Host, and the only
 * thread that touches the module, the relay or the connection state.
 *
 * It holds a primary connection, where the phone's identity is proven, and
 * the `integrations` stream beside it, which a ticket from that connection
 * authorizes and which dies with it — the module-only Runner of
 * `packages/runner-client/src/module-connection.ts`, written as one loop:
 * challenge, enroll or authenticate, welcome, ticket, stream challenge,
 * stream welcome, modules report, then serving until either socket ends.
 * Every frame after a welcome carries that welcome's fence, every heartbeat
 * is stamped in the Host's time and strictly increasing, and a lease that
 * runs out locally ends the connection rather than stamping one more frame.
 *
 * Nothing the Host sends can end the thread: a frame this phone cannot read
 * ends that attempt as the Host's protocol violation, and any other failure
 * ends it as this phone's own, and either way the phone tries again. Only Stop
 * ends the thread. All of its timing is on `elapsed`, the phone's monotonic
 * clock, so a change of the wall clock moves no lease, timer or deadline.
 *
 * Other threads reach it only through `post`, `identityChanged` and `stop`.
 */
class RunnerConnection(
    private val sockets: WebSocket.Factory,
    private val discovery: HostDiscovery,
    private val record: PhoneRecord,
    private val runtimeVersion: String,
    private val owner: ConnectionOwner,
    private val elapsed: () -> Long,
    private val log: (String) -> Unit,
    private val deviceName: (() -> String)? = null,
    private val updater: PhoneUpdater? = null,
) {
    private sealed interface Event {
        class Task(val run: () -> Unit) : Event
        class Frame(val socket: Socket, val text: String, val receivedAt: Long) : Event
        class Binary(val socket: Socket) : Event
        class Closed(val socket: Socket, val code: Int) : Event
        class Failed(val socket: Socket, val detail: String) : Event
        data object IdentityChanged : Event
        data object Stop : Event
    }

    /** Thrown to leave an attempt that ended; `end` says how. */
    private class Ended(val end: AttemptEnd) : Exception(end.toString())

    /** Thrown to leave whatever the thread was doing for a reason that is not the connection's fault. */
    private class Interrupted(val stop: Boolean) : Exception()

    private inner class Socket(path: String, hostUrl: String) : WebSocketListener() {
        // OkHttp takes the HTTP origin and upgrades it, over TLS for https.
        val webSocket: WebSocket = sockets.newWebSocket(Request.Builder().url(hostUrl + path).build(), this)

        // A frame's time starts here, on OkHttp's reader thread: what it then
        // spends waiting for the runtime thread is part of its budget.
        override fun onMessage(webSocket: WebSocket, text: String) {
            inbox.put(Event.Frame(this, text, elapsed()))
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            inbox.put(Event.Binary(this))
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
            inbox.put(Event.Closed(this, code))
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val detail = response?.let { "HTTP ${it.code} from the Host" } ?: (t.message ?: t.javaClass.simpleName)
            inbox.put(Event.Failed(this, detail))
        }

        fun send(frame: JsonObject): Boolean = webSocket.send(JsonText.stringifyFrame(frame))

        fun close(code: Int, reason: String) {
            if (!webSocket.close(code, reason)) webSocket.cancel()
        }
    }

    private val inbox = LinkedBlockingQueue<Event>()
    private val policy = ConnectionPolicy(Random())
    private val bootId = "rbt_${UUID.randomUUID()}"
    private val thread = Thread(::run, "opensteer-runtime")

    /** The Host's clock on the primary connection. */
    val hostClock = HostClock(elapsed)
    private val streamClock = HostClock(elapsed)

    /** A pairing whose decision was final; it is not tried again until the stored identity changes. */
    private var halted: PhoneIdentity? = null

    /** The target the current attempt reports about, even if setup has already stored another. */
    private var activeTarget: HostTarget? = null

    /** Whether the Host welcomed this attempt, after which the phone counts as enrolled. */
    private var welcomed = false

    /** The identity and target the policy's history is about; another starts it over. */
    private var policyFor: Any? = null

    fun start() {
        thread.start()
    }

    /** Runs `task` on the runtime thread. */
    fun post(task: () -> Unit) {
        inbox.put(Event.Task(task))
    }

    /** A pairing or an unpairing changed the stored identity; the connection starts over from it. */
    fun identityChanged() {
        inbox.put(Event.IdentityChanged)
    }

    /** Ends the thread, closing whatever it has open; returns once it has. */
    fun stop() {
        inbox.put(Event.Stop)
        discovery.cancel()
        updater?.cancel()
        thread.join(STOP_WAIT_MS)
    }

    private fun run() {
        var failure: Exception? = null
        while (true) {
            try {
                val failed = failure
                if (failed != null) {
                    failure = null
                    recover(failed)
                }
                serveStoredIdentity()
            } catch (interrupted: Interrupted) {
                if (interrupted.stop) break
            } catch (error: Exception) {
                failure = error
            }
        }
        try {
            owner.useIdentity(null)
        } catch (error: Exception) {
            log("The runtime could not let go of its identity: $error")
        }
    }

    /**
     * A failure that is not the Host's doing — a Keystore that would not
     * answer, a fault of this app — is said and waited out like any other, and
     * the wait happens even if saying it fails, so nothing can spin.
     */
    private fun recover(error: Exception) {
        log("The runtime failed: $error")
        try {
            owner.linkChanged(activeTarget, ConnectionState.OFFLINE, Issue(IssueCode.FAILED, "This phone's connection failed; it is trying again."))
        } finally {
            waitFor(elapsed() + ConnectionPolicy.MAX_BACKOFF_MS)
        }
    }

    /** One turn of the loop: whatever the stored identity calls for, until it is done or changes. */
    private fun serveStoredIdentity() {
        val identity = try {
            record.load()
        } catch (error: Exception) {
            log("The stored identity could not be read: ${error.message}")
            activeTarget = null
            owner.useIdentity(null)
            owner.linkChanged(null, ConnectionState.OFFLINE, Issue(IssueCode.FAILED, "This phone could not read its saved identity."))
            return idle()
        }
        activeTarget = identity?.target
        owner.useIdentity(identity)
        if (identity == null) {
            owner.linkChanged(null, if (record.removed) ConnectionState.REMOVED else ConnectionState.UNPAIRED, null)
            return idle()
        }
        if (identity == halted) return idle()
        val stand = Triple(identity.runnerId, identity.enrollmentId, identity.target)
        if (stand != policyFor) {
            // A re-pair or a RETARGET: nothing learned about the previous Host applies.
            policy.reset()
            policyFor = stand
        }
        owner.keepAwake(true)
        welcomed = false
        var end = try {
            attempt(identity)
        } catch (ended: Ended) {
            ended.end
        } catch (interrupted: Interrupted) {
            if (interrupted.stop) throw interrupted
            // The stored identity changed underneath the attempt: start over from it.
            return
        } catch (unreadable: WireException) {
            if (unreadable.reason == "runner-proof-format-mismatch") AttemptEnd.Refused(ProtocolError("forbidden", unreadable.message.orEmpty(), unreadable.reason, false))
            else AttemptEnd.Violation("The Host sent a frame this phone cannot read: ${unreadable.message}")
        }
        if (end is AttemptEnd.Refused && end.error.reason == "agent-phone-outdated" && identity.enrolled) {
            updater?.check(identity, required = true)?.let { end = AttemptEnd.UpdateFailed(it) }
        }
        val enrolled = identity.enrolled || welcomed
        when (val decision = policy.next(end, enrolled, identity.deploymentName)) {
            is Decision.Stop -> {
                log("Connection stopped: ${decision.issue.code.wire}")
                if (decision.wipe) {
                    if (!record.removeIfCurrent(identity)) return
                    activeTarget = null
                    owner.useIdentity(null)
                    owner.linkChanged(null, ConnectionState.REMOVED, decision.issue)
                } else {
                    halted = record.load()
                    owner.linkChanged(identity.target, if (decision.issue.code == IssueCode.NEEDS_UPDATE) ConnectionState.NEEDS_UPDATE else if (enrolled) ConnectionState.OFFLINE else ConnectionState.PAIRING, decision.issue)
                }
                idle()
            }
            is Decision.Retry -> {
                val delay = policy.delayFor(decision)
                log("Connection ended (${end.javaClass.simpleName}); retrying in $delay ms")
                owner.linkChanged(identity.target, if (enrolled) ConnectionState.OFFLINE else ConnectionState.PAIRING, decision.issue)
                waitFor(elapsed() + delay)
            }
        }
    }

    /** Waits for the stored identity to change, doing posted work meanwhile. */
    private fun idle() {
        owner.keepAwake(false)
        while (true) {
            when (val event = inbox.take()) {
                Event.IdentityChanged -> {
                    halted = null
                    return
                }
                else -> handleIdle(event)
            }
        }
    }

    /** Waits out a backoff, doing posted work meanwhile; a changed identity is tried at once. */
    private fun waitFor(until: Long) {
        while (true) {
            val remaining = until - elapsed()
            if (remaining <= 0) return
            val event = inbox.poll(remaining, TimeUnit.MILLISECONDS) ?: return
            if (event == Event.IdentityChanged) {
                halted = null
                return
            }
            handleIdle(event)
        }
    }

    /** Outside an attempt only posted work and stopping mean anything; socket events are a closed socket's leftovers. */
    private fun handleIdle(event: Event) {
        when (event) {
            is Event.Task -> runTask(event)
            Event.Stop -> throw Interrupted(stop = true)
            else -> Unit
        }
    }

    private fun runTask(task: Event.Task) {
        try {
            task.run()
        } catch (error: Exception) {
            log("A runtime task failed: $error")
        } finally {
            owner.settled()
        }
    }

    private fun attempt(stored: PhoneIdentity): AttemptEnd {
        owner.linkChanged(
            stored.target,
            if (stored.enrolled) ConnectionState.CONNECTING else ConnectionState.PAIRING,
            policy.standing(stored.deploymentName),
        )
        // An address is used only once it has answered as this Deployment's
        // Host: before the one-use token is spent there, and after setup moved
        // an enrolled phone to it. The confirmation is stored, so a restart
        // does not ask again.
        val identity = if (stored.hostVerified) {
            stored
        } else {
            when (val result = discovery.check(stored)) {
                HostDiscovery.Result.Matches -> stored.confirmed().also { confirmed ->
                    if (!record.replace(stored, confirmed)) throw Interrupted(stop = false)
                    owner.useIdentity(confirmed)
                }
                is HostDiscovery.Result.Mismatch -> return AttemptEnd.HostMismatch(result.detail)
                is HostDiscovery.Result.Unreachable -> return AttemptEnd.Unreachable(result.detail)
            }
        }
        updater?.check(identity, required = false)?.let { throw Ended(AttemptEnd.UpdateFailed(it)) }
        val primary = Socket("/internal/v1/runners", identity.hostUrl)
        try {
            val welcome = authenticate(primary, identity)
            val fence = welcome.fence
            val lease = Lease(fence, hostClock.local(IsoTime.parse(welcome.connectionLeaseExpiresAt)))
            val ticket = requestTicket(primary, lease)
            val stream = Socket("/internal/v1/runners/auxiliary/${RunnerDescriptor.MODULE}", identity.hostUrl)
            try {
                val welcomed = Welcomed(primary, lease)
                val streamWelcome = openStream(stream, identity, ticket, fence, welcomed)
                val streamLease = Lease(streamWelcome.fence, streamClock.local(IsoTime.parse(streamWelcome.streamLeaseExpiresAt)))
                if (!primary.send(RunnerWire.modulesReport(current(lease), IsoTime.format(hostClock.now())))) {
                    return AttemptEnd.Closed(ABNORMAL_CLOSE, afterWelcome = true)
                }
                owner.module.attach(object : ModuleStream {
                    override val fence: AuxiliaryFence = streamWelcome.fence

                    override fun send(frame: JsonObject): Boolean =
                        !streamLease.expired(elapsed()) && stream.send(frame)
                }, loginText = streamWelcome.loginText, hostClock = hostClock)
                owner.linkChanged(identity.target, ConnectionState.ONLINE, null)
                owner.settled()
                return serve(welcomed, welcome.heartbeatIntervalMs, stream, streamLease, streamWelcome.heartbeatIntervalMs)
            } finally {
                owner.module.detach()
                stream.close(NORMAL_CLOSE, "integrations stream closed")
            }
        } finally {
            primary.close(NORMAL_CLOSE, "runner connection closed")
        }
    }

    /** The welcomed primary connection, which keeps speaking while the stream opens. */
    private inner class Welcomed(val socket: Socket, val lease: Lease<RunnerFence>) {
        /** Set once the Host renews the lease: proof the connection worked. */
        var renewed = false

        /** What a frame on the primary means once it is welcomed: a renewal, the Host's refusal, or a violation. */
        fun hear(text: String): AttemptEnd? = when (val message = RunnerWire.decodeHostMessage(bounded(text))) {
            is HostMessage.LeaseRenewed -> {
                renew(lease, message.fence, message.connectionLeaseExpiresAt)
                renewed = true
                null
            }
            is HostMessage.Error -> refusal(socket, message)
            else -> AttemptEnd.Violation("The Host sent a phone a message it has no use for.")
        }
    }

    private fun authenticate(primary: Socket, identity: PhoneIdentity): HostMessage.Welcome {
        val challenge = when (val first = RunnerWire.decodeHostMessage(nextFrame(primary).text)) {
            is HostMessage.Challenge -> first.challenge
            is HostMessage.Error -> throw Ended(refusal(primary, first))
            else -> throw Ended(AttemptEnd.Violation("The Host did not start the Runner handshake."))
        }
        // No local check of the challenge's expiry: the Host judges it by its
        // own clock, and this phone's may be off.
        val descriptor = RunnerDescriptor(bootId, deviceName?.invoke() ?: identity.runnerName, identity.runnerId, runtimeVersion, loginText = true, editing = true, displayCut = true, sharedInput = true)
        val proof = if (identity.enrolled) {
            RunnerWire.authenticate(challenge, descriptor, identity.runnerKey)
        } else {
            RunnerWire.enroll(challenge, descriptor, identity.runnerKey, requireNotNull(identity.enrollmentToken))
        }
        if (!primary.send(proof)) throw Ended(AttemptEnd.Closed(ABNORMAL_CLOSE, afterWelcome = false))
        val frame = nextFrame(primary)
        val welcome = when (val answer = RunnerWire.decodeHostMessage(frame.text)) {
            is HostMessage.Welcome -> answer
            is HostMessage.Error -> throw Ended(refusal(primary, answer))
            else -> throw Ended(AttemptEnd.Violation("The Host answered the identity proof with something else."))
        }
        if (welcome.fence.runnerId != identity.runnerId || welcome.fence.bootId != bootId) {
            throw Ended(AttemptEnd.Violation("The Host welcomed a different Runner."))
        }
        if (RunnerDescriptor.MODULE !in welcome.allowedModules) {
            throw Ended(AttemptEnd.Violation("This phone's enrollment does not allow the integrations module."))
        }
        if (identity.enrolled && welcome.fence.connectionGeneration <= identity.lastConnectionGeneration) {
            throw Ended(AttemptEnd.Violation("The Host's connection generation did not advance."))
        }
        hostClock.adopt(IsoTime.parse(welcome.serverTime), frame.receivedAt)
        // The token is forgotten the moment the Host has accepted it; an
        // unpairing in between wins, and this connection is abandoned.
        if (!record.replace(identity, identity.welcomed(welcome.fence.connectionGeneration))) throw Interrupted(stop = false)
        welcomed = true
        return welcome
    }

    private fun requestTicket(primary: Socket, lease: Lease<RunnerFence>): String {
        val requestId = "aux:${UUID.randomUUID()}"
        if (!primary.send(RunnerWire.ticketRequest(current(lease), requestId))) {
            throw Ended(AttemptEnd.Closed(ABNORMAL_CLOSE, afterWelcome = true))
        }
        while (true) {
            when (val message = RunnerWire.decodeHostMessage(nextFrame(primary).text)) {
                is HostMessage.LeaseRenewed -> renew(lease, message.fence, message.connectionLeaseExpiresAt)
                is HostMessage.AuxiliaryTicket -> {
                    if (!lease.accepts(message.fence)) throw Ended(AttemptEnd.Violation("The ticket carried a stale connection fence."))
                    if (message.requestId != requestId || message.module != RunnerDescriptor.MODULE) {
                        throw Ended(AttemptEnd.Violation("The Host answered a different ticket request."))
                    }
                    return message.ticket
                }
                is HostMessage.Error -> throw Ended(refusal(primary, message))
                else -> throw Ended(AttemptEnd.Violation("The Host sent an unexpected message while issuing a ticket."))
            }
        }
    }

    private fun openStream(
        stream: Socket,
        identity: PhoneIdentity,
        ticket: String,
        fence: RunnerFence,
        primary: Welcomed,
    ): AuxiliaryHandshake.Welcome {
        val challenge = when (val first = RunnerWire.decodeAuxiliaryHandshake(nextFrame(stream, primary).text)) {
            is AuxiliaryHandshake.Challenge -> first.challenge
            is AuxiliaryHandshake.Rejected -> throw Ended(AttemptEnd.Refused(first.error))
            is AuxiliaryHandshake.Welcome -> throw Ended(AttemptEnd.Violation("The Host welcomed the stream before challenging it."))
        }
        if (challenge.module != RunnerDescriptor.MODULE) throw Ended(AttemptEnd.Violation("The Host challenged a different module."))
        val proof = RunnerWire.auxiliaryAuthenticate(challenge, identity.runnerKey, identity.runnerId, bootId, ticket)
        if (!stream.send(proof)) throw Ended(AttemptEnd.Closed(ABNORMAL_CLOSE, afterWelcome = true))
        val frame = nextFrame(stream, primary)
        val welcome = when (val answer = RunnerWire.decodeAuxiliaryHandshake(frame.text)) {
            is AuxiliaryHandshake.Welcome -> answer
            is AuxiliaryHandshake.Rejected -> throw Ended(AttemptEnd.Refused(answer.error))
            is AuxiliaryHandshake.Challenge -> throw Ended(AttemptEnd.Violation("The Host challenged the stream twice."))
        }
        // The stream belongs to exactly the connection whose ticket opened it.
        if (welcome.fence.fence != fence) throw Ended(AttemptEnd.Violation("The stream was welcomed for another connection."))
        streamClock.adopt(IsoTime.parse(welcome.serverTime), frame.receivedAt)
        return welcome
    }

    private fun serve(
        primary: Welcomed,
        heartbeatMs: Long,
        stream: Socket,
        streamLease: Lease<AuxiliaryFence>,
        streamHeartbeatMs: Long,
    ): AttemptEnd {
        val lease = primary.lease
        var nextHeartbeat = elapsed() + heartbeatMs
        var nextStreamHeartbeat = elapsed() + streamHeartbeatMs
        var nextStatus = elapsed() + STATUS_INTERVAL_MS
        fun closed(code: Int) = AttemptEnd.Closed(code, afterWelcome = true, renewed = primary.renewed)
        while (true) {
            if (lease.expired(elapsed()) || streamLease.expired(elapsed())) {
                // Nothing more is stamped for a connection the Host may already have let go.
                log("A connection lease ran out without renewal")
                return closed(LEASE_EXPIRED_CLOSE)
            }
            if (elapsed() >= nextHeartbeat) {
                val sentAt = IsoTime.format(hostClock.heartbeatTimestamp())
                if (!primary.socket.send(RunnerWire.heartbeat(current(lease), sentAt))) return closed(ABNORMAL_CLOSE)
                nextHeartbeat += heartbeatMs
            }
            if (elapsed() >= nextStreamHeartbeat) {
                val sentAt = IsoTime.format(streamClock.heartbeatTimestamp())
                if (!stream.send(RunnerWire.auxiliaryHeartbeat(current(streamLease), sentAt))) return closed(ABNORMAL_CLOSE)
                nextStreamHeartbeat += streamHeartbeatMs
            }
            if (elapsed() >= nextStatus) {
                owner.module.refreshStatus()
                nextStatus += STATUS_INTERVAL_MS
            }
            val now = elapsed()
            val wait = minOf(nextHeartbeat, nextStreamHeartbeat, nextStatus, lease.expiresAt, streamLease.expiresAt) - now
            val event = inbox.poll(wait.coerceAtLeast(0), TimeUnit.MILLISECONDS) ?: continue
            when (event) {
                is Event.Task -> runTask(event)
                is Event.Frame -> when (event.socket) {
                    primary.socket -> primary.hear(event.text)?.let { return it }
                    stream -> {
                        val frame = IntegrationsWire.decode(bounded(event.text))
                        if (!streamLease.accepts(frame.fence)) return AttemptEnd.Violation("A stream frame carried a stale fence.")
                        when (frame) {
                            is StreamFrame.LeaseRenewed -> {
                                streamLease.renew(streamClock.local(IsoTime.parse(frame.streamLeaseExpiresAt)))
                                primary.renewed = true
                            }
                            is IntegrationsMessage -> owner.module.handle(frame, event.receivedAt)
                        }
                        owner.settled()
                    }
                    else -> Unit
                }
                is Event.Binary -> if (event.socket === primary.socket || event.socket === stream) {
                    return AttemptEnd.Violation("The Host sent a binary frame.")
                }
                is Event.Closed -> if (event.socket === primary.socket || event.socket === stream) return closed(event.code)
                is Event.Failed -> if (event.socket === primary.socket || event.socket === stream) return closed(ABNORMAL_CLOSE)
                Event.IdentityChanged -> throw Interrupted(stop = false)
                Event.Stop -> throw Interrupted(stop = true)
            }
        }
    }

    /** The fence to stamp a frame with; a lease that ran out ends the connection instead. */
    private fun <F> current(lease: Lease<F>): F =
        lease.fenceAt(elapsed()) ?: throw Ended(AttemptEnd.Closed(LEASE_EXPIRED_CLOSE, afterWelcome = true))

    private fun renew(lease: Lease<RunnerFence>, fence: RunnerFence, expiresAt: String) {
        if (!lease.accepts(fence)) throw Ended(AttemptEnd.Violation("A lease renewal carried a stale fence."))
        lease.renew(hostClock.local(IsoTime.parse(expiresAt)))
    }

    /**
     * A refusal is classified by the close that follows it as much as by its
     * reason: the Host may send `host.error` and then close 4010, so the close
     * is waited for briefly before deciding.
     */
    private fun refusal(socket: Socket, error: HostMessage.Error): AttemptEnd {
        val deadline = elapsed() + REFUSAL_CLOSE_WAIT_MS
        while (true) {
            val remaining = deadline - elapsed()
            if (remaining <= 0) break
            when (val event = inbox.poll(remaining, TimeUnit.MILLISECONDS) ?: break) {
                is Event.Closed -> if (event.socket === socket) {
                    if (event.code == ConnectionPolicy.REVOKED_CLOSE_CODE) return AttemptEnd.Closed(event.code, afterWelcome = false)
                    break
                }
                is Event.Failed -> if (event.socket === socket) break
                is Event.Task -> runTask(event)
                Event.IdentityChanged -> throw Interrupted(stop = false)
                Event.Stop -> throw Interrupted(stop = true)
                else -> Unit
            }
        }
        return AttemptEnd.Refused(error.error)
    }

    /**
     * The next text frame on `socket`, within the handshake timeout. While the
     * stream opens, the welcomed `primary` keeps speaking: its renewals are
     * kept, and its refusal or close — a revocation above all — ends the
     * attempt at once.
     */
    private fun nextFrame(socket: Socket, primary: Welcomed? = null): Event.Frame {
        val deadline = elapsed() + HANDSHAKE_TIMEOUT_MS
        while (true) {
            val remaining = deadline - elapsed()
            if (remaining <= 0) throw Ended(AttemptEnd.Unreachable("The Host did not answer in time."))
            val event = inbox.poll(remaining, TimeUnit.MILLISECONDS) ?: continue
            // The welcomed primary, when this event is its.
            val held = primary?.takeIf { event.socket() === it.socket }
            when (event) {
                is Event.Frame -> when {
                    held != null -> held.hear(event.text)?.let { throw Ended(it) }
                    event.socket === socket -> {
                        bounded(event.text)
                        return event
                    }
                }
                is Event.Binary -> if (held != null || event.socket === socket) throw Ended(AttemptEnd.Violation("The Host sent a binary frame."))
                is Event.Closed -> when {
                    held != null -> throw Ended(AttemptEnd.Closed(event.code, afterWelcome = true, renewed = held.renewed))
                    event.socket === socket -> throw Ended(AttemptEnd.Closed(event.code, afterWelcome = primary != null))
                }
                is Event.Failed -> when {
                    held != null -> throw Ended(AttemptEnd.Closed(ABNORMAL_CLOSE, afterWelcome = true, renewed = held.renewed))
                    event.socket === socket -> throw Ended(AttemptEnd.Unreachable(event.detail))
                }
                is Event.Task -> runTask(event)
                Event.IdentityChanged -> throw Interrupted(stop = false)
                Event.Stop -> throw Interrupted(stop = true)
            }
        }
    }

    private fun Event.socket(): Socket? = when (this) {
        is Event.Frame -> socket
        is Event.Binary -> socket
        is Event.Closed -> socket
        is Event.Failed -> socket
        else -> null
    }

    private fun bounded(text: String): String {
        if (text.length > IntegrationsWire.MAX_FRAME_BYTES || text.toByteArray(Charsets.UTF_8).size > IntegrationsWire.MAX_FRAME_BYTES) {
            throw Ended(AttemptEnd.Violation("The Host sent a frame over 1 MiB."))
        }
        return text
    }

    private companion object {
        const val HANDSHAKE_TIMEOUT_MS = 15_000L
        const val REFUSAL_CLOSE_WAIT_MS = 3_000L
        const val STATUS_INTERVAL_MS = 30_000L
        const val STOP_WAIT_MS = 5_000L
        const val NORMAL_CLOSE = 1000
        const val ABNORMAL_CLOSE = 1006
        const val LEASE_EXPIRED_CLOSE = 4000
    }
}
