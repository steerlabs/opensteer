import type { HostClient, HostSnapshot } from "./client.js";

export type HostSnapshotSelector<Selection> = (snapshot: HostSnapshot) => Selection;
export type HostSelectionEquality<Selection> = (previous: Selection, next: Selection) => boolean;

/**
 * A client has one upstream subscription, regardless of how many consumers
 * select from it. This keeps the transport boundary singular while still
 * letting each screen subscribe at the smallest useful granularity.
 */
export interface HostSnapshotStore {
  readonly getSnapshot: () => HostSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

const stores = new WeakMap<HostClient, HostSnapshotStore>();

function createHostSnapshotStore(hostClient: HostClient): HostSnapshotStore {
  const listeners = new Set<() => void>();
  let unsubscribeFromClient: (() => void) | null = null;

  const publish = () => {
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: hostClient.getSnapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) unsubscribeFromClient = hostClient.subscribe(publish);

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size !== 0) return;
        unsubscribeFromClient?.();
        unsubscribeFromClient = null;
      };
    },
  };
}

export function hostSnapshotStore(hostClient: HostClient): HostSnapshotStore {
  const current = stores.get(hostClient);
  if (current) return current;
  const created = createHostSnapshotStore(hostClient);
  stores.set(hostClient, created);
  return created;
}

export interface HostSelection<Selection> {
  readonly getSnapshot: () => Selection;
}

/**
 * Cache selector results by semantic equality. A subscriber only re-reads when
 * this returned identity changes.
 */
export function createHostSelection<Selection>(
  store: HostSnapshotStore,
  selector: HostSnapshotSelector<Selection>,
  isEqual: HostSelectionEquality<Selection> = Object.is,
): HostSelection<Selection> {
  let initialized = false;
  let value: Selection;

  return {
    getSnapshot: () => {
      const next = selector(store.getSnapshot());
      if (initialized && isEqual(value, next)) return value;
      initialized = true;
      value = next;
      return value;
    },
  };
}
