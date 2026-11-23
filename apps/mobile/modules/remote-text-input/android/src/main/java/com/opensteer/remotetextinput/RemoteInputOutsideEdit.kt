package com.opensteer.remotetextinput

/**
 * CW4: a text change that reaches the hidden field outside the gate (a source the view does not
 * route through it) is one event, in order: one input, sent once the change has settled, with its
 * text and its caret together. The caret it moves on the way (TextView sets the selection more
 * than once for one change: setText puts it at the start, an accessibility set-text then at the
 * end) is part of it, never a selection report of its own, never undone. The known sources (an
 * accessibility set-text, a multi-character key) go through the gate whole instead.
 */
internal class RemoteInputOutsideEdit(private val send: () -> Unit) {
  var active = false
    private set

  /** The text is about to change; `byGate`: in a gate turn or the view's own apply. */
  fun changing(byGate: Boolean) {
    if (!byGate) active = true
  }

  /** A selection change now belongs to the outside change: carried by its input, not reported. */
  fun ownsSelection(): Boolean = active

  /**
   * The text changed. `later` runs its argument after the current call stack (the view's post),
   * when whatever set the selection for the same change has run too.
   */
  fun changed(byGate: Boolean, later: (() -> Unit) -> Unit) {
    if (byGate || !active) return
    later {
      if (active) {
        active = false
        send()
      }
    }
  }
}
