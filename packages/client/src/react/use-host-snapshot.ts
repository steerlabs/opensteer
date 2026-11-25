import { useMemo, useSyncExternalStore } from "react";
import type { HostClient, HostSnapshot } from "../host/client.js";
import {
  createHostSelection,
  hostSnapshotStore,
  type HostSelectionEquality,
  type HostSnapshotSelector,
  type HostSnapshotSource,
} from "../host/host-snapshot-store.js";

export function useHostSelector<Selection>(
  hostClient: HostSnapshotSource,
  selector: HostSnapshotSelector<Selection>,
  isEqual: HostSelectionEquality<Selection> = Object.is,
): Selection {
  const store = hostSnapshotStore(hostClient);
  // One reader for this mounted hook, kept across selector changes, so its kinds stay watched
  // exactly while it is mounted.
  const reader = useMemo(() => store.reader?.(), [store]);
  const selection = useMemo(
    () => createHostSelection(store, selector, isEqual, reader),
    [isEqual, selector, store, reader],
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
