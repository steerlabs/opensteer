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

/**
 * A work task draws its local sends in the same list as the Host's queue.
 *
 * A message is drawn where the Host will put it, so delivery replaces it in
 * place. Once sent, that is where the outbox saw it going as it went; before,
 * where it would go now: the first into an idle task's run, the rest behind it.
 * `idle` is whether the task would start a run for a message now.
 */
export function splitLocalMessages(
  entries: readonly TranscriptEntry[],
  workTask: boolean,
  hostQueue = false,
  idle = false,
): {
  readonly transcript: readonly TranscriptEntry[];
  readonly afterQueue: readonly MessageEntry[];
} {
  if (!workTask) return { transcript: entries, afterQueue: noLocalMessages };
  const hasWaiting =
    hostQueue || entries.some((entry) => entry.kind === "message" && entry.queuePending);
  const queued = new Set<TranscriptEntry>();
  let first = true;
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    if (entry.queuePending) queued.add(entry);
    const local = entry.localDelivery;
    if (entry.queuePending || local === undefined) continue;
    const direct = local.attempted ? local.inTranscript === true : first && idle && !hasWaiting;
    first = false;
    if (!direct) queued.add(entry);
  }
  return queued.size === 0
    ? { transcript: entries, afterQueue: noLocalMessages }
    : {
        transcript: entries.filter((entry) => !queued.has(entry)),
        afterQueue: entries.filter((entry): entry is MessageEntry => queued.has(entry)),
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
  const rows = inputs.map((input) => {
    const alias = input.entry.clientSendKey ?? aliases.get(input.messageId);
    return {
      key: alias ?? input.messageId,
      input,
      entry:
        alias && !input.entry.clientSendKey
          ? { ...input.entry, clientSendKey: alias }
          : input.entry,
    };
  });
  const admitted = new Set(rows.map(({ key }) => key));
  const ids = new Set(inputs.map(({ messageId }) => messageId));
  const remaining = local.flatMap((entry) => {
    const key = entry.clientSendKey ?? entry.id;
    return admitted.has(key) || ids.has(entry.id) ? [] : [{ key, input: null, entry }];
  });
  const hostPending = (entry: MessageEntry) => entry.queuePending && !entry.localDelivery;
  return [
    ...rows.filter(({ input }) => input.kind !== "ask"),
    ...remaining.filter(({ entry }) => hostPending(entry)),
    ...rows.filter(({ input }) => input.kind === "ask"),
    ...remaining.filter(({ entry }) => !hostPending(entry)),
  ];
}
