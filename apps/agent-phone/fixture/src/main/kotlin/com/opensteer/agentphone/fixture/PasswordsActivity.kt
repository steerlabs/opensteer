package com.opensteer.agentphone.fixture

import android.app.Activity
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

/** Synthetic saved-login receiver. No entered text is persisted or logged. */
class PasswordsActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val receipts = Receipts(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }
        val mode = intent.getStringExtra("mode") ?: "login"
        val expectedPassword = when (mode) {
            "unicode" -> "\uFEFFhéllo 😀 e\u0301 مرحبا"
            "empty" -> ""
            "controls" -> "a\r\nb\tc"
            else -> "pw-canary-7d8bde4e-709c-47e5-86ad-f61c9e2ffda0"
        }
        val account = "synthetic.person@passwords-fixture.test"
        root.addView(TextView(this).apply { text = "Sign in to passwords-fixture.test" })
        fun field(name: String, expected: String, secure: Boolean): EditText {
            val input = EditText(this).apply {
                id = View.generateViewId()
                hint = name
                inputType = if (secure) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                    else InputType.TYPE_CLASS_TEXT
                if (mode == "secure-fallback" && secure) {
                    contentDescription = expectedPassword
                    hint = expectedPassword
                }
            }
            var attempts = 0
            input.accessibilityDelegate = object : View.AccessibilityDelegate() {
                override fun performAccessibilityAction(host: View, action: Int, args: Bundle?): Boolean {
                    if (action == AccessibilityNodeInfo.ACTION_SET_TEXT) {
                        attempts += 1
                        receipts.record("login_attempt", JSONObject().put("field", name).put("attempts", attempts).toString())
                    }
                    return super.performAccessibilityAction(host, action, args)
                }
            }
            input.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(s: Editable?) {
                    receipts.record("login_predicate", JSONObject().put("field", name).put("matches", s.toString() == expected).put("attempts", attempts).toString())
                }
            })
            root.addView(input)
            return input
        }
        val username = field("Username", account, false)
        val password = field("Password", expectedPassword, true)
        val code = field("Code", "028491", false)
        val status = TextView(this).apply { text = "Signed out" }
        root.addView(Button(this).apply {
            text = "Sign in"
            setOnClickListener {
                val authenticated = username.text.toString() == account && password.text.toString() == expectedPassword &&
                    (mode != "totp" || code.text.toString() == "028491")
                receipts.record("login_submit", JSONObject().put("authenticated", authenticated).toString())
                status.text = if (authenticated) "Signed in as $account" else "Sign in failed"
            }
        })
        root.addView(Button(this).apply {
            text = "Record login tap"
            setOnClickListener { receipts.record("login_tap", "true") }
        })
        root.addView(status)
        setContentView(root)
    }
}
