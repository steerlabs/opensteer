package com.opensteer.agentphone.ui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.opensteer.agentphone.phone

/** The notification's Stop: ends the task holding the phone. Not exported; only the notification sends it. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == STOP) intent.getStringExtra(SESSION_ID)?.let { context.phone.runtime?.stopSession(it) }
    }

    companion object {
        const val STOP = "com.opensteer.agentphone.action.STOP_TASK"
        const val SESSION_ID = "sessionId"
    }
}
