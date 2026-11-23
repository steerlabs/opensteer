package com.opensteer.remotetextinput

/**
 * CW4: a text change that reaches the hidden field outside the gate (a source the view does not
 * route through it) is one event, in order: one input, sent once the change has settled, with its
 * text and its caret together. The caret it moves on the way (TextView sets the selection more
 * than once for one change: setText puts it at the start, an accessibility set-text then at the
 * end) is part of it, never a selection report of its own, never undone. The known sources (an
 * accessibility set-text, a multi-character key) go through the gate whole instead.
 *
 * CY10: it takes its place in the gate's order when it arrives (`reserve`, the gate's), so nothing
 * typed after it can go before it; and it owns only the selection changes made outside a gate
 * turn while it settles, never another edit's.
 */
internal class RemoteInputOutsideEdit(private val reserve: () -> (() -> Unit)) {
  private var give: (() -> Unit)? = null

  /** The text is about to change; `byGate`: in a gate turn or the view's own apply. */
  fun changing(byGate: Boolean) {
    if (!byGate && give == null) give = reserve()
  }

  /** Whether a selection change belongs to the outside change: carried by its input, not reported. */
  fun ownsSelection(inTurn: Boolean): Boolean = give != null && !inTurn

  /**
   * The text changed. `later` runs its argument after the current call stack (the view's post),
   * when whatever set the selection for the same change has run too.
   */
  fun changed(byGate: Boolean, later: (() -> Unit) -> Unit) {
    if (byGate || give == null) return
    later {
      val given = give ?: return@later
      give = null
      given()
    }
  }
}
