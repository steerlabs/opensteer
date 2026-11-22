import { useMemo } from "react";
import type { HostClient } from "../host/client.js";
import { waitingInputs, type WaitingInput } from "../host/waiting-inputs.js";
import { useThreadInputQueue } from "./use-thread-input-queue.js";

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
  return useMemo(() => queue && waitingInputs(queue), [queue]);
}
