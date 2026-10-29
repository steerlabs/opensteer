package com.opensteer.agentphone.wire

import com.opensteer.agentphone.TestFiles
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Every proof the phone signs, compared with the bytes the Host's own
 * TypeScript produced from the same keys and clock. Ways the phone could
 * disagree with the Host and be refused:
 *
 * 1. a key derived from the seed differently, or spelled differently in PEM
 *    or fingerprinted over something other than its DER SPKI;
 * 2. a transcript with a field missing, in another order, the descriptor's
 *    wire JSON canonicalized wrongly, or arrays reordered;
 * 3. the enrollment token hashed instead of digested as `sha256:<base64url>`;
 * 4. the auxiliary transcript without the ticket digest or the challenged module;
 * 5. padded or standard base64 where the Host reads unpadded base64url.
 */
class ProofVectorsTest {
    private val vectors = TestFiles.vectors as JsonObject
    private val runner = vectors.obj("runner")
    private val auxiliary = vectors.obj("auxiliary")

    private val runnerKey = Ed25519Key.fromSeed(hex(runner.obj("key").string("seed")))

    private val challenge = runner.obj("challenge").let {
        RunnerChallenge(
            challengeId = it.string("challengeId"),
            expiresAt = it.string("expiresAt"),
            hostSessionId = it.string("hostSessionId"),
            nonce = it.string("nonce"),
        )
    }
    private val descriptor = runner.obj("descriptor").let {
        RunnerDescriptor(
            bootId = it.string("bootId"),
            name = it.string("name"),
            runnerId = it.string("runnerId"),
            runtimeVersion = it.string("runtimeVersion"),
        )
    }

    @Test
    fun derivesTheRunnerKeyAsTheHostSpellsIt() {
        val key = runner.obj("key")
        assertEquals(key.string("publicKeyRaw"), runnerKey.publicKeyRaw.toHex())
        assertEquals(key.string("publicKeyPem"), runnerKey.publicKeyPem)
        assertEquals(key.string("fingerprint"), runnerKey.fingerprint)
        assertArrayEquals(hex(key.string("seed")), runnerKey.seed)
    }

    @Test
    fun encodesTheDescriptorFieldForField() {
        assertEquals(runner.fields.getValue("descriptor"), descriptor.toJson())
    }

    @Test
    fun signsAuthenticationAndEnrollmentByteForByte() {
        val enrollment = runner.obj("enrollment")
        assertEquals(runner.string("authentication"), Proofs.runnerAuthentication(runnerKey, challenge, descriptor))
        assertEquals(enrollment.string("enrollmentTokenHash"), Digests.tokenDigest(enrollment.string("enrollmentToken")))
        assertEquals(
            enrollment.string("signature"),
            Proofs.runnerEnrollment(runnerKey, challenge, descriptor, enrollment.string("enrollmentToken")),
        )
    }

    @Test
    fun signsCompleteWireDescriptorsIncludingUnknownFields() {
        val enrollmentToken = runner.obj("enrollment").string("enrollmentToken")
        for (value in (runner.fields.getValue("proofDescriptors") as JsonArray).items) {
            val vector = value as JsonObject
            val wireDescriptor = vector.obj("descriptor")
            assertEquals(vector.string("authentication"), Proofs.runnerAuthentication(runnerKey, challenge, wireDescriptor))
            assertEquals(vector.string("enrollment"), Proofs.runnerEnrollment(runnerKey, challenge, wireDescriptor, enrollmentToken))
        }
    }

    @Test
    fun signsTheAuxiliaryStreamOverTheTicketDigest() {
        val digest = vectors.obj("tokenDigest")
        assertEquals(digest.string("output"), Digests.tokenDigest(digest.string("input")))
        assertEquals(auxiliary.string("ticketDigest"), Digests.tokenDigest(auxiliary.string("ticket")))
        val wireChallenge = auxiliary.obj("challenge")
        val auxiliaryChallenge = AuxiliaryChallenge(
            challengeId = wireChallenge.string("challengeId"),
            expiresAt = wireChallenge.string("expiresAt"),
            hostSessionId = wireChallenge.string("hostSessionId"),
            module = wireChallenge.string("module"),
            nonce = wireChallenge.string("nonce"),
        )
        assertEquals(
            auxiliary.string("signature"),
            Proofs.auxiliary(
                runnerKey,
                auxiliaryChallenge,
                runnerId = descriptor.runnerId,
                bootId = descriptor.bootId,
                ticket = auxiliary.string("ticket"),
            ),
        )
    }

    @Test
    fun encodesUnpaddedBase64Url() {
        assertEquals("-_8", Base64Url.encode(byteArrayOf(0xfb.toByte(), 0xff.toByte())))
        assertArrayEquals(byteArrayOf(0xfb.toByte(), 0xff.toByte()), Base64Url.decode("-_8"))
        for (bad in listOf("-_8=", "+/8", "a", "ab c")) {
            assertThrows("decode of '$bad'", WireException::class.java) { Base64Url.decode(bad) }
        }
    }

    private fun JsonObject.obj(key: String) = fields.getValue(key) as JsonObject
    private fun JsonObject.string(key: String) = (fields.getValue(key) as JsonString).value

    private fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
}
