import {
  taskActivityKey,
  threadInDirectory,
  type HostClient,
  type HostSnapshot,
  type SessionTaskView,
} from "@opensteer/client/host";
import { useSessionStop, useTaskActivity } from "@opensteer/client/react";
import { useCallback, useMemo } from "react";
import { actionLine } from "../ui/client-feedback.js";
import { useHostValue } from "../ui/mobile-client-context.js";
import { sessionRowOf, sessionTaskOf } from "./agent-session-model.js";

/*
 * What a connected agent's own task reads and does, apart from the pane that draws it, so a
 * task row or a tab's status row never loads the pane's question cards.
 */

/** The task row, from the directory. */
export function useSessionThread(hostClient: HostClient | null, threadId: string) {
  const select = useCallback(
    (snapshot: HostSnapshot) => threadInDirectory(threadId, snapshot),
    [threadId],
  );
  return useHostValue(hostClient, select, null);
}

/** A task's session view while a connected agent works it itself; null for any other task. */
export function useSessionTask(
  hostClient: HostClient | null,
  threadId: string,
): SessionTaskView | null {
  const thread = useSessionThread(hostClient, threadId);
  const operations = useTaskActivity(hostClient, threadId, taskActivityKey(thread));
  return useMemo(
    () => (thread === null ? null : sessionTaskOf({ threads: [thread] }, threadId, operations)),
    [operations, thread, threadId],
  );
}

/** A session task's row in Tasks: the agent's mark and what it is using; null for any other. */
export function useSessionRow(
  hostClient: HostClient | null,
  threadId: string,
): ReturnType<typeof sessionRowOf> {
  const thread = useSessionThread(hostClient, threadId);
  return useMemo(
    () => (thread === null ? null : sessionRowOf({ threads: [thread] }, threadId)),
    [thread, threadId],
  );
}

/** Native feedback for the same session Stop the web renders. */
export function useAgentSessionStop(
  hostClient: HostClient,
  threadId: string,
  sessionId: string | null,
) {
  const stop = useSessionStop(hostClient, threadId, sessionId);
  return {
    ...stop,
    line: actionLine(stop, { check: () => void stop.reconcile() }, stop.key),
  };
}
