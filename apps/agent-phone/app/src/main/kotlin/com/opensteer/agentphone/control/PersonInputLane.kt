package com.opensteer.agentphone.control

/** One bounded person lane for the device; resets fence queued work before physical cleanup. */
class PersonInputLane(
    private val execute: (() -> Unit) -> Unit,
    private val interrupt: () -> Unit,
    private val cleanup: (() -> Unit) -> Unit,
) {
    class Stream { internal var sequence = -1L }
    private sealed interface Entry {
        class Batch(val stamp: Long, val bytes: Int, val events: Int, val action: (() -> Boolean) -> Unit, val refused: (String) -> Unit) : Entry
        data object Reset : Entry
    }
    private val queue = ArrayDeque<Entry>()
    private var stamp = 0L
    private var running = false
    private var bytes = 0
    private var events = 0

    @Synchronized fun submit(stream: Stream, sequence: Long, geometry: Long, currentGeometry: Long, size: Int, count: Int,
        refused: (String) -> Unit, action: (() -> Boolean) -> Unit) {
        if (sequence <= stream.sequence) { refused("stale"); return }
        stream.sequence = sequence
        if (geometry != currentGeometry) { refused("stale"); return }
        if (bytes + size > 1_048_576 || events + count > 512) { refused("too-large"); return }
        bytes += size; events += count
        queue += Entry.Batch(stamp, size, count, action, refused)
        next()
    }

    @Synchronized fun reset() {
        stamp++
        val dropped = queue.filterIsInstance<Entry.Batch>()
        queue.removeAll(dropped.toSet())
        for (batch in dropped) {
            bytes -= batch.bytes; events -= batch.events
            batch.refused("unavailable")
        }
        interrupt()
        if (queue.lastOrNull() != Entry.Reset) queue += Entry.Reset
        next()
    }

    @Synchronized private fun current(expected: Long) = stamp == expected
    @Synchronized private fun next() {
        if (running || queue.isEmpty()) return
        running = true
        val entry = queue.removeFirst()
        execute {
            when (entry) {
                Entry.Reset -> cleanup { finished() }
                is Entry.Batch -> try {
                    if (current(entry.stamp)) entry.action { current(entry.stamp) } else entry.refused("unavailable")
                } finally {
                    synchronized(this) { bytes -= entry.bytes; events -= entry.events }
                    finished()
                }
            }
        }
    }
    @Synchronized private fun finished() { running = false; next() }
}
