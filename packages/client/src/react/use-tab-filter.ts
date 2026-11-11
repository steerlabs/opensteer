import { useMemo } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import { placeFilterList } from "../host/places.js";
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
  const select = useMemo(() => {
    let places: ReturnType<typeof placeFilterList> | undefined;
    let machines: HostSnapshot["machines"] | undefined;
    let choice: TabDeviceChoice;
    return (snapshot: HostSnapshot) => {
      const next = placeFilterList(snapshot);
      if (next !== places || snapshot.machines !== machines) {
        places = next;
        machines = snapshot.machines;
        choice = tabDeviceChoice({ places, machines, hereId, homeId, filter });
      }
      return choice;
    };
  }, [filter, hereId, homeId]);
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
  const select = useMemo(() => {
    let places: ReturnType<typeof placeFilterList> | undefined;
    let keys: string | null = null;
    return (snapshot: HostSnapshot) => {
      if (!tabFilterActive(filter)) return null;
      const next = placeFilterList(snapshot);
      if (places !== next) {
        places = next;
        keys = places
          .filter((place) => tabMatchesFilter(place, filter))
          .map((place) => place.key)
          .join("\n");
      }
      return keys;
    };
  }, [filter]);
  const keys = useHostSelector(hostClient, select);
  return useMemo(() => (keys === null ? null : new Set(keys ? keys.split("\n") : [])), [keys]);
}
