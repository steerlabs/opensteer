package com.opensteer.phoneconnection

import com.opensteer.phoneconnection.core.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DeviceLeavesTest {
    private class Memory : DurableBytes {
        var bytes: ByteArray? = null
        var fail = false
        override fun read() = bytes
        override fun write(bytes: ByteArray) { if (fail) throw Refused("storage-unavailable"); this.bytes = bytes }
    }
    private fun leave(runner: String) = Wire.fields("version" to JsonPrimitive(1), "deploymentId" to JsonPrimitive("dep_home"),
        "runnerId" to JsonPrimitive(runner), "hostUrl" to JsonPrimitive("https://home.example"),
        "issuedAt" to JsonPrimitive("2026-11-12T18:30:00.000Z"), "signature" to JsonPrimitive("proof"))
    @Test fun enrollmentPinsThePreparedIdentityOnlyOnCapableHosts() {
        val access = Wire.fields("browser" to JsonPrimitive(false), "apps" to JsonPrimitive(false), "files" to JsonPrimitive(false))
        val command = Proofs.phoneEnrollment("attempt", "Phone", "rnr_one", "public-key", true, access)
        assertEquals(Wire.fields("runnerId" to JsonPrimitive("rnr_one"), "publicKeyPem" to JsonPrimitive("public-key")), command.obj("preparedIdentity"))
        assertEquals(access, command.obj("access"))
        val legacy = Proofs.phoneEnrollment("attempt", "Phone", "rnr_one", "public-key", false, access)
        assertFalse(legacy.containsKey("preparedIdentity"))
        assertFalse(legacy.containsKey("access"))
    }
    @Test fun preparedLeaveRetainsPublicKeyAndLegacyMintReceiptAfterErasure() {
        for (devicesV1 in listOf(true, false)) {
            val identity = JsonObject(leave("rnr_one") + mapOf("state" to JsonPrimitive("prepared"), "devicesV1" to JsonPrimitive(devicesV1),
                "mintKey" to JsonPrimitive("android-enroll:stable"), "name" to JsonPrimitive("Pixel")))
            val bytes = Memory()
            val obligation = DeviceLeaves.obligation(identity, "public-key", identity.text("issuedAt"), "signature")
            DeviceLeaves(bytes).persist(obligation)
            val survived = DeviceLeaves(bytes).pending().single()
            assertEquals("android-enroll:stable", survived.text("mintKey"))
            assertEquals("Pixel", survived.text("name"))
            if (devicesV1) assertEquals(Wire.fields("runnerId" to JsonPrimitive("rnr_one"), "publicKeyPem" to JsonPrimitive("public-key")), survived.obj("preparedIdentity"))
            else assertEquals(JsonNull, survived["preparedIdentity"])
            assertFalse(survived.containsKey("seed"))
        }
    }
    @Test fun successiveLeavesSurviveRestartAndNeedSeparateAcknowledgments() {
        val bytes = Memory()
        val ledger = DeviceLeaves(bytes)
        ledger.persist(leave("rnr_one")); ledger.persist(leave("rnr_two"))
        val restarted = DeviceLeaves(bytes)
        assertEquals(listOf(leave("rnr_one"), leave("rnr_two")), restarted.pending())
        restarted.complete("rnr_two")
        assertEquals(listOf(leave("rnr_one")), restarted.pending())
        restarted.complete("rnr_one")
        assertTrue(restarted.pending().isEmpty())
    }
    @Test fun failedSigningOrPersistenceFencesWithoutErasing() {
        val bytes = Memory().apply { fail = true }
        var fenced = false
        var erased = false
        assertThrows(Refused::class.java) { DeviceLeaves(bytes).leave({ fenced = true }, { leave("rnr_one") }, { erased = true }) }
        assertTrue(fenced); assertFalse(erased)
        bytes.fail = false
        assertThrows(Refused::class.java) { DeviceLeaves(bytes).leave({}, { throw Refused("sign-failed") }, { erased = true }) }
        assertFalse(erased)
    }
}
