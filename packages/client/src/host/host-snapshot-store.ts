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
  /** A reader of its own, for a client whose fields are read on demand. */
  readonly reader?: () => SnapshotReader;
}

/**
 * One mounted reader of the snapshot. Fields read through `view` are what it needs; they stay
 * current while it is open and for a short grace after its last close.
 */
export interface SnapshotReader {
  view(snapshot: HostSnapshot): HostSnapshot;
  open(): void;
  close(): void;
}

const stores = new WeakMap<HostClient, HostSnapshotStore>();
const tracked = new WeakMap<object, HostSnapshot>();

/**
 * A view of the snapshot that calls `read` with each field read through it. Equal snapshots give
 * the same view, so selections keep their identity.
 */
export function trackSnapshot(
  snapshot: HostSnapshot,
  views: WeakMap<HostSnapshot, HostSnapshot>,
  read: (field: PropertyKey) => void,
): HostSnapshot {
  const held = views.get(snapshot);
  if (held) return held;
  const view = new Proxy(snapshot, {
    get(target, field, receiver) {
      read(field);
      return Reflect.get(target, field, receiver);
    },
  });
  tracked.set(view, snapshot);
  views.set(snapshot, view);
  return view;
}

/** The snapshot under a tracked view; comparing raw snapshots reads nothing on anyone's behalf. */
export function rawSnapshot<Value>(value: Value): Value {
  return (
    typeof value === "object" && value !== null ? (tracked.get(value) ?? value) : value
  ) as Value;
}

function createHostSnapshotStore(hostClient: HostClient): HostSnapshotStore {
  const listeners = new Set<() => void>();
  let unsubscribeFromClient: (() => void) | null = null;

  const publish = () => {
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: hostClient.getSnapshot,
    ...(hostClient.snapshotReader ? { reader: hostClient.snapshotReader } : {}),
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
  /** Calls the listener only when this selection, not the whole snapshot, changed. */
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Cache selector results by semantic equality. A subscriber only re-reads when
 * this returned identity changes.
 */
export function createHostSelection<Selection>(
  store: HostSnapshotStore,
  selector: HostSnapshotSelector<Selection>,
  isEqual: HostSelectionEquality<Selection> = Object.is,
  /** The mounted reader this selection reads for; one of its own when none is given. */
  reader: SnapshotReader | undefined = store.reader?.(),
): HostSelection<Selection> {
  let initialized = false;
  let value: Selection;
  // What the selector and its consumer read through the reader's view is what the reader needs.
  const getSnapshot = () => {
    const snapshot = store.getSnapshot();
    const next = selector(reader ? reader.view(snapshot) : snapshot);
    if (initialized && isEqual(rawSnapshot(value), rawSnapshot(next))) return value;
    initialized = true;
    value = next;
    return value;
  };

  return {
    getSnapshot,
    subscribe: (listener) => {
      reader?.open();
      getSnapshot();
      const unsubscribe = store.subscribe(() => {
        const previous = value;
        if (getSnapshot() !== previous) listener();
      });
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        unsubscribe();
        reader?.close();
      };
    },
  };
}
