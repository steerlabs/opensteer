import type { ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import type { ThreadInputQueue } from "@opensteer/core";
import type {
  TranscriptPageSchema,
  TranscriptItem,
  TranscriptOrderCursor,
} from "@opensteer/protocol/transcript";

type Frame = Extract<
  ScopedHostMessage,
  {
    type:
      | "host.snapshot"
      | "host.changes"
      | "host.synchronized"
      | "host.removed"
      | "host.snapshot-required";
  }
>;
type DetailSnapshot = Extract<
  Extract<Frame, { type: "host.snapshot" }>["snapshot"],
  { items: unknown }
>;
type Listener = () => void;
type Page = import("zod").infer<typeof TranscriptPageSchema>;
export type VersionedInputQueue = ThreadInputQueue & { readonly revision: string };

export interface TranscriptState {
  readonly generation: number;
  readonly through: string | null;
  readonly synchronized: boolean;
  readonly items: ReadonlyMap<string, TranscriptItem>;
  readonly ids: readonly string[];
  readonly historyIds: readonly string[];
  readonly activeIds: ReadonlySet<string>;
  readonly readRevision: string;
  readonly liveItems: ReadonlyMap<string, TranscriptItem>;
  readonly removed: boolean;
  readonly stale: ReadonlySet<string>;
  readonly overlayRevisions: ReadonlyMap<string, string>;
  readonly snapshot: DetailSnapshot | null;
  readonly inputQueue: VersionedInputQueue | null;
  readonly inputQueueRevision: string;
  readonly orderRevision: string;
  readonly newest: boolean;
}

const emptyState: TranscriptState = {
  generation: 0,
  through: null,
  synchronized: false,
  items: new Map(),
  ids: [],
  historyIds: [],
  activeIds: new Set(),
  readRevision: "0",
  liveItems: new Map(),
  removed: false,
  stale: new Set(),
  overlayRevisions: new Map(),
  snapshot: null,
  inputQueue: null,
  inputQueueRevision: "0",
  orderRevision: "0",
  newest: true,
};

function comparePosition(a: TranscriptItem, b: TranscriptItem) {
  const delta = BigInt(a.position) - BigInt(b.position);
  return delta < 0n ? -1 : delta > 0n ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class ThreadTranscriptStore {
  readonly #listeners = new Set<Listener>();
  #state: TranscriptState = emptyState;

  getSnapshot = () => this.#state;

  subscribe = (listener: Listener) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  begin(generation: number, retained: boolean) {
    if (generation <= this.#state.generation) return;
    this.#set({
      ...(retained ? this.#state : emptyState),
      generation,
      synchronized: false,
      liveItems: emptyState.liveItems,
    });
  }

  apply(frame: Frame): boolean {
    const state = this.#state;
    if (frame.generation !== state.generation || frame.scope.kind === "shell") return false;
    switch (frame.type) {
      case "host.removed":
        this.#set({ ...emptyState, generation: state.generation, removed: true });
        return true;
      case "host.snapshot-required":
        this.#set({ ...state, through: null, synchronized: false });
        return true;
      case "host.synchronized":
        if (frame.throughSequence !== state.through) return false;
        if (!state.synchronized) this.#set({ ...state, synchronized: true });
        return true;
      case "host.snapshot": {
        if ("tasks" in frame.snapshot || state.synchronized) return false;
        const items = new Map<string, TranscriptItem>();
        for (const item of [...frame.snapshot.activeItems, ...frame.snapshot.items]) {
          const previous = items.get(item.id);
          if (previous && BigInt(previous.revision) >= BigInt(item.revision)) continue;
          const held = state.items.get(item.id);
          items.set(item.id, held?.revision === item.revision ? held : item);
        }
        const historyIds = frame.snapshot.items.map(({ id }) => id);
        this.#set({
          ...state,
          through: frame.throughSequence,
          snapshot: frame.snapshot,
          synchronized: false,
          removed: false,
          liveItems: emptyState.liveItems,
          items,
          historyIds,
          activeIds: new Set(frame.snapshot.activeItems.map(({ id }) => id)),
          ids: sortedIds(items),
          readRevision: "0",
          orderRevision: frame.snapshot.orderRevision,
          inputQueueRevision: frame.snapshot.inputQueueRevision,
          inputQueue:
            state.inputQueue?.revision === frame.snapshot.inputQueueRevision
              ? state.inputQueue
              : null,
          newest: frame.snapshot.anchorItemId == null && frame.snapshot.nextAfter == null,
          stale: new Set(),
          overlayRevisions: new Map(),
        });
        return true;
      }
      case "host.changes": {
        if (
          frame.fromSequence !== state.through ||
          BigInt(frame.throughSequence) <= BigInt(frame.fromSequence)
        )
          return false;
        let items: Map<string, TranscriptItem> | undefined;
        let stale: Set<string> | undefined;
        let overlayRevisions: Map<string, string> | undefined;
        let ids: string[] | undefined;
        let historyIds: string[] | undefined;
        let activeIds: Set<string> | undefined;
        let liveItems: Map<string, TranscriptItem> | undefined;
        let snapshot = state.snapshot;
        let orderRevision = state.orderRevision;
        let inputQueueRevision = state.inputQueueRevision;
        let inputQueue = state.inputQueue;
        for (const change of frame.changes) {
          if (change.operation === "invalidate") {
            stale ??= new Set(state.stale);
            if (change.entityId === "input-queue") {
              const revision = change.value.revision ?? change.sequence;
              if (BigInt(revision) > BigInt(inputQueueRevision)) {
                inputQueueRevision = revision;
                inputQueue = null;
              }
            }
            if (change.entityId === "history-order")
              orderRevision = change.value.revision ?? change.sequence;
            if (["requests", "tools", "nodes"].includes(change.entityId)) {
              overlayRevisions ??= new Map(state.overlayRevisions);
              overlayRevisions.set(change.entityId, change.value.revision ?? change.sequence);
            }
            stale.add(change.entityId);
            continue;
          }
          if (snapshot && change.entityKind === "thread") {
            if (change.operation === "remove") return false;
            if (BigInt(change.value.revision) > BigInt(snapshot.thread.revision))
              snapshot = { ...snapshot, thread: change.value };
          }
          if (snapshot && change.entityKind === "run-queue") {
            if (change.operation === "upsert") {
              if (BigInt(change.value.revision) > BigInt(snapshot.queue?.revision ?? "-1"))
                snapshot = { ...snapshot, queue: change.value };
            } else {
              const { queue: _removed, ...rest } = snapshot;
              snapshot = rest;
            }
          }
          if (snapshot && change.entityKind === "request") {
            const previous = snapshot.pendingRequests.find(({ id }) => id === change.entityId);
            if (
              previous &&
              change.operation === "upsert" &&
              BigInt(previous.revision) >= BigInt(change.value.revision)
            )
              continue;
            const requests = snapshot.pendingRequests.filter(
              (request) => request.id !== change.entityId,
            );
            if (change.operation === "upsert" && change.value.status === "pending")
              requests.push(change.value);
            snapshot = { ...snapshot, pendingRequests: requests };
          }
          if (change.entityKind !== "item") continue;
          if ((liveItems ?? state.liveItems).has(change.entityId)) {
            liveItems ??= new Map(state.liveItems);
            liveItems.delete(change.entityId);
          }
          const id = change.entityId;
          const previous = (items ?? state.items).get(id);
          if (change.operation === "remove") {
            if (!previous || BigInt(previous.revision) > BigInt(change.sequence)) continue;
            items ??= new Map(state.items);
            items.delete(id);
            ids ??= [...state.ids];
            removeId(ids, id);
            historyIds ??= [...state.historyIds];
            removeId(historyIds, id);
            if ((activeIds ?? state.activeIds).has(id)) {
              activeIds ??= new Set(state.activeIds);
              activeIds.delete(id);
            }
            orderRevision = change.sequence;
          } else {
            const next = change.value;
            if (previous && BigInt(previous.revision) >= BigInt(next.revision)) continue;
            const history = historyIds ?? state.historyIds;
            const first = (items ?? state.items).get(history[0] ?? "");
            const last = (items ?? state.items).get(history.at(-1) ?? "");
            const inHistory =
              (!snapshot?.nextBefore || !first || comparePosition(next, first) >= 0) &&
              (state.newest || !last || comparePosition(next, last) <= 0);
            const active = (activeIds ?? state.activeIds).has(id);
            if (!previous && !inHistory && !active) continue;
            items ??= new Map(state.items);
            items.set(id, next);
            if (previous?.position !== next.position) {
              ids ??= [...state.ids];
              insertId(ids, next, items);
              historyIds ??= [...state.historyIds];
              if (inHistory) insertId(historyIds, next, items);
              else removeId(historyIds, id);
              if (previous) orderRevision = change.sequence;
            }
          }
        }
        if (items && historyIds && historyIds.length > 250) {
          ids ??= [...state.ids];
          snapshot = trimWindow(
            historyIds,
            items,
            activeIds ?? state.activeIds,
            snapshot,
            orderRevision,
            state.newest ? "latest" : "earlier",
          );
          ids = ids.filter((id) => items!.has(id));
        }
        this.#set({
          ...state,
          through: frame.throughSequence,
          snapshot,
          liveItems: liveItems ?? state.liveItems,
          orderRevision,
          inputQueueRevision,
          inputQueue,
          items: items ?? state.items,
          ids: ids ?? state.ids,
          historyIds: historyIds ?? state.historyIds,
          activeIds: activeIds ?? state.activeIds,
          stale: stale ?? state.stale,
          overlayRevisions: overlayRevisions ?? state.overlayRevisions,
        });
        return true;
      }
    }
  }

  liveItem(item: TranscriptItem | undefined, itemId: string, close: boolean) {
    const state = this.#state;
    if (close) {
      if (!state.liveItems.has(itemId)) return;
      const liveItems = new Map(state.liveItems);
      liveItems.delete(itemId);
      this.#set({ ...state, liveItems });
      return;
    }
    if (!item || state.items.has(itemId) || state.liveItems.has(itemId)) return;
    const liveItems = new Map(state.liveItems);
    if (liveItems.size >= 16) {
      const oldest = liveItems.keys().next();
      if (!oldest.done) liveItems.delete(oldest.value);
    }
    liveItems.set(itemId, item);
    this.#set({ ...state, liveItems });
  }

  installQueue(queue: VersionedInputQueue, generation: number) {
    const state = this.#state;
    if (
      generation !== state.generation ||
      !state.synchronized ||
      BigInt(queue.revision) < BigInt(state.inputQueueRevision) ||
      (state.inputQueue && BigInt(queue.revision) <= BigInt(state.inputQueue.revision))
    )
      return false;
    const stale = new Set(state.stale);
    stale.delete("input-queue");
    this.#set({ ...state, inputQueue: queue, inputQueueRevision: queue.revision, stale });
    return true;
  }

  installPage(page: Page, generation: number, mode: "earlier" | "newer" | "around" | "latest") {
    const state = this.#state;
    if (
      state.generation !== generation ||
      !state.synchronized ||
      !state.snapshot ||
      state.through === null ||
      BigInt(page.revision) < BigInt(state.through) ||
      BigInt(page.orderRevision) < BigInt(state.orderRevision)
    )
      return false;
    const merge = mode === "earlier" || mode === "newer";
    const items = new Map([...state.items].filter(([id]) => merge || state.activeIds.has(id)));
    for (const item of page.items) {
      const previous = state.items.get(item.id);
      items.set(
        item.id,
        previous && BigInt(previous.revision) >= BigInt(item.revision) ? previous : item,
      );
    }
    const historyIds = [
      ...new Set([...(merge ? state.historyIds : []), ...page.items.map(({ id }) => id)]),
    ].sort((a, b) => comparePosition(items.get(a)!, items.get(b)!));
    const snapshot = trimWindow(
      historyIds,
      items,
      state.activeIds,
      {
        ...state.snapshot,
        nextBefore: mode === "newer" ? state.snapshot.nextBefore : page.nextBefore,
        nextAfter:
          mode === "earlier" ? (state.snapshot.nextAfter ?? null) : (page.nextAfter ?? null),
      },
      page.orderRevision,
      mode === "earlier" ? "earlier" : "latest",
      state.snapshot.nextBefore ?? state.snapshot.nextAfter,
    );
    const stale = new Set(state.stale);
    stale.delete("history-order");
    this.#set({
      ...state,
      snapshot,
      historyIds,
      ids: stableIds(state.ids, sortedIds(items)),
      items,
      stale,
      readRevision: maxRevision(state.readRevision, page.revision),
      orderRevision: page.orderRevision,
      newest: mode !== "around" && snapshot?.nextAfter == null,
    });
    return true;
  }

  installOverlays(
    kind: "requests" | "tools" | "nodes",
    page: {
      revision: string;
      entries: readonly (TranscriptItem | DetailSnapshot["pendingRequests"][number])[];
      next: string | null;
    },
    generation: number,
    replace = false,
  ) {
    const state = this.#state;
    if (
      state.generation !== generation ||
      !state.synchronized ||
      !state.snapshot ||
      state.through === null ||
      BigInt(page.revision) < BigInt(state.through)
    )
      return false;
    const snapshot = { ...state.snapshot };
    const overlayCursors = { ...snapshot.overlayCursors };
    if (page.next === null) delete overlayCursors[kind];
    else overlayCursors[kind] = page.next;
    snapshot.overlayCursors = overlayCursors;
    const items = new Map(state.items);
    const activeIds = new Set(state.activeIds);
    if (kind === "requests") {
      const requests = new Map(
        (replace ? [] : snapshot.pendingRequests).map((request) => [request.id, request]),
      );
      for (const entry of page.entries) {
        if ("position" in entry) continue;
        const previous = requests.get(entry.id);
        if (!previous || BigInt(entry.revision) > BigInt(previous.revision))
          requests.set(entry.id, entry);
      }
      snapshot.pendingRequests = [...requests.values()].slice(-100);
    } else {
      if (replace) {
        const history = new Set(state.historyIds);
        for (const id of activeIds) {
          if (items.get(id)?.kind !== (kind === "tools" ? "tool" : "node")) continue;
          activeIds.delete(id);
          if (!history.has(id)) items.delete(id);
        }
      }
      for (const entry of page.entries) {
        if (!("position" in entry)) continue;
        activeIds.add(entry.id);
        const held = items.get(entry.id);
        if (!held || BigInt(entry.revision) > BigInt(held.revision)) items.set(entry.id, entry);
      }
    }
    const stale = new Set(state.stale);
    stale.delete(kind);
    this.#set({
      ...state,
      snapshot,
      items,
      activeIds,
      stale,
      readRevision: maxRevision(state.readRevision, page.revision),
      ids: stableIds(state.ids, sortedIds(items)),
    });
    return true;
  }

  canCheckpoint(state = this.#state) {
    return (
      state.snapshot !== null &&
      state.through !== null &&
      state.stale.size === 0 &&
      state.newest &&
      BigInt(state.through) >= BigInt(state.readRevision) &&
      state.historyIds.length <= 50 &&
      state.activeIds.size <= 20 &&
      state.snapshot.pendingRequests.length <= 20
    );
  }

  checkpoint(state = this.#state): DetailSnapshot | undefined {
    const { snapshot, items, orderRevision, inputQueueRevision } = state;
    if (!snapshot || !this.canCheckpoint(state)) return;
    return {
      ...snapshot,
      items: state.historyIds.map((id) => items.get(id)!),
      activeItems: [...state.activeIds].map((id) => items.get(id)!),
      orderRevision,
      inputQueueRevision,
    };
  }

  #set(state: TranscriptState) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

