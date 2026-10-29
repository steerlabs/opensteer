package com.opensteer.agentphone.wire

import com.opensteer.agentphone.TestFiles
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.util.concurrent.Executors
import java.util.concurrent.Callable
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/** Shared immutable oracle: these tests never write or regenerate the vectors. */
object LoginVectors {
    val cases: List<JsonObject> = ((JsonText.parse(TestFiles.repositoryRoot.resolve("packages/protocol/fixtures/login-envelope-v1.json").readText()) as JsonObject).fields.getValue("vectors") as JsonArray).items.map { it as JsonObject }
    val valid get() = cases.first()
    fun binding(vector: JsonObject = valid) = LoginBinding.decode(vector.fields.getValue("expectedBinding"))
    fun envelope(vector: JsonObject = valid) = SealedLoginEnvelope.decode(vector.fields.getValue("envelope"))
    fun now(vector: JsonObject = valid) = (vector.fields.getValue("now") as JsonNumber).value.toLong()
    fun receiver(vector: JsonObject = valid, clock: () -> Long = { now(vector) }): LoginTextReceiver {
        val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
        val scalar = Base64Url.decode((vector.fields.getValue("receiverPrivateKey") as JsonString).value)
        val key = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, scalar), params))
        val receiver = vector.fields.getValue("receiver") as JsonObject
        return LoginTextReceiver(key, receiver, clock)
    }
}

/** Failures: byte/curve/AAD/UTF-8 disagreement, tampering, wrong context/key and deadline boundary. */
@RunWith(Parameterized::class)
class LoginEnvelopeVectorTest(private val vector: JsonObject) {
    @Test fun consumesSharedOracle() {
        val receiver = LoginVectors.receiver(vector)
        val fields = vector.fields
        if ((fields.getValue("expected") as JsonString).value == "reject") {
            assertThrows(LoginTextException::class.java) {
                receiver.preflight(listOf(LoginVectors.envelope(vector) to LoginVectors.binding(vector)))
            }
        } else {
            val binding = LoginVectors.binding(vector)
            assertEquals((fields.getValue("aad") as JsonString).value, CanonicalJson.encode(binding.toJson()))
            val prepared = receiver.preflight(listOf(LoginVectors.envelope(vector) to binding)).single()
            prepared.useText { assertTrue(it.concatToString() == (fields.getValue("plaintext") as JsonString).value) }
        }
        receiver.invalidate()
    }
    companion object {
        @JvmStatic @Parameterized.Parameters(name = "vector {index}")
        fun vectors() = LoginVectors.cases.map { arrayOf(it) }
    }
}

/** Failures: partial batch, simultaneous replay, rollback revival, reused prepared value and stale connection. */
class LoginTextReceiverTest {
    @Test fun comparesEveryIndependentBindingMember() {
        val b = LoginVectors.binding()
        val mutations = listOf(b.copy(connectionId = "other"), b.copy(connectionGeneration = 8), b.copy(runId = "run_00000000-0000-4000-8000-000000000009"), b.copy(sessionId = "cus_00000000-0000-4000-8000-000000000009"), b.copy(actId = "other"), b.copy(actionIndex = 1), b.copy(field = "username"), b.copy(expiresAt = b.expiresAt - 1))
        for (expected in mutations) assertThrows(LoginTextException::class.java) {
            LoginVectors.receiver().preflight(listOf(LoginVectors.envelope() to expected))
        }
    }

    @Test fun refusesMalformedAndExtraEnvelopeFields() {
        val raw = LoginVectors.valid.fields.getValue("envelope") as JsonObject
        val invalid = listOf(
            JsonObject(raw.fields + ("unexpected" to jsonOf(true))),
            JsonObject(raw.fields + ("nonce" to jsonOf("AA=="))),
            JsonObject(raw.fields + ("senderPublicKey" to jsonOf(Base64Url.encode(ByteArray(65))))),
            JsonObject(raw.fields + ("salt" to jsonOf("A"))),
            JsonObject(raw.fields + ("ciphertext" to jsonOf(Base64Url.encode(ByteArray(16385))))),
        )
        for (value in invalid) assertThrows(LoginTextException::class.java) { SealedLoginEnvelope.decode(value) }
    }

    @Test fun failedBatchClaimsNothingAndDuplicateBatchRunsNothing() {
        val receiver = LoginVectors.receiver()
        val good = LoginVectors.envelope() to LoginVectors.binding()
        val bad = LoginVectors.cases.first { (it.fields.getValue("name") as JsonString).value == "tampered-tag" }
        assertThrows(LoginTextException::class.java) { receiver.preflight(listOf(good, LoginVectors.envelope(bad) to LoginVectors.binding(bad))) }
        assertThrows(LoginTextException::class.java) { receiver.preflight(listOf(good, good)) }
        receiver.preflight(listOf(good)).single().useText { assertTrue(it.isNotEmpty()) }
        assertThrows(LoginTextException::class.java) { receiver.preflight(listOf(good)) }
    }

