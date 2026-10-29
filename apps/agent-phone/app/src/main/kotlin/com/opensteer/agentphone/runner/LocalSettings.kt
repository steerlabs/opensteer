package com.opensteer.agentphone.runner

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import com.opensteer.agentphone.wire.WireException

/**
 * The owner's choices on this phone, which hold across reboots and never
 * leave it: whether agents are paused, whether Opensteer removed the phone,
 * which the phone keeps saying until it is set up again, and the Stops the
 * owner pressed that the Host has not yet recorded.
 *
 * Writes are committed, not applied: a pause or a Stop must be on disk before
 * the runtime acts on it, and every write runs off the main thread.
 */
@SuppressLint("ApplySharedPref")
class LocalSettings(context: Context) {
    private val preferences = context.getSharedPreferences("agent_phone", Context.MODE_PRIVATE)

    var paused: Boolean
        get() = preferences.getBoolean(PAUSED, false)
        set(value) {
            preferences.edit().putBoolean(PAUSED, value).commit()
        }

    var removed: Boolean
        get() = preferences.getBoolean(REMOVED, false)
        set(value) {
            preferences.edit().putBoolean(REMOVED, value).commit()
        }

    /**
     * The unrecorded Stops of the identity `runnerId`. What another identity
     * left is not this one's: it is dropped when read, as is anything
     * unreadable, which is said in the log.
     */
    fun stopJournal(runnerId: String): StopJournal = object : StopJournal {
        override fun load(): List<PendingStop> {
            // Read untyped: `getString` throws on a value of another type, which is as unreadable as bad text.
            val stored = preferences.all[PENDING_STOPS] ?: return emptyList()
            val stops = try {
                StopJournalText.decode(runnerId, stored)
            } catch (unreadable: WireException) {
                Log.w(TAG, "The kept Stops could not be read and were dropped: ${unreadable.message}")
                emptyList()
            }
            if (stops.isEmpty()) save(stops)
            return stops
        }

        override fun save(stops: List<PendingStop>): Boolean {
            val edit = preferences.edit()
            if (stops.isEmpty()) edit.remove(PENDING_STOPS) else edit.putString(PENDING_STOPS, StopJournalText.encode(runnerId, stops))
            return edit.commit()
        }
    }

    private companion object {
        const val PAUSED = "paused"
        const val REMOVED = "removed"
        const val PENDING_STOPS = "pending_stops"
        const val TAG = "AgentPhone"
    }
}
