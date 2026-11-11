import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";
import { hostSnapshotStore } from "../host/host-snapshot-store.js";

export function useBrowserGroups(client: HostClient) {
  return useSyncExternalStore(
    client.browserTabs.subscribeGroups,
    client.browserTabs.groups,
    client.browserTabs.groups,
  );
}

export function useBrowserGroup(client: HostClient, groupId: string) {
  const subscribe = useCallback(
    (listener: () => void) => client.browserTabs.subscribeGroup(groupId, listener),
    [client, groupId],
  );
  const get = useCallback(() => client.browserTabs.group(groupId), [client, groupId]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useBrowserSessionGroupId(client: HostClient, sessionId: string | undefined) {
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId === undefined
        ? () => {}
        : client.browserTabs.subscribeSessionGroup(sessionId, listener),
    [client, sessionId],
  );
  const get = useCallback(
    () => (sessionId === undefined ? undefined : client.browserTabs.groupForSession(sessionId)),
    [client, sessionId],
  );
  return useSyncExternalStore(subscribe, get, get);
}

export function useBrowserTabs(client: HostClient, groupId: string) {
  const subscribe = useCallback(
    (listener: () => void) => client.browserTabs.subscribeTabs(groupId, listener),
    [client, groupId],
  );
  const get = useCallback(() => client.browserTabs.tabs(groupId), [client, groupId]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useBrowserTab(
  client: HostClient,
  groupId: string | undefined,
  tabId: string | undefined,
) {
  const subscribe = useCallback(
    (listener: () => void) =>
      groupId === undefined || tabId === undefined
        ? () => {}
        : client.browserTabs.subscribeTab(groupId, tabId, listener),
    [client, groupId, tabId],
  );
  const get = useCallback(
    () =>
      groupId === undefined || tabId === undefined
        ? undefined
        : client.browserTabs.tab(groupId, tabId),
    [client, groupId, tabId],
  );
  return useSyncExternalStore(subscribe, get, get);
}

export function useBrowserTabStructure(client: HostClient) {
  return useSyncExternalStore(
    client.browserTabs.subscribeStructure,
    client.browserTabs.structure,
    client.browserTabs.structure,
  );
}

/**
 * The exact page a viewer of this tab holds (its address and icon), for the
 * page's own chrome; undefined until one is admitted. Rows read `useBrowserTab`.
 */
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
 * Whether this tab's page is awake. A Watch holds a sleeping tab's last
 * picture and never retains it, which would wake it; a tab the client does
 * not hold counts as awake.
 */
export function useBrowserTabAwake(
  client: Pick<HostClient, "browserTabs">,
  sessionId: string | undefined,
  tabId: string | undefined,
): boolean {
  const store = client.browserTabs;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (sessionId === undefined || tabId === undefined) return () => {};
      let release = () => {};
      const follow = () => {
        release();
        const groupId = store.groupForSession(sessionId);
        release = groupId ? store.subscribeTab(groupId, tabId, listener) : () => {};
        listener();
      };
      const stop = store.subscribeSessionGroup(sessionId, follow);
      follow();
      return () => {
        stop();
        release();
      };
    },
    [sessionId, store, tabId],
  );
  const get = useCallback(() => {
    const row =
      sessionId === undefined || tabId === undefined
        ? undefined
        : store.sessionTab(sessionId, tabId);
    return row === undefined || row.state === "live";
  }, [sessionId, store, tabId]);
  return useSyncExternalStore(subscribe, get, get);
}

/** Task membership follows occupants independently of a tab's title or loading. */
export function useBrowserTabOccupancy(client: HostClient, groupId: string) {
  const get = useCallback(() => client.browserTabs.occupancyRevision(groupId), [client, groupId]);
  return useSyncExternalStore(client.browserTabs.subscribe, get, get);
}
