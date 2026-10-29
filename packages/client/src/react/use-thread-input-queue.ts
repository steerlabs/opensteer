import { useCallback } from "react";
import type { ThreadInputQueue } from "@opensteer/core";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { useHostSelector } from "./use-host-snapshot.js";

/**
 * The Host's durable input queue for one Thread, as the snapshot holds it.
 * Activating the Thread loads it and every relevant event reloads it, so a
 * surface only reads. Null until the first read lands.
 */
export function useThreadInputQueue(
  hostClient: HostClient,
  threadId: string | null | undefined,
): ThreadInputQueue | null {
  const select = useCallback(
    (snapshot: HostSnapshot) => (threadId ? (snapshot.inputQueues[threadId] ?? null) : null),
    [threadId],
  );
  return useHostSelector(hostClient, select);
}
