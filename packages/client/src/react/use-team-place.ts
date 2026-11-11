import type { HostClient } from "../host/client.js";
import { isTeamPlace } from "../host/team-place.js";
import { useHostSelector } from "./use-host-snapshot.js";

/** The shared team-place answer for one Host, re-rendering only when it changes. */
export function useTeamPlace(client: HostClient): boolean {
  return useHostSelector(client, isTeamPlace);
}
