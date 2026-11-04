package com.opensteer.agentphone.update

import android.content.SharedPreferences
import com.opensteer.agentphone.runner.PhoneIdentity

internal class UpdateJournal(private val journal: SharedPreferences, private val sessionExists: (Int) -> Boolean) {
    fun state(): String = journal.getString("state", "idle") ?: "idle"

    fun pendingState(identity: PhoneIdentity): String? = state().takeIf {
        journal.getString("scope", null)?.startsWith("${identity.runnerId} ${identity.hostUrl} ") == true &&
            it in setOf("installing", "awaiting-user") && sessionExists(journal.getInt("sessionId", -1))
    }

    fun takeCancelled(identity: PhoneIdentity): Boolean {
        if (state() != "cancelled" || journal.getString("scope", null)?.startsWith("${identity.runnerId} ${identity.hostUrl} ") != true) return false
        check(journal.edit().putString("state", "idle").remove("sessionId").commit()) { "Could not record the cancelled update" }
        return true
    }

    fun begin(identity: PhoneIdentity, offer: UpdateOffer) {
        if (pendingState(identity) != null) return
        val scope = "${identity.runnerId} ${identity.hostUrl} ${offer.sha256}"
        val attempts = if (journal.getString("scope", null) == scope) journal.getInt("attempts", 0) else 0
        check(attempts < 3) { "This release already failed three update attempts. Update over USB to try again." }
        check(journal.edit().putString("scope", scope).putInt("attempts", attempts + 1)
            .putString("sha256", offer.sha256).putLong("version", offer.versionCode)
            .putString("state", "downloading").remove("sessionId").commit()) { "Could not save the update attempt" }
    }

    fun clearObsoleteConsent(identity: PhoneIdentity, abandon: (Int) -> Unit, cancelNotification: () -> Unit) = synchronized(lock) {
        if (!matches(identity) || state() != "awaiting-user") return@synchronized
        val session = journal.getInt("sessionId", -1)
        // Fence Android's late result before abandoning: abandonSession may itself deliver a result.
        check(journal.edit().putString("state", "idle").remove("sessionId").commit()) { "Could not clear the obsolete update session" }
        cancelNotification()
        if (session >= 0) abandon(session)
    }

    fun result(session: Int, apply: () -> Unit) = synchronized(lock) {
        if (session != journal.getInt("sessionId", -1)) return@synchronized
        apply()
    }

    fun cancelled() {
        if (state() == "cancelled") return
        check(journal.edit().putString("state", "cancelled").putInt("attempts", (journal.getInt("attempts", 1) - 1).coerceAtLeast(0)).commit())
    }

    private fun matches(identity: PhoneIdentity) =
        journal.getString("scope", null)?.startsWith("${identity.runnerId} ${identity.hostUrl} ") == true

    companion object {
        // Receivers and the connection create separate installer instances over the same preferences.
        private val lock = Any()
    }
}
