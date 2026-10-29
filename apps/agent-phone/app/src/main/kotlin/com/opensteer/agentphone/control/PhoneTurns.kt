package com.opensteer.agentphone.control

import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Serial authority turns with a separate worker for Android's blocking reads and receipt waits.
 * The executor itself never waits on a gesture callback; its FIFO advances when the request worker returns.
 */
internal class PhoneTurns {
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "opensteer-executor") }
    private val android = Executors.newSingleThreadExecutor { Thread(it, "opensteer-phone-turn") }
    private data class Turn(val blocking: Boolean, val action: () -> Unit)
    private val queue = ArrayDeque<Turn>()
    private var running = false
    private var closed = false
    fun execute(action: () -> Unit) = enqueue(Turn(false, action))
    fun android(action: () -> Unit) = enqueue(Turn(true, action))
    fun afterCurrent(action: () -> Unit) = enqueue(Turn(false, action), first = true)
    @Synchronized private fun enqueue(turn: Turn, first: Boolean = false) {
        if (closed) return
        if (first) queue.addFirst(turn) else queue.addLast(turn)
        if (!running) { running = true; executor.execute(::next) }
    }
    private fun next() {
        val turn = synchronized(this) {
            if (closed || queue.isEmpty()) { running = false; return }
            queue.removeFirst()
        }
        if (turn.blocking) android.execute {
            try { turn.action() } finally { advance() }
        } else try { turn.action() } finally { advance() }
    }
    @Synchronized private fun advance() { if (!closed) executor.execute(::next) }
    @Synchronized fun shutdownNow() {
        closed = true; queue.clear(); executor.shutdownNow(); android.shutdownNow()
    }
    fun awaitTermination(timeout: Long, unit: TimeUnit): Boolean {
        val deadline = System.nanoTime() + unit.toNanos(timeout)
        val stopped = android.awaitTermination(timeout, unit)
        return executor.awaitTermination((deadline - System.nanoTime()).coerceAtLeast(0), TimeUnit.NANOSECONDS) && stopped
    }
}
