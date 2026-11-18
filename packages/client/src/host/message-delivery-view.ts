import type { MessageEntry, TranscriptEntry } from "./client.js";
import type { WaitingInput } from "./waiting-inputs.js";

/** Where a message a device holds is on its way to the computer, as its transcript draws it. */
export type MessageDeliveryPhase = "waiting" | "sending" | "rejected" | "restoring" | "delivered";

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
  if (phase === "restoring") return ["edit"];
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

const noLocalMessages: readonly MessageEntry[] = [];

/** A work task draws its local sends in the same list as the Host's queue. */
export function splitLocalMessages(
  entries: readonly TranscriptEntry[],
  workTask: boolean,
): {
  readonly transcript: readonly TranscriptEntry[];
  readonly afterQueue: readonly MessageEntry[];
} {
  if (!workTask) return { transcript: entries, afterQueue: noLocalMessages };
  const afterQueue = entries.filter(
    (entry): entry is MessageEntry => entry.kind === "message" && entry.localDelivery !== undefined,
  );
  return afterQueue.length === 0
    ? { transcript: entries, afterQueue: noLocalMessages }
    : {
        transcript: entries.filter((entry) => entry.kind !== "message" || !entry.localDelivery),
        afterQueue,
      };
}

export function waitingMessageRows(
  inputs: readonly WaitingInput[],
  local: readonly MessageEntry[],
  transcript: readonly TranscriptEntry[] = [],
): readonly {
  readonly key: string;
  readonly input: WaitingInput | null;
  readonly entry: MessageEntry;
}[] {
  const aliases = new Map(
    transcript.flatMap((entry) =>
      entry.kind === "message" && entry.clientSendKey ? [[entry.id, entry.clientSendKey]] : [],
    ),
  );
  const rows = inputs.map((input) => ({
    key: input.entry.clientSendKey ?? aliases.get(input.messageId) ?? input.messageId,
    input,
    entry: input.entry,
  }));
  const admitted = new Set(rows.map(({ key }) => key));
  return [
    ...rows.filter(({ input }) => input.kind !== "ask"),
    ...local.flatMap((entry) => {
      const key = entry.clientSendKey ?? entry.id;
      return admitted.has(key) ? [] : [{ key, input: null, entry }];
    }),
    ...rows.filter(({ input }) => input.kind === "ask"),
  ];
}
