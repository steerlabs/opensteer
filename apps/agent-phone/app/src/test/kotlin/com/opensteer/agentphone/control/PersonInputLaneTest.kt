package com.opensteer.agentphone.control

import org.junit.Assert.*
import org.junit.Test

class PersonInputLaneTest {
    @Test fun resetDropsQueuedInputAndWaitsForCleanupBeforeTheNextBatch() {
        val work = ArrayDeque<() -> Unit>(); val clean = ArrayDeque<() -> Unit>(); val seen = ArrayList<String>()
        val lane = PersonInputLane({ work += it }, { seen += "cancel" }, { clean += it })
        val stream = PersonInputLane.Stream()
        fun batch(sequence: Long) = lane.submit(stream, sequence, 1, 1, 100, 1,
            { seen += "$sequence:$it" }, { valid -> assertTrue(valid()); seen += "$sequence:ran" })
        batch(0); batch(1)
        lane.reset(); batch(2)
        assertEquals(listOf("1:unavailable", "cancel"), seen)
        work.removeFirst()()
        assertEquals("0:unavailable", seen.last())
        work.removeFirst()()
        assertTrue(work.isEmpty())
        clean.removeFirst()()
        work.removeFirst()()
        assertEquals("2:ran", seen.last())
        batch(2)
        assertEquals("2:stale", seen.last())
    }

    @Test fun repeatedResetsInvalidateWorkEvenWhileCleanupIsPending() {
        val work = ArrayDeque<() -> Unit>(); val clean = ArrayDeque<() -> Unit>(); val seen = ArrayList<String>()
        val lane = PersonInputLane({ work += it }, {}, { clean += it }); val stream = PersonInputLane.Stream()
        lane.reset(); work.removeFirst()()
        lane.submit(stream, 0, 1, 1, 100, 1, { seen += it }, { fail("Reset work ran") })
        lane.reset()
        assertEquals(listOf("unavailable"), seen)
        clean.removeFirst()(); work.removeFirst()()
        assertTrue(work.isEmpty())
        clean.removeFirst()()
    }

    @Test fun streamSequenceGeometryAndQueueBoundsSurviveResets() {
        val work = ArrayDeque<() -> Unit>(); val refused = ArrayList<String>()
        val lane = PersonInputLane({ work += it }, {}, { it() }); val stream = PersonInputLane.Stream()
        fun batch(sequence: Long, geometry: Long = 1, size: Int = 100, count: Int = 1) =
            lane.submit(stream, sequence, geometry, 1, size, count, { refused += it }, {})
        batch(0, 2); batch(0); batch(1, size = 1_048_577); batch(2, count = 513)
        assertEquals(listOf("stale", "stale", "too-large", "too-large"), refused)
        batch(3); lane.reset()
        while (work.isNotEmpty()) work.removeFirst()()
        batch(3)
        assertEquals("stale", refused.last())
        lane.submit(PersonInputLane.Stream(), 0, 1, 1, 100, 1, { fail(it) }, {})
        while (work.isNotEmpty()) work.removeFirst()()
    }
}
