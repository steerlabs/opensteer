package com.opensteer.agentphone.runner

import com.opensteer.agentphone.wire.AuxiliaryFence
import com.opensteer.agentphone.wire.ComputerUseOutcome
import com.opensteer.agentphone.wire.JsonObject
import com.opensteer.agentphone.wire.JsonString
import com.opensteer.agentphone.wire.RunnerFence

val testFence = AuxiliaryFence(
    RunnerFence(
        bootId = "rbt_22222222-2222-4222-8222-222222222222",
        connectionGeneration = 1,
        connectionId = "rcn_11111111-1111-4111-8111-111111111111",
        connectionLeaseId = "rls_11111111-1111-4111-8111-111111111111",
        runnerId = "rnr_33333333-3333-4333-8333-333333333333",
    ),
    auxiliaryStreamId = "rax_11111111-1111-4111-8111-111111111111",
)

class RecordingStream(override val fence: AuxiliaryFence = testFence) : ModuleStream {
    val sent = mutableListOf<JsonObject>()
    var open = true

    override fun send(frame: JsonObject): Boolean {
        if (!open) return false
        sent += frame
        return true
    }

    fun types() = sent.map { (it.fields.getValue("type") as JsonString).value }
}

/** Phone work that finishes only when a test says so. */
class FakePhone : PhoneOperations {
    override fun displayUnavailable(source: com.opensteer.agentphone.wire.DisplaySource): String? = "session-ended"
    override fun displayDeadline(sources: List<com.opensteer.agentphone.wire.DisplaySource>): Long? = null
    class Running(val call: PhoneCall, val done: (ComputerUseOutcome) -> Unit) : PhoneWork {
        var cancelled = false
        override fun cancel() {
            cancelled = true
        }
    }

    val running = mutableListOf<Running>()
    var released = 0

    override fun runView(message: com.opensteer.agentphone.wire.IntegrationsMessage.ComputerView, receivedAt: Long, done: (ComputerUseOutcome) -> Unit): PhoneWork {
        done(ComputerUseOutcome.Failure(com.opensteer.agentphone.wire.ComputerUseErrorCode.UNSUPPORTED, "Test port has no owner producer."))
        return PhoneWork {}
    }

    override fun run(call: PhoneCall, done: (ComputerUseOutcome) -> Unit): PhoneWork =
        Running(call, done).also { running += it }

    override fun releaseSessions() {
        released += 1
    }

    fun finish(requestId: String, outcome: ComputerUseOutcome) {
        val work = running.first { it.call.requestId == requestId }
        running.remove(work)
        work.done(outcome)
    }
}

/**
 * What the phone keeps on disk for its identity: the Stops the Host has not
 * recorded. The next `failures` writes fail, as a disk that is briefly full does.
 */
class MemoryJournal(initial: List<PendingStop> = emptyList(), var failures: Int = 0) : StopJournal {
    var kept = initial
    var writes = 0

    override fun load() = kept

    override fun save(stops: List<PendingStop>): Boolean {
        writes += 1
        if (failures > 0) {
            failures -= 1
            return false
        }
        kept = stops
        return true
    }
}