    @Test fun claimsReplayAtomically() {
        val receiver = LoginVectors.receiver()
        val pool = Executors.newFixedThreadPool(8)
        try {
            val results = pool.invokeAll((1..16).map { Callable {
                try { receiver.preflight(listOf(LoginVectors.envelope() to LoginVectors.binding())); true }
                catch (_: LoginTextException) { false }
            } }).map { it.get() }
            assertEquals(1, results.count { it })
        } finally { pool.shutdownNow() }
    }

    @Test fun expiryRollbackAndConnectionLossCannotRevivePreparedText() {
        var now = LoginVectors.now()
        val receiver = LoginVectors.receiver(clock = { now })
        val prepared = receiver.preflight(listOf(LoginVectors.envelope() to LoginVectors.binding())).single()
        now = LoginVectors.binding().expiresAt
        assertThrows(LoginTextException::class.java) { prepared.useText { fail("Expired text reached typing") } }
        now = LoginVectors.now()
        assertThrows(LoginTextException::class.java) { receiver.preflight(listOf(LoginVectors.envelope() to LoginVectors.binding())) }
        val fresh = LoginVectors.receiver()
        val queued = fresh.preflight(listOf(LoginVectors.envelope() to LoginVectors.binding())).single()
        fresh.invalidate()
        assertThrows(LoginTextException::class.java) { queued.useText { fail("Disconnected text reached typing") } }
    }

    @Test fun preparedTextIsSingleUseAndClearedAfterTyping() {
        val prepared = LoginVectors.receiver().preflight(listOf(LoginVectors.envelope() to LoginVectors.binding())).single()
        var buffer: CharArray? = null
        prepared.useText { buffer = it }
        assertTrue(buffer!!.all { it == '\u0000' })
        assertThrows(LoginTextException::class.java) { prepared.useText { fail("Reused text reached typing") } }
    }

    @Test fun receiverChecksExpiryAndDispatchDeadlineIndependently() {
        val binding = LoginVectors.binding()
        val envelope = LoginVectors.envelope()
        val behind = LoginVectors.receiver(clock = { binding.expiresAt - 60001 })
        behind.preflight(listOf(envelope to binding), binding.expiresAt - 1).single().useText {
            assertTrue(it.isNotEmpty())
        }
        val now = LoginVectors.now()
        for (deadline in listOf(now - 1, now)) {
            val error = assertThrows(LoginTextException::class.java) {
                LoginVectors.receiver().preflight(listOf(envelope to binding), deadline)
            }
            assertTrue(error.message!!.contains("act deadline"))
        }
        var current = now
        val receiver = LoginVectors.receiver(clock = { current })
        val prepared = receiver.preflight(listOf(envelope to binding), now + 1).single()
        current += 1
        val error = assertThrows(LoginTextException::class.java) {
            prepared.useText { fail("Expired act reached typing") }
        }
        assertTrue(error.message!!.contains("act deadline"))
    }

    @Test fun rejectsAuthenticatedInvalidUtf8AndOversizeValuesButAcceptsTheLimit() {
        val original = LoginVectors.envelope()
        fun seal(bytes: ByteArray): SealedLoginEnvelope {
            val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
            val key = Base64Url.decode((LoginVectors.valid.fields.getValue("derivedKey") as JsonString).value)
            try {
                cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, javax.crypto.spec.SecretKeySpec(key, "AES"), javax.crypto.spec.GCMParameterSpec(128, original.nonce))
                cipher.updateAAD(CanonicalJson.encode(original.binding.toJson()).toByteArray(Charsets.UTF_8))
                val sealed = cipher.doFinal(bytes)
                return original.copy(ciphertext = sealed.copyOfRange(0, sealed.size - 16), tag = sealed.takeLast(16).toByteArray())
            } finally { key.fill(0); bytes.fill(0) }
        }
        // Only fixed synthetic oracle keys are used; no shared fixture is regenerated.
        for (invalid in listOf(byteArrayOf(0xc3.toByte(), 0x28), ByteArray(4097) { 65 })) {
            assertThrows(LoginTextException::class.java) { LoginVectors.receiver().preflight(listOf(seal(invalid) to original.binding)) }
        }
        val maximum = seal(ByteArray(4096) { 65 })
        LoginVectors.receiver().preflight(listOf(maximum to original.binding)).single().useText { assertEquals(4096, it.size) }
    }

    @Test fun generatesFreshUncompressedConnectionKeys() {
        val a = LoginTextReceiver.generate("connection", 1) { LoginVectors.now() }
        val b = LoginTextReceiver.generate("connection", 2) { LoginVectors.now() }
        val publicA = (a.key.fields.getValue("publicKey") as JsonString).value
        assertEquals(65, Base64Url.decode(publicA).size)
        assertEquals(4, Base64Url.decode(publicA)[0].toInt())
        assertNotEquals(a.key, b.key)
        a.invalidate(); b.invalidate()
    }
}