function stableIds(previous: readonly string[], next: string[]) {
  return previous.length === next.length && previous.every((id, index) => id === next[index])
    ? previous
    : next;
}

function sortedIds(items: ReadonlyMap<string, TranscriptItem>) {
  return [...items.values()].sort(comparePosition).map(({ id }) => id);
}

function maxRevision(a: string, b: string) {
  return BigInt(a) >= BigInt(b) ? a : b;
}

function removeId(ids: string[], id: string) {
  const index = ids.indexOf(id);
  if (index !== -1) ids.splice(index, 1);
}

function insertId(ids: string[], item: TranscriptItem, items: ReadonlyMap<string, TranscriptItem>) {
  removeId(ids, item.id);
  let first = 0;
  let end = ids.length;
  while (first < end) {
    const mid = Math.floor((first + end) / 2);
    if (comparePosition(items.get(ids[mid]!)!, item) < 0) first = mid + 1;
    else end = mid;
  }
  ids.splice(first, 0, item.id);
}

function trimWindow(
  historyIds: string[],
  items: Map<string, TranscriptItem>,
  activeIds: ReadonlySet<string>,
  snapshot: DetailSnapshot | null,
  orderRevision: string,
  edge: "earlier" | "latest",
  fallback?: TranscriptOrderCursor | null,
) {
  const extra = historyIds.length - 250;
  if (!snapshot || extra <= 0) return snapshot;
  const removed = historyIds.splice(edge === "earlier" ? 250 : 0, extra);
  for (const id of removed) if (!activeIds.has(id)) items.delete(id);
  const template = snapshot.nextBefore ?? snapshot.nextAfter ?? fallback;
  if (!template) return snapshot;
  const boundary = items.get((edge === "earlier" ? historyIds.at(-1) : historyIds[0])!)!;
  const cursor = {
    ...template,
    orderRevision,
    beforeId: boundary.id,
    beforePosition: boundary.position,
  };
  return edge === "earlier"
    ? { ...snapshot, nextAfter: cursor }
    : { ...snapshot, nextBefore: cursor };
}
