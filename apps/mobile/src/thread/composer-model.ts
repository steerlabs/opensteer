/**
 * What the composer bar shows, decided away from the bar that shows it.
 *
 * The bar has one job that is genuinely stateful — a message and its
 * idempotency key — and a second that is only arithmetic: which control is in
 * the round slot and whether the settings row is on screen. The second is
 * here so it can be read and tested without a renderer, and so the component
 * is left with layout.
 *
 * Expansion is derived, never stored. A stored flag would have to be cleared on
 * every path that empties the field, and one missed path leaves a two-row bar
 * over an empty thread.
 */

export type ComposerAction = "send" | "stop" | "voice";

export type ComposerShape = "capsule" | "rounded";

export interface ComposerState {
  /** Files staged on the draft, uploaded or not. */
  readonly attachments: number;
  /** Every staged file is on the Host; words never go on without them. */
  readonly attachmentsReady: boolean;
  /** False while the Host is unreachable: a message is never queued blind. */
  readonly canRespond: boolean;
  /** What stops this Thread accepting anything, in words, or null. */
  readonly disabledReason: string | null;
  readonly focused: boolean;
  /** A durable message this phone still owes the Host. */
  readonly pendingCommand: boolean;
  /**
   * A native menu or a sheet raised from the bar is on screen. It takes first
   * responder away from the field, and without this the row holding the control
   * that opened it would leave while the menu is still anchored to it.
   */
  readonly presenting: boolean;
  /** An archived Thread: its transcript stays, its composer does not. */
  readonly readOnly: boolean;
  readonly running: boolean;
  readonly sending: boolean;
  readonly text: string;
  /** The open Request is answered by choosing, so there is nothing to type. */
  readonly textHidden: boolean;
  /** Voice can be started from this bar. */
  readonly voice: boolean;
}

export interface ComposerView {
  /** The single round control at the trailing edge, or nothing to put there. */
  readonly action: ComposerAction | null;
  readonly canSend: boolean;
  readonly expanded: boolean;
  /** Archived: one sentence where the field would be, and no controls. */
  readonly readOnly: boolean;
  readonly shape: ComposerShape;
  readonly showField: boolean;
  readonly showPills: boolean;
}

export function composerView(state: ComposerState): ComposerView {
  const hasContent = state.text.trim().length > 0 || state.attachments > 0;
  const blocked = state.disabledReason !== null || !state.canRespond || state.readOnly;
  // Text, not trimmed text: a space typed on purpose has already changed the
  // bar's shape, and having it snap back would be the bar arguing.
  const expanded =
    !state.readOnly &&
    (state.focused || state.text.length > 0 || state.attachments > 0 || state.presenting);
  return {
    // One circle, never two. A run with something typed keeps Send, because the
    // typed thing is what the person came back for; Stop stays reachable in the
    // bar's own menu for exactly that case. With nothing to send and nothing
    // running, the circle is voice where it exists, rather than a Send that
    // cannot be pressed. An archived thread has no circle at all: a control that
    // can never be used is worse than no control.
    action: state.readOnly
      ? null
      : state.textHidden
        ? state.running
          ? "stop"
          : null
        : stateAction(state, hasContent),
    canSend:
      !blocked && !state.sending && !state.pendingCommand && state.attachmentsReady && hasContent,
    expanded,
    readOnly: state.readOnly,
    shape: expanded ? "rounded" : "capsule",
    showField: !state.textHidden && !state.readOnly,
    showPills: expanded,
  };
}

function stateAction(state: ComposerState, hasContent: boolean): ComposerAction {
  if (hasContent) return "send";
  if (state.running) return "stop";
  return state.voice ? "voice" : "send";
}
