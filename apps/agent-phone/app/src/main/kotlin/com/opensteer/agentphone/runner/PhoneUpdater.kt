package com.opensteer.agentphone.runner

sealed interface PhoneUpdateResult {
    data object Current : PhoneUpdateResult
    data class Pending(val detail: String) : PhoneUpdateResult
    data class Failed(val detail: String) : PhoneUpdateResult
}

interface PhoneUpdater {
    fun check(identity: PhoneIdentity, required: Boolean): PhoneUpdateResult
    fun cancel()
}
