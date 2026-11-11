import { useCallback, useMemo } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { placeList } from "../host/places.js";
import {
  sameTabDeviceChoice,
  tabDeviceChoice,
  tabFilterActive,
  tabMatchesFilter,
  type TabDeviceChoice,
  type TabFilter,
} from "../host/tab-list.js";
import { useHostSelector } from "./use-host-snapshot.js";

/**
 * The devices the tab filter offers, with their counts, and the filter as it
 * stands. Its counts read every place, but it changes only with them, so a
 * title arriving renders nothing.
 */
export function useTabDeviceChoice(
  hostClient: HostClient,
  hereId: string | null,
  homeId: string | null,
  filter: TabFilter,
): TabDeviceChoice {
  const select = useCallback(
    (snapshot: HostSnapshot) =>
      tabDeviceChoice({
        places: placeList(snapshot),
        machines: snapshot.machines,
        hereId,
        homeId,
        filter,
      }),
    [filter, hereId, homeId],
  );
  return useHostSelector(hostClient, select, sameTabDeviceChoice);
}

/**
 * The keys of the places an active filter lists; null while it lists them
 * all. Only a change of who matches renders the list, never a title.
 */
export function useTabFilterMatches(
  hostClient: HostClient,
  filter: TabFilter,
): ReadonlySet<string> | null {
  const select = useCallback(
    (snapshot: HostSnapshot) =>
      tabFilterActive(filter)
        ? placeList(snapshot)
            .filter((place) => tabMatchesFilter(place, filter))
            .map((place) => place.key)
            .join("\n")
        : null,
    [filter],
  );
  const keys = useHostSelector(hostClient, select);
  return useMemo(() => (keys === null ? null : new Set(keys ? keys.split("\n") : [])), [keys]);
}
