package com.opensteer.phoneconnection

import com.opensteer.phoneconnection.core.*
import kotlinx.serialization.json.*
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The session-binding and leave proofs against the TypeScript Host's own
 * vectors. BouncyCastle's Ed25519 is deterministic, so the signature bytes
 * themselves must match the Host's.
 */
class DeviceProofsTest {
    private val vectors = Wire.parse(File(System.getProperty("device.vectors"), "device-proofs.v1.json").readText(), 65536)
    private val seed = vectors.text("runnerSeed").chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun hex(text: String) = text.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) }

    @Test fun `binding transcript and signature match the Host byte for byte`() {
        val bind = vectors.obj("bind")
        val transcript = Proofs.deviceSessionBind(bind.text("deploymentId"), bind.text("runnerId"), bind.text("sessionId"), bind.text("issuedAt"))
        assertEquals(bind.text("transcriptHex", max = 4096), hex(Wire.canonical(transcript)))
        assertEquals(bind.text("signature"), Proofs.sign(seed, transcript))
        assertTrue(verifies(bind.text("signature"), transcript))
    }

    @Test fun `leave transcript and signature match the Host byte for byte`() {
        val leave = vectors.obj("leave")
        val transcript = Proofs.deviceLeave(leave.text("deploymentId"), leave.text("runnerId"), leave.text("issuedAt"))
        assertEquals(leave.text("transcriptHex", max = 4096), hex(Wire.canonical(transcript)))
        assertEquals(leave.text("signature"), Proofs.sign(seed, transcript))
        val bind = vectors.obj("bind")
        assertFalse("A bind signature never passes as a leave", verifies(bind.text("signature"), transcript))
    }

    private fun verifies(signature: String, transcript: JsonArray): Boolean {
        val bytes = Wire.canonical(transcript).toByteArray(Charsets.UTF_8)
        return Ed25519Signer().run {
            init(false, Ed25519PrivateKeyParameters(seed, 0).generatePublicKey()); update(bytes, 0, bytes.size)
            verifySignature(Wire.decode64(signature))
        }
    }
}
