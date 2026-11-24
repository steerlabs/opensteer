import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { App, AppId, Tab, TabId, TabLayout } from "@opensteer/core";
import { AppsList, type AppsListState } from "../host/apps.js";
import type { HostClient, HostSnapshot } from "../host/client.js";
import {
  requestPageTab,
  threadAgentPlace,
  type BrowserTabDestination,
  type ThreadAgentPlace,
} from "../host/browser-agent-follow.js";
import { hostSnapshotStore } from "../host/host-snapshot-store.js";
import type { PlaceListSource } from "../host/places.js";
import type { TabStrip } from "../host/tab-strip.js";
import { useHostSelector } from "./use-host-snapshot.js";

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

/**
 * The page a Request is about, from the tab list alone (see `requestPageTab`): its own tab,
 * or its task's only page. Null for no Request, or when that is not one page.
 */
export function useRequestPageTab(
  hostClient: HostClient,
  request: Parameters<typeof requestPageTab>[1] | null,
): BrowserTabDestination | null {
  const tabs = hostClient.getSnapshot().tabs;
  const subscribe = useCallback(
    (listener: () => void) => tabs?.subscribe(listener) ?? (() => {}),
    [tabs],
  );
  const held = useMemo(() => ({ current: null as BrowserTabDestination | null }), [request, tabs]);
  const get = useCallback(() => {
    const next = request === null || !tabs ? null : requestPageTab({ tabs }, request);
    if (next?.tabId !== held.current?.tabId) held.current = next;
    return held.current;
  }, [held, request, tabs]);
  return useSyncExternalStore(subscribe, get, get);
}

const selectBrowserProfiles = (snapshot: HostSnapshot) => snapshot.browserProfiles;

/**
 * The tab list and the profiles its pages browse as: a new source only when the profiles change.
 * Each view reads the tabs it draws from it with `useTabRead`.
 */
export function useTabSource(hostClient: HostClient): PlaceListSource {
  const tabs = hostClient.getSnapshot().tabs;
  const browserProfiles = useHostSelector(hostClient, selectBrowserProfiles);
  return useMemo(() => ({ tabs, browserProfiles }), [tabs, browserProfiles]);
}

/**
 * What a view draws of the tab list, read again on each tab change and kept while `isEqual` finds
 * it the same: the view redraws when a tab it draws changes, whichever tabs those are, and never
 * for another.
 */
export function useTabRead<Value>(
  source: PlaceListSource,
  read: (source: PlaceListSource) => Value,
  isEqual: (previous: Value, next: Value) => boolean,
): Value {
  const held = useRef<{ readonly value: Value } | null>(null);
  const { tabs } = source;
  const subscribe = useCallback((listener: () => void) => tabs.subscribe(listener), [tabs]);
  const get = useCallback(() => {
    const next = read(source);
    if (held.current && isEqual(held.current.value, next)) return held.current.value;
    held.current = { value: next };
    return next;
  }, [isEqual, read, source]);
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
