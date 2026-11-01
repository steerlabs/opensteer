import type { AssignmentSummary, ThreadInputQueue, WaitingRequest } from "@opensteer/core";
import type { ThreadSummary, TranscriptEntry } from "./client.js";
import { conversationRows, groupTranscriptEntries } from "./agent-activity-model.js";
import { withoutOwnAssignment } from "./assignment-presentation.js";
import { visibleTranscript } from "./transcript.js";

/** The stable keys of the rows both transcript surfaces draw. */
export function drawnTranscriptRowKeys(
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
): readonly string[] {
  const conversation = thread.role === "conversation";
  const groups = groupTranscriptEntries(
    withoutOwnAssignment(visibleTranscript(entries, inputQueue, { conversation }), thread.id),
    { assignments, inputQueuePaused: thread.inputQueuePaused },
  );
  // Earlier history is settled; composing, at-computer and picture-only rows
  // cannot reveal older content, so both surfaces' live-only options are off.
  return conversation
    ? conversationRows(groups, { atComputer: () => false, live: false, waitingRequests }).map(
        (row) => row.key,
      )
    : groups.map((group) => group.key);
}
