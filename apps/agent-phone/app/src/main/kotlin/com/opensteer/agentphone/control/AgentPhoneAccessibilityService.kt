package com.opensteer.agentphone.control

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent
import com.opensteer.agentphone.phone

/**
 * The one owner of the phone's runtime. Android binds an enabled
 * accessibility service at boot, re-binds it after its process dies, and
 * gives it what the runtime needs: the screen, gestures, background activity
 * starts and a process kept running. No foreground service is involved.
 */
class AgentPhoneAccessibilityService : AccessibilityService() {
    private var runtime: PhoneRuntime? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        // A re-bind without an unbind in between still starts from nothing.
        teardown()
        val started = PhoneRuntime(this, phone)
        runtime = started
        phone.runtimeStarted(started)
        started.start()
    }

    /**
     * Own windows close publication immediately; other packages' window changes
     * also lift protection when the owner leaves this app. Contentless helper
     * activities do not represent protected UI.
     */
    @android.annotation.TargetApi(33)
    override fun onCreateInputMethod(): android.accessibilityservice.InputMethod = OwnerInputMethod(this) { runtime?.editingChanged() }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType in setOf(AccessibilityEvent.TYPE_VIEW_FOCUSED, AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED,
                AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED, AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED, AccessibilityEvent.TYPE_WINDOWS_CHANGED)) runtime?.editingChanged()

        if (event?.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) {
            runtime?.windowsChanged()
            return
        }
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || event.packageName == null) return
        if (event.className == WakeActivity::class.java.name || event.className == com.opensteer.agentphone.display.ProjectionActivity::class.java.name) return
        runtime?.windowChanged(event.packageName == packageName)
    }

    override fun onInterrupt() = Unit

    override fun onUnbind(intent: Intent?): Boolean {
        teardown()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        teardown()
        super.onDestroy()
    }

    private fun teardown() {
        val current = runtime ?: return
        runtime = null
        phone.runtimeStopped(current)
        current.stop()
    }
}
