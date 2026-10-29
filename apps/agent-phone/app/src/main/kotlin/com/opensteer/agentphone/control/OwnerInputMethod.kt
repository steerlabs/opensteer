package com.opensteer.agentphone.control

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.InputMethod
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo

/** Input start binds a connection to an accessibility identity, including virtual/resource-less editors. */
@android.annotation.TargetApi(33)
class OwnerInputMethod(private val service: AccessibilityService, private val changed: () -> Unit) : InputMethod(service) {
    var editor: AccessibilityNodeInfo? = null
        private set
    var selectionStart = -1
        private set
    var selectionEnd = -1
        private set
    var epoch = 0L
        private set

    override fun onStartInput(info: EditorInfo, restarting: Boolean) {
        super.onStartInput(info, restarting)
        epoch++
        selectionStart = info.initialSelStart
        selectionEnd = info.initialSelEnd
        // An input start must query this session's focus, not the previous editor's cached node.
        service.clearCache()
        editor = ownerFocusedEditor(service)?.takeIf {
            it.refresh() && it.isFocused && it.isEditable && it.packageName?.toString() == info.packageName
        }
        android.util.Log.d("OpensteerDisplay", "Owner editor started bound=${editor != null}")
        changed()
    }

    override fun onFinishInput() {
        editor = null
        selectionStart = -1
        selectionEnd = -1
        epoch++
        changed()
        super.onFinishInput()
    }

    override fun onUpdateSelection(oldSelStart: Int, oldSelEnd: Int, newSelStart: Int, newSelEnd: Int, candidatesStart: Int, candidatesEnd: Int) {
        super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)
        selectionStart = newSelStart
        selectionEnd = newSelEnd
        if (oldSelStart != newSelStart || oldSelEnd != newSelEnd) changed()
    }
}
