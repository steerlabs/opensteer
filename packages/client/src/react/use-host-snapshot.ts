import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
  const { getSnapshot } = selection;
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

const selectSnapshot = (snapshot: HostSnapshot) => snapshot;

export function useHostSnapshot(
  hostClient: HostClient,
  isEqual: HostSelectionEquality<HostSnapshot> = Object.is,
) {
  const snapshot = useHostSelector(hostClient, selectSnapshot, isEqual);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      await hostClient.refresh();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to connect to the Host.");
      throw error;
    }
  }, [hostClient]);

  useEffect(() => {
    let active = true;
    void hostClient
      .load()
      .then(() => {
        if (active) setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : "Unable to connect to the Host.");
      });
    return () => {
      active = false;
    };
  }, [hostClient]);

  return { loadError, reload, snapshot };
}
