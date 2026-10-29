package com.opensteer.agentphone.runner

interface PhoneUpdater {
    /** Returns a terminal issue, or null when there is no newer release. Installation replaces this process. */
    fun check(identity: PhoneIdentity, required: Boolean): String?
    fun cancel()
}
