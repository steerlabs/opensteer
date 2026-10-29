import assert from "node:assert/strict";

export interface DialogExitObservation {
  readonly phase:
    | "release-held"
    | "settling"
    | "answered"
    | "dialog-close-observed"
    | "release-finished"
    | "detach-sent"
    | "exited";
  readonly at: number;
}

/** Timestamps are diagnostics; only acknowledged milestones establish cross-transport order. */
export function assertDialogExitOrder(events: readonly DialogExitObservation[]): void {
  const index = (phase: DialogExitObservation["phase"]) => {
    const position = events.findIndex((entry) => entry.phase === phase);
    assert(position >= 0, `Missing dialog-exit observation: ${phase}`);
    return position;
  };
  const answered = index("answered");
  assert(index("release-held") < answered);
  assert(index("settling") < answered);
  assert(answered < index("dialog-close-observed"));
  assert(index("dialog-close-observed") < index("release-finished"));
  assert(index("release-finished") < index("detach-sent"));
  assert(index("detach-sent") < index("exited"));
}
