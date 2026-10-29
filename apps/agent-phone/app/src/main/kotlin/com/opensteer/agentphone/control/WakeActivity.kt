package com.opensteer.agentphone.control

import android.app.Activity
import android.app.KeyguardManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.util.concurrent.atomic.AtomicInteger

/**
 * Turns the screen on for an agent's `wake` action, and dismisses a lock
 * screen that needs no credential. It shows nothing and always finishes:
 * when the lock screen is gone, when it cannot be dismissed, or after a few
 * seconds whatever happened.
 */
class WakeActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        live.incrementAndGet()
        created.incrementAndGet()
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        main.postDelayed(::finish, LONGEST_MS)
    }

    override fun onResume() {
        super.onResume()
        val keyguard = getSystemService(KeyguardManager::class.java)
        if (keyguard.isKeyguardLocked && !keyguard.isDeviceSecure) {
            keyguard.requestDismissKeyguard(
                this,
                object : KeyguardManager.KeyguardDismissCallback() {
                    override fun onDismissSucceeded() = finish()

                    override fun onDismissError() = finish()

                    override fun onDismissCancelled() = finish()
                },
            )
        } else {
            // The window had to be shown for the screen to turn on; it has been.
            main.postDelayed(::finish, SHOWN_MS)
        }
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        live.decrementAndGet()
        super.onDestroy()
    }

    companion object {
        private const val SHOWN_MS = 300L
        /** It finishes by then whatever happened. */
        const val LONGEST_MS = 3_000L
        private val live = AtomicInteger()
        private val created = AtomicInteger()

        /** How many have ever been created, so a waiter can tell its own from an earlier one. */
        val started: Int get() = created.get()

        /** Whether one is on screen now. */
        val showing: Boolean get() = live.get() > 0
    }
}
