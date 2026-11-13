import { useEffect } from "react";
import type { HostClient } from "../host/client.js";
import { trackThreadVisits } from "../host/thread-visits.js";

/** `presented`: the task is on screen in front of the person (focused screen, foreground app). */
export function useThreadVisits(client: HostClient, threadId: string, presented = true): void {
  useEffect(
    () => (presented ? trackThreadVisits(client, threadId) : undefined),
    [client, threadId, presented],
  );
}
