package com.opensteer.agentphone.update

import com.opensteer.agentphone.runner.PhoneUpdateResult
import java.util.concurrent.TimeUnit

/** The six-hour cache applies to completed checks, never a pending or cancelled installation. */
internal class UpdateCheckPolicy {
    private var checkedFor: String? = null
    private var checkedAt = Long.MIN_VALUE / 2

    fun begin(key: String, now: Long, required: Boolean, pending: Boolean): Boolean {
        if (!pending && !required && key == checkedFor && now - checkedAt < TimeUnit.HOURS.toMillis(6)) return false
        checkedFor = key
        checkedAt = now
        return true
    }

    fun cancellation(takeCancelled: () -> Boolean): PhoneUpdateResult.Pending? {
        if (!takeCancelled()) return null
        checkedFor = null
        return PhoneUpdateResult.Pending("Update cancelled. Opensteer will try again.")
    }
}
