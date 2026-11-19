import { useMemo, useSyncExternalStore } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import {
  createHostSelection,
  hostSnapshotStore,
  type HostSelectionEquality,
  type HostSnapshotSelector,
} from "../host/host-snapshot-store.js";

export function useHostSelector<Selection>(
  hostClient: HostClient,
  selector: HostSnapshotSelector<Selection>,
  isEqual: HostSelectionEquality<Selection> = Object.is,
): Selection {
  const store = hostSnapshotStore(hostClient);
  const selection = useMemo(
    () => createHostSelection(store, selector, isEqual),
    [isEqual, selector, store],
  );
  return useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot);
}

const selectSnapshot = (snapshot: HostSnapshot) => snapshot;

export function useHostSnapshot(
  hostClient: HostClient,
  isEqual: HostSelectionEquality<HostSnapshot> = Object.is,
) {
  const snapshot = useHostSelector(hostClient, selectSnapshot, isEqual);
  return { snapshot };
}
