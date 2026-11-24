package com.opensteer.remotetextinput

/**
 * The hidden field's selection changes only through the gate. Every input-method call passes the
 * connection wrapper and the gate, as do the hardware keys; a selection change seen outside a
 * gate turn (an accessibility service's long click or selection action, a context menu item, a
 * drag over the field, a stylus gesture) is not the person's keyboard: it is undone at once, the
 * selection going back where the gate left it, and reports nothing.
 */
internal class RemoteInputSelection(start: Int = 0, end: Int = 0) {
  enum class Outcome {
    /** A change in a gate turn the view did not make itself: reported. */
    REPORT,
    /** Nothing to report: the view's own change in a gate turn, or no change. */
    QUIET,
    /** A change outside the gate: put the selection back at [kept]. */
    UNDO,
  }
  /** Where the gate last left the selection. */
  var kept: Pair<Int, Int> = start to end
    private set

  /**
   * `mutating`: the view itself is applying what the gate or JavaScript told it (an answer, a
   * reset, the input method's call in its turn), in a gate turn or not.
   */
  fun changed(start: Int, end: Int, inGateTurn: Boolean, mutating: Boolean): Outcome {
    if (inGateTurn || mutating) {
      kept = start to end
      return if (mutating) Outcome.QUIET else Outcome.REPORT
    }
    return if (start == kept.first && end == kept.second) Outcome.QUIET else Outcome.UNDO
  }

  /** Where the selection goes back to in a text `length` long. */
  fun restore(length: Int): Pair<Int, Int> {
    val start = kept.first.coerceIn(0, length)
    return start to kept.second.coerceIn(start, length)
  }
}
