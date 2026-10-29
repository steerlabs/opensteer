package com.opensteer.agentphone.fixture

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicReference

/**
 * Real Activity/View/SQLite regression, without UiAutomation (which would
 * suspend the Agent Phone service). Failure modes, declared before the hook:
 * missing or double action receipts; same-value IME/Editable callbacks
 * masquerading as writes; collapsed identical dispatches; missing rejected
 * dispatches; fabricated receipts from plain edits; and changed forwarding
 * or submit behavior. The JSON result retains every callback and action row.
 *
 * `adb shell am instrument -w -r
 * com.opensteer.agentphone.fixture.test/com.opensteer.agentphone.fixture.TextReceiptInstrumentation`
 */
class TextReceiptInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        start()
    }

    override fun onStart() {
        val cases = JSONArray()
        val receipts = Receipts(targetContext)
        var activity: Activity? = null
        var fatal: Throwable? = null
        try {
            val fixture = startActivitySync(
                Intent(targetContext, FixtureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            activity = fixture

            case(cases, receipts, fixture, "one accessibility write forwards once with one submit") { field ->
                val token = "one-dispatch"
                check(setText(field, token)) { "The enabled editor rejected ACTION_SET_TEXT." }
                check(field.text.toString() == token) { "The dispatched value was not visible." }
                check(field.performAccessibilityAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id, null))
                expectDetails(receipts, "set_text", listOf(token))
                expectDetails(receipts, "text", listOf(token))
                expectDetails(receipts, "submit", listOf("0:$token"))
            }

            case(cases, receipts, fixture, "same-value InputConnection and Editable callbacks are not dispatches") { field ->
                val token = "same-value"
                field.setText(token)
                receipts.writableDatabase.delete("receipts", null, null)
                field.setSelection(0, token.length)
                val connection = requireNotNull(field.onCreateInputConnection(EditorInfo()))
                check(connection.commitText(token, 1)) { "The real InputConnection rejected its replacement." }
                field.text.replace(0, field.length(), token)
                check(field.text.toString() == token) { "Same-value edits changed the visible text." }
                expectDetails(receipts, "set_text", emptyList())
                expectDetails(receipts, "text", listOf(token, token))
                expectDetails(receipts, "submit", emptyList())
                connection.closeConnection()
            }

            case(cases, receipts, fixture, "identical accessibility writes remain two distinct dispatches") { field ->
                val token = "repeat-dispatch"
                check(setText(field, token))
                check(setText(field, token))
                check(field.text.toString() == token) { "Repeated writes changed the expected final value." }
                expectDetails(receipts, "set_text", listOf(token, token))
                expectDetails(receipts, "text", listOf(token, token))
                expectDetails(receipts, "submit", emptyList())
            }

            case(cases, receipts, fixture, "a rejected disabled write is recorded before forwarding") { field ->
                field.setText("keep-this-value")
                receipts.writableDatabase.delete("receipts", null, null)
                field.isEnabled = false
                check(!setText(field, "rejected-dispatch")) { "The disabled editor unexpectedly accepted the write." }
                check(field.text.toString() == "keep-this-value") { "A rejected write changed the editor." }
                expectDetails(receipts, "set_text", listOf("rejected-dispatch"))
                expectDetails(receipts, "text", emptyList())
                expectDetails(receipts, "submit", emptyList())
            }

            case(cases, receipts, fixture, "plain non-accessibility edits do not fabricate action receipts") { field ->
                field.setText("plain-edit")
                field.text.replace(0, field.length(), "plain-replacement")
                check(field.text.toString() == "plain-replacement")
                expectDetails(receipts, "set_text", emptyList())
                expectDetails(receipts, "text", listOf("plain-edit", "plain-replacement"))
                expectDetails(receipts, "submit", emptyList())
            }
        } catch (error: Throwable) {
            fatal = error
        } finally {
            activity?.let { onMain { it.finish() } }
            receipts.close()
        }
        val passed = fatal == null && (0 until cases.length()).all { cases.getJSONObject(it).getBoolean("passed") }
        val report = JSONObject().put("cases", cases).put("passed", passed)
        fatal?.let { report.put("error", "${it.javaClass.simpleName}: ${it.message}") }
        finish(if (passed) Activity.RESULT_OK else Activity.RESULT_CANCELED, Bundle().apply {
            putString("stream", "\n${report.toString(2)}\n")
        })
    }

    private fun case(results: JSONArray, receipts: Receipts, activity: Activity, name: String, run: (EditText) -> Unit) {
        val result = JSONObject().put("name", name)
        try {
            onMain {
                val field = activity.findViewById<EditText>(R.id.fixture_text)
                field.isEnabled = true
                field.requestFocus()
                field.setText("")
                receipts.writableDatabase.delete("receipts", null, null)
                try {
                    run(field)
                } finally {
                    result.put("finalValue", field.text.toString())
                    result.put("receipts", rows(receipts))
                }
            }
            result.put("passed", true)
        } catch (error: Throwable) {
            result.put("passed", false).put("error", "${error.javaClass.simpleName}: ${error.message}")
        }
        results.put(result)
    }

    private fun onMain(run: () -> Unit) {
        val failure = AtomicReference<Throwable?>()
        runOnMainSync {
            try {
                run()
            } catch (error: Throwable) {
                failure.set(error)
            }
        }
        failure.get()?.let { throw it }
    }

    private fun setText(field: EditText, text: String): Boolean = field.performAccessibilityAction(
        AccessibilityNodeInfo.ACTION_SET_TEXT,
        Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) },
    )

    private fun expectDetails(receipts: Receipts, kind: String, expected: List<String>) {
        val actual = ArrayList<String>()
        receipts.readableDatabase.query("receipts", arrayOf("detail"), "kind = ?", arrayOf(kind), null, null, "_id").use { cursor ->
            while (cursor.moveToNext()) actual += cursor.getString(0)
        }
        check(actual == expected) { "$kind receipts: expected $expected, got $actual" }
    }

    private fun rows(receipts: Receipts): JSONArray = JSONArray().apply {
        receipts.readableDatabase.query("receipts", arrayOf("_id", "at", "kind", "detail"), null, null, null, null, "_id").use { cursor ->
            while (cursor.moveToNext()) {
                put(JSONObject().put("id", cursor.getLong(0)).put("at", cursor.getLong(1))
                    .put("kind", cursor.getString(2)).put("detail", cursor.getString(3)))
            }
        }
    }
}
