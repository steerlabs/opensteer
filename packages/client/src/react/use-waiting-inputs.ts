import { useMemo } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { waitingInputs, type WaitingInput } from "../host/waiting-inputs.js";
import { useThreadInputQueue } from "./use-thread-input-queue.js";
import { useHostSelector } from "./use-host-snapshot.js";

const selectNeedsYou = (snapshot: HostSnapshot) => snapshot.needsYou;

/**
 * Everything waiting to reach the agent at the foot of one task
 * (`waitingInputs`), kept current from the snapshot. Null until the task's
 * queue is first read; activating the task reads it.
 */
export function useWaitingInputs(
  hostClient: HostClient,
  threadId: string | null | undefined,
  observed = true,
): readonly WaitingInput[] | null {
  const queue = useThreadInputQueue(hostClient, threadId, observed);
  const needsYou = useHostSelector(hostClient, selectNeedsYou);
  return useMemo(
    () =>
      queue &&
      waitingInputs(queue, { needsYou, ownsLease: (leaseId) => hostClient.ownsEditLease(leaseId) }),
    [hostClient, needsYou, queue],
  );
}
