package com.opensteer.agentphone.fixture

import androidx.activity.ComponentActivity
import android.os.Bundle
import android.os.Build
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.view.MotionEvent
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.text.input.TextFieldValue

/** Each mode is a real editor. Receipts belong to the fixture, never the phone wire. */
class EditingFixtureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val receipts = Receipts(this)
        val mode = intent.getStringExtra("mode") ?: "native"
        if (mode == "moving") window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 80, 24, 0) }
        layout.addView(TextView(this).apply { text = "Remote editing: $mode" })
        if (mode == "moving") layout.setOnApplyWindowInsetsListener { view, insets ->
            if (!insets.isVisible(WindowInsets.Type.ime())) receipts.record("editing_ime_hidden", "")
            // Edge-to-edge no longer resizes the content window; the app owns IME avoidance.
            if (Build.VERSION.SDK_INT >= 35) view.setPadding(24, 80, 24, insets.getInsets(WindowInsets.Type.ime()).bottom)
            view.onApplyWindowInsets(insets)
        }
        setContentView(layout)
        when (mode) {
            "webview" -> {
                val inputId = java.util.UUID.randomUUID().toString()
                // The harness exposes the virtual editor only after the accessibility IME starts.
                var exposeEditor = false
                val web = object : WebView(this) {
                    override fun getAccessibilityNodeProvider(): android.view.accessibility.AccessibilityNodeProvider? =
                        if (exposeEditor) super.getAccessibilityNodeProvider() else null

                    override fun onCreateInputConnection(info: android.view.inputmethod.EditorInfo): android.view.inputmethod.InputConnection? {
                        val connection = super.onCreateInputConnection(info)
                        if (connection != null && info.inputType != 0) {
                            android.util.Log.d("AgentPhoneFixture", "WebView input started $inputId")
                            receipts.record("editing_web_input_started", inputId)
                        }
                        return connection
                    }
                }
                val release = object : android.content.BroadcastReceiver() {
                    override fun onReceive(context: android.content.Context, intent: android.content.Intent) {
                        exposeEditor = true
                        web.sendAccessibilityEvent(android.view.accessibility.AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
                        web.sendAccessibilityEvent(android.view.accessibility.AccessibilityEvent.TYPE_VIEW_FOCUSED)
                    }
                }
                if (Build.VERSION.SDK_INT >= 33) registerReceiver(release,
                    android.content.IntentFilter("com.opensteer.agentphone.fixture.EXPOSE_WEB_EDITOR"),
                    "android.permission.DUMP", null, RECEIVER_EXPORTED)
                else exposeEditor = true
                lifecycle.addObserver(object : androidx.lifecycle.DefaultLifecycleObserver {
                    override fun onDestroy(owner: androidx.lifecycle.LifecycleOwner) { if (Build.VERSION.SDK_INT >= 33) unregisterReceiver(release) }
                })
                web.id = R.id.fixture_text
                web.settings.javaScriptEnabled = true
                web.addJavascriptInterface(object {
                    @JavascriptInterface fun focused() { receipts.record("editing_web_focus", "") }
                    @JavascriptInterface fun changed(text: String, start: Int, end: Int) {
                        receipts.record("editing_text", text)
                        receipts.record("editing_selection", "$start:$end")
                    }
                }, "receipt")
                web.webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String) {
                        receipts.record("editing_web_ready", "")
                    }
                }
                web.setOnTouchListener { _, event ->
                    if (event.actionMasked == MotionEvent.ACTION_DOWN) receipts.record("editing_web_touch", "down")
                    if (event.actionMasked == MotionEvent.ACTION_UP) receipts.record("editing_web_touch", "up")
                    false
                }
                layout.addView(web, LinearLayout.LayoutParams(-1, 600))
                web.loadDataWithBaseURL("https://fixture.invalid/", """<meta name="viewport" content="width=device-width"><textarea style="width:90%;height:260px" onfocus="receipt.focused()" oninput="receipt.changed(this.value,this.selectionStart,this.selectionEnd)" onselect="receipt.changed(this.value,this.selectionStart,this.selectionEnd)"></textarea>""", "text/html", "utf-8", null)
            }
            "compose" -> {
                val compose = ComposeView(this)
                layout.addView(compose, LinearLayout.LayoutParams(-1, 600))
                compose.setContent {
                    var value by remember { mutableStateOf(TextFieldValue()) }
                    val focus = remember { FocusRequester() }
                    BasicTextField(value, onValueChange = {
                        value = it
                        receipts.record("editing_text", it.text)
                        receipts.record("editing_selection", "${it.selection.start}:${it.selection.end}")
                    }, modifier = Modifier.fillMaxWidth().focusRequester(focus))
                    LaunchedEffect(Unit) { focus.requestFocus() }
                }
            }
            else -> {
                val field = object : EditText(this) {
                    override fun onSelectionChanged(start: Int, end: Int) {
                        super.onSelectionChanged(start, end)
                        receipts.record("editing_selection", "$start:$end")
                    }
                }
                // NO_ID deliberately tests connection binding without an Android resource name.
                field.id = if (mode == "resource-less") View.NO_ID else R.id.fixture_text
                field.inputType = if (mode == "sensitive") android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
                    else android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
                field.addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                    override fun afterTextChanged(s: Editable?) { receipts.record("editing_text", s.toString()) }
                })
                if (mode == "moving") {
                    layout.isFocusableInTouchMode = true
                    layout.addView(View(this), LinearLayout.LayoutParams(-1, 0, 1f))
                    layout.addView(field, LinearLayout.LayoutParams(-1, 200))
                    field.setOnFocusChangeListener { _, focused -> if (focused) field.post {
                        getSystemService(android.view.inputmethod.InputMethodManager::class.java).showSoftInput(field, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
                    } }
                    layout.requestFocus()
                } else {
                    layout.addView(field, LinearLayout.LayoutParams(-1, 600))
                    field.requestFocus()
                }
            }
        }
    }
}
