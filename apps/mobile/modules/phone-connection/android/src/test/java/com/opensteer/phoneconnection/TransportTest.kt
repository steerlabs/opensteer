package com.opensteer.phoneconnection

import com.opensteer.phoneconnection.core.*
import kotlinx.serialization.json.*
import okhttp3.Request
import okhttp3.WebSocket
import okio.ByteString
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.Executor

class TransportTest {
    private fun vector(name: String) = Wire.parse(File(System.getProperty("phone.vectors"), "$name.v1.json").readText(), 100000)
    private class Memory : DurableBytes {
        private var bytes: ByteArray? = null
        override fun read() = bytes
        override fun write(bytes: ByteArray) { this.bytes = bytes }
    }
    private class Socket : WebSocket {
        val text = mutableListOf<String>()
        val bytes = mutableListOf<ByteArray>()
        override fun request() = Request.Builder().url("https://host.example.test").build()
        override fun queueSize() = 0L
        override fun send(text: String): Boolean { this.text.add(text); return true }
        override fun send(bytes: ByteString): Boolean { this.bytes.add(bytes.toByteArray()); return true }
        override fun close(code: Int, reason: String?) = true
        override fun cancel() {}
    }
    private inner class Fixture {
        val fences = vector("fences")
        val tickets = vector("attach-tickets")
        var now = fences.number("now")
        var tick = 0L
        val admission = Admission({ now }).apply { active = true }
        val ledger = ReplayLedger(Memory()).apply { initialize() }
        val events = mutableListOf<JsonObject>()
        val queue = mutableListOf<Runnable>()
        val socket = Socket()
        val transport = BrowserTransport(admission, AttachTickets("phone", ledger) { now }, Executor { queue.add(it) }, { events.add(it) }, {}, { tick })
        val capability = Wire.parse("""{"runtimeId":"phone","capabilityGeneration":1,"capabilityLeaseId":"bcl_11111111-1111-4111-8111-111111111111"}""")
        val channelId = "bch_11111111-1111-4111-8111-111111111111"
        val rawToken = tickets["cases"]!!.jsonArray.first().jsonObject.text("token", max = 16384)
        init { online() }
        fun online() {
            val welcome = JsonObject(fences.obj("welcome") + mapOf("browserWireVersion" to JsonPrimitive(1), "browserAttachPublicKeys" to JsonArray(listOf(
                Wire.fields("keyId" to JsonPrimitive("fixture"), "publicKeyPem" to tickets.getValue("publicKeyPem"))))))
            transport.online(socket, welcome)
            transport.fence()
            transport.receive(JsonObject(fences.obj("fence") + mapOf("type" to JsonPrimitive("capability.grant"), "requestId" to JsonPrimitive("grant"),
                "lease" to JsonObject(capability + ("expiresAt" to JsonPrimitive("2026-11-09T12:00:01.000Z"))))))
            transport.fence()
            transport.send(admission.epoch, JsonObject(fences.obj("fence") + mapOf("type" to JsonPrimitive("capability.accepted"), "requestId" to JsonPrimitive("grant"), "capability" to capability)))
        }
        fun attach(): String {
            transport.receive(JsonObject(fences.obj("fence") + mapOf("type" to JsonPrimitive("browser.attach"), "requestId" to JsonPrimitive("attach"),
                "channelId" to JsonPrimitive(channelId), "capability" to capability, "attachTicket" to JsonPrimitive(rawToken))))
            return events.last().obj("message").text("attachHandle")
        }
        fun runQueued() { val pending = queue.toList(); queue.clear(); pending.forEach { it.run() } }
        fun admit() {
            val handle = attach()
            val verified = transport.verifyAttach(admission.epoch, handle)
            val claims = verified.obj("claims")
            val next = ReplayState.parse(verified.obj("replayState"), 4096).claim(claims.text("nonce"), claims.time("expiresAt"), now, 4096)
            transport.commitAttach(admission.epoch, handle, verified.text("claimsDigest"), next.json())
        }
    }
    private fun refused(block: () -> Unit) { try { block(); fail("Expected refusal") } catch (_: Refused) {} }

