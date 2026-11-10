package com.opensteer.phoneconnection

import com.opensteer.phoneconnection.core.*
import kotlinx.serialization.json.*
import okhttp3.WebSocket
import okio.ByteString.Companion.toByteString
import org.bouncycastle.util.encoders.Base64
import java.util.UUID
import java.util.concurrent.Executor

class BrowserTransport(
    private val admission: Admission,
    private val tickets: AttachTickets,
    private val worker: Executor,
    private val emit: (JsonObject) -> Unit,
    private val fenceBrowser: (Int) -> Unit,
    private val monotonicNanos: () -> Long = System::nanoTime,
    private val detachBrowser: (Int, String) -> Unit = { _, _ -> },
    private val scheduleDrain: (Runnable) -> Unit = {},
) {
    private data class Channel(var capability: JsonObject, val credit: FrameCredit = FrameCredit(), var sequence: Long = 0,
        val captures: MutableMap<String, String?> = mutableMapOf(), var claims: JsonObject? = null, var admitted: Boolean = false, var lastFrameAt: Long? = null)
    data class Agent(val channelId: String, val attachmentId: String, val actorToken: String, val sessionId: String)
    private val agents = mutableMapOf<String, Agent>()
    private val channels = mutableMapOf<String, Channel>()
    private var socket: WebSocket? = null
    private var pendingGrant: JsonObject? = null
    private var grantRequest: String? = null
    private var grantFrame: JsonObject? = null
    private var revoked: JsonObject? = null
    private data class PendingFrame(val channelId: String, val channel: Channel, val token: String, val current: () -> Boolean, val completed: (Boolean) -> Unit)
    private var pendingFrame: PendingFrame? = null

    fun online(value: WebSocket, welcome: JsonObject) = synchronized(admission) {
        val fence = admission.adopt(welcome)
        tickets.setKeys(welcome["browserAttachPublicKeys"] as? JsonArray ?: throw Refused("invalid-wire"))
        Wire.requireThat(runCatching { welcome.number("browserWireVersion") }.getOrNull() == 1L, "needs-update")
        socket = value
        emit(Wire.fields("type" to JsonPrimitive("connection"), "state" to JsonPrimitive("online"),
            "fence" to fence.fields, "leaseDeadline" to JsonPrimitive(admission.deadline)))
    }
    fun renew(frame: JsonObject) = synchronized(admission) {
        admission.renew(frame)
        (frame["browserAttachPublicKeys"] as? JsonArray)?.let { tickets.setKeys(it) }
        emit(Wire.fields("type" to JsonPrimitive("connection"), "state" to JsonPrimitive("online"),
            "fence" to admission.fence!!.fields, "leaseDeadline" to JsonPrimitive(admission.deadline)))
    }
    fun reportOnline() = synchronized(admission) {
        val fence = admission.fence ?: return@synchronized
        admission.requireCurrent(admission.epoch, fence)
        emit(Wire.fields("type" to JsonPrimitive("connection"), "state" to JsonPrimitive("online"),
            "fence" to fence.fields, "leaseDeadline" to JsonPrimitive(admission.deadline)))
        grantFrame?.let { emit(Wire.fields("type" to JsonPrimitive("relayCommand"), "message" to it)) }
    }
    fun fence(): Int = synchronized(admission) {
        finishFrame(false)
        val epoch = admission.advance()
        channels.values.forEach { it.credit.close() }; channels.clear()
        agents.keys.toList().forEach { id -> agents.remove(id); detachBrowser(epoch, id) }
        tickets.retire()
        fenceBrowser(epoch)
        epoch
    }
    fun offline(reason: String) = synchronized(admission) {
        val lost = admission.fence
        fence()
        admission.release(); tickets.retire(clearKeys = true); socket = null; pendingGrant = null; grantRequest = null; grantFrame = null; revoked = null
        if (lost != null) emit(Wire.fields("type" to JsonPrimitive("connection"), "state" to JsonPrimitive("offline"),
            "fence" to lost.fields, "reason" to JsonPrimitive(reason)))
    }
    fun receive(frame: JsonObject) = synchronized(admission) {
        val fence = Fence.auxiliary(frame)
        admission.requireCurrent(admission.epoch, fence)
        var message = frame
        var authorityHandle: String? = null
        when (frame.text("type")) {
            "capability.grant" -> {
                val lease = frame.obj("lease")
                Wire.requireThat(lease.text("runtimeId") == tickets.runtimeId, "retired-capability")
                val reference = admission.checkCapability(lease)
                val previous = admission.capability
                if (previous != null && reference != previous) {
                    val continuing = runCatching { admission.requireCurrent(admission.epoch, fence, previous) }.isSuccess
                    if (continuing) {
                        admission.acceptCapability(lease)
                        channels.values.forEach { it.capability = reference }
                    } else fence()
                }
                pendingGrant = lease; grantRequest = frame.text("requestId"); grantFrame = frame
            }
            "capability.revoke" -> {
                admission.requireCurrent(admission.epoch, fence, frame.obj("capability"))
                revoked = frame.obj("capability"); fence()
            }
            "browser.attach" -> {
                admission.requireCurrent(admission.epoch, fence, frame.obj("capability"))
                val channel = frame.text("channelId")
                Wire.requireThat(!channels.containsKey(channel), "duplicate-channel")
                val handle = tickets.hold(frame.text("attachTicket", max = 16384), admission.epoch, fence, channel)
                channels[channel] = Channel(frame.obj("capability"))
                message = JsonObject((frame - "attachTicket") + ("attachHandle" to JsonPrimitive(handle)))
            }
            "browser.client-message" -> {
                requireChannel(admission.epoch, fence, frame.text("channelId"), frame.obj("capability"))
                val payload = frame.obj("message")
                val channelId = frame.text("channelId")
                val channel = channels.getValue(channelId)
                when (payload.text("type")) {
                    "agent.attach" -> {
                        val claims = channel.claims ?: throw Refused("forbidden")
                        Wire.requireThat(claims.text("access") == "read-write" && payload.text("sessionId") == claims.text("sessionId") && payload.text("backend") == "cdp", "forbidden")
                        val agent = Agent(channelId, payload.text("attachmentId"), payload.text("actorToken"), claims.text("sessionId"))
                        Wire.requireThat(agents[agent.attachmentId]?.let { it != agent } != true, "forbidden")
                        agents[agent.attachmentId] = agent
                    }
                    "agent.detach" -> {
                        val id = payload.text("attachmentId")
                        Wire.requireThat(agents[id]?.channelId == channelId, "forbidden")
                        detachAgent(admission.epoch, id)
                    }
                }
                if (payload["type"] == JsonPrimitive("cdp.command")) {
                    val command = payload.obj("command")
                    if (command["method"] == JsonPrimitive("Page.captureScreenshot")) {
                        val channel = channels.getValue(frame.text("channelId"))
                        Wire.requireThat(channel.captures.size < 32, "capacity")
                        val requestId = payload.text("requestId")
                        Wire.requireThat(!channel.captures.containsKey(requestId), "duplicate-capture")
                        val actor = payload.text("actorToken")
                        val agent = requireAgent(admission.epoch, channelId, actor, payload.text("attachmentId"))
                        channel.captures[requestId] = agent.attachmentId
                    }
                    if (command["method"] == JsonPrimitive("Opensteer.openTab")) {
                        val parameters = command["parameters"] as? JsonObject
                        val ticket = (parameters?.get("operationAuthority") as? JsonPrimitive)?.content
                        if (ticket != null) {
                            authorityHandle = tickets.hold(ticket, admission.epoch, fence, frame.text("channelId"))
                            val sanitized = JsonObject(command + ("parameters" to JsonObject(parameters - "operationAuthority")))
                            message = JsonObject(frame + ("message" to JsonObject(payload + ("command" to sanitized))))
                        }
                    }
                }
            }
            "browser.close", "browser.profile.delete" -> admission.requireCurrent(admission.epoch, fence, frame.obj("capability"))
            "browser.health.request" -> Unit
            else -> throw Refused("invalid-wire")
        }
        emit(JsonObject(linkedMapOf("type" to JsonPrimitive("relayCommand"), "message" to message).apply {
            if (authorityHandle != null) put("authorityHandle", JsonPrimitive(authorityHandle))
        }))
    }
    fun verifyAttach(epoch: Int, handle: String): JsonObject = synchronized(admission) {
        val fence = admission.fence ?: throw Refused("retired-stream")
        admission.requireCurrent(epoch, fence, admission.capability ?: throw Refused("retired-capability"))
        val verified = tickets.verify(handle, epoch, fence)
        Wire.fields("claims" to verified.claims, "claimsDigest" to JsonPrimitive(verified.digest),
            "replayState" to verified.state.json(), "maxReplayEntries" to JsonPrimitive(4096))
    }
    fun commitAttach(epoch: Int, handle: String, digest: String, transition: JsonObject): String = synchronized(admission) {
        val fence = admission.fence ?: throw Refused("retired-stream")
        admission.requireCurrent(epoch, fence, admission.capability ?: throw Refused("retired-capability"))
        val permit = tickets.commit(handle, epoch, fence, digest, ReplayState.parse(transition, 4096))
        val verified = tickets.permit(permit, epoch, fence)
        val channel = channels[verified.channelId] ?: throw Refused("channel-gone")
        val previous = channel.claims
        if (previous != null) {
            val identity = verified.claims.obj("identity")
            val priorIdentity = previous.obj("identity")
            val sameIdentity = if (identity.text("kind") == "fresh") true
                else if (identity.text("kind") == "profile-local" && priorIdentity.text("kind") == "profile-local")
                identity.obj("binding") == priorIdentity.obj("binding") else identity == priorIdentity
            Wire.requireThat(sameIdentity && listOf("sessionId", "access", "subject").all { previous[it] == verified.claims[it] }, "forbidden")
        } else channel.claims = verified.claims
        channel.admitted = true
        permit
    }
    fun allocationPermit(epoch: Int, permit: String): AttachTickets.Permit = synchronized(admission) {
        val fence = admission.fence ?: throw Refused("retired-stream")
        admission.requireCurrent(epoch, fence, admission.capability ?: throw Refused("retired-capability"))
        tickets.permit(permit, epoch, fence)
    }
    fun allocationClaims(epoch: Int, permit: String, sessionId: String): JsonObject = synchronized(admission) {
        val channelId = if (permit.startsWith("cdp:")) {
            val agent = requireAttachment(epoch, permit.removePrefix("cdp:"), sessionId)
            agent.channelId
        } else {
            val operation = allocationPermit(epoch, permit)
            Wire.requireThat(operation.claims.text("sessionId") == sessionId, "forbidden")
            operation.channelId
        }
        withChannel(epoch, channelId) {
            val claims = channels.getValue(channelId).claims ?: throw Refused("forbidden")
            Wire.requireThat(claims.text("sessionId") == sessionId, "forbidden")
            claims
        }
    }
    fun <Result> withChannel(epoch: Int, channelId: String, operation: () -> Result): Result = synchronized(admission) {
        requireChannel(epoch, admission.fence ?: throw Refused("retired-stream"), channelId,
            admission.capability ?: throw Refused("retired-capability"))
        operation()
    }
    fun viewer(epoch: Int, channelId: String, sessionId: String, control: Boolean): String = withChannel(epoch, channelId) {
        val claims = channels.getValue(channelId).claims ?: throw Refused("forbidden")
        Wire.requireThat(claims.text("sessionId") == sessionId && (!control || claims.text("access") == "read-write"), "forbidden")
        claims.text("subject")
    }
    fun requireAgent(epoch: Int, channelId: String, actorToken: String, attachmentId: String): Agent = withChannel(epoch, channelId) {
        val agent = agents[attachmentId] ?: throw Refused("forbidden")
        Wire.requireThat(agent.channelId == channelId && agent.actorToken == actorToken, "forbidden")
        agent
    }
    fun requireAttachment(epoch: Int, attachmentId: String, sessionId: String, channelId: String? = null): Agent = synchronized(admission) {
        val agent = agents[attachmentId] ?: throw Refused("forbidden")
        withChannel(epoch, agent.channelId) {
            Wire.requireThat(agent.sessionId == sessionId && (channelId == null || channelId == agent.channelId), "forbidden")
            agent
        }
    }
    fun detachAgent(epoch: Int, attachmentId: String) = synchronized(admission) {
        admission.requireCurrent(epoch, admission.fence ?: throw Refused("retired-stream"), admission.capability ?: throw Refused("retired-capability"))
        if (agents.remove(attachmentId) != null) detachBrowser(epoch, attachmentId)
        channels.values.forEach { channel -> channel.captures.entries.removeAll { it.value == attachmentId } }
        Unit
    }
    fun <Result> withAttachment(epoch: Int, attachmentId: String, sessionId: String, operation: () -> Result): Result = synchronized(admission) {
        requireAttachment(epoch, attachmentId, sessionId)
        operation()
    }
    fun send(epoch: Int, message: JsonObject) = synchronized(admission) {
        val fence = Fence.auxiliary(message)
        admission.requireCurrent(epoch, fence)
        val type = message.text("type")
        if (type == "capability.accepted") {
            val grant = pendingGrant ?: throw Refused("retired-capability")
            Wire.requireThat(message.text("requestId") == grantRequest && message.obj("capability") == JsonObject(grant - "expiresAt"), "retired-capability")
            admission.acceptCapability(grant)
            pendingGrant = null; grantRequest = null; grantFrame = null
        } else if (type == "capability.revoked") {
            Wire.requireThat(message.obj("capability") == revoked, "retired-capability")
            revoked = null
        } else if (message.containsKey("capability")) {
            admission.requireCurrent(epoch, fence, message.obj("capability"))
        }
        if (type == "browser.server-message" || type == "browser.attached") {
            val channel = requireChannel(epoch, fence, message.text("channelId"), message.obj("capability"))
            if (type == "browser.server-message") {
                val payload = message.obj("message")
                if (payload["type"] in setOf(JsonPrimitive("cdp.error"), JsonPrimitive("cdp.result"))) channel.captures.remove(payload.text("requestId"))
            }
        }
        val encoded = message.toString()
        Wire.requireThat(encoded.toByteArray(Charsets.UTF_8).size <= 16 * 1024 * 1024, "invalid-wire")
        Wire.requireThat(socket?.send(encoded) == true, "stream-gone")
    }
    fun closeChannel(epoch: Int, channelId: String) = synchronized(admission) {
        admission.requireCurrent(epoch, admission.fence ?: throw Refused("retired-stream"), admission.capability ?: throw Refused("retired-capability"))
        if (pendingFrame?.channelId == channelId) finishFrame(false)
        channels.remove(channelId)?.credit?.close(); tickets.retireChannel(channelId)
        agents.values.filter { it.channelId == channelId }.map { it.attachmentId }.forEach { detachAgent(epoch, it) }
    }
    fun ack(epoch: Int, channelId: String, token: String) = synchronized(admission) {
        val fence = admission.fence ?: throw Refused("retired-stream")
        requireChannel(epoch, fence, channelId, admission.capability ?: throw Refused("retired-capability")).credit.ack(token)
    }
    fun frameWritable(epoch: Int, channelId: String): Boolean = synchronized(admission) {
        requireChannel(epoch, admission.fence ?: throw Refused("retired-stream"), channelId, admission.capability ?: throw Refused("retired-capability"))
        pendingFrame == null && socket?.queueSize() == 0L
    }
    private fun finishFrame(accepted: Boolean) {
        val pending = pendingFrame ?: return
        pendingFrame = null
        pending.channel.credit.ack(pending.token)
        pending.completed(accepted)
    }
    private fun awaitFrameDrain(pending: PendingFrame): Unit = synchronized(admission) {
        if (pendingFrame !== pending) return@synchronized
        val current = try {
            val fence = admission.fence ?: throw Refused("retired-stream")
            requireChannel(admission.epoch, fence, pending.channelId, pending.channel.capability) === pending.channel && pending.current()
        } catch (_: Exception) { false }
        if (!current || socket == null) finishFrame(false)
        else if (socket!!.queueSize() == 0L) finishFrame(true)
        else try { scheduleDrain(Runnable { awaitFrameDrain(pending) }) } catch (_: Exception) { finishFrame(false) }
    }

    fun frame(epoch: Int, channelId: String, header: JsonObject, pixels: ByteArray, valid: () -> Boolean = { true }, completed: (Boolean) -> Unit) {
        val fence: Fence
        val channel: Channel
        val token = UUID.randomUUID().toString()
        if (header.containsKey("watchToken") || pixels.isEmpty() || pixels.size > FrameCodec.MAX_FRAME) return completed(false)
        synchronized(admission) {
            fence = admission.fence ?: return completed(false)
            channel = try { requireChannel(epoch, fence, channelId, admission.capability ?: throw Refused("retired-capability")) }
                catch (_: Refused) { return completed(false) }
            val at = monotonicNanos()
            if (pendingFrame != null || socket?.queueSize() != 0L || channel.lastFrameAt?.let { at - it < 125_000_000 } == true || !channel.credit.reserve(token)) return completed(false)
            channel.lastFrameAt = at
            pendingFrame = PendingFrame(channelId, channel, token, valid, completed)
        }
        val ownedPixels = pixels.copyOf()
        val deliver = Runnable {
            val accepted = try {
                val frame = FrameCodec.envelope(header, ownedPixels)
                val bytes = synchronized(admission) {
                    Wire.requireThat(requireChannel(epoch, fence, channelId, channel.capability) === channel, "channel-gone")
                    val relay = JsonObject(fence.fields + mapOf("type" to JsonPrimitive("browser.frame"), "capability" to channel.capability,
                        "channelId" to JsonPrimitive(channelId), "sequence" to JsonPrimitive(++channel.sequence)))
                    FrameCodec.relay(relay, frame)
                }
                synchronized(admission) {
                    Wire.requireThat(requireChannel(epoch, fence, channelId, channel.capability) === channel, "channel-gone")
                    Wire.requireThat(pendingFrame?.token == token && socket?.queueSize() == 0L, "capture-busy")
                    Wire.requireThat(valid(), "stale-frame")
                    socket?.send(bytes.toByteString()) == true
                }
            } catch (_: Exception) { false }
            synchronized(admission) {
                val pending = pendingFrame
                if (pending?.token == token) {
                    if (accepted) awaitFrameDrain(pending) else finishFrame(false)
                }
            }
        }
        try { worker.execute(deliver) } catch (_: Exception) {
            synchronized(admission) { if (pendingFrame?.token == token) finishFrame(false) }
        }
    }
    fun capture(epoch: Int, channelId: String, requestId: String, pixels: ByteArray, attachmentId: String? = null, valid: () -> Boolean = { true }, completed: (Boolean) -> Unit) {
        if (pixels.isEmpty() || pixels.size > FrameCodec.MAX_FRAME) return completed(false)
        val token = UUID.randomUUID().toString()
        val fence = synchronized(admission) {
            try {
                val current = admission.fence ?: throw Refused("retired-stream")
                val channel = requireChannel(epoch, current, channelId, admission.capability ?: throw Refused("retired-capability"))
                val expected = channel.captures[requestId] ?: throw Refused("retired-capture")
                Wire.requireThat(expected == attachmentId, "forbidden")
                requireAttachment(epoch, expected, channel.claims!!.text("sessionId"), channelId)
                Wire.requireThat(pendingFrame == null && socket?.queueSize() == 0L && channel.credit.reserve(token), "capture-busy")
                channel.captures.remove(requestId)
                pendingFrame = PendingFrame(channelId, channel, token, valid, completed)
                current
            } catch (_: Refused) { return completed(false) }
        }
        val ownedPixels = pixels.copyOf()
        val deliver = Runnable {
            val sent = try {
                val result = Wire.fields("type" to JsonPrimitive("cdp.result"), "requestId" to JsonPrimitive(requestId),
                    "result" to Wire.fields("data" to JsonPrimitive(Base64.toBase64String(ownedPixels))))
                synchronized(admission) {
                    val channel = requireChannel(epoch, fence, channelId, admission.capability ?: throw Refused("retired-capability"))
                    requireAttachment(epoch, attachmentId ?: throw Refused("forbidden"), channel.claims!!.text("sessionId"), channelId)
                    Wire.requireThat(pendingFrame?.token == token && socket?.queueSize() == 0L, "capture-busy")
                    Wire.requireThat(valid(), "stale-frame")
                    send(epoch, JsonObject(fence.fields + mapOf("type" to JsonPrimitive("browser.server-message"), "channelId" to JsonPrimitive(channelId),
                        "capability" to channel.capability, "message" to result)))
                    true
                }
            } catch (_: Exception) { false }
            synchronized(admission) {
                val pending = pendingFrame
                if (pending?.token == token) {
                    if (sent) awaitFrameDrain(pending) else finishFrame(false)
                }
            }
        }
        try { worker.execute(deliver) } catch (_: Exception) {
            synchronized(admission) { if (pendingFrame?.token == token) finishFrame(false) }
        }
    }
    private fun requireChannel(epoch: Int, fence: Fence, channelId: String, capability: JsonObject): Channel {
        admission.requireCurrent(epoch, fence, capability)
        val channel = channels[channelId] ?: throw Refused("channel-gone")
        Wire.requireThat(channel.admitted && channel.capability == capability, "retired-capability")
        return channel
    }
}
