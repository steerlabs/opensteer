/** Where a message a device holds is on its way to the computer, as its transcript draws it. */
export type MessageDeliveryPhase = "waiting" | "sending" | "rejected" | "delivered";

export type MessageDeliveryAction = "edit" | "delete" | "dont-send";

/**
 * What a person may do to a message still on their device. A refused message
 * can be edited or deleted. A waiting one can be taken back only if no attempt
 * was ever made: after one, it may already be on the computer, and the same
 * key is replayed until it is settled.
 */
export function messageDeliveryActions(
  phase: MessageDeliveryPhase,
  attempted: boolean,
): readonly MessageDeliveryAction[] {
  if (phase === "rejected") return ["edit", "delete"];
  if (phase === "waiting" && !attempted) return ["edit", "dont-send"];
  return [];
}

/**
 * Which messages of a transcript's run carry the status line: a run of waiting
 * messages says it once, under the last, as a grouped receipt does.
 */
export function messageDeliveryStatusShown(
  phases: readonly MessageDeliveryPhase[],
): readonly boolean[] {
  return phases.map(
    (phase, index) =>
      phase !== "delivered" && !(phase === "waiting" && phases[index + 1] === "waiting"),
  );
}
