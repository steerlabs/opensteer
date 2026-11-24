import { useCallback, useMemo } from "react";
import type { HostClient, HostSnapshot, ThreadSummary, TranscriptEntry } from "../host/client.js";
import {
  assignmentScope,
  sameFields,
  sameThreadScope,
  sameWorkScope,
  threadScope,
  transcriptWork,
  type ThreadScope,
  type WorkScope,
} from "../host/thread-scope.js";
import { useHostSelector } from "./use-host-snapshot.js";

const sameRow = (left: ThreadSummary | null, right: ThreadSummary | null) =>
  left === right || (left !== null && right !== null && sameFields(left, right));

/** One Thread's row: it redraws when that row changes, never for another one. */
export function useThreadRow(
  hostClient: HostClient,
  threadId: string | null,
): ThreadSummary | null {
  const select = useCallback(
    (snapshot: HostSnapshot) =>
      threadId === null ? null : (snapshot.threads.find(({ id }) => id === threadId) ?? null),
    [threadId],
  );
  return useHostSelector(hostClient, select, sameRow);
}

/**
 * A task's own work, as `threadScope` reads it: what it handed out, the assignment it works on,
 * the work its transcript names, the questions waiting on any of it, and its browsers.
 */
export function useThreadScope(
  hostClient: HostClient,
  threadId: string,
  entries: readonly TranscriptEntry[],
): ThreadScope {
  const found = useMemo(() => transcriptWork(entries), [entries]);
  const key = `${found.assignmentIds.join(" ")}\n${found.threadIds.join(" ")}`;
  // The ids, not the transcript: a new message does not make a new selection.
  const work = useMemo(() => found, [key]);
  const select = useCallback(
    (snapshot: HostSnapshot) => threadScope(snapshot, threadId, work),
    [threadId, work],
  );
  return useHostSelector(hostClient, select, sameThreadScope);
}

/** What cards about these assignments read; see `WorkScope`. */
export function useAssignmentScope(
  hostClient: HostClient,
  assignmentIds: readonly string[],
): WorkScope {
  const key = assignmentIds.join(" ");
  const select = useCallback(
    (snapshot: HostSnapshot) => assignmentScope(snapshot, key ? key.split(" ") : []),
    [key],
  );
  return useHostSelector(hostClient, select, sameWorkScope);
}
