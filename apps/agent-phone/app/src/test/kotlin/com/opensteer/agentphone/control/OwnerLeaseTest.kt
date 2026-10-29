package com.opensteer.agentphone.control

import org.junit.Assert.*
import org.junit.Test

/** Failure list: stale barriers reopen admission, mismatched input, release lets old queued input through. */
class OwnerLeaseTest {
    @Test fun barriersFenceAcquireReleaseAndInput() {
        val barriers = ArrayList<() -> Unit>(); val reports = ArrayList<String>(); var blocked = false
        val lease = OwnerLease({ blocked = it }, { _, done -> barriers += done }, { done -> barriers += done },
            { done -> done() }, { _, _, state, _ -> reports += state })
        lease.acquire("session", "first")
        assertTrue(blocked)
        assertFalse(lease.accept("session", "first", 1, 0, 1))
        barriers.removeAt(0)()
        assertEquals(listOf("held"), reports)
        assertTrue(lease.accept("session", "first", 1, 0, 1))
        assertFalse(lease.accept("session", "first", 1, 0, 1))
        assertFalse(lease.accept("session", "first", 1, 1, 2))
        assertFalse(lease.accept("other", "first", 1, 1, 1))
        val stamp = lease.stamp
        lease.release("released-by-owner")
        assertFalse(lease.current(stamp))
        assertTrue(blocked)
        barriers.removeAt(0)()
        assertFalse(blocked)
        assertEquals(listOf("held", "released"), reports)
    }
    @Test fun lateAcquireCannotHoldAfterReleaseOrAffectReplacement() {
        val barriers = ArrayList<() -> Unit>(); val reports = ArrayList<String>(); var blocked = false
        val lease = OwnerLease({ blocked = it }, { _, done -> barriers += done }, { done -> barriers += done },
            { done -> done() }, { _, _, state, _ -> reports += state })
        lease.acquire("session", "first")
        lease.release("paused")
        barriers.removeAt(0)()
        assertTrue(reports.isEmpty())
        barriers.removeAt(0)()
        assertFalse(blocked)
        lease.acquire("session", "next"); barriers.removeAt(0)()
        lease.acquire("session", "other")
        assertEquals(listOf("released", "held", "refused"), reports)
        assertTrue(blocked)
    }
    @Test fun duplicateAcquireKeepsItsPendingBarrierAndReleaseReport() {
        val barriers = ArrayList<() -> Unit>(); val reports = ArrayList<String>()
        val lease = OwnerLease({}, { _, done -> barriers += done }, { done -> barriers += done },
            { done -> done() }, { _, _, state, _ -> reports += state })
        lease.acquire("session", "same")
        lease.acquire("session", "same")
        assertTrue(reports.isEmpty())
        barriers.removeAt(0)()
        lease.release("released-by-owner")
        lease.acquire("session", "same")
        barriers.removeAt(0)()
        assertEquals(listOf("held", "released"), reports)
        barriers.removeAt(0)()
        assertEquals(listOf("held", "released", "held"), reports)
    }

    @Test fun newAcquireWaitsBehindPendingRelease() {
        val barriers = ArrayList<() -> Unit>(); val reports = ArrayList<String>()
        val lease = OwnerLease({}, { _, done -> barriers += done }, { done -> barriers += done }, { it() },
            { _, id, state, _ -> reports += "$id:$state" })
        lease.acquire("s", "first"); barriers.removeAt(0)()
        lease.release("released-by-owner"); lease.acquire("s", "next")
        assertEquals(listOf("first:held"), reports)
        barriers.removeAt(0)()
        assertEquals(listOf("first:held", "first:released"), reports)
        barriers.removeAt(0)()
        assertEquals(listOf("first:held", "first:released", "next:held"), reports)
    }
}
