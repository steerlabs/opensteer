package com.opensteer.remotetextinput

/**
 * Undo and redo are the far page's. TextView's own would change the hidden text outside the gate
 * (an input method's or a menu's undo reaches onTextContextMenuItem); instead the field sends the
 * far page's own chord through the gate, Ctrl+Z and Ctrl+Shift+Z, as a hardware key would, and
 * the reducer sends the page's command and resets the mirror from what comes back.
 */
internal object RemoteInputUndo {
  fun chord(redo: Boolean): List<Map<String, Any?>> = listOf("keydown", "keyup").map { type ->
    mapOf(
      "type" to type,
      "key" to if (redo) "Z" else "z",
      "code" to "KeyZ",
      "alt" to false,
      "control" to true,
      "meta" to false,
      "shift" to redo,
      "altGraph" to false,
      "location" to 0,
      "repeat" to false,
    )
  }
}
