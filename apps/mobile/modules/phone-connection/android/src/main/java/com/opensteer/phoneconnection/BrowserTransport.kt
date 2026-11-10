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
) {
    private data class Channel(val capability: JsonObject, val credit: FrameCredit = FrameCredit(), var sequence: Long = 0,
        val captures: MutableSet<String> = mutableSetOf(), var admitted: Boolean = false, var lastFrameAt: Long? = null)
    private val channels = mutableMapOf<String, Channel>()
    private var socket: WebSocket? = null
    private var pendingGrant: JsonObject? = null
    private var grantRequest: String? = null
    private var grantFrame: JsonObject? = null
    private var revoked: JsonObject? = null

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
        val epoch = admission.advance()
        channels.values.forEach { it.credit.close() }; channels.clear(); tickets.retire()
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
                if (admission.capability != null && reference != admission.capability) fence()
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
                if (payload["type"] == JsonPrimitive("cdp.command")) {
                    val command = payload.obj("command")
                    if (command["method"] == JsonPrimitive("Page.captureScreenshot")) {
                        val channel = channels.getValue(frame.text("channelId"))
                        Wire.requireThat(channel.captures.size < 32, "capacity")
                        Wire.requireThat(channel.captures.add(payload.text("requestId")), "duplicate-capture")
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
        channel.admitted = true
        permit
    }
    fun allocationPermit(epoch: Int, permit: String): AttachTickets.Permit = synchronized(admission) {
        val fence = admission.fence ?: throw Refused("retired-stream")
        admission.requireCurrent(epoch, fence, admission.capability ?: throw Refused("retired-capability"))
        tickets.permit(permit, epoch, fence)
    }
    fun <Result> withChannel(epoch: Int, channelId: String, operation: () -> Result): Result = synchronized(admission) {
        requireChannel(epoch, admission.fence ?: throw Refused("retired-stream"), channelId,
            admission.capability ?: throw Refused("retired-capability"))
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
        channels.remove(channelId)?.credit?.close(); tickets.retireChannel(channelId)
    }
    fun ack(epoch: Int, channelId: String, token: String) = synchronized(admission) {
        val fence = admission.fence ?: throw Refused("retired-stream")
        requireChannel(epoch, fence, channelId, admission.capability ?: throw Refused("retired-capability")).credit.ack(token)
    }

    fun frame(epoch: Int, channelId: String, header: JsonObject, pixels: ByteArray, completed: (Boolean) -> Unit) {
        val fence: Fence
        val channel: Channel
        val token = UUID.randomUUID().toString()
        if (pixels.isEmpty() || pixels.size > FrameCodec.MAX_FRAME) return completed(false)
        synchronized(admission) {
            fence = admission.fence ?: return completed(false)
            channel = try { requireChannel(epoch, fence, channelId, admission.capability ?: throw Refused("retired-capability")) }
                catch (_: Refused) { return completed(false) }
            val at = monotonicNanos()
            if (channel.lastFrameAt?.let { at - it < 125_000_000 } == true || !channel.credit.reserve(token)) return completed(false)
            channel.lastFrameAt = at
        }
        val ownedPixels = pixels.copyOf()
        worker.execute {
            val accepted = try {
                val frame = FrameCodec.envelope(JsonObject(header + ("watchToken" to JsonPrimitive(token))), ownedPixels)
                val bytes = synchronized(admission) {
                    Wire.requireThat(requireChannel(epoch, fence, channelId, channel.capability) === channel, "channel-gone")
                    val relay = JsonObject(fence.fields + mapOf("type" to JsonPrimitive("browser.frame"), "capability" to channel.capability,
                        "channelId" to JsonPrimitive(channelId), "sequence" to JsonPrimitive(++channel.sequence)))
                    FrameCodec.relay(relay, frame)
                }
                synchronized(admission) {
                    Wire.requireThat(requireChannel(epoch, fence, channelId, channel.capability) === channel, "channel-gone")
                    socket?.send(bytes.toByteString()) == true
                }
            } catch (_: Exception) { false }
            if (!accepted) channel.credit.ack(token)
            completed(accepted)
        }
    }
    fun capture(epoch: Int, channelId: String, requestId: String, pixels: ByteArray, completed: (Boolean) -> Unit) {
        if (pixels.isEmpty() || pixels.size > FrameCodec.MAX_FRAME) return completed(false)
        val fence = synchronized(admission) {
            try {
                val current = admission.fence ?: throw Refused("retired-stream")
                val channel = requireChannel(epoch, current, channelId, admission.capability ?: throw Refused("retired-capability"))
                Wire.requireThat(channel.captures.remove(requestId), "retired-capture")
                current
            } catch (_: Refused) { return completed(false) }
        }
        val ownedPixels = pixels.copyOf()
        worker.execute {
            val sent = try {
                val result = Wire.fields("type" to JsonPrimitive("cdp.result"), "requestId" to JsonPrimitive(requestId),
                    "result" to Wire.fields("data" to JsonPrimitive(Base64.toBase64String(ownedPixels))))
                synchronized(admission) {
                    val channel = requireChannel(epoch, fence, channelId, admission.capability ?: throw Refused("retired-capability"))
                    send(epoch, JsonObject(fence.fields + mapOf("type" to JsonPrimitive("browser.server-message"), "channelId" to JsonPrimitive(channelId),
                        "capability" to channel.capability, "message" to result)))
                    true
                }
            } catch (_: Exception) { false }
            completed(sent)
        }
    }
    private fun requireChannel(epoch: Int, fence: Fence, channelId: String, capability: JsonObject): Channel {
        admission.requireCurrent(epoch, fence, capability)
        val channel = channels[channelId] ?: throw Refused("channel-gone")
        Wire.requireThat(channel.admitted && channel.capability == capability, "retired-capability")
        return channel
    }
}
