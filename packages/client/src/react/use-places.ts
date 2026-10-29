import { browserTabStrip } from "../host/browser-tab-strip.js";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import {
  placeList,
  runPlace,
  samePlaceListSource,
  type PlaceItem,
  type ThreadPlace,
} from "../host/places.js";
import { useHostSelector } from "./use-host-snapshot.js";
const selectSource = (snapshot: HostSnapshot) => snapshot;
/**
 * The place list, keeping each unchanged item's object from the last one: one
 * tab's catalog change re-renders that tab's row, not every row beside it.
 */
export function usePlaceList(hostClient: HostClient) {
  const source = useHostSelector(hostClient, selectSource, samePlaceListSource);
  const previous = useRef<{
    readonly items: readonly PlaceItem[];
    readonly byKey: ReadonlyMap<string, { readonly item: PlaceItem; readonly json: string }>;
  }>({ items: [], byKey: new Map() });
  return useMemo(() => {
    const byKey = new Map<string, { readonly item: PlaceItem; readonly json: string }>();
    let changed = false;
    const items = placeList(source).map((item, index) => {
      const json = JSON.stringify(item);
      const held = previous.current.byKey.get(item.key);
      const kept = held?.json === json ? held.item : item;
      byKey.set(item.key, { item: kept, json });
      if (kept !== previous.current.items[index]) changed = true;
      return kept;
    });
    const list =
      changed || items.length !== previous.current.items.length ? items : previous.current.items;
    previous.current = { items: list, byKey };
    return list;
  }, [source]);
}
export function usePlaceActivity(hostClient: HostClient, placeKey: string) {
  const subscribe = useCallback(
    (listener: () => void) => hostClient.subscribePlaceActivity(placeKey, listener),
    [hostClient, placeKey],
  );
  const get = useCallback(() => hostClient.placeActivity(placeKey), [hostClient, placeKey]);
  return useSyncExternalStore(subscribe, get, get);
}
/** Retain only while visible; painting a frame returns its exact target's credit. */
export function useBrowserWatch(
  hostClient: HostClient,
  sessionId: string,
  surfaceId: string,
  enabled = true,
) {
  const subscribe = useCallback(
    (listener: () => void) => hostClient.subscribeBrowserWatch(sessionId, surfaceId, listener),
    [hostClient, sessionId, surfaceId],
  );
  const get = useCallback(
    () => hostClient.browserWatchState(sessionId, surfaceId),
    [hostClient, sessionId, surfaceId],
  );
  const state = useSyncExternalStore(subscribe, get, get);
  useEffect(
    () => (enabled ? hostClient.retainBrowserWatch(sessionId, surfaceId) : undefined),
    [hostClient, sessionId, surfaceId, enabled],
  );
  const frameDisplayed = useCallback(
    (token: string) => hostClient.acceptBrowserWatchFrame(sessionId, token, surfaceId),
    [hostClient, sessionId, surfaceId],
  );
  return { ...state, frameDisplayed };
}

/** A Thread's newest place as the Host named it; null without a client or a Thread. */
export function useThreadPlace(
  hostClient: HostClient | null,
  threadId: string | null,
): ThreadPlace | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      hostClient === null || threadId === null
        ? () => undefined
        : hostClient.subscribeLatestPlace(threadId, listener),
    [hostClient, threadId],
  );
  const get = useCallback(
    () =>
      hostClient === null || threadId === null ? null : hostClient.latestPlaceOfThread(threadId),
    [hostClient, threadId],
  );
  return useSyncExternalStore(subscribe, get, get);
}

/** The place a Run acted in last, while its picture is live ([`runPlace`](../host/places.ts)). */
export function useRunPlace(
  hostClient: HostClient | null,
  threadId: string | null,
  runId: string | null,
): ThreadPlace | null {
  return runPlace(useThreadPlace(hostClient, threadId), runId);
}

const selectTabGroups = (snapshot: HostSnapshot) => snapshot.browserTabGroups;
export function useBrowserTabStrip(hostClient: HostClient) {
  const places = usePlaceList(hostClient);
  const layout = useHostSelector(hostClient, selectTabGroups);
  return browserTabStrip(places, layout);
}
