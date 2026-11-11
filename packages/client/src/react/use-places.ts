import { placeIdentityKey, type PlaceEnteredEventView } from "@opensteer/core";
import { runPlaceDestination, runPlaceSessionId } from "../host/run-place.js";
import { browserTabStrip } from "../host/browser-tab-strip.js";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { hostSnapshotStore } from "../host/host-snapshot-store.js";
import type { PlaceItem, PlaceSlot } from "../host/places.js";
import { readPlaceIndex } from "./place-index.js";
import { useHostSelector } from "./use-host-snapshot.js";
const selectSource = (snapshot: HostSnapshot) => snapshot;
/**
 * The place list, keeping each unchanged item's object from the last one.
 * A reader of the whole list re-renders when any place changes; a list that
 * only arranges rows reads `usePlaceSlots`, and each row its own `usePlace`.
 * Not `enabled`, it reads and subscribes to nothing.
 */
export function usePlaceList(hostClient: HostClient, enabled = true): readonly PlaceItem[] {
  const subscribe = enabled ? hostSnapshotStore(hostClient).subscribe : subscribeNothing;
  const get = useCallback(
    () => (enabled ? readPlaceIndex(hostClient).items : noPlaces),
    [enabled, hostClient],
  );
  return useSyncExternalStore(subscribe, get, get);
}
const noPlaces: readonly PlaceItem[] = [];
const subscribeNothing = () => () => {};
/** The places as a list arranges them: changes only when one comes, goes, moves or changes device. */
export function usePlaceSlots(hostClient: HostClient): readonly PlaceSlot[] {
  const get = useCallback(() => readPlaceIndex(hostClient).slots, [hostClient]);
  return useSyncExternalStore(hostSnapshotStore(hostClient).subscribe, get, get);
}
/** One place, live: its reader re-renders when this place changes, never for another. */
export function usePlace(hostClient: HostClient, key: string | null): PlaceItem | null {
  const get = useCallback(
    () => (key === null ? null : (readPlaceIndex(hostClient).byKey.get(key) ?? null)),
    [hostClient, key],
  );
  return useSyncExternalStore(hostSnapshotStore(hostClient).subscribe, get, get);
}
/** These places, live, in this order; the array is kept while none of them changes. */
export function usePlaces(hostClient: HostClient, keys: readonly string[]): readonly PlaceItem[] {
  const held = useRef<readonly PlaceItem[]>([]);
  const get = useCallback(() => {
    const { byKey } = readPlaceIndex(hostClient);
    const next = keys.flatMap((key) => byKey.get(key) ?? []);
    const previous = held.current;
    if (next.length !== previous.length || next.some((place, i) => place !== previous[i]))
      held.current = next;
    return held.current;
  }, [hostClient, keys]);
  return useSyncExternalStore(hostSnapshotStore(hostClient).subscribe, get, get);
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

const selectTabGroups = (snapshot: HostSnapshot) => snapshot.browserTabGroups;
export function useBrowserTabStrip(hostClient: HostClient) {
  const places = usePlaceList(hostClient);
  const layout = useHostSelector(hostClient, selectTabGroups);
  return browserTabStrip(places, layout);
}

/** Catalog changes retarget a picture without subscribing the card to streaming text. */
export function useRunPlaceBinding(hostClient: HostClient, entry: PlaceEnteredEventView | null) {
  const source = useHostSelector(
    hostClient,
    selectSource,
    (a, b) =>
      a.machines === b.machines &&
      a.browserSessions === b.browserSessions &&
      a.workspaceTabs === b.workspaceTabs,
  );
  const destination = useMemo(
    () => (entry ? runPlaceDestination(entry, source) : null),
    [entry, source],
  );
  const sessionId = useMemo(
    () => (entry ? runPlaceSessionId(entry, source) : null),
    [entry, source],
  );
  const key = entry ? `${entry.runId}:${placeIdentityKey(entry.data.place)}` : null;
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
