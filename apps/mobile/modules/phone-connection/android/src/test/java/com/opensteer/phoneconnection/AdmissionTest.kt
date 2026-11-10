package com.opensteer.phoneconnection

import com.opensteer.phoneconnection.core.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.CompletableFuture

class AdmissionTest {
    private fun vector() = Wire.parse(File(System.getProperty("phone.vectors"), "fences.v1.json").readText())
    private fun refused(block: () -> Unit) {
        try { block(); fail("Retired work executed") } catch (_: Refused) { }
    }
    @Test fun `queued operations cannot cross epoch stream lease or capability retirement`() {
        var now = vector().number("now")
        val admission = Admission({ now })
        val fence = admission.adopt(vector().obj("welcome"))
        admission.active = true
        val epoch = admission.epoch
        admission.acceptCapability(Wire.parse("""{"runtimeId":"phone","capabilityGeneration":1,"capabilityLeaseId":"bcl_11111111-1111-4111-8111-111111111111","expiresAt":"2026-11-09T12:00:00.500Z"}"""))
        val capability = admission.capability!!
        val queued = { admission.requireCurrent(epoch, fence, capability) }
        queued()
        admission.advance()
        refused(queued)
        admission.acceptCapability(Wire.parse("""{"runtimeId":"phone","capabilityGeneration":2,"capabilityLeaseId":"bcl_22222222-2222-4222-8222-222222222222","expiresAt":"2026-11-09T12:00:00.500Z"}"""))
        refused { admission.requireCurrent(admission.epoch, fence, capability) }
        now += 500
        refused { admission.requireCurrent(admission.epoch, fence, admission.capability) }
        now += 500
        refused { admission.requireCurrent(admission.epoch, fence) }
    }
    @Test fun `frame credit is single outstanding and cannot be refunded by another channel token`() {
        val credit = FrameCredit()
        assertTrue(credit.reserve("one"))
        assertFalse(credit.reserve("two"))
        credit.ack("wrong")
        assertFalse(credit.reserve("two"))
        credit.ack("one")
        assertTrue(credit.reserve("two"))
        credit.close()
        assertFalse(credit.reserve("three"))
    }
    @Test fun `an expired primary lease refuses an otherwise live auxiliary fence`() {
        val now = vector().number("now")
        var primary = true
        val admission = Admission({ now }, { primary }).apply { active = true }
        val fence = admission.adopt(vector().obj("welcome"))
        admission.requireCurrent(admission.epoch, fence)
        primary = false
        refused { admission.requireCurrent(admission.epoch, fence) }
    }
    @Test fun `retirement persists deny before erasure and retains pending restart or failure`() {
        val calls = mutableListOf<String>()
        var persisted: String? = null
        val retirement = Retirement(
            persist = { persisted = it; calls.add("deny") },
            fence = { calls.add("fence") },
            erase = { calls.add("erase"); CompletableFuture.completedFuture(false) },
            forget = { calls.add("forget") },
        )
        retirement.begin("deployment")
        assertEquals(listOf("deny", "fence"), calls)
        assertFalse(retirement.finish("deployment").join())
        assertEquals("deployment", persisted)
        assertEquals(listOf("deny", "fence", "erase"), calls)
        val failed = Retirement({ calls.add("deny") }, { calls.add("fence") }, { throw Refused("unavailable") }, { calls.add("forget") })
        failed.begin("deployment")
        refused { failed.finish("deployment") }
        assertFalse(calls.contains("forget"))
        calls.clear()
        val complete = Retirement({ calls.add("deny") }, { calls.add("fence") }, { calls.add("erase"); CompletableFuture.completedFuture(true) }, { calls.add("forget") })
        complete.begin("deployment")
        assertTrue(complete.finish("deployment").join())
        assertEquals(listOf("deny", "fence", "erase", "forget"), calls)
        calls.clear()
        val unavailable = Retirement({ throw Refused("unavailable") }, { calls.add("fence") }, { CompletableFuture.completedFuture(true) }, { calls.add("forget") })
        refused { unavailable.begin("deployment") }
        assertEquals(listOf("fence"), calls)
    }
}
