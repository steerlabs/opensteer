import { placeIdentityKey, type PlaceEnteredEventView } from "@opensteer/core";
import { runPlaceDestination, runPlaceSessionId } from "../host/run-place.js";
import { browserTabStrip } from "../host/browser-tab-strip.js";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { placeList, placeStructure, placeByKey, samePlaceListSource } from "../host/places.js";
import { hostSnapshotStore } from "../host/host-snapshot-store.js";
import { useHostSelector } from "./use-host-snapshot.js";
const selectSource = (snapshot: HostSnapshot) => snapshot;
function usePlaceSelection<T>(
  hostClient: HostClient,
  select: (source: HostSnapshot) => T,
  structural = false,
) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const host = hostSnapshotStore(hostClient).subscribe(listener);
      const tabs = structural
        ? hostClient.browserTabs.subscribeStructure(listener)
        : hostClient.browserTabs.subscribe(listener);
      return () => {
        host();
        tabs();
      };
    },
    [hostClient, structural],
  );
  const get = useCallback(() => select(hostClient.getSnapshot()), [hostClient, select]);
  return useSyncExternalStore(subscribe, get, get);
}
export function usePlaceList(hostClient: HostClient) {
  return usePlaceSelection(hostClient, placeList);
}
export function usePlaceStructure(hostClient: HostClient) {
  return usePlaceSelection(hostClient, placeStructure, true);
}
export function usePlace(hostClient: HostClient, key: string) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const store = hostClient.browserTabs;
      let source = hostClient.getSnapshot();
      const host = hostSnapshotStore(hostClient).subscribe(() => {
        const next = hostClient.getSnapshot();
        if (!samePlaceListSource(source, next) || source.browserSessions !== next.browserSessions) {
          source = next;
          listener();
        }
      });
      const separator = key.startsWith("browser:") ? key.indexOf(":", "browser:".length) : -1;
      const sessionId = separator < 0 ? undefined : key.slice("browser:".length, separator);
      const tabId = separator < 0 ? undefined : key.slice(separator + 1);
      let releaseRow = () => {};
      const bind = () => {
        releaseRow();
        const groupId = sessionId === undefined ? undefined : store.groupForSession(sessionId);
        if (groupId !== undefined && tabId !== undefined) {
          const row = store.subscribeTab(groupId, tabId, listener);
          const group = store.subscribeGroup(groupId, listener);
          releaseRow = () => {
            row();
            group();
          };
        }
        listener();
      };
      const session =
        sessionId === undefined ? () => {} : store.subscribeSessionGroup(sessionId, bind);
      bind();
      return () => {
        host();
        session();
        releaseRow();
      };
    },
    [hostClient, key],
  );
  const get = useCallback(() => placeByKey(hostClient.getSnapshot(), key), [hostClient, key]);
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
  return useMemo(() => browserTabStrip(places, layout), [places, layout]);
}

export function useBrowserTabStripStructure(hostClient: HostClient) {
  const places = usePlaceStructure(hostClient);
  const layout = useHostSelector(hostClient, selectTabGroups);
  return useMemo(() => browserTabStrip(places, layout), [places, layout]);
}

/** Catalog changes retarget a picture without subscribing the card to streaming text. */
export function useRunPlaceBinding(hostClient: HostClient, entry: PlaceEnteredEventView | null) {
  const source = useHostSelector(
    hostClient,
    selectSource,
    (a, b) => a.machines === b.machines && a.browserSessions === b.browserSessions,
  );
  const tabRevision = useSyncExternalStore(
    hostClient.browserTabs.subscribe,
    () => hostClient.browserTabs.revision,
  );
  const destination = useMemo(
    () => (entry ? runPlaceDestination(entry, source) : null),
    [entry, source, tabRevision],
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
