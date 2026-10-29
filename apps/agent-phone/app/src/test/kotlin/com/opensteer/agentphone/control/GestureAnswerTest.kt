package com.opensteer.agentphone.control

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Waiting for Android's answer to a gesture it took. Failure modes:
 *
 * 1. an interrupt during the wait thrown out as if no gesture had been made,
 *    so the caller cleans up a gesture that is on the screen — or the
 *    interrupt swallowed, so the runtime stopping is never noticed;
 * 2. Android's own answer misread: a finished gesture called failed, a
 *    cancelled one called done;
 * 3. no answer in time called anything but unknown.
 */
class GestureAnswerTest {
    @Test
    fun anInterruptedWaitIsUnknownAndKeepsTheInterrupt() {
        Thread.currentThread().interrupt()
        assertEquals(Effect.UNKNOWN, gestureAnswer(CountDownLatch(1), AtomicBoolean(false), waitMs = 5_000))
        assertTrue("The interrupt is kept for the caller", Thread.interrupted())
    }

    @Test
    fun androidsOwnAnswerIsWhatItSaid() {
        val answered = CountDownLatch(1).apply { countDown() }
        assertEquals(Effect.DONE, gestureAnswer(answered, AtomicBoolean(true), waitMs = 5_000))
        assertEquals(Effect.FAILED, gestureAnswer(answered, AtomicBoolean(false), waitMs = 5_000))
    }

    @Test
    fun noAnswerInTimeIsUnknown() {
        assertEquals(Effect.UNKNOWN, gestureAnswer(CountDownLatch(1), AtomicBoolean(false), waitMs = 10))
        assertEquals(Effect.UNKNOWN, gestureAnswer(CountDownLatch(1), AtomicBoolean(false), waitMs = 0))
    }
}
