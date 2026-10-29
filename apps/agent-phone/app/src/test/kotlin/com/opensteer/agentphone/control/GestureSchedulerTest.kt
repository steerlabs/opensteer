package com.opensteer.agentphone.control

import org.junit.Assert.*
import org.junit.Test

/** Failure list: overlap, discontinuity, unbounded moves, stationary injection, up/cancel endpoint, watchdog, lost authority. */
class GestureSchedulerTest {
    private class Clock : GestureClock {
        var now = 0L
        val tasks = ArrayList<Pair<Long, () -> Unit>>()
        override fun post(action: () -> Unit) { tasks += now to action }
        override fun after(ms: Long, action: () -> Unit) { tasks += now + ms to action }
        override fun now() = now
        fun advance(ms: Long = 0) {
            val until = now + ms
            while (true) {
                val next = tasks.filter { it.first <= until }.minByOrNull { it.first } ?: break
                tasks.remove(next); now = next.first; next.second()
            }
            now = until
        }
    }
    @Test fun segmentsAreSerializedAndUpPreservesMovesAndElapsedDuration() {
        val clock = Clock()
        val segments = ArrayList<GestureSegment>()
        val callbacks = ArrayList<(Boolean) -> Unit>()
        val scheduler = GestureScheduler(clock, { segment, done -> segments += segment; callbacks += done })
        scheduler.down(DisplayPoint(1, 2), { true })
        clock.advance()
        scheduler.move(DisplayPoint(10, 20)); scheduler.move(DisplayPoint(20, 40)); clock.advance(40)
        assertEquals(1, segments.size)
        callbacks.removeAt(0)(true); clock.advance()
        assertEquals(DisplayPoint(1, 2), segments[1].points.first())
        assertEquals(DisplayPoint(20, 40), segments[1].points.last())
        scheduler.move(DisplayPoint(30, 60)); scheduler.up(DisplayPoint(40, 80)); clock.advance(40)
        assertEquals(2, segments.size)
        callbacks.removeAt(0)(true); clock.advance()
        assertFalse(segments.last().continuing)
        assertEquals(listOf(DisplayPoint(20, 40), DisplayPoint(30, 60), DisplayPoint(40, 80)), segments.last().points)
        assertTrue(segments.last().durationMs >= 32)
    }
    @Test fun stationaryContactIsNotReinjectedAndWatchdogReleases() {
        val clock = Clock(); val segments = ArrayList<GestureSegment>()
        val scheduler = GestureScheduler(clock, { segment, done -> segments += segment; done(true) })
        scheduler.down(DisplayPoint(5, 5), { true }); clock.advance(4999)
        assertEquals(1, segments.size)
        clock.advance(1)
        assertEquals(2, segments.size)
        assertFalse(segments.last().continuing)
    }
    @Test fun cancelAndAuthorityLossReleaseAtDispatchedEndpoint() {
        for (cancel in listOf(true, false)) {
            val clock = Clock(); val segments = ArrayList<GestureSegment>(); var allowed = true
            val scheduler = GestureScheduler(clock, { segment, done -> segments += segment; done(true) })
            scheduler.down(DisplayPoint(5, 5), { allowed }); clock.advance()
            scheduler.move(DisplayPoint(9, 9))
            if (cancel) scheduler.cancel() else allowed = false
            clock.advance(64)
            assertTrue(segments.last().cancel)
            assertFalse(segments.last().continuing)
        }
    }
    @Test fun completionBeforeBufferDeadlineStillWaitsForThirtyTwoMs() {
        val clock = Clock(); val segments = ArrayList<GestureSegment>(); val callbacks = ArrayList<(Boolean) -> Unit>()
        val scheduler = GestureScheduler(clock) { segment, done -> segments += segment; callbacks += done }
        scheduler.down(DisplayPoint(0, 0), { true }); clock.advance()
        scheduler.move(DisplayPoint(20, 20)); clock.advance(1)
        callbacks.removeAt(0)(true); clock.advance(30)
        assertEquals(1, segments.size)
        clock.advance(1)
        assertEquals(2, segments.size)
    }

    @Test fun authorityLossCannotReportACompletedDrag() {
        val clock = Clock(); var allowed = true; var completed: Boolean? = null
        val scheduler = GestureScheduler(clock) { _, done -> done(true) }
        scheduler.down(DisplayPoint(5, 5), { allowed }, done = { completed = it }); clock.advance()
        allowed = false
        scheduler.move(DisplayPoint(20, 20)); clock.advance(32)
        assertEquals(false, completed)
    }

