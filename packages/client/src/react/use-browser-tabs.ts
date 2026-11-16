import { useCallback, useSyncExternalStore } from "react";
import type { TabId } from "@opensteer/core";
import type { HostClient } from "../host/client.js";
import { hostSnapshotStore } from "../host/host-snapshot-store.js";

export function useBrowserViewerSurface(
  client: HostClient,
  sessionId: string | undefined,
  surfaceId: string | undefined,
) {
  const get = useCallback(
    () =>
      sessionId === undefined || surfaceId === undefined
        ? undefined
        : client.browserViewerSurface(sessionId, surfaceId),
    [client, sessionId, surfaceId],
  );
  return useSyncExternalStore(hostSnapshotStore(client).subscribe, get, get);
}

/**
 * Whether this tab is awake. A Watch holds a sleeping tab's last picture and
 * never retains it, which would wake it; a tab the client does not list
 * counts as awake.
 */
export function useBrowserTabAwake(
  client: Pick<HostClient, "getSnapshot">,
  tabId: string | undefined,
): boolean {
  const tabs = client.getSnapshot().tabs;
  const subscribe = useCallback(
    (listener: () => void) =>
      tabId === undefined ? () => {} : tabs.subscribeTab(tabId as TabId, listener),
    [tabs, tabId],
  );
  const get = useCallback(
    () => tabId === undefined || tabs.get(tabId as TabId)?.state !== "asleep",
    [tabs, tabId],
  );
  return useSyncExternalStore(subscribe, get, get);
}
