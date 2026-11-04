package com.opensteer.agentphone.update

import android.content.SharedPreferences
import com.opensteer.agentphone.runner.PhoneIdentity

internal class UpdateJournal(private val journal: SharedPreferences, private val sessionExists: (Int) -> Boolean) {
    fun state(): String = journal.getString("state", "idle") ?: "idle"

    fun pendingState(identity: PhoneIdentity): String? = state().takeIf {
        journal.getString("scope", null)?.startsWith("${identity.runnerId} ${identity.hostUrl} ") == true &&
            it in setOf("installing", "awaiting-user") && sessionExists(journal.getInt("sessionId", -1))
    }

    fun takeCancelled(identity: PhoneIdentity): Boolean = locked {
        if (state() != "cancelled" || journal.getString("scope", null)?.startsWith("${identity.runnerId} ${identity.hostUrl} ") != true) return@locked false
        check(journal.edit().putString("state", "idle").remove("sessionId").commit()) { "Could not record the cancelled update" }
        true
    }

    fun begin(identity: PhoneIdentity, offer: UpdateOffer) = locked {
        if (pendingState(identity) != null) return@locked
        val scope = "${identity.runnerId} ${identity.hostUrl} ${offer.sha256}"
        val attempts = if (journal.getString("scope", null) == scope) journal.getInt("attempts", 0) else 0
        check(attempts < 3) { "This release already failed three update attempts. Update over USB to try again." }
        check(journal.edit().putString("scope", scope).putInt("attempts", attempts + 1)
            .putString("sha256", offer.sha256).putLong("version", offer.versionCode)
            .putString("state", "downloading").remove("sessionId").commit()) { "Could not save the update attempt" }
    }

    /** Consent is obsolete once the running app is admitted or another release is offered, whichever pairing began it. */
    fun clearObsoleteConsent(abandon: (Int) -> Unit, cancelNotification: () -> Unit) = locked {
        if (state() != "awaiting-user") return@locked
        val session = journal.getInt("sessionId", -1)
        // Fence Android's late result before abandoning: abandonSession may itself deliver a result.
        check(journal.edit().putString("state", "idle").remove("sessionId").commit()) { "Could not clear the obsolete update session" }
        cancelNotification()
        if (session >= 0) abandon(session)
    }

    fun result(session: Int, apply: () -> Unit) = locked {
        if (session != journal.getInt("sessionId", -1)) return@locked
        apply()
    }

    fun cancelled() = locked {
        if (state() == "cancelled") return@locked
        check(journal.edit().putString("state", "cancelled").putInt("attempts", (journal.getInt("attempts", 1) - 1).coerceAtLeast(0)).commit())
    }

    /** Every journal transition takes this lock: receivers and the connection use separate instances over the same preferences. */
    fun <T> locked(block: () -> T): T = synchronized(lock, block)

    private companion object {
        val lock = Any()
    }
}
