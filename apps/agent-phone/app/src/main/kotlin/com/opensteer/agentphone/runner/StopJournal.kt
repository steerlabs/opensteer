package com.opensteer.agentphone.runner

import com.opensteer.agentphone.wire.Fields
import com.opensteer.agentphone.wire.Ids
import com.opensteer.agentphone.wire.JsonArray
import com.opensteer.agentphone.wire.JsonText
import com.opensteer.agentphone.wire.WireException
import com.opensteer.agentphone.wire.jsonObject
import com.opensteer.agentphone.wire.jsonOf

/** An owner's Stop the Host has not yet said it recorded: the session stopped and its Run. */
data class PendingStop(val sessionId: String, val runId: String)

/**
 * Where one identity keeps its owner's unrecorded Stops, so that neither a
 * restart nor a reboot can lose one before the Host has it. Runtime thread
 * only.
 */
interface StopJournal {
    /** The Stops kept for this identity, in the order they were pressed. */
    fun load(): List<PendingStop>

    /** Replaces what is kept; nothing kept leaves nothing on disk. False when the disk did not take it. */
    fun save(stops: List<PendingStop>): Boolean
}

/**
 * The journal's text on disk. It names the identity it belongs to, because
 * one left from before a re-pairing must never be replayed to another Host
 * nor refuse that Host's Runs.
 */
object StopJournalText {
    fun encode(runnerId: String, stops: List<PendingStop>): String = JsonText.stringify(
        jsonObject(
            "runnerId" to jsonOf(runnerId),
            "stops" to JsonArray(stops.map { jsonObject("runId" to jsonOf(it.runId), "sessionId" to jsonOf(it.sessionId)) }),
        ),
    )

    /**
     * The Stops `stored` keeps for `runnerId`: none when nothing is stored or
     * it is another identity's. Throws `WireException` when it is unreadable,
     * including a value of another type, which Android hands back as that type.
     */
    fun decode(runnerId: String, stored: Any?): List<PendingStop> {
        if (stored == null) return emptyList()
        val text = stored as? String ?: throw WireException("The kept Stops are not text.")
        val fields = Fields.parse(text, "stopJournal")
        val owner = fields.string("runnerId", pattern = Ids.runner)
        val stops = fields.array("stops").mapIndexed { index, item ->
            val stop = Fields.of(item, "stopJournal.stops[$index]")
            PendingStop(
                runId = stop.string("runId", pattern = Ids.run),
                sessionId = stop.string("sessionId", pattern = Ids.computerUseSession),
            ).also { stop.end() }
        }
        fields.end()
        return if (owner == runnerId) stops else emptyList()
    }
}
