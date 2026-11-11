import { useCallback, useSyncExternalStore } from "react";
import type { HostClient } from "../host/client.js";

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
