package com.opensteer.agentphone.control

import org.junit.Assert.*
import org.junit.Test

/** Failure cases: capture renews authority, stale close ends a replacement, expiry/close revives, wrong display captures, state is unbounded. */
class OwnerViewLeasesTest {
    @Test fun staleOperationsNeverReviveOrCloseReplacement() {
        val leases = OwnerViewLeases()
        assertTrue(leases.open("v", 1, "main", 100, 0))
        assertEquals(null, leases.unavailable("v", 1, "main", 50))
        assertFalse(leases.open("v", 1, "other", 100, 0))
        assertTrue(leases.close("v", 1))
        assertFalse(leases.open("v", 1, "main", 100, 0))
        assertTrue(leases.open("v", 2, "main", 100, 0))
        assertFalse(leases.close("v", 1))
        assertEquals(null, leases.unavailable("v", 2, "main", 99))
        assertEquals("expired", leases.unavailable("v", 2, "main", 100))
        assertFalse(leases.renew("v", 2, "main", 200, 100))
        leases.clear()
        assertEquals("ended", leases.unavailable("v", 2, "main", 0))
    }
}
