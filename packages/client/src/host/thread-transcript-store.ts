import type { ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import type { ThreadInputQueue } from "@opensteer/core";
import type { TranscriptPageSchema, TranscriptItem } from "@opensteer/protocol/transcript";

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
  readonly liveItems: ReadonlyMap<string, TranscriptItem>;
  readonly removed: boolean;
  readonly stale: ReadonlySet<string>;
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
  liveItems: new Map(),
  removed: false,
  stale: new Set(),
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
        const items = new Map(
          [...frame.snapshot.items, ...frame.snapshot.activeItems].map((item) => [
            item.id,
            state.items.get(item.id)?.revision === item.revision ? state.items.get(item.id)! : item,
          ]),
        );
        this.#set({
          ...state,
          through: frame.throughSequence,
          snapshot: frame.snapshot,
          synchronized: false,
          removed: false,
          liveItems: emptyState.liveItems,
          items,
          ids: stableIds(
            state.ids,
            [...items.values()].sort(comparePosition).map(({ id }) => id),
          ),
          orderRevision: frame.snapshot.orderRevision,
          inputQueueRevision: frame.snapshot.inputQueueRevision,
          inputQueue:
            state.inputQueue?.revision === frame.snapshot.inputQueueRevision
              ? state.inputQueue
              : null,
          newest: true,
          stale: new Set(),
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
        let orderChanged = false;
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
            snapshot = { ...snapshot, pendingRequests: requests.slice(-20) };
          }
          if (change.entityKind !== "item") continue;
          if ((liveItems ?? state.liveItems).has(change.entityId)) {
            liveItems ??= new Map(state.liveItems);
            liveItems.delete(change.entityId);
          }
          const previous = (items ?? state.items).get(change.entityId);
          if (change.operation === "remove") {
            if (!previous) continue;
            items ??= new Map(state.items);
            items.delete(change.entityId);
            orderChanged = true;
            orderRevision = change.sequence;
          } else {
            if (previous && BigInt(previous.revision) >= BigInt(change.value.revision)) continue;
            items ??= new Map(state.items);
            items.set(change.entityId, change.value);
            orderChanged ||= previous?.position !== change.value.position;
            if (previous && previous.position !== change.value.position)
              orderRevision = change.sequence;
          }
        }
        if (items && items.size > 250)
          retainItems(items, snapshot, state.newest ? "latest" : "earlier");
        const ids =
          orderChanged && items
            ? stableIds(
                state.ids,
                [...items.values()].sort(comparePosition).map(({ id }) => id),
              )
            : state.ids;
        this.#set({
          ...state,
          through: frame.throughSequence,
          snapshot,
          liveItems: liveItems ?? state.liveItems,
          orderRevision,
          inputQueueRevision,
          inputQueue,
          items: items ?? state.items,
          ids,
          stale: stale ?? state.stale,
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
    const items =
      mode === "earlier" || mode === "newer"
        ? new Map(state.items)
        : new Map<string, TranscriptItem>();
    for (const item of [...state.snapshot.activeItems, ...page.items]) {
      const previous = state.items.get(item.id);
      items.set(
        item.id,
        previous && BigInt(previous.revision) >= BigInt(item.revision) ? previous : item,
      );
    }
    retainItems(items, state.snapshot, mode === "earlier" ? "earlier" : "latest");
    const stale = new Set(state.stale);
    stale.delete("history-order");
    this.#set({
      ...state,
      snapshot: {
        ...state.snapshot,
        nextBefore: mode === "newer" ? state.snapshot.nextBefore : page.nextBefore,
        ...(mode !== "earlier" && page.nextAfter !== undefined
          ? { nextAfter: page.nextAfter }
          : {}),
        items: page.items.slice(-50),
      },
      ids: stableIds(
        state.ids,
        [...items.values()].sort(comparePosition).map(({ id }) => id),
      ),
      items,
      stale,
      orderRevision: page.orderRevision,
      newest: mode === "latest" || (mode === "newer" && !page.nextAfter),
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
    if (kind === "requests") {
      const requests = new Map(snapshot.pendingRequests.map((request) => [request.id, request]));
      for (const entry of page.entries) {
        if ("position" in entry) continue;
        const previous = requests.get(entry.id);
        if (!previous || BigInt(entry.revision) > BigInt(previous.revision))
          requests.set(entry.id, entry);
      }
      snapshot.pendingRequests = [...requests.values()].slice(-100);
    } else {
      for (const entry of page.entries) {
        if (!("position" in entry)) continue;
        const held = items.get(entry.id);
        if (!held || BigInt(entry.revision) > BigInt(held.revision)) items.set(entry.id, entry);
      }
      retainItems(items, snapshot, "latest");
    }
    this.#set({
      ...state,
      snapshot,
      items,
      ids: stableIds(
        state.ids,
        [...items.values()].sort(comparePosition).map(({ id }) => id),
      ),
    });
    return true;
  }

  checkpoint(): DetailSnapshot | undefined {
    const { snapshot, items, orderRevision, inputQueueRevision, stale, newest } = this.#state;
    if (
      !snapshot ||
      stale.size ||
      !newest ||
      items.size > 50 ||
      snapshot.pendingRequests.length > 20
    )
      return;
    return {
      ...snapshot,
      items: [...items.values()].sort(comparePosition),
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

function retainItems(
  items: Map<string, TranscriptItem>,
  snapshot: DetailSnapshot | null,
  edge: "earlier" | "latest",
) {
  const pinned = new Set(snapshot?.activeItems.map(({ id }) => id));
  const ordered = [...items.values()].sort(comparePosition);
  if (edge === "latest") ordered.reverse();
  for (const item of ordered.slice(250)) if (!pinned.has(item.id)) items.delete(item.id);
}