/** Failures: reference/mixed input, missing/lying context, new status sent to an old Host or a stale stream key. */
class LoginTextWireTest {
    private fun params(text: Json, context: Json? = null): JsonObject = JsonObject(linkedMapOf<String, Json>(
        "observationId" to jsonOf("obs_test"), "includeScreenshot" to jsonOf(false),
        "actions" to jsonArray(jsonObject("type" to jsonOf("type"), "text" to text)),
    ).also { if (context != null) it["loginContext"] = context })

    @Test fun strictDispatchRequiresMatchingContextAndRejectsAgentReferences() {
        val b = LoginVectors.binding()
        val sealed = jsonObject("sealed" to LoginVectors.valid.fields.getValue("envelope"))
        val context = jsonObject("runId" to jsonOf(b.runId), "actId" to jsonOf(b.actId))
        val decoded = AndroidPhoneWire.decodeActParams(params(sealed, context))
        assertTrue((decoded.actions.single() as PhoneAction.Type).text is PhoneText.Saved)
        val invalid = listOf(
            params(sealed), params(sealed, jsonObject("runId" to jsonOf(b.runId), "actId" to jsonOf("other"))),
            params(jsonObject("sealed" to LoginVectors.valid.fields.getValue("envelope"), "loginRef" to jsonOf("lgn_" + "a".repeat(32))), context),
            params(jsonObject("loginRef" to jsonOf("lgn_" + "a".repeat(32)), "field" to jsonOf("password")), context),
        )
        for (value in invalid) assertThrows(WireException::class.java) { AndroidPhoneWire.decodeActParams(value) }
    }

    @Test fun queueTimeDoesNotExtendTheOriginalHostDeadline() {
        val phone = com.opensteer.agentphone.runner.FakePhone()
        val module = com.opensteer.agentphone.runner.IntegrationsModule(com.opensteer.agentphone.runner.StreamOutbox(), phone, com.opensteer.agentphone.runner.MemoryJournal(), { false }, {})
        val stream = com.opensteer.agentphone.runner.RecordingStream()
        val base = LoginVectors.now()
        module.attach(stream, loginText = true, hostClock = com.opensteer.agentphone.runner.HostClock { 5000 }.apply { adopt(base, 0) })
        val b = LoginVectors.binding()
        module.handle(IntegrationsMessage.ComputerUse(stream.fence, "read-write", "android-phone", "act", jsonObject(
            "observationId" to jsonOf("obs_test"), "includeScreenshot" to jsonOf(false), "actions" to jsonArray(jsonObject("type" to jsonOf("wake"))),
        ), b.actId, b.runId, b.sessionId, null, 10000), receivedAt = 1000)
        assertEquals(base + 11000, phone.running.single().call.loginDispatch!!.deadline)
        module.detach()
    }

    @Test fun connectionStatusAnnouncesOnlyNegotiatedLiveKeyAndInvalidatesIt() {
        val phone = com.opensteer.agentphone.runner.FakePhone()
        val outbox = com.opensteer.agentphone.runner.StreamOutbox()
        val module = com.opensteer.agentphone.runner.IntegrationsModule(outbox, phone, com.opensteer.agentphone.runner.MemoryJournal(), { false }, {})
        val legacy = com.opensteer.agentphone.runner.RecordingStream()
        module.attach(legacy)
        assertTrue(legacy.sent.none { "loginText" in it.fields })
        val modern = com.opensteer.agentphone.runner.RecordingStream()
        module.attach(modern, loginText = true, hostClock = com.opensteer.agentphone.runner.HostClock { 0 }.apply { adopt(LoginVectors.now(), 0) })
        val announced = modern.sent.first().fields.getValue("loginText") as JsonObject
        assertEquals(jsonOf(modern.fence.auxiliaryStreamId), announced.fields["connectionId"])
        assertEquals(jsonOf(modern.fence.fence.connectionGeneration), announced.fields["connectionGeneration"])
        module.detach()
        val next = com.opensteer.agentphone.runner.RecordingStream()
        module.attach(next, loginText = true, hostClock = com.opensteer.agentphone.runner.HostClock { 0 }.apply { adopt(LoginVectors.now(), 0) })
        assertNotEquals(announced.fields["publicKey"], (next.sent.first().fields.getValue("loginText") as JsonObject).fields["publicKey"])
        module.detach()
    }
}
