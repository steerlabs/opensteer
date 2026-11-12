import { useEffect } from "react";
import type { HostClient } from "../host/client.js";
import { trackThreadVisits } from "../host/thread-visits.js";

export function useThreadVisits(client: HostClient, threadId: string, presented = true): void {
  useEffect(
    () => (presented ? trackThreadVisits(client, threadId) : undefined),
    [client, threadId, presented],
  );
}
