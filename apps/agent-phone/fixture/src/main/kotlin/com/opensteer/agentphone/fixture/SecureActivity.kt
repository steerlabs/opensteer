package com.opensteer.agentphone.fixture

import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button

/**
 * A screen that keeps itself out of screenshots, as banking and password apps
 * do. Android blacks its window out of every screenshot, and the phone shares
 * that screenshot as it is, beside the accessibility tree; the receipt proves
 * an action on it still lands.
 */
class SecureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        setContentView(R.layout.activity_secure)
        val receipts = Receipts(this)
        findViewById<Button>(R.id.fixture_secure_button).setOnClickListener { receipts.record("secure_tap", "") }
    }
}
