import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { computerSetupRequests } from "../integrations/computer-setup-requests.js";

export function useThreadServerApprovals(hostClient: HostClient, threadId: string) {
  const list = computerSetupRequests(hostClient);
  const requests = useSyncExternalStore(list.subscribe, list.getSnapshot, list.getSnapshot);
  // A failed read is retried on the next render, without a failure-driven render loop.
  useEffect(() => {
    const snapshot = hostClient.getSnapshot();
    if (snapshot.user && snapshot.connection === "connected")
      void list.read().catch(() => undefined);
  });
  const reload = useCallback(async () => {
    await list.read();
  }, [list]);
  const waiting = useMemo(
    () =>
      requests?.filter((request) => request.kind === "server" && request.threadId === threadId) ??
      [],
    [requests, threadId],
  );
  return { requests: waiting, reload };
}