    @Test fun acceptedTrafficExtendsStillHoldAndNoHalfSecondLift() {
        val clock = Clock(); val segments = ArrayList<GestureSegment>()
        val scheduler = GestureScheduler(clock) { segment, done -> segments += segment; done(true) }
        scheduler.down(DisplayPoint(5, 5), { true }); clock.advance(4000)
        assertEquals(1, segments.size)
        scheduler.traffic(); clock.advance(4000)
        assertEquals(1, segments.size)
        clock.advance(1000)
        assertTrue(segments.last().cancel)
    }
    @Test fun failedContinuationReleasesBeforeCleanupAndIgnoresLateCallback() {
        val clock = Clock(); val segments = ArrayList<GestureSegment>(); val callbacks = ArrayList<(Boolean) -> Unit>()
        var cleaned = false
        val scheduler = GestureScheduler(clock) { segment, done -> segments += segment; callbacks += done }
        scheduler.down(DisplayPoint(5, 5), { true }); clock.advance()
        val late = callbacks.removeAt(0)
        scheduler.cancel { cleaned = true }; clock.advance()
        late(false); clock.advance()
        assertFalse(cleaned)
        assertTrue(segments.last().cancel)
        late(true); clock.advance()
        assertFalse(cleaned)
        callbacks.removeAt(0)(true); clock.advance()
        assertTrue(cleaned)
    }
    @Test fun scrollAccumulatesDuringFlightAndHoldsBeforeLift() {
        val clock = Clock(); val segments = ArrayList<GestureSegment>(); val callbacks = ArrayList<(Boolean) -> Unit>()
        val scheduler = GestureScheduler(clock) { segment, done -> segments += segment; callbacks += done }
        repeat(10) { scheduler.scroll(DisplayPoint(500, 800), 0.0, -2.0, { true }) }
        clock.advance()
        assertTrue(segments.isNotEmpty())
        repeat(10) { scheduler.scroll(DisplayPoint(500, 800), 0.0, -10.0, { true }) }
        clock.advance()
        var guard = 0
        while (callbacks.isNotEmpty() && guard++ < 20) { callbacks.removeAt(0)(true); clock.advance(300) }
        val movement = segments.filter { it.points.size > 1 }
        assertEquals(-120, movement.sumOf { it.points.last().y - it.points.first().y })
        assertTrue(movement.all { it.durationMs >= 300 })
        assertTrue(segments.filter { !it.continuing }.all { it.durationMs >= 100 && it.points.distinct().size == 1 })
    }
    /** A still long press must not be replayed as a slow first movement. */
    @Test fun firstMoveAfterLongHoldUsesMovementTime() {
        val clock = Clock(); val segments = ArrayList<GestureSegment>()
        val scheduler = GestureScheduler(clock) { segment, done -> segments += segment; done(true) }
        scheduler.down(DisplayPoint(5, 5), { true }); clock.advance(1200)
        scheduler.move(DisplayPoint(30, 5)); clock.advance(32)
        assertEquals(32L, segments.last().durationMs)
    }

    /** Fractional wheel input must survive until it crosses touch slop; swipes must stay on display. */
    @Test fun fractionalScrollAndLargeBacklogPreserveDistanceWithinBounds() {
        val clock = Clock(); val segments = ArrayList<GestureSegment>(); val callbacks = ArrayList<(Boolean) -> Unit>()
        val scheduler = GestureScheduler(clock) { segment, done -> segments += segment; callbacks += done }
        repeat(100) { scheduler.scroll(DisplayPoint(50, 50), 0.0, -0.2, { true }, DisplayPoint(100, 100)) }
        scheduler.scroll(DisplayPoint(50, 50), 0.0, -200.0, { true }, DisplayPoint(100, 100))
        clock.advance()
        var guard = 0
        while (callbacks.isNotEmpty() && guard++ < 30) { callbacks.removeAt(0)(true); clock.advance(300) }
        val movement = segments.filter { it.points.size > 1 }
        assertEquals(-220, movement.sumOf { it.points.last().y - it.points.first().y })
        assertTrue(movement.flatMap { it.points }.all { it.y in 0..99 })
    }

}
