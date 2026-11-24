package com.opensteer.remotetextinput

/**
 * CZ1: what an accessibility set-text does. Where the field is editable it goes through the gate
 * whole (its text and the caret it puts at the end are one edit); anywhere else it is refused and
 * nothing changes: never TextView's own set-text, which changes the hidden field outside the gate.
 */
internal enum class RemoteInputSetText {
  THROUGH_GATE,
  REFUSED;

  companion object {
    fun of(editable: Boolean): RemoteInputSetText = if (editable) THROUGH_GATE else REFUSED
  }
}
