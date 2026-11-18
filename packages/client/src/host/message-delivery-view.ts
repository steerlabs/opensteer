import type { MessageEntry, TranscriptEntry } from "./client.js";

/** Where a message a device holds is on its way to the computer, as its transcript draws it. */
export type MessageDeliveryPhase = "waiting" | "sending" | "rejected" | "delivered";

export type MessageDeliveryAction = "edit" | "delete" | "dont-send" | "retry";

/**
 * What a person may do to a message still on their device. A refused message
 * can be edited or deleted. A waiting one can be taken back only if no attempt
 * was ever made: after one, it may already be on the computer, and the same
 * key is replayed until it is settled. One whose answer was lost for good (an
 * older release's unsettled send) can only go again under that key.
 */
export function messageDeliveryActions(
  phase: MessageDeliveryPhase,
  attempted: boolean,
  unconfirmed = false,
): readonly MessageDeliveryAction[] {
  if (phase === "rejected") return unconfirmed ? ["retry"] : ["edit", "delete"];
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

/**
 * Where a task's messages still on this device stand. Sent behind a turn at
 * work, the Host will hold a message in its queue, so it is drawn after the
 * queue, where it will join it; sent to a task at rest, it starts the next turn
 * in the transcript. Each is placed when it first appears and stays put, so it
 * never jumps between the two. `placed` is the previous answer, returned as is
 * when nothing changed.
 */
export function placeLocalMessages(
  placed: ReadonlyMap<string, boolean>,
  entries: readonly TranscriptEntry[],
  behindWork: boolean,
): ReadonlyMap<string, boolean> {
  const keys = entries.flatMap((entry) =>
    entry.kind === "message" && entry.localDelivery ? [entry.clientSendKey ?? entry.id] : [],
  );
  if (keys.length === placed.size && keys.every((key) => placed.has(key))) return placed;
  return new Map(keys.map((key) => [key, placed.get(key) ?? behindWork]));
}

/** The transcript without the messages drawn after the queue, and those messages in order. */
export function splitLocalMessages(
  entries: readonly TranscriptEntry[],
  placed: ReadonlyMap<string, boolean>,
): {
  readonly transcript: readonly TranscriptEntry[];
  readonly afterQueue: readonly MessageEntry[];
} {
  const afterQueue = entries.filter(
    (entry): entry is MessageEntry =>
      entry.kind === "message" &&
      entry.localDelivery !== undefined &&
      placed.get(entry.clientSendKey ?? entry.id) === true,
  );
  return afterQueue.length === 0
    ? { transcript: entries, afterQueue }
    : {
        transcript: entries.filter((entry) => !afterQueue.includes(entry as MessageEntry)),
        afterQueue,
      };
}
