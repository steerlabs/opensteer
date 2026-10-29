package com.opensteer.agentphone.control

/** Barriers retain their lease identity: a stale callback cannot reopen agent admission. */
class OwnerLease(
    private val blockAgent: (Boolean) -> Unit,
    private val acquireBarrier: (String, () -> Unit) -> Unit,
    private val releaseBarrier: (() -> Unit) -> Unit,
    private val cleanup: (() -> Unit) -> Unit,
    private val report: (String, String, String, String?) -> Unit,
) {
    private data class Lease(val session: String, val control: String, val stamp: Long, var held: Boolean = false, var sequence: Long = -1, var releasing: Boolean = false)
    private var lease: Lease? = null
    private var revision = 0L
    private var queued: Pair<String, String>? = null
    val stamp: Long @Synchronized get() = revision
    @Synchronized fun current(stamp: Long): Boolean = lease?.let { it.stamp == stamp && it.held && !it.releasing } == true
    @Synchronized fun matches(session: String, control: String): Boolean = lease?.let { it.session == session && it.control == control } == true
    @Synchronized fun acquire(session: String, control: String) {
        val old = lease
        if (old != null) {
            if (old.releasing) {
                val next = session to control
                if (queued == null || queued == next) queued = next else report(session, control, "refused", "busy")
                return
            }
            if (old.session == session && old.control == control) {
                if (old.held && !old.releasing) report(session, control, "held", null)
            } else report(session, control, "refused", "busy")
            return
        }
        val next = Lease(session, control, ++revision)
        lease = next
        blockAgent(true)
        acquireBarrier(session) { synchronized(this) {
            if (lease !== next || next.releasing) return@synchronized
            next.held = true
            report(session, control, "held", null)
        } }
    }
    @Synchronized fun accept(session: String, control: String, geometry: Long, sequence: Long, currentGeometry: Long): Boolean {
        val current = lease ?: return false
        if (!current.held || current.releasing || current.session != session || current.control != control || geometry != currentGeometry || sequence <= current.sequence) return false
        current.sequence = sequence
        return true
    }
    @Synchronized fun release(reason: String) {
        val old = lease ?: return
        if (old.releasing) return
        old.releasing = true; revision++
        cleanup { releaseBarrier { synchronized(this) {
            if (lease !== old) return@synchronized
            lease = null
            blockAgent(false)
            report(old.session, old.control, "released", reason)
            val next = queued; queued = null
            if (next != null) acquire(next.first, next.second)
        } } }
    }
}
