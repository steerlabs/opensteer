import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type {
  BrowserSessionUseSummary,
  HostClient,
  HostSnapshot,
  ThreadSummary,
  TranscriptEntry,
} from "../host/client.js";
import { transcriptTabReads } from "../host/surfaces.js";
import {
  assignmentScope,
  sameFields,
  sameItems,
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

export type TranscriptTabs = Pick<HostSnapshot, "tabs" | "browserProfiles">;

const selectTabs = (snapshot: HostSnapshot) => snapshot.tabs;
const selectBrowserProfiles = (snapshot: HostSnapshot) => snapshot.browserProfiles;

/**
 * The tab list as a transcript's chips read it: a new source only when a tab they read changed
 * (`transcriptTabReads`), so another task's browsing never redraws this transcript.
 */
export function useTranscriptTabs(
  hostClient: HostClient,
  entries: readonly TranscriptEntry[],
  uses: readonly BrowserSessionUseSummary[],
): TranscriptTabs {
  const tabs = useHostSelector(hostClient, selectTabs);
  const browserProfiles = useHostSelector(hostClient, selectBrowserProfiles);
  const held = useRef<{ readonly reads: readonly unknown[]; readonly source: TranscriptTabs }>(
    null,
  );
  const read = useCallback(() => {
    const source = { tabs, browserProfiles };
    const reads = transcriptTabReads(entries, uses, source);
    if (held.current && sameItems(held.current.reads, reads)) return held.current.source;
    held.current = { reads, source };
    return source;
  }, [browserProfiles, entries, tabs, uses]);
  const subscribe = useCallback((listener: () => void) => tabs.subscribe(listener), [tabs]);
  return useSyncExternalStore(subscribe, read, read);
}
