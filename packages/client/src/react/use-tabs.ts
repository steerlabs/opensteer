import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { App, AppId, Tab, TabId, TabLayout } from "@opensteer/core";
import { AppsList, type AppsListState } from "../host/apps.js";
import type { HostClient } from "../host/client.js";
import { threadAgentPlace, type ThreadAgentPlace } from "../host/browser-agent-follow.js";
import { hostSnapshotStore } from "../host/host-snapshot-store.js";
import type { TabStrip } from "../host/tab-strip.js";

/** The one layout order every surface draws; changes only with structure, never a title. */
export function useTabStrip(hostClient: HostClient): TabStrip {
  const tabs = hostClient.getSnapshot().tabs;
  const subscribe = useCallback(
    (listener: () => void) => tabs.subscribeStructure(listener),
    [tabs],
  );
  const get = useCallback(() => tabs.strip, [tabs]);
  return useSyncExternalStore(subscribe, get, get);
}

export function useTabLayout(hostClient: HostClient): TabLayout {
  const tabs = hostClient.getSnapshot().tabs;
  const subscribe = useCallback(
    (listener: () => void) => tabs.subscribeStructure(listener),
    [tabs],
  );
  const get = useCallback(() => tabs.layout, [tabs]);
  return useSyncExternalStore(subscribe, get, get);
}

/** One tab's row; rerenders only when that row changes. */
export function useTab(hostClient: HostClient, tabId: string | null): Tab | undefined {
  const tabs = hostClient.getSnapshot().tabs;
  const subscribe = useCallback(
    (listener: () => void) =>
      tabId === null ? () => {} : tabs.subscribeTab(tabId as TabId, listener),
    [tabs, tabId],
  );
  const get = useCallback(
    () => (tabId === null ? undefined : tabs.get(tabId as TabId)),
    [tabs, tabId],
  );
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * The page, Mac app or phone screen a task's agent is working in now; the same object
 * returns while that place and its name stay the same.
 */
export function useThreadAgentPlace(
  hostClient: HostClient,
  threadId: string | null,
): ThreadAgentPlace | null {
  const tabs = hostClient.getSnapshot().tabs;
  const subscribe = useCallback((listener: () => void) => tabs.subscribe(listener), [tabs]);
  const held = useMemo(() => ({ current: null as ThreadAgentPlace | null }), [threadId, tabs]);
  const get = useCallback(() => {
    const next = threadId === null ? null : threadAgentPlace({ tabs }, threadId);
    const last = held.current;
    if (
      next === null ||
      last === null ||
      next.tabId !== last.tabId ||
      next.kind !== last.kind ||
      next.title !== last.title
    )
      held.current = next;
    return held.current;
  }, [held, tabs, threadId]);
  return useSyncExternalStore(subscribe, get, get);
}

/** Whether the catalog still lacks rows the stream will bring. */
export function useTabsSyncing(hostClient: HostClient): boolean {
  const tabs = hostClient.getSnapshot().tabs;
  const subscribe = useCallback((listener: () => void) => tabs.subscribe(listener), [tabs]);
  const get = useCallback(() => tabs.syncing, [tabs]);
  return useSyncExternalStore(subscribe, get, get);
}

const appsLists = new WeakMap<HostClient, AppsList>();
/** The person's apps, shared by every view of this client; read only while one is shown. */
export function appsList(hostClient: HostClient): AppsList {
  let list = appsLists.get(hostClient);
  if (!list) {
    const store = hostSnapshotStore(hostClient);
    list = new AppsList({
      client: hostClient,
      revision: () => hostClient.getSnapshot().appsRevision,
      subscribe: (listener) => store.subscribe(listener),
    });
    appsLists.set(hostClient, list);
  }
  return list;
}
/** `enabled` false keeps what was read without reading again, as for a screen out of view. */
export function useAppsList(
  hostClient: HostClient,
  enabled = true,
): {
  readonly list: AppsList;
  readonly state: AppsListState;
} {
  const list = useMemo(() => appsList(hostClient), [hostClient]);
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? list.subscribe(listener) : () => {}),
    [enabled, list],
  );
  const get = useCallback(() => list.state, [list]);
  return { list, state: useSyncExternalStore(subscribe, get, get) };
}

/** Changes with any tab change; for views deriving from many rows at once. */
export function useTabsRevision(hostClient: HostClient): number {
  const tabs = hostClient.getSnapshot().tabs;
  const subscribe = useCallback((listener: () => void) => tabs.subscribe(listener), [tabs]);
  const get = useCallback(() => tabs.revision, [tabs]);
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * One app's record, read when shown and again on each apps change. Null until
 * the first read lands or if it fails; a failed reread keeps the last answer.
 */
export function useApp(hostClient: HostClient, appId: AppId | null): App | null {
  const store = hostSnapshotStore(hostClient);
  const revision = useSyncExternalStore(
    store.subscribe,
    () => hostClient.getSnapshot().appsRevision,
    () => hostClient.getSnapshot().appsRevision,
  );
  const [read, setRead] = useState<{ readonly appId: AppId; readonly app: App | null } | null>(
    null,
  );
  useEffect(() => {
    if (appId === null) return;
    let current = true;
    hostClient.getApp(appId).then(
      (app) => current && setRead({ appId, app }),
      () => current && setRead((held) => (held?.appId === appId ? held : { appId, app: null })),
    );
    return () => {
      current = false;
    };
  }, [appId, hostClient, revision]);
  return read?.appId === appId ? read.app : null;
}
