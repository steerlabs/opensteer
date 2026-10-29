package com.opensteer.agentphone.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.CompoundButton
import android.widget.Switch
import android.widget.TextView
import com.opensteer.agentphone.R
import com.opensteer.agentphone.phone
import com.opensteer.agentphone.wire.ConnectionState
import com.opensteer.agentphone.wire.IssueCode
import com.opensteer.agentphone.wire.SetupStatus

/**
 * The owner's view of this phone: which Opensteer it works for, whether it
 * is connected and able to work, the Pause switch, Stop, and
 * removing it from Opensteer.
 */
class MainActivity : Activity() {
    private lateinit var deployment: TextView
    private lateinit var connection: TextView
    private lateinit var address: TextView
    private lateinit var issue: TextView
    private lateinit var dot: View
    private lateinit var setupMessage: TextView
    private lateinit var setupSection: View
    private lateinit var agentsSection: View
    private lateinit var healthSection: View
    private lateinit var accessibility: TextView
    private lateinit var accessibilitySettings: Button
    private lateinit var power: TextView
    private lateinit var charging: TextView
    private lateinit var batterySettings: Button
    private lateinit var pause: Switch
    private lateinit var session: TextView
    private lateinit var stop: Button
    private lateinit var unpair: Button
    private var shownSessionId: String? = null
    private val refresh: () -> Unit = ::load
    private val batteryChanged = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = load()
    }
    private val onPause = CompoundButton.OnCheckedChangeListener { _, checked -> phone.setPaused(checked) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
        setContentView(R.layout.activity_main)
        deployment = findViewById(R.id.status_deployment)
        connection = findViewById(R.id.status_connection)
        address = findViewById(R.id.status_address)
        issue = findViewById(R.id.status_issue)
        dot = findViewById(R.id.status_dot)
        setupMessage = findViewById(R.id.setup_message)
        setupSection = findViewById(R.id.setup_message_section)
        agentsSection = findViewById(R.id.agents_section)
        healthSection = findViewById(R.id.health_section)
        accessibility = findViewById(R.id.status_accessibility)
        accessibilitySettings = findViewById(R.id.accessibility_settings)
        power = findViewById(R.id.status_power)
        charging = findViewById(R.id.status_charging)
        batterySettings = findViewById(R.id.battery_settings)
        pause = findViewById(R.id.pause_switch)
        session = findViewById(R.id.status_session)
        stop = findViewById(R.id.session_stop)
        unpair = findViewById(R.id.unpair_button)
        accessibilitySettings.setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        batterySettings.setOnClickListener { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        stop.setOnClickListener { shownSessionId?.let { phone.runtime?.stopSession(it) } }
        unpair.setOnClickListener {
            val dialog = AlertDialog.Builder(this)
                .setTitle(R.string.unpair_title)
                .setMessage(R.string.unpair_message)
                .setPositiveButton(R.string.unpair_confirm) { _, _ -> phone.onSetupThread { phone.unpair() } }
                .setNegativeButton(android.R.string.cancel, null)
                .create()
            dialog.window?.addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
            dialog.show()
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(getColor(R.color.phone_danger))
        }
        pause.setOnCheckedChangeListener(onPause)
    }

    override fun onStart() {
        super.onStart()
        phone.addListener(refresh)
        registerReceiver(batteryChanged, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        load()
    }

    override fun onStop() {
        phone.removeListener(refresh)
        unregisterReceiver(batteryChanged)
        super.onStop()
    }

    /** Status reads the sealed identity, so it is built off the main thread. */
    private fun load() {
        phone.onSetupThread {
            val status = phone.status()
            runOnUiThread { if (!isDestroyed) render(status) }
        }
    }

    private fun render(status: SetupStatus) {
        val paired = status.pairing != null
        val unreadableSetup = !paired && status.issue?.code == IssueCode.FAILED
        deployment.text = status.pairing?.let { getString(R.string.status_paired, it.deploymentName) }
        deployment.visibility = if (paired) View.VISIBLE else View.GONE
        address.text = status.pairing?.let { getString(R.string.status_address, it.hostUrl) }
        address.visibility = if (paired) View.VISIBLE else View.GONE
        val state = when {
            status.connection == ConnectionState.NEEDS_UPDATE -> R.string.state_needs_update
            paired && status.paused -> R.string.state_paused
            else -> when (status.connection) {
                ConnectionState.UNPAIRED -> R.string.state_unpaired
                ConnectionState.PAIRING -> R.string.state_pairing
                ConnectionState.CONNECTING -> R.string.state_connecting
                ConnectionState.ONLINE -> R.string.state_online
                ConnectionState.OFFLINE -> R.string.state_offline
                ConnectionState.NEEDS_UPDATE -> R.string.state_needs_update
                ConnectionState.REMOVED -> R.string.state_removed
            }
        }
        val stateColor = when {
            status.connection == ConnectionState.NEEDS_UPDATE -> R.color.phone_warning
            paired && status.paused -> R.color.phone_warning
            status.connection == ConnectionState.ONLINE -> R.color.phone_success
            status.connection == ConnectionState.PAIRING || status.connection == ConnectionState.CONNECTING -> R.color.phone_accent
            else -> R.color.phone_muted
        }
        connection.setText(state)
        dot.background.mutate().setTint(getColor(stateColor))
        issue.text = status.issue?.detail
        issue.visibility = if (paired && status.issue != null && (!status.paused || status.connection == ConnectionState.NEEDS_UPDATE)) View.VISIBLE else View.GONE
        setupSection.visibility = if (paired) View.GONE else View.VISIBLE
        setupMessage.setText(when {
            unreadableSetup -> R.string.setup_reset_identity
            status.connection == ConnectionState.REMOVED -> R.string.removed_next_step
            else -> R.string.setup_next_step
        })
        agentsSection.visibility = if (paired) View.VISIBLE else View.GONE
        healthSection.visibility = if (paired) View.VISIBLE else View.GONE
        accessibility.setText(if (status.accessibilityConnected) R.string.accessibility_on else R.string.accessibility_off)
        accessibility.setTextColor(getColor(if (status.accessibilityConnected) R.color.phone_text_soft else R.color.phone_warning))
        accessibilitySettings.visibility = if (status.accessibilityConnected) View.GONE else View.VISIBLE
        power.setText(if (status.batteryOptimizationExempt) R.string.battery_exempt else R.string.battery_not_exempt)
        batterySettings.visibility = if (status.batteryOptimizationExempt) View.GONE else View.VISIBLE
        val pluggedIn = pluggedIn()
        charging.setText(if (pluggedIn) R.string.battery_charging else R.string.battery_unplugged)
        charging.setTextColor(getColor(if (pluggedIn) R.color.phone_text_soft else R.color.phone_warning))
        pause.setOnCheckedChangeListener(null)
        pause.isChecked = status.paused
        pause.isEnabled = paired
        pause.setOnCheckedChangeListener(onPause)
        val active = phone.report?.session
        shownSessionId = active?.id
        val inUse = active != null
        val taskTitle = active?.title ?: getString(R.string.untitled_task)
        session.text = if (inUse) getString(R.string.session_in_use, taskTitle) else getString(R.string.session_none)
        stop.contentDescription = getString(R.string.stop_task_description, taskTitle)
        stop.visibility = if (inUse) View.VISIBLE else View.GONE
        unpair.visibility = if (paired || unreadableSetup) View.VISIBLE else View.GONE
    }

    /** A phone for agents is meant to stay plugged in; on battery it says so. */
    private fun pluggedIn(): Boolean {
        val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return false
        return battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
    }
}
