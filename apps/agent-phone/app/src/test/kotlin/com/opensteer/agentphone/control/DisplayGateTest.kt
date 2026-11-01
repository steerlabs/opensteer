package com.opensteer.agentphone.control

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

/** Failure list: close races enqueue, retired output publishes, lift reuses generation, queue survives protection. */
class DisplayGateTest {
    @Test fun onlyCurrentUnprotectedEncoderPublishes() {
        val gate = DisplayGate()
        val first = Any()
        assertEquals(1L, gate.reset(first))
        var sent = 0
        assertTrue(gate.publish(first) { sent++ })
        gate.close { sent = 0 }
        assertFalse(gate.publish(first) { sent++ })
        val second = Any()
        assertEquals(2L, gate.reset(second))
        assertFalse(gate.publish(first) { sent++ })
        assertTrue(gate.publish(second) { sent++ })
        assertEquals(1, sent)
    }
    @Test fun closeAndEnqueueShareOneLock() {
        val gate = DisplayGate()
        val encoder = Any()
        gate.reset(encoder)
        val entered = CountDownLatch(1)
        val finish = CountDownLatch(1)
        var queued = false
        val output = Thread { gate.publish(encoder) { entered.countDown(); finish.await(); queued = true } }.apply { start() }
        assertTrue(entered.await(2, TimeUnit.SECONDS))
        val closed = CountDownLatch(1)
        val close = Thread { gate.close { queued = false }; closed.countDown() }.apply { start() }
        assertFalse(closed.await(20, TimeUnit.MILLISECONDS))
        finish.countDown(); output.join(2000); close.join(2000)
        assertFalse(queued)
        assertFalse(gate.publish(encoder) { queued = true })
    }
    @Test fun windowBoundsAndDrainRequireRecovery() {
        var now = 0L
        val window = DisplayWindow { now }
        assertTrue(window.sent(0, 700_000))
        assertFalse(window.sent(1, 400_000))
        assertFalse(window.sent(1, 1))
        assertTrue(window.ack(0))
        assertTrue(window.needsSync)
        window.resume()
        assertTrue(window.sent(1, 1))
        now = 501
        assertFalse(window.sent(2, 1))
        assertTrue(window.ack(1))
        assertTrue(window.needsSync)
        assertThrows(IllegalArgumentException::class.java) { window.ack(2) }
    }
    /** Recovery requests an IDR on the same encoder; only a privacy/geometry reset retires it. */
    @Test fun drainedWindowDoesNotRetireTheEncoder() {
        val gate = DisplayGate()
        val encoder = Any()
        gate.reset(encoder)
        val window = DisplayWindow { 0L }
        window.block()
        assertTrue(window.needsSync)
        window.resume()
        assertEquals(1L, gate.generation)
        assertTrue(gate.publish(encoder) {})
    }
    @Test fun bitrateNeverIncreasesDuringSilence() {
        val rate = DisplayBitrate()
        assertEquals(2_500_000, rate.value)
        rate.flow(0)
        rate.flow(100)
        assertFalse(rate.healthy(9_000))
        repeat(90) { rate.flow(9_100L + it * 100); rate.healthy(9_100L + it * 100) }
        assertTrue(rate.value > 2_500_000)
        rate.congested(20_000)
        assertTrue(rate.value < 2_750_001)
        repeat(100) { rate.congested(21_000L + it * 1000) }
        assertEquals(1_000_000, rate.value)
    }
    /** A codec may have encoded deltas queued before the sync request reaches it. */
    @Test fun refreshDropsPriorDeltasUntilTheRequestedKeyWithoutRetiringTheEncoder() {
        val gate = DisplayGate()
        val encoder = Any()
        gate.reset(encoder)
        gate.requestKey()
        assertFalse(gate.publish(encoder, key = false) { error("Published an old delta") })
        assertTrue(gate.publish(encoder, key = true) {})
        assertTrue(gate.publish(encoder, key = false) {})
        assertEquals(1L, gate.generation)
    }

    @Test fun hostCapLowersOnlyTheEffectiveBitrateAndClearsWithoutRestart() {
        val rate = DisplayBitrate()
        assertTrue(rate.cap(400_000))
        assertEquals(400_000, rate.value)
        repeat(10) { rate.congested(it * 1000L) }
        assertEquals(400_000, rate.value)
        assertTrue(rate.cap(null))
        assertEquals(1_000_000, rate.value)
        assertFalse(rate.cap(4_000_000))
        assertEquals(1_000_000, rate.value)
        assertThrows(IllegalArgumentException::class.java) { rate.cap(399_999) }
    }

}
