package com.opensteer.remotetextinput

/**
 * CY10: a multiple key event (KeyEvent.ACTION_MULTIPLE) goes through the gate whole: a string of
 * characters (an unknown key code) is typed as one insertion; a key repeated (a key code with its
 * repeat count) is each press in turn, through the gate like any key.
 */
internal sealed interface RemoteInputMultipleKey {
  data class Insert(val text: String) : RemoteInputMultipleKey
  data class Presses(val count: Int) : RemoteInputMultipleKey
  data object Nothing : RemoteInputMultipleKey

  companion object {
    fun of(unknown: Boolean, repeatCount: Int, characters: String?): RemoteInputMultipleKey = when {
      unknown && !characters.isNullOrEmpty() -> Insert(characters)
      !unknown && repeatCount > 0 -> Presses(repeatCount)
      else -> Nothing
    }
  }
}
