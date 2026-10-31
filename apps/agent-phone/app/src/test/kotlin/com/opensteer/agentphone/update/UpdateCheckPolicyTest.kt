package com.opensteer.agentphone.update

import com.opensteer.agentphone.runner.PhoneUpdateResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

class UpdateCheckPolicyTest {
    @Test
    fun cancellationAfterTheCheckStartedIsPendingAndTheNextAttemptChecksAgain() {
        val policy = UpdateCheckPolicy()
        assertTrue(policy.begin("phone host", 1_000, required = false, pending = false))
        var cancelled = false
        val takeCancelled = { cancelled.also { cancelled = false } }
        assertNull(policy.cancellation(takeCancelled))
        // Android can decline after the initial cancellation check, including while a failure unwinds.
        cancelled = true
        assertEquals(PhoneUpdateResult.Pending("Update cancelled. Opensteer will try again."), policy.cancellation(takeCancelled))
        assertNull(policy.cancellation(takeCancelled))
        assertTrue("a cancelled check must not occupy the six-hour cache", policy.begin("phone host", 1_001, required = false, pending = false))
    }

    @Test
    fun completedChecksAreCachedButPendingRequiredAndChangedTargetsAreChecked() {
        val policy = UpdateCheckPolicy()
        assertTrue(policy.begin("phone host", 1_000, required = false, pending = false))
        assertNull(policy.cancellation { false })
        assertFalse(policy.begin("phone host", 1_001, required = false, pending = false))
        assertTrue(policy.begin("phone host", 1_002, required = false, pending = true))
        assertTrue(policy.begin("phone host", 1_003, required = true, pending = false))
        assertTrue(policy.begin("phone another-host", 1_004, required = false, pending = false))
        assertTrue(policy.begin("phone another-host", 1_004 + TimeUnit.HOURS.toMillis(6), required = false, pending = false))
    }
}
