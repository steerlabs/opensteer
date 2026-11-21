import {
  sameStableHostSnapshot,
  sameTaskListSource,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";

const selectSnapshot = (snapshot: HostSnapshot) => snapshot;

/** The page's stable chrome, and everything a task list is drawn from. */
function sameTaskSnapshot(previous: HostSnapshot, next: HostSnapshot): boolean {
  return sameStableHostSnapshot(previous, next) && sameTaskListSource(previous, next);
}

/** The snapshot task rows read, repainted whenever what a row says changes. */
export function useTaskSnapshot(hostClient: HostClient): HostSnapshot {
  return useHostSelector(hostClient, selectSnapshot, sameTaskSnapshot);
}
