package com.opensteer.agentphone.control

/** Ephemeral authority belonging to one authenticated module connection; no task/session fields. */
class OwnerViewLeases {
    private class Lease(val generation: Long, val display: String, var expires: Long, var closed: Boolean = false)
    private val leases = HashMap<String, Lease>()

    @Synchronized fun open(id: String, generation: Long, display: String, expires: Long, now: Long): Boolean {
        for (lease in leases.values) if (lease.expires <= now) lease.closed = true
        if (generation < 1 || display != "main" || expires <= now || expires - now > 180_000) return false
        val old = leases[id]
        if (old != null && (old.generation > generation || old.generation == generation && (old.closed || old.display != display))) return false
        if (old?.generation == generation) return true
        if (old == null && leases.size >= 1000) return false
        if (leases.values.count { !it.closed && it.expires > now } >= 64 && old?.closed != false) return false
        leases[id] = Lease(generation, display, expires)
        return true
    }

    @Synchronized fun renew(id: String, generation: Long, display: String, expires: Long, now: Long): Boolean {
        if (unavailable(id, generation, display, now) != null || expires <= now || expires - now > 180_000) return false
        leases.getValue(id).let { it.expires = maxOf(it.expires, expires) }
        return true
    }

    @Synchronized fun close(id: String, generation: Long): Boolean {
        val lease = leases[id] ?: return false
        if (lease.generation != generation) return false
        lease.closed = true
        return true
    }

    @Synchronized fun unavailable(id: String, generation: Long, display: String, now: Long): String? {
        val lease = leases[id] ?: return "ended"
        return if (lease.closed || lease.generation != generation || lease.display != display) "ended" else if (lease.expires <= now) "expired" else null
    }

    @Synchronized fun deadline(id: String, generation: Long): Long? = leases[id]?.takeIf { !it.closed && it.generation == generation }?.expires

    @Synchronized fun clear() = leases.clear()
}
