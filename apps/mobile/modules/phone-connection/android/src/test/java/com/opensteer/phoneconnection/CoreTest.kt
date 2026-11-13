package com.opensteer.phoneconnection

import com.opensteer.phoneconnection.core.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class CoreTest {
    private fun vector(name: String) = Wire.parse(File(System.getProperty("phone.vectors"), "$name.v1.json").readText(), 2_097_152)
    private fun hex(text: String) = text.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun refused(reason: String? = null, operation: () -> Unit) {
        try { operation(); fail("Expected refusal") } catch (error: Refused) { if (reason != null) assertEquals(reason, error.reason) }
    }
    private class Memory : DurableBytes {
        var bytes: ByteArray? = null
        override fun read() = bytes
        override fun write(bytes: ByteArray) { this.bytes = bytes }
    }
    @Test fun `native ticket verifier consumes every portable ticket vector`() {
        val vector = vector("attach-tickets")
        val keys = mapOf("fixture" to AttachTickets.publicKey(vector.text("publicKeyPem", max = 2048)))
        for (entry in vector["cases"]!!.jsonArray) {
            val case = entry.jsonObject
            val accepted = case["accepted"]!!.jsonPrimitive.boolean
            if (accepted) assertEquals(case["claims"] ?: vector.obj("claims"), AttachTickets.verifyToken(case.text("token", max = 16384), vector.text("runtimeId"), vector.number("now"), keys))
            else refused { AttachTickets.verifyToken(case.text("token", max = 16384), vector.text("runtimeId"), vector.number("now"), keys) }
        }
    }
    @Test fun `native browser descriptor is the one JavaScript writes`() {
        val android = vector("phone-descriptors").obj("android")
        assertEquals(android.obj("browser"), BrowserDescriptor.from(android.obj("qualification")))
        refused("unsupported") { BrowserDescriptor.from(JsonObject(android.obj("qualification") + ("sharedControl" to JsonPrimitive(false)))) }
    }
    @Test fun `native auxiliary state consumes shared fences and refuses expired equal fences`() {
        val vector = vector("fences")
        var now = vector.number("now")
        val lease = AuxiliaryLease { now }
        lease.adopt(vector.obj("welcome"))
        for (entry in vector["comparisons"]!!.jsonArray) {
            val case = entry.jsonObject
            assertEquals(case["accepted"]!!.jsonPrimitive.boolean, lease.accepts(Fence.auxiliary(JsonObject(vector.obj("fence") + case.obj("patch")))))
        }
        val fence = lease.fence!!
        lease.requireCurrent(fence)
        now += 1000
        assertTrue(lease.accepts(fence)); assertTrue(lease.expired)
        refused("retired-stream") { lease.requireCurrent(fence) }
        lease.release(); assertFalse(lease.accepts(fence))
    }
    @Test fun `native replay ledger consumes ordered shared transitions`() {
        val vector = vector("fences").obj("replay")
        var state = ReplayState.parse(vector.obj("initial"), 4096)
        for (entry in vector["cases"]!!.jsonArray) {
            val case = entry.jsonObject
            val expires = if (case.containsKey("expiresAt")) case.number("expiresAt") else vector.number("expiresAt")
            if (case["accepted"]!!.jsonPrimitive.boolean) state = state.claim(case.text("nonce"), expires, case.number("now"), 4096)
            else refused(case.text("error")) { state.claim(case.text("nonce"), expires, case.number("now"), 4096) }
        }
    }
    @Test fun `native frame writer matches both exact portable envelopes and invalid bytes`() {
        val vector = vector("frames")
        val frame = hex(vector.text("envelopeHex", max = 100000))
        assertArrayEquals(frame, FrameCodec.envelope(vector.obj("header"), hex(vector.text("payloadHex"))))
        val relay = hex(vector.text("relayEnvelopeHex", max = 100000))
        assertArrayEquals(relay, FrameCodec.relay(vector.obj("relayHeader"), frame))
        assertArrayEquals(frame, FrameCodec.decodeRelay(relay).second)
        for (entry in vector["invalidHex"]!!.jsonArray) refused { FrameCodec.validateFrame(hex(entry.jsonPrimitive.content)) }
        refused { FrameCodec.validateFrame(ByteArray(FrameCodec.MAX_FRAME + 1)) }
    }
    @Test fun `ledger is fail closed across loss corruption restart capacity and concurrent witnesses`() {
        val memory = Memory()
        val ledger = ReplayLedger(memory, 1)
        refused("unavailable") { ledger.read() }
        ledger.initialize()
        val initial = ledger.read()
        val nonce = "test-single-use-nonce"
        val next = initial.claim(nonce, 2000, 1000, 1)
        ledger.commit(initial, next, nonce, 2000, 1000)
        val restarted = ReplayLedger(memory, 1)
        assertEquals(next, restarted.read())
        refused("already-used") { restarted.read().claim(nonce, 2000, 1000, 1) }
        refused("full") { restarted.read().claim("another-test-nonce", 2000, 1000, 1) }
        refused("unavailable") { restarted.commit(initial, next, nonce, 2000, 1000) }
        memory.bytes = "broken".toByteArray()
        refused("unavailable") { restarted.read() }
        memory.bytes = null
        refused("unavailable") { restarted.read() }
    }
    @Test fun `wire rejects wrong primitive malformed text and noncanonical base64`() {
        refused { Wire.parse("[]") }; refused { Wire.parse("\uFEFF{}") }
        refused { Wire.parse("{broken}") }; refused { Wire.parse("{'hello':1}") }
        refused { Wire.parse("{\"value\":\"1\"}").number("value") }
        refused { Wire.parse("{\"value\":1.5}").number("value") }
        refused { Wire.decode64("Zg==") }; refused { Wire.decode64("Zh") }
        assertEquals("f", Wire.decode(Wire.decode64("Zg")))
    }
    @Test fun `wire accepts protocol ISO variants without accepting invalid calendar dates or epoch overflow`() {
        fun timestamp(value: String) = Wire.fields("at" to JsonPrimitive(value)).time("at")
        val at = timestamp("2026-11-09T12:00:00.000Z")
        assertEquals(at, timestamp("2026-11-09T12:00Z"))
        assertEquals(at, timestamp("2026-11-09T13:00:00.000000+01:00"))
        refused { timestamp("2026-02-30T12:00Z") }
        refused { timestamp("2026-11-09T24:00Z") }
        refused { Wire.parse("{\"epoch\":4294967296}").number("epoch", max = Int.MAX_VALUE.toLong()) }
        assertEquals(1000L, Wire.parse("{\"value\":1e3}").number("value"))
    }
    @Test fun `atomic ledger survives new instances and a failed fsync never grants allocation`() {
        val directory = java.nio.file.Files.createTempDirectory("phone-ledger-test").toFile()
        try {
            val file = File(directory, "replay")
            var directorySyncs = 0
            fun storage() = AtomicBytes(file) { directorySyncs += 1 }
            val ledger = ReplayLedger(storage()); ledger.initialize()
            val state = ledger.read()
            val nonce = "durable-single-use-nonce"
            ledger.commit(state, state.claim(nonce, 2000, 1000, 4096), nonce, 2000, 1000)
            refused("already-used") { ReplayLedger(storage()).read().claim(nonce, 2000, 1000, 4096) }
            assertEquals(2, directorySyncs)
            val failed = ReplayLedger(AtomicBytes(file) { throw Refused("unavailable") })
            val next = failed.read()
            refused { failed.commit(next, next.claim("failed-sync-nonce", 2000, 1000, 4096), "failed-sync-nonce", 2000, 1000) }
            refused("already-used") { ReplayLedger(storage()).read().claim("failed-sync-nonce", 2000, 1000, 4096) }
        } finally { directory.deleteRecursively() }
    }
    @Test fun `primary and auxiliary proofs pin challenge descriptor module and credential digest`() {
        val challenge = Wire.parse("""{"type":"host.challenge","challengeId":"rch_11111111-1111-4111-8111-111111111111","nonce":"11111111111111111111111111111111","hostSessionId":"22222222222222222222222222222222","expiresAt":"2026-11-09T12:00:01.000Z","proofFormatVersion":2}""")
        val descriptor = Wire.parse("""{"name":"Phone","modules":{"browser":{"wireVersion":2,"runtimeId":"phone"}}}""")
        val proof = Proofs.primary(challenge, descriptor, "fingerprint", "disposable-enrollment")
        val transcript = Wire.canonical(proof)
        assertTrue(transcript.startsWith("[\"opensteer-runner-enroll-v2\",\"challengeId\",\"rch_11111111-1111-4111-8111-111111111111\""))
        assertTrue(transcript.contains("\"descriptor\",{\"modules\":{\"browser\":{\"runtimeId\":\"phone\",\"wireVersion\":2}},\"name\":\"Phone\"}"))
        assertEquals(JsonPrimitive(Wire.digest("disposable-enrollment".toByteArray())), proof.last())
        assertFalse(transcript.contains("disposable-enrollment"))
        val authentication = Proofs.primary(challenge, descriptor, "fingerprint", null)
        assertEquals(JsonPrimitive("opensteer-runner-auth-v2"), authentication.first())
        assertEquals(descriptor, authentication.last())
        refused("needs-update") { Proofs.primary(JsonObject(challenge - "proofFormatVersion"), descriptor, "fingerprint", null) }
        val auxiliary = JsonObject((challenge - "proofFormatVersion") + mapOf("type" to JsonPrimitive("host.auxiliary.challenge"), "module" to JsonPrimitive("browser")))
        val auxProof = Proofs.auxiliary(auxiliary, "runner", "boot", "disposable-auxiliary")
        assertEquals(JsonPrimitive("opensteer-runner-auxiliary-v1"), auxProof.first())
        assertEquals(JsonPrimitive(Wire.digest("disposable-auxiliary".toByteArray())), auxProof.last())
        refused { Proofs.auxiliary(JsonObject(auxiliary + ("module" to JsonPrimitive("integrations"))), "runner", "boot", "disposable-auxiliary") }
        refused { Proofs.origin("https://user:password@host.example.test") }
        refused { Proofs.origin("http://host.example.test") }
        refused { Proofs.origin("https://127.0.0.1") }
        assertEquals("https://host.example.test", Proofs.origin("https://host.example.test/"))
    }
}
