import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { TabId, TabPlaceEnteredEventView } from "@opensteer/core";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { placeList, placeByKey, type PlaceItem } from "../host/places.js";
import { actingOccupants } from "../host/place-activity.js";
import { placeAgents, samePlaceAgents, type PlaceAgents } from "../host/place-agents.js";
import { runPlaceDestination, runPlaceSessionId } from "../host/run-place.js";
import { hostSnapshotStore } from "../host/host-snapshot-store.js";
import { useHostSelector } from "./use-host-snapshot.js";

const noPlaces: readonly PlaceItem[] = [];
/** Every listed tab as drawn, in layout order. */
export function usePlaceList(hostClient: HostClient, enabled = true) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled) return () => {};
      const tabs = hostClient.getSnapshot().tabs.subscribe(listener);
      const host = hostSnapshotStore(hostClient).subscribe(listener);
      return () => {
        tabs();
        host();
      };
    },
    [hostClient, enabled],
  );
  const get = useCallback(
    () => (enabled ? placeList(hostClient.getSnapshot()) : noPlaces),
    [hostClient, enabled],
  );
  return useSyncExternalStore(subscribe, get, get);
}
function subscribePlace(hostClient: HostClient, key: string | null, listener: () => void) {
  if (key === null) return () => {};
  const row = hostClient.getSnapshot().tabs.subscribeTab(key as TabId, listener);
  const host = hostSnapshotStore(hostClient).subscribe(listener);
  return () => {
    row();
    host();
  };
}
/** One tab as drawn; rerenders only for that tab or its profile. */
export function usePlace(hostClient: HostClient, key: string | null) {
  const subscribe = useCallback(
    (listener: () => void) => subscribePlace(hostClient, key, listener),
    [hostClient, key],
  );
  const get = useCallback(
    () => (key === null ? undefined : placeByKey(hostClient.getSnapshot(), key)),
    [hostClient, key],
  );
  return useSyncExternalStore(subscribe, get, get);
}
export function usePlaces(hostClient: HostClient, keys: readonly string[]): readonly PlaceItem[] {
  const held = useRef<readonly PlaceItem[]>(noPlaces);
  const subscribe = useCallback(
    (listener: () => void) => {
      const releases = keys.map((key) => subscribePlace(hostClient, key, listener));
      return () => {
        for (const release of releases) release();
      };
    },
    [hostClient, keys],
  );
  const get = useCallback(() => {
    const source = hostClient.getSnapshot();
    const next = keys.flatMap((key) => placeByKey(source, key) ?? []);
    if (next.length !== held.current.length || next.some((place, i) => place !== held.current[i]))
      held.current = next;
    return held.current;
  }, [hostClient, keys]);
  return useSyncExternalStore(subscribe, get, get);
}
export function usePlaceActivity(hostClient: HostClient, placeKey: string) {
  const subscribe = useCallback(
    (listener: () => void) => hostClient.subscribePlaceActivity(placeKey, listener),
    [hostClient, placeKey],
  );
  const get = useCallback(() => hostClient.placeActivity(placeKey), [hostClient, placeKey]);
  return useSyncExternalStore(subscribe, get, get);
}
const nobody: PlaceAgents = { agents: [], unnamedActing: false };
/**
 * The agents using one tab that the reader can open, each working while the
 * Host reports its Run acting in that very tab, working first. Redraws only
 * when who is there, or who works, changes.
 */
export function usePlaceAgents(hostClient: HostClient, placeKey: string | null): PlaceAgents {
  const place = usePlace(hostClient, placeKey);
  const activity = usePlaceActivity(hostClient, placeKey ?? "");
  const select = useCallback(
    (snapshot: HostSnapshot) =>
      place
        ? placeAgents(
            {
              destination: place.destination,
              occupants: actingOccupants(place.occupants, activity),
            },
            snapshot,
          )
        : nobody,
    [activity, place],
  );
  return useHostSelector(hostClient, select, samePlaceAgents);
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

/** The newest place.entered for a nonterminal Run, regardless of loaded history or viewing eligibility.
 * Null clients/Run ids subscribe to nothing. The event carries data.place, title/site, and sequence.
 */
export function useRunPlace(hostClient: HostClient | null, runId: string | null) {
  const subscribe = useCallback(
    (listener: () => void) =>
      hostClient === null || runId === null
        ? () => undefined
        : hostClient.subscribeRunPlace(runId, listener),
    [hostClient, runId],
  );
  const get = useCallback(
    () => (hostClient === null || runId === null ? null : hostClient.runPlace(runId)),
    [hostClient, runId],
  );
  return useSyncExternalStore(subscribe, get, get);
}

const selectSource = (snapshot: HostSnapshot) => snapshot;
/** Catalog changes retarget a picture without subscribing the card to streaming text. */
export function useRunPlaceBinding(hostClient: HostClient, entry: TabPlaceEnteredEventView | null) {
  const source = useHostSelector(hostClient, selectSource, (a, b) => a.machines === b.machines);
  const tabId = entry?.data.tabId ?? null;
  const tabs = hostClient.getSnapshot().tabs;
  const subscribe = useCallback(
    (listener: () => void) =>
      tabId === null ? () => {} : tabs.subscribeTab(tabId as TabId, listener),
    [tabs, tabId],
  );
  const read = useCallback(
    () => (tabId === null ? undefined : tabs.get(tabId as TabId)),
    [tabs, tabId],
  );
  const tab = useSyncExternalStore(subscribe, read, read);
  const destination = useMemo(
    () => (entry ? runPlaceDestination(entry, source) : null),
    // The tab row decides whether the destination is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entry, source, tab],
  );
  const sessionId = useMemo(
    () => (entry ? runPlaceSessionId(entry, source) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entry, source, tab],
  );
  const key = entry ? `${entry.runId}:${entry.data.tabId}` : null;
  const retained = useRef({ key, destination, sessionId });
  if (retained.current.key !== key) retained.current = { key, destination, sessionId };
  else
    retained.current = {
      key,
      destination: destination ?? retained.current.destination,
      sessionId: sessionId ?? retained.current.sessionId,
    };
  return {
    destination,
    binding: retained.current.destination,
    sessionId: retained.current.sessionId,
  };
}