    @Test fun `attach handles bind exact verified bytes and fsynced nonce state survives reconnect`() {
        val fixture = Fixture()
        val handle = fixture.attach()
        assertFalse(fixture.events.joinToString().contains(fixture.rawToken))
        val epoch = fixture.admission.epoch
        val verified = fixture.transport.verifyAttach(epoch, handle)
        val state = ReplayState.parse(verified.obj("replayState"), 4096)
        val claims = verified.obj("claims")
        val next = state.claim(claims.text("nonce"), claims.time("expiresAt"), fixture.now, 4096).json()
        refused { fixture.transport.commitAttach(epoch, handle, "wrong", next) }
        val permit = fixture.transport.commitAttach(epoch, handle, verified.text("claimsDigest"), next)
        assertEquals(claims, fixture.transport.allocationPermit(epoch, permit).claims)
        refused { fixture.transport.commitAttach(epoch, handle, verified.text("claimsDigest"), next) }
        fixture.transport.offline("inactive")
        fixture.online()
        refused { fixture.transport.allocationPermit(fixture.admission.epoch, permit) }
        val second = fixture.attach()
        val replay = fixture.transport.verifyAttach(fixture.admission.epoch, second)
        refused { ReplayState.parse(replay.obj("replayState"), 4096).claim(claims.text("nonce"), claims.time("expiresAt"), fixture.now, 4096) }
    }
    @Test fun `queued native pixels are dropped on background channel close or lease expiry`() {
        for (loss in listOf("epoch", "channel", "expiry", "capability")) {
            val fixture = Fixture()
            fixture.admit()
            val frame = vector("frames")
            var delivered: Boolean? = null
            fixture.transport.frame(fixture.admission.epoch, fixture.channelId, frame.obj("header"), byteArrayOf(1, 2, 3)) { delivered = it }
            assertNull(delivered)
            when (loss) {
                "epoch" -> fixture.transport.fence()
                "channel" -> fixture.transport.closeChannel(fixture.admission.epoch, fixture.channelId)
                "capability" -> fixture.transport.receive(JsonObject(fixture.fences.obj("fence") + mapOf("type" to JsonPrimitive("capability.grant"),
                    "requestId" to JsonPrimitive("replacement"), "lease" to JsonObject(fixture.capability + mapOf("capabilityGeneration" to JsonPrimitive(2),
                        "expiresAt" to JsonPrimitive("2026-11-09T12:00:01.000Z"))))))
                else -> fixture.now += 1000
            }
            fixture.runQueued()
            assertEquals(false, delivered)
            assertTrue(fixture.socket.bytes.isEmpty())
        }
    }
    @Test fun `native frame credit requires the exact token and frames stay ordered`() {
        val fixture = Fixture(); fixture.admit()
        val header = vector("frames").obj("header")
        fixture.transport.frame(fixture.admission.epoch, fixture.channelId, header, byteArrayOf(1)) {}
        fixture.runQueued()
        val first = FrameCodec.decodeRelay(fixture.socket.bytes.single())
        val token = FrameCodec.split(first.second).first.text("watchToken")
        fixture.transport.ack(fixture.admission.epoch, fixture.channelId, "wrong")
        fixture.transport.frame(fixture.admission.epoch, fixture.channelId, header, byteArrayOf(2)) {}
        fixture.runQueued(); assertEquals(1, fixture.socket.bytes.size)
        fixture.transport.ack(fixture.admission.epoch, fixture.channelId, token)
        fixture.transport.frame(fixture.admission.epoch, fixture.channelId, header, byteArrayOf(3)) {}
        fixture.runQueued(); assertEquals(1, fixture.socket.bytes.size)
        fixture.tick += 125_000_000
        fixture.transport.frame(fixture.admission.epoch, fixture.channelId, header, byteArrayOf(3)) {}
        fixture.runQueued(); assertEquals(2, fixture.socket.bytes.size)
        assertEquals(2L, FrameCodec.decodeRelay(fixture.socket.bytes.last()).first.number("sequence"))
    }
    @Test fun `uncommitted channels cannot send pixels and queued pixels own their buffer`() {
        val fixture = Fixture(); fixture.attach()
        val header = vector("frames").obj("header")
        var delivered = true
        fixture.transport.frame(fixture.admission.epoch, fixture.channelId, header, byteArrayOf(1)) { delivered = it }
        assertFalse(delivered); assertTrue(fixture.queue.isEmpty())
        fixture.transport.closeChannel(fixture.admission.epoch, fixture.channelId)
        fixture.admit()
        val pixels = byteArrayOf(1, 2, 3)
        fixture.transport.frame(fixture.admission.epoch, fixture.channelId, header, pixels) { delivered = it }
        pixels.fill(0)
        fixture.runQueued()
        assertTrue(delivered)
        val inner = FrameCodec.decodeRelay(fixture.socket.bytes.single()).second
        assertArrayEquals(byteArrayOf(1, 2, 3), FrameCodec.split(inner).second)
    }
    @Test fun `captures are single use and neither queued captures nor relay sends survive revocation`() {
        for (revoke in listOf(false, true)) {
            val fixture = Fixture(); fixture.admit()
            val epoch = fixture.admission.epoch
            fixture.transport.receive(JsonObject(fixture.fences.obj("fence") + mapOf("type" to JsonPrimitive("browser.client-message"), "channelId" to JsonPrimitive(fixture.channelId),
                "capability" to fixture.capability, "message" to Wire.fields("type" to JsonPrimitive("cdp.command"), "requestId" to JsonPrimitive("capture"),
                    "command" to Wire.fields("method" to JsonPrimitive("Page.captureScreenshot"))))))
            var delivered: Boolean? = null
            fixture.transport.capture(epoch, fixture.channelId, "capture", byteArrayOf(1)) { delivered = it }
            fixture.transport.capture(epoch, fixture.channelId, "capture", byteArrayOf(2)) {}
            if (revoke) fixture.transport.receive(JsonObject(fixture.fences.obj("fence") + mapOf("type" to JsonPrimitive("capability.revoke"),
                "capability" to fixture.capability, "requestId" to JsonPrimitive("revoke"))))
            fixture.runQueued()
            assertEquals(!revoke, delivered)
            assertEquals(if (revoke) 0 else 1, fixture.socket.text.count { Wire.parse(it)["type"] == JsonPrimitive("browser.server-message") })
            if (revoke) refused { fixture.transport.send(epoch, JsonObject(fixture.fences.obj("fence") + mapOf("type" to JsonPrimitive("browser.closed"), "capability" to fixture.capability))) }
        }
    }
    @Test fun `native relay strips operation authority before JavaScript sees a command`() {
        val fixture = Fixture(); fixture.admit()
        val message = Wire.fields("type" to JsonPrimitive("cdp.command"), "requestId" to JsonPrimitive("request"),
            "command" to Wire.fields("method" to JsonPrimitive("Opensteer.openTab"), "parameters" to Wire.fields("operationAuthority" to JsonPrimitive(fixture.rawToken))))
        fixture.transport.receive(JsonObject(fixture.fences.obj("fence") + mapOf("type" to JsonPrimitive("browser.client-message"), "channelId" to JsonPrimitive(fixture.channelId),
            "capability" to fixture.capability, "message" to message)))
        val event = fixture.events.last()
        assertFalse(event.toString().contains(fixture.rawToken))
        assertTrue(event.containsKey("authorityHandle"))
        assertFalse(event.obj("message").obj("message").obj("command").obj("parameters").containsKey("operationAuthority"))
    }
    @Test fun `refused captures release bounded pending request admission`() {
        val fixture = Fixture(); fixture.admit()
        for (request in 1..33) {
            val requestId = "capture-$request"
            fixture.transport.receive(JsonObject(fixture.fences.obj("fence") + mapOf("type" to JsonPrimitive("browser.client-message"), "channelId" to JsonPrimitive(fixture.channelId),
                "capability" to fixture.capability, "message" to Wire.fields("type" to JsonPrimitive("cdp.command"), "requestId" to JsonPrimitive(requestId),
                    "command" to Wire.fields("method" to JsonPrimitive("Page.captureScreenshot"))))))
            fixture.transport.send(fixture.admission.epoch, JsonObject(fixture.fences.obj("fence") + mapOf("type" to JsonPrimitive("browser.server-message"),
                "channelId" to JsonPrimitive(fixture.channelId), "capability" to fixture.capability, "message" to Wire.fields("type" to JsonPrimitive("cdp.error"), "requestId" to JsonPrimitive(requestId)))))
            var delivered = true
            fixture.transport.capture(fixture.admission.epoch, fixture.channelId, requestId, byteArrayOf(1)) { delivered = it }
            assertFalse(delivered)
        }
    }
}
