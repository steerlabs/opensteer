import type { Request } from "@opensteer/core";
import { useCallback } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { requestAsker, type RequestAsker } from "../host/subagent-now.js";
import { useHostSelector } from "./use-host-snapshot.js";
import { useThreadTranscript } from "./use-thread-transcript.js";

/**
 * The subagent that asked a Request, or null when the Run's own agent did. The asker and the
 * subagent it runs inside are cards in the asking thread's transcript, never in the snapshot.
 */
export function useRequestAsker(hostClient: HostClient, request: Request): RequestAsker | null {
  const { entries } = useThreadTranscript(hostClient, request.originatingThreadId, false);
  return useHostSelector(
    hostClient,
    useCallback(
      (snapshot: HostSnapshot) =>
        requestAsker(
          { ...snapshot, transcripts: { [request.originatingThreadId]: entries } },
          request,
        ),
      [entries, request],
    ),
    sameAsker,
  );
}

function sameAsker(left: RequestAsker | null, right: RequestAsker | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.nodeId === right.nodeId &&
      left.title === right.title &&
      left.byline === right.byline)
  );
}
