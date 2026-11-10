package com.opensteer.phoneconnection.core

import kotlinx.serialization.json.*
import java.util.concurrent.CompletableFuture

class Admission(private val now: () -> Long, private val primaryCurrent: () -> Boolean = { true }) {
    private val lease = AuxiliaryLease(now)
    var epoch: Int = 0; private set
    var active = false
    var capability: JsonObject? = null; private set
    private var capabilityEnd = 0L
    private var capabilityHighWater = 0L
    val deadline get() = lease.deadline
    val fence get() = lease.fence

    @Synchronized fun adopt(welcome: JsonObject): Fence {
        capability = null; capabilityEnd = 0; capabilityHighWater = 0
        return lease.adopt(welcome).also { Wire.requireThat(!lease.expired, "retired-stream") }
    }
    @Synchronized fun renew(frame: JsonObject) = lease.renew(frame)
    @Synchronized fun advance(): Int {
        Wire.requireThat(epoch < Int.MAX_VALUE, "epoch-exhausted")
        epoch += 1; capability = null; capabilityEnd = 0
        return epoch
    }
    @Synchronized fun checkCapability(value: JsonObject): JsonObject {
        requireCurrent(epoch, fence ?: throw Refused("retired-stream"))
        value.only("runtimeId", "capabilityGeneration", "capabilityLeaseId", "expiresAt")
        value.text("runtimeId")
        Wire.requireThat(Regex("bcl_" + Wire.uuid.pattern).matches(value.text("capabilityLeaseId")))
        val reference = JsonObject(value.filterKeys { it != "expiresAt" })
        val generation = value.number("capabilityGeneration", 1)
        Wire.requireThat(generation > capabilityHighWater || reference == capability, "retired-capability")
        Wire.requireThat(value.time("expiresAt") > now(), "retired-capability")
        return reference
    }
    @Synchronized fun acceptCapability(value: JsonObject) {
        val reference = checkCapability(value)
        capability = reference; capabilityEnd = value.time("expiresAt"); capabilityHighWater = value.number("capabilityGeneration", 1)
    }
    @Synchronized fun requireCurrent(expectedEpoch: Int, expectedFence: Fence, expectedCapability: JsonObject? = null) {
        Wire.requireThat(active && expectedEpoch == epoch, "retired-epoch")
        Wire.requireThat(primaryCurrent(), "retired-primary")
        lease.requireCurrent(expectedFence)
        if (expectedCapability != null) Wire.requireThat(capability == expectedCapability && capabilityEnd > now(), "retired-capability")
    }
    @Synchronized fun release() { advance(); lease.release() }
}

class FrameCredit {
    private var outstanding: String? = null
    private var closed = false
    @Synchronized fun reserve(token: String): Boolean {
        if (closed || outstanding != null) return false
        outstanding = token
        return true
    }
    @Synchronized fun ack(token: String) { if (outstanding == token) outstanding = null }
    @Synchronized fun close() { closed = true; outstanding = null }
}

class Retirement(
    private val persist: (String) -> Unit,
    private val fence: () -> Unit,
    private val erase: (String) -> CompletableFuture<Boolean>,
    private val forget: () -> Unit,
) {
    fun begin(deploymentId: String) {
        try { persist(deploymentId) } finally { fence() }
    }
    fun finish(deploymentId: String): CompletableFuture<Boolean> = erase(deploymentId).thenApply { erased ->
        if (erased) forget()
        erased
    }
}
