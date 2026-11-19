import { useMemo } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { SubagentCache } from "../host/subagent-model.js";
import { runningNow, sameRunningNow, type RunningNow } from "../host/subagent-now.js";
import { useHostSelector } from "./use-host-snapshot.js";
import { useThreadTranscript } from "./use-thread-transcript.js";

/**
 * What runs in one conversation now. Its subagents and commands are cards in
 * the thread's own transcript, never in the Host snapshot, so this reads both.
 * Out of reach of the conversation's computer, everything is last known.
 */
export function useRunningNow(
  hostClient: HostClient,
  threadId: string,
  reachable: boolean,
): RunningNow | null {
  const { entries, requests } = useThreadTranscript(hostClient, threadId);
  const select = useMemo(() => {
    const cache = new SubagentCache();
    let held: { readonly inputs: readonly unknown[]; readonly value: RunningNow | null } | null =
      null;
    return (snapshot: HostSnapshot) => {
      // Only these snapshot fields move a card; anything else costs a comparison.
      const inputs = [
        snapshot.assignments,
        snapshot.connection,
        snapshot.environments,
        snapshot.network,
        snapshot.threads,
        snapshot.waitingRequests,
      ];
      if (held && inputs.every((input, index) => input === held?.inputs[index])) return held.value;
      const value = runningNow(
        {
          ...snapshot,
          connection: reachable ? snapshot.connection : "offline",
          transcripts: { [threadId]: entries },
          requests: { [threadId]: requests },
        },
        threadId,
        cache,
      );
      held = { inputs, value };
      return value;
    };
  }, [entries, reachable, requests, threadId]);
  return useHostSelector(hostClient, select, sameRunningNow);
}
