package com.opensteer.remotetextinput

import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.InputDevice
import android.view.WindowInsets
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.facebook.react.views.textinput.ReactEditText
import java.net.URL
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Full Expo module + reducer regression, with deliberate native FIFO scheduling.
 * InputConnection calls exercise native composition and RN editor-action blur;
 * this is not a recording of a Japanese/Korean soft IME. */
class RemoteEditingJourneyTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private fun main(action: () -> Unit) = instrumentation.runOnMainSync(action)
  private fun waitFor(label: String, predicate: () -> Boolean) {
    val deadline = SystemClock.uptimeMillis() + 60000
    while (SystemClock.uptimeMillis() < deadline) {
      if (predicate()) return
      SystemClock.sleep(100)
    }
    throw AssertionError("Timed out: $label")
  }
  private fun views(): List<View> {
    val result = mutableListOf<View>()
    fun visit(view: View) {
      result.add(view)
      if (view is ViewGroup) for (index in 0 until view.childCount) visit(view.getChildAt(index))
    }
    main {
      for (activity in ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)) visit(activity.window.decorView)
    }
    return result
  }
  private fun keyboardVisible(view: View): Boolean {
    var visible = false
    main { visible = view.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true }
    return visible
  }
  private fun events(): List<JSONObject> {
    val array = JSONObject(URL("http://10.0.2.2:18766/events").readText()).getJSONArray("events")
    return (0 until array.length()).map { array.getJSONObject(it) }
  }
  private fun tap(label: String) {
    val view = views().firstOrNull { it.contentDescription?.toString() == label || (it is TextView && it.text.toString().equals(label, true)) }
      ?: throw AssertionError("No native view: $label")
    val coordinates = IntArray(2)
    var x = 0f; var y = 0f
    main { view.getLocationOnScreen(coordinates); x = coordinates[0] + view.width / 2f; y = coordinates[1] + view.height / 2f }
    val now = SystemClock.uptimeMillis()
    for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
      val event = MotionEvent.obtain(now, now + action * 30L, action, x, y, 0)
      event.source = InputDevice.SOURCE_TOUCHSCREEN
      instrumentation.sendPointerSync(event)
      event.recycle()
    }
  }
  private fun launch() {
    instrumentation.targetContext.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("com.opensteer.mobile://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A18766")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    waitFor("production native proxy") { views().any { it is RemoteInputEditText } }
  }
  @Test fun contextRotationAppliesResetBeforeQueuedTyping() {
    launch()
    val view = views().filterIsInstance<RemoteInputEditText>().single()
    waitFor("native soft keyboard") { keyboardVisible(view) }
    val button = views().first { it.contentDescription?.toString() == "Next remote field" }
    lateinit var connection: InputConnection
    val packets = JSONArray()
    val failure = AtomicReference<String>()
    main {
      connection = view.onCreateInputConnection(EditorInfo())!!
      val owner = view.parent as RemoteTextInputView
      val oldContext = owner.editingContext?.get("contextId")
      val dispatcher = view.deliver!!
      val handler = Handler(Looper.getMainLooper())
      var rotating = false
      var queued = false
      view.deliver = { packet ->
        packets.put(JSONObject(packet))
        val event = packet["event"] as Map<*, *>
        if (!rotating && event["type"] == "compositionupdate") {
          rotating = true
          // Touch the actual RN button while the native gate still has marked text.
          handler.post {
            if (BaseInputConnection.getComposingSpanStart(view.text) < 0) failure.set("Composition ended before rotation touch")
            val location = IntArray(2); button.getLocationOnScreen(location)
            val root = button.rootView
            val origin = IntArray(2); root.getLocationOnScreen(origin)
            val now = SystemClock.uptimeMillis()
            for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
              val touch = MotionEvent.obtain(now, now + action * 30L, action,
                location[0] - origin[0] + button.width / 2f,
                location[1] - origin[1] + button.height / 2f, 0)
              touch.source = InputDevice.SOURCE_TOUCHSCREEN
              root.dispatchTouchEvent(touch); touch.recycle()
            }
          }
        }
        if (rotating && !queued && event["type"] == "compositionend") {
          queued = true
          val deadline = SystemClock.uptimeMillis() + 60000
          fun deliverAfterContextPublication() {
            if (owner.editingContext?.get("contextId") != oldContext) {
              // Native configure is already queued behind this ending. Queue a
              // behind configure, then let the real JS module acknowledge it.
              connection.commitText("a", 1)
              dispatcher(packet)
            } else if (SystemClock.uptimeMillis() < deadline) {
              handler.postDelayed({ deliverAfterContextPublication() }, 10)
            } else failure.set("Context did not rotate before ending acknowledgement")
          }
          handler.post { deliverAfterContextPublication() }
        } else dispatcher(packet)
      }
      connection.setComposingText("に", 1)
    }
    waitFor("new context a accepted") {
      failure.get()?.let { throw AssertionError(it) }
      events().any { it.optString("type") == "target" && it.getJSONObject("details").optString("value") == "a" }
    }
    SystemClock.sleep(300) // Let any deferred React reset run before the next key.
    val targetsBeforeB = events().count { it.optString("type") == "target" }
    main { connection.commitText("b", 1) }
    waitFor("second edit") { events().count { it.optString("type") == "target" } > targetsBeforeB }
    val target = events().last { it.optString("type") == "target" }.getJSONObject("details")
    var trace = ""
    main { trace = packets.toString(2) }
    instrumentation.targetContext.filesDir.resolve("rotation-packets.json").writeText(trace)
    assertEquals("Queued typing must append after rotation", "ab", target.getString("value"))
    main { assertTrue("Rotation must retain focus", view.hasFocus()) }
    assertTrue("Rotation must retain the keyboard", keyboardVisible(view))
  }
  @Test fun legacyReturnUsesTheRealNativeBlurPathAndKeepsTyping() {
    launch()
    tap("baseline")
    waitFor("legacy RN input") { views().any { it is ReactEditText } }
    val view = views().filterIsInstance<ReactEditText>().single()
    val start = events().size
    waitFor("legacy soft keyboard") { keyboardVisible(view) }
    lateinit var connection: InputConnection
    main {
      connection = view.onCreateInputConnection(EditorInfo())!!
      connection.commitText("a", 1)
    }
    waitFor("legacy a") { events().drop(start).any { it.optString("type") == "browser-operation" && it.getJSONObject("details").optJSONObject("edit")?.optString("text") == "a" } }
    // RN ReactEditText's actual editor-action listener decides submit vs blur.
    // Calling JS onSubmitEditing directly would miss this regression.
    main { connection.performEditorAction(EditorInfo.IME_ACTION_DONE) }
    waitFor("Enter projection") { events().drop(start).any { it.optString("type") == "browser-operation" && it.getJSONObject("details").optJSONObject("keystroke")?.optString("key") == "Enter" } }
    SystemClock.sleep(300)
    assertFalse("Return must not invoke native blur/onDone", events().drop(start).any { it.optString("type") == "keyboard-done" })
    main { assertTrue("RN input stays focused after Return", view.hasFocus()) }
    assertTrue("Return must retain the keyboard", keyboardVisible(view))
    main { connection.commitText("b", 1) }
    waitFor("legacy b after Return") { events().drop(start).any { it.optString("type") == "browser-operation" && it.getJSONObject("details").optJSONObject("edit")?.optString("text") == "b" } }
  }
}
