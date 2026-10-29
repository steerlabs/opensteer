package com.opensteer.agentphone.setup

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.opensteer.agentphone.SetupResult
import com.opensteer.agentphone.phone
import com.opensteer.agentphone.wire.JsonText
import com.opensteer.agentphone.wire.SetupWire

/**
 * Setup's control channel over USB: `am broadcast -n <this receiver>` with
 * PAIR, RETARGET, STATUS or UNPAIR. The manifest exports it only to holders of
 * `android.permission.DUMP` — the ADB shell and the system.
 *
 * It answers promptly with the work done on the setup thread, never the
 * main thread and never behind the network: PAIR stores the pairing and lets
 * the runtime enroll in its own time, and RETARGET stores the new address —
 * for an enrolled phone or a pending one — and lets the runtime confirm and
 * connect to it, which STATUS then reports. Every answer
 * is the ordered broadcast's result code and, as result data, the status
 * after the command — which carries no secret, because Android logs it.
 */
class SetupReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        val phone = context.phone
        val action = intent.action
        val payload = intent.getStringExtra(PAYLOAD_EXTRA)
        phone.setup.execute {
            try {
                val result = when (action) {
                    PAIR -> phone.pair(payload)
                    RETARGET -> phone.retarget(payload)
                    STATUS -> SetupResult(SetupResult.APPLIED, phone.status())
                    UNPAIR -> phone.unpair()
                    else -> SetupResult(SetupResult.UNKNOWN_COMMAND, phone.status())
                }
                pending.setResult(result.code, JsonText.stringify(SetupWire.encodeStatus(result.status)), null)
            } catch (error: Exception) {
                Log.e(TAG, "Setup command $action failed", error)
                pending.setResult(SetupResult.FAILED, null, null)
            } finally {
                pending.finish()
            }
        }
    }

    private companion object {
        const val TAG = "AgentPhoneSetup"
        const val PAIR = "com.opensteer.agentphone.action.PAIR"
        const val RETARGET = "com.opensteer.agentphone.action.RETARGET"
        const val STATUS = "com.opensteer.agentphone.action.STATUS"
        const val UNPAIR = "com.opensteer.agentphone.action.UNPAIR"
        const val PAYLOAD_EXTRA = "payload"
    }
}
