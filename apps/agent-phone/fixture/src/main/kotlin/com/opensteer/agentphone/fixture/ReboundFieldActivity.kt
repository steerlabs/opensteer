package com.opensteer.agentphone.fixture

import android.app.Activity
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.widget.Button
import android.widget.EditText

/**
 * A list's recycled editor without a second view: rebinding changes its
 * semantic label while the node, view id, window and current text all stay.
 * The harness presses the buttons as an owner would, without replacing the
 * agent's cited observation, and receipts prove whether a stale act wrote.
 */
class ReboundFieldActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_rebound_field)
        val receipts = Receipts(this)
        val field = findViewById<EditText>(R.id.fixture_rebound_field)
        val description = intent.getStringExtra("labelKind") == "description"
        field.hint = "Message A"
        field.contentDescription = if (description) "Recipient A" else null
        field.setText("Keep me")
        field.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit

            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit

            override fun afterTextChanged(s: Editable?) = receipts.record("rebound_text", s.toString())
        })
        findViewById<Button>(R.id.fixture_rebind).setOnClickListener {
            if (description) field.contentDescription = "Recipient B" else field.hint = "Message B"
            receipts.record("rebound_label", if (description) "Recipient B" else "Message B")
        }
        findViewById<Button>(R.id.fixture_change_text).setOnClickListener {
            field.setText("Updated ")
            field.setSelection(field.text.length)
        }
    }
}
