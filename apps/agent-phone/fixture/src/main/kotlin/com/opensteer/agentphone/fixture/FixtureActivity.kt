package com.opensteer.agentphone.fixture

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.os.Bundle
import android.os.SystemClock
import android.text.Editable
import android.text.TextWatcher
import android.view.DragEvent
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo
import android.widget.AbsListView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView

/**
 * One screen with one of everything an agent does on a phone. Every
 * interaction is written to the receipts table, so a test asserts exactly
 * what happened — the text a field holds, which row was tapped, where a chip
 * was dropped — rather than reading pixels.
 */
open class FixtureActivity : Activity() {
    protected open val includePassword = true
    /** Where the finger actually went during one drag, in screen pixels and uptime milliseconds. */
    private val dragPath = mutableListOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_fixture)
        val receipts = Receipts(this)
        (findViewById<EditText>(R.id.fixture_text).parent as android.view.ViewGroup).addView(
            Button(this).apply {
                text = "Sign in with Opensteer Passwords"
                setOnClickListener { startActivity(android.content.Intent(this@FixtureActivity, PasswordsActivity::class.java)) }
            },
            0,
        )

        val text = findViewById<EditText>(R.id.fixture_text)
        // IME and same-value Editable replacements also notify TextWatcher.
        // Count dispatches at the View boundary, including rejected attempts;
        // keep every callback below as separate evidence of the field's text.
        text.accessibilityDelegate = object : View.AccessibilityDelegate() {
            override fun performAccessibilityAction(host: View, action: Int, args: Bundle?): Boolean {
                if (action == AccessibilityNodeInfo.ACTION_SET_TEXT) {
                    val requested = args?.getCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE)
                    receipts.record("set_text", requested?.toString().orEmpty())
                }
                return super.performAccessibilityAction(host, action, args)
            }
        }
        text.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit

            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit

            override fun afterTextChanged(s: Editable?) = receipts.record("text", s.toString())
        })
        // Every editor action is a submit; which one the platform sends is recorded beside the text.
        text.setOnEditorActionListener { view, action, _ ->
            receipts.record("submit", "${editorAction(action)}:${view.text}")
            true
        }

        // Only the fixture's private receipt database sees the real secret; accessibility stays masked.
        val password = findViewById<EditText>(R.id.fixture_password)
        // Android hides windows containing password inputs during screen sharing.
        // The display fixture exercises ordinary pixels; the original fixture keeps password coverage.
        if (!includePassword) (password.parent as android.view.ViewGroup).removeView(password)
        password.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) = receipts.record("password", s.toString())
        })
        @SuppressLint("ClickableViewAccessibility")
        findViewById<Button>(R.id.fixture_button).setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> receipts.record("button_touch", "down")
                MotionEvent.ACTION_UP -> receipts.record("button_touch", "up")
                MotionEvent.ACTION_CANCEL -> receipts.record("button_touch", "cancel")
            }
            false
        }
        findViewById<Button>(R.id.fixture_button).setOnClickListener { receipts.record("button_tap", "") }

        findViewById<TextView>(R.id.fixture_long_press).setOnLongClickListener {
            receipts.record("long_press", "")
            true
        }

        val drag = findViewById<TextView>(R.id.fixture_drag)
        // The finger's path on the chip, so a failed drag shows whether it was ever held or lifted early.
        // The listener only records and consumes nothing, so the chip's own long click still runs.
        @SuppressLint("ClickableViewAccessibility")
        drag.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    receipts.record("chip_touch", "down")
                    dragPath.clear()
                    dragPoint(event.rawX, event.rawY, event.eventTime)
                }
                // Moves before the system drag takes the pointer; after it, drag events carry it.
                MotionEvent.ACTION_MOVE -> dragPoint(event.rawX, event.rawY, event.eventTime)
                MotionEvent.ACTION_UP -> receipts.record("chip_touch", "up")
                MotionEvent.ACTION_CANCEL -> receipts.record("chip_touch", "cancel")
            }
            false
        }
        drag.setOnLongClickListener { view ->
            val started = view.startDragAndDrop(ClipData.newPlainText("chip", "chip"), View.DragShadowBuilder(view), null, 0)
            receipts.record("drag_start", started.toString())
            started
        }
        findViewById<TextView>(R.id.fixture_drop_target).setOnDragListener { view, event ->
            when (event.action) {
                DragEvent.ACTION_DRAG_LOCATION -> dragPoint(view, event)
                DragEvent.ACTION_DROP -> {
                    dragPoint(view, event)
                    receipts.record("drop", "target")
                }
                DragEvent.ACTION_DRAG_ENDED -> if (!event.result) receipts.record("drop", "outside")
            }
            true
        }
        // The rest of the screen sees the drag wherever the target does not, and ends the
        // path once: every listener that accepted the drag is told it ended.
        findViewById<View>(android.R.id.content).setOnDragListener { view, event ->
            when (event.action) {
                DragEvent.ACTION_DRAG_LOCATION -> dragPoint(view, event)
                DragEvent.ACTION_DRAG_ENDED -> {
                    if (dragPath.isNotEmpty()) receipts.record("drag_path", dragPath.joinToString(",", "[", "]"))
                    dragPath.clear()
                }
            }
            true
        }

        val list = findViewById<ListView>(R.id.fixture_list)
        list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, List(ROWS) { getString(R.string.row, it + 1) })
        list.setOnItemClickListener { _, _, position, _ -> receipts.record("row_tap", (position + 1).toString()) }
        list.setOnScrollListener(object : AbsListView.OnScrollListener {
            override fun onScrollStateChanged(view: AbsListView, state: Int) {
                if (state == AbsListView.OnScrollListener.SCROLL_STATE_IDLE) {
                    receipts.record("scrolled", (view.firstVisiblePosition + 1).toString())
                }
            }

            override fun onScroll(view: AbsListView, first: Int, visible: Int, total: Int) {
                val child = view.getChildAt(0) ?: return
                receipts.record("scroll_offset", (first * child.height - child.top + view.paddingTop).toString())
            }
        })
    }

    private fun dragPoint(view: View, event: DragEvent) {
        val origin = IntArray(2).also(view::getLocationOnScreen)
        dragPoint(origin[0] + event.x, origin[1] + event.y, SystemClock.uptimeMillis())
    }

    private fun dragPoint(x: Float, y: Float, uptimeMillis: Long) {
        dragPath += "{\"x\":$x,\"y\":$y,\"t\":$uptimeMillis}"
    }

    private fun editorAction(action: Int): String = when (action) {
        EditorInfo.IME_ACTION_SEND -> "send"
        EditorInfo.IME_ACTION_DONE -> "done"
        EditorInfo.IME_ACTION_GO -> "go"
        EditorInfo.IME_ACTION_SEARCH -> "search"
        EditorInfo.IME_ACTION_NEXT -> "next"
        else -> action.toString()
    }

    private companion object {
        const val ROWS = 200
    }
}
