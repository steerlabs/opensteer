import type { AssignmentSummary, ThreadInputQueue, WaitingRequest } from "@opensteer/core";
import type { ThreadSummary, TranscriptEntry } from "./client.js";
import { conversationRows, groupTranscriptEntries } from "./agent-activity-model.js";
import { withoutOwnAssignment } from "./assignment-presentation.js";
import { visibleTranscript } from "./transcript.js";

/** The first thing the reader can see, rather than the first transport entry. */
export function earliestShownTranscriptEntry(
  entries: readonly TranscriptEntry[],
  {
    thread,
    inputQueue = null,
    assignments = {},
    waitingRequests = [],
  }: {
    readonly thread: Pick<ThreadSummary, "id" | "role" | "inputQueuePaused">;
    readonly inputQueue?: ThreadInputQueue | null;
    readonly assignments?: Readonly<Record<string, AssignmentSummary>>;
    readonly waitingRequests?: readonly WaitingRequest[];
  },
): string | null {
  const conversation = thread.role === "conversation";
  const groups = groupTranscriptEntries(
    withoutOwnAssignment(visibleTranscript(entries, inputQueue, { conversation }), thread.id),
    { assignments, inputQueuePaused: thread.inputQueuePaused },
  );
  // Earlier history is settled; composing, at-computer and picture-only rows
  // cannot reveal older content, so both surfaces' live-only options are off.
  const first = conversation
    ? conversationRows(groups, { atComputer: () => false, live: false, waitingRequests })[0]?.group
    : groups[0];
  if (!first) return null;
  if (first.kind !== "turn") return first.entry.id;
  return (
    (conversation ? first.turn.reply?.id : first.turn.work[0]?.id) ??
    first.turn.assignments[0]?.id ??
    first.key
  );
}
