package com.opensteer.agentphone.control

import com.opensteer.agentphone.wire.DisplayWire

/** Encoder identity, protection and publication are one decision, including enqueueing the send. */
class DisplayGate {
    val lock = Any()
    var generation = 0L
        private set
    private var encoder: Any? = null
    private var awaitingKey = false
    fun reset(current: Any): Long = synchronized(lock) { encoder = current; awaitingKey = false; ++generation }
    fun close(drop: () -> Unit) = synchronized(lock) { encoder = null; awaitingKey = false; drop() }
    fun requestKey() = synchronized(lock) { awaitingKey = true }
    fun publish(current: Any, key: Boolean = false, enqueue: () -> Unit): Boolean = synchronized(lock) {
        if (encoder !== current || awaitingKey && !key) false
        else { if (key) awaitingKey = false; enqueue(); true }
    }
}

/** Cumulative acknowledgements cover only frames actually handed to the socket. Caller owns serialization. */
class DisplayWindow(private val now: () -> Long) {
    private data class Pending(val sequence: Long, val bytes: Int, val at: Long)
    private val pending = ArrayDeque<Pending>()
    private var bytes = 0
    private var lastSent = -1L
    private var lastAck = -1L
    var blocked = false
        private set
    val needsSync: Boolean get() = blocked && pending.isEmpty()
    val delay: Long get() = pending.firstOrNull()?.let { now() - it.at } ?: 0
    fun block() { blocked = true }
    fun check() { if (delay >= DisplayWire.UNACKED_MS) blocked = true }
    fun sent(sequence: Long, size: Int): Boolean {
        check()
        if (blocked || bytes + size > DisplayWire.UNACKED_BYTES) { blocked = true; return false }
        require(sequence > lastSent)
        lastSent = sequence
        pending += Pending(sequence, size, now()); bytes += size
        return true
    }
    fun ack(sequence: Long): Boolean {
        require(sequence <= lastSent) { "Acknowledgement is ahead of the stream" }
        if (sequence <= lastAck) return false
        lastAck = sequence
        while (pending.firstOrNull()?.let { it.sequence <= sequence } == true) bytes -= pending.removeFirst().bytes
        return true
    }
    fun resume() { require(pending.isEmpty()); blocked = false }
}

/** Congestion reductions are rate limited; a quiet screen cannot accumulate healthy credit. */
class DisplayBitrate {
    private var estimate = 2_500_000
    private var hostCap: Int? = null
    val value: Int get() = minOf(estimate, hostCap ?: 4_000_000)
    fun cap(value: Int?): Boolean {
        require(value == null || value in 400_000..4_000_000)
        val before = this.value
        hostCap = value
        return before != this.value
    }
    private var healthySince: Long? = null
    private var lastFlow: Long? = null
    private var lastReduction: Long? = null
    fun flow(now: Long) {
        if (lastFlow == null || now - requireNotNull(lastFlow) > 500) healthySince = now
        lastFlow = now
    }
    fun healthy(now: Long): Boolean {
        if (lastFlow == null || now - requireNotNull(lastFlow) > 500) { healthySince = null; return false }
        val since = healthySince ?: now.also { healthySince = it }
        if (now - since < 8_000) return false
        healthySince = now
        val before = value
        estimate = (estimate * 1.1).toInt().coerceAtMost(4_000_000)
        return value != before
    }
    fun congested(now: Long): Boolean {
        healthySince = null
        if (lastReduction?.let { now - it < 1000 } == true) return false
        lastReduction = now
        val before = value
        estimate = (estimate * 0.75).toInt().coerceAtLeast(1_000_000)
        return before != value
    }
}
