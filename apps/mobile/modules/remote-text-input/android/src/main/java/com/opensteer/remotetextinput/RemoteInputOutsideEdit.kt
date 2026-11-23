package com.opensteer.remotetextinput

/**
 * CW4: a text change that reaches the hidden field outside the gate (a source the view does not
 * route through it) is one event, in order: one input, sent once the change has settled, with its
 * text and its caret together. The caret it moves on the way (TextView sets the selection more
 * than once for one change: setText puts it at the start, an accessibility set-text then at the
 * end) is part of it, never a selection report of its own, never undone. The known sources (an
 * accessibility set-text, a multi-character key) go through the gate whole instead.
 *
 * CY10, CZ4: it takes its place in the gate's order once the text has changed (`reserve`, the
 * gate's), so nothing typed after it goes before it; its input is made at its turn, so it says
 * what the field holds then (a key that was waiting has been applied over it). The place is
 * always given back: when the change settles, when the view goes (`abandon`), and a change that
 * never finished (a watcher threw before the text changed) reserved nothing. It owns only the
 * selection changes made outside a gate turn while it settles.
 */
internal class RemoteInputOutsideEdit(private val reserve: () -> (() -> Unit)) {
  private var changing = false
  private var give: (() -> Unit)? = null

  /**
   * The text is about to change; `byGate`: in a gate turn or the view's own apply. `later` runs
   * its argument after the current call stack (the view's post): a change that never reaches
   * `changed` stops owning the selection then.
   */
  fun changing(byGate: Boolean, later: (() -> Unit) -> Unit) {
    if (byGate || changing) return
    changing = true
    later { if (give == null) changing = false }
  }

  /** Whether a selection change belongs to the outside change: carried by its input, not reported. */
  fun ownsSelection(inTurn: Boolean): Boolean = (changing || give != null) && !inTurn

  /**
   * The text changed. `later` runs its argument after the current call stack (the view's post),
   * when whatever set the selection for the same change has run too.
   */
  fun changed(byGate: Boolean, later: (() -> Unit) -> Unit) {
    if (byGate || !changing) return
    if (give == null) give = reserve()
    later { settle() }
  }

  /** The view goes before the change settled: its place is given back, its input sent. */
  fun abandon() = settle()

  private fun settle() {
    changing = false
    val given = give ?: return
    give = null
    given()
  }
}
