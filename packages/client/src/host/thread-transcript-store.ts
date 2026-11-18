import type { AssignmentSummary } from "@opensteer/core";
import type { PersonalResumeCursor, ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import type { PersonalInputQueue, WaitingInputView } from "@opensteer/protocol";
import type {
  TranscriptPageSchema,
  TranscriptItem,
  TranscriptOrderCursor,
} from "@opensteer/protocol/transcript";

type Frame = Extract<
  ScopedHostMessage,
  { type: "host.snapshot" | "host.changes" | "host.synchronized" | "host.removed" }
>;
type DetailSnapshot = Extract<
  Extract<Frame, { type: "host.snapshot" }>["snapshot"],
  { items: unknown }
>;
type Listener = () => void;
type Page = import("zod").infer<typeof TranscriptPageSchema>;
type RequestSummary = DetailSnapshot["pendingRequests"][number];
type Pending =
  | {
      readonly kind: "item";
      readonly id: string;
      readonly sequence: string;
      readonly value?: TranscriptItem;
    }
  | {
      readonly kind: "request";
      readonly id: string;
      readonly sequence: string;
      readonly value?: RequestSummary;
    };

export interface TranscriptState {
  readonly generation: number;
  readonly through: string | null;
  readonly synchronized: boolean;
  readonly items: ReadonlyMap<string, TranscriptItem>;
  readonly ids: readonly string[];
  readonly historyIds: readonly string[];
  readonly activeIds: ReadonlySet<string>;
  readonly readRevision: string;
  readonly cursorScope?: Omit<TranscriptOrderCursor, "beforeId" | "beforePosition"> | undefined;
  readonly liveItems: ReadonlyMap<string, TranscriptItem>;
  readonly removed: boolean;
  readonly snapshot: DetailSnapshot | null;
  /** Waiting messages keyed by message id; `snapshot.queue.inputs` orders them. */
  readonly queueEntries: ReadonlyMap<string, WaitingInputView>;
  readonly inputQueue: PersonalInputQueue | null;
  readonly assignments: ReadonlyMap<string, AssignmentSummary | null>;
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
  snapshot: null,
  queueEntries: new Map(),
  inputQueue: null,
  assignments: new Map(),
  newest: true,
};

function comparePosition(a: TranscriptItem, b: TranscriptItem) {
  const delta = BigInt(a.position) - BigInt(b.position);
  return delta < 0n ? -1 : delta > 0n ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function newer(held: { readonly revision: string } | undefined, revision: string) {
  return !held || BigInt(held.revision) < BigInt(revision);
}

export function displayedItemIds(state: TranscriptState): readonly string[] {
  if (!state.liveItems.size) return state.ids;
  const ids = [...state.ids];
  const items = { get: (id: string) => state.items.get(id) ?? state.liveItems.get(id) };
  for (const item of state.liveItems.values()) insertId(ids, item, items);
  return ids;
}

export function finalizedItemText(item: TranscriptItem | undefined): boolean {
  return (
    item?.kind === "message" ||
    item?.kind === "reasoning" ||
    item?.kind === "node-message" ||
    (item?.kind === "tool" && item.view.status !== "running") ||
    (item?.kind === "node" && item.view.status !== "running" && item.view.status !== "stopping")
  );
}

/** A running tool or node: it stays in the open-work overlay whatever the history window. */
function openWork(item: TranscriptItem) {
  return (item.kind === "tool" || item.kind === "node") && !finalizedItemText(item);
}

function inputQueueOf(
  threadId: string,
  queue: DetailSnapshot["queue"],
  entries: ReadonlyMap<string, WaitingInputView>,
  previous: PersonalInputQueue | null,
): PersonalInputQueue | null {
  if (!queue) return null;
  const items = queue.inputs.flatMap((id) => entries.get(id) ?? []);
  if (
    previous &&
    previous.revision === queue.revision &&
    previous.paused === queue.paused &&
    previous.steerRunId === queue.steerRunId &&
    previous.items.length === items.length &&
    previous.items.every((item, index) => item === items[index])
  )
    return previous;
  return {
    threadId: threadId as PersonalInputQueue["threadId"],
    revision: queue.revision,
    paused: queue.paused,
    steerRunId: queue.steerRunId,
    items,
  };
}

export class ThreadTranscriptStore {
  readonly #listeners = new Set<Listener>();
  #state: TranscriptState = emptyState;
  // Changes that land while a page read is in flight, so the page cannot undo them.
  readonly #pending = new Map<string, Pending>();
  readonly #reads = new Set<number>();
  #readCount = 0;
  #lostReads = 0;

  getSnapshot = () => this.#state;

  subscribe = (listener: Listener) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Starts recording changes for a page read; pass the token to the install and to endRead. */
  beginRead() {
    const token = ++this.#readCount;
    this.#reads.add(token);
    return token;
  }

  endRead(token: number) {
    this.#reads.delete(token);
    if (!this.#reads.size) this.#pending.clear();
  }

  #record(change: Pending) {
    if (!this.#reads.size) return;
    const key = `${change.kind}:${change.id}`;
    this.#pending.delete(key);
    this.#pending.set(key, change);
    if (this.#pending.size <= 2000) return;
    this.#pending.clear();
    this.#lostReads = this.#readCount;
  }

  #readable(token: number | undefined) {
    return token === undefined || (this.#reads.has(token) && token > this.#lostReads);
  }

  begin(generation: number, retained: boolean) {
    if (generation <= this.#state.generation) return;
    this.#pending.clear();
    this.#lostReads = this.#readCount;
    this.#set({
      ...(retained ? this.#state : emptyState),
      generation,
      synchronized: false,
      liveItems: emptyState.liveItems,
    });
  }

  apply(
    frame: Frame,
    authority?: Pick<PersonalResumeCursor, "deploymentId" | "viewerId" | "epoch">,
  ): boolean {
    const state = this.#state;
    if (frame.generation !== state.generation || frame.scope.kind === "shell") return false;
    switch (frame.type) {
      case "host.removed":
        this.#set({ ...emptyState, generation: state.generation, removed: true });
        return true;
      case "host.synchronized":
        if (frame.throughSequence !== state.through) return false;
        if (!state.synchronized) this.#set({ ...state, synchronized: true });
        return true;
      case "host.snapshot": {
        if ("tasks" in frame.snapshot) return false;
        this.#snapshot(frame.snapshot, frame.throughSequence, frame.scope, authority);
        return true;
      }
      case "host.changes": {
        if (
          frame.fromSequence !== state.through ||
          BigInt(frame.throughSequence) <= BigInt(frame.fromSequence)
        )
          return false;
        let items: Map<string, TranscriptItem> | undefined;
        let ids: string[] | undefined;
        let historyIds: string[] | undefined;
        let activeIds: Set<string> | undefined;
        let liveItems: Map<string, TranscriptItem> | undefined;
        let queueEntries: Map<string, WaitingInputView> | undefined;
        let assignments: Map<string, AssignmentSummary | null> | undefined;
        let snapshot = state.snapshot;
        for (const change of frame.changes) {
          switch (change.entityKind) {
            case "thread":
              if (!snapshot) break;
              if (change.operation === "remove") return false;
              if (newer(snapshot.thread, change.value.revision))
                snapshot = { ...snapshot, thread: change.value };
              break;
            case "run-queue":
              if (!snapshot) break;
              if (change.operation === "upsert") {
                if (newer(snapshot.queue, change.value.revision))
                  snapshot = { ...snapshot, queue: change.value };
              } else {
                const { queue: _removed, ...rest } = snapshot;
                snapshot = rest;
              }
              break;
            case "queue-entry": {
              const held = (queueEntries ?? state.queueEntries).get(change.entityId);
              if (change.operation === "remove") {
                if (held) (queueEntries ??= new Map(state.queueEntries)).delete(change.entityId);
              } else if (!held || held.message.revision <= change.value.message.revision)
                (queueEntries ??= new Map(state.queueEntries)).set(change.entityId, change.value);
              break;
            }
            case "assignment":
              (assignments ??= new Map(state.assignments)).set(
                change.entityId,
                change.operation === "upsert" ? change.value : null,
              );
              break;
            case "node":
              if (!snapshot) break;
              if (change.operation === "upsert") {
                if (newer(snapshot.nodeSubject, change.value.revision))
                  snapshot = { ...snapshot, nodeSubject: change.value };
              }
              break;
            case "request": {
              this.#record({
                kind: "request",
                id: change.entityId,
                sequence: change.sequence,
                ...(change.operation === "upsert" ? { value: change.value } : {}),
              });
              if (!snapshot) break;
              const previous = snapshot.pendingRequests.find(({ id }) => id === change.entityId);
              if (
                previous &&
                change.operation === "upsert" &&
                !newer(previous, change.value.revision)
              )
                break;
              const requests = snapshot.pendingRequests.filter(
                (request) => request.id !== change.entityId,
              );
              if (change.operation === "upsert" && change.value.status === "pending")
                requests.push(change.value);
              snapshot = { ...snapshot, pendingRequests: requests };
              break;
            }
            case "item": {
              this.#record({
                kind: "item",
                id: change.entityId,
                sequence: change.sequence,
                ...(change.operation === "upsert" ? { value: change.value } : {}),
              });
              const provisional = (liveItems ?? state.liveItems).has(change.entityId);
              if (provisional) {
                liveItems ??= new Map(state.liveItems);
                liveItems.delete(change.entityId);
              }
              const id = change.entityId;
              const previous = (items ?? state.items).get(id);
              if (change.operation === "remove") {
                if (!previous || BigInt(previous.revision) > BigInt(change.sequence)) break;
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
                break;
              }
              const next = change.value;
              if (previous && !newer(previous, next.revision)) break;
              const history = historyIds ?? state.historyIds;
              const first = (items ?? state.items).get(history[0] ?? "");
              const last = (items ?? state.items).get(history.at(-1) ?? "");
              const inHistory =
                provisional ||
                ((!snapshot?.nextBefore || !first || comparePosition(next, first) >= 0) &&
                  (state.newest || !last || comparePosition(next, last) <= 0));
              const wasActive = (activeIds ?? state.activeIds).has(id);
              const active = openWork(next);
              if (wasActive !== active) {
                activeIds ??= new Set(state.activeIds);
                if (active) activeIds.add(id);
                else activeIds.delete(id);
              }
              if (!inHistory && !active && !history.includes(id)) {
                if (previous) {
                  items ??= new Map(state.items);
                  items.delete(id);
                  ids ??= [...state.ids];
                  removeId(ids, id);
                }
                break;
              }
              items ??= new Map(state.items);
              items.set(id, next);
              if (!previous || previous.position !== next.position) {
                ids ??= [...state.ids];
                insertId(ids, next, items);
                historyIds ??= [...state.historyIds];
                if (inHistory) insertId(historyIds, next, items);
                else removeId(historyIds, id);
              }
              break;
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
            state.newest ? "latest" : "earlier",
            state.cursorScope,
          );
          ids = ids.filter((id) => items!.has(id));
        }
        if (snapshot?.queue && (queueEntries || snapshot.queue !== state.snapshot?.queue)) {
          const listed = new Set<string>(snapshot.queue.inputs);
          for (const id of (queueEntries ?? state.queueEntries).keys())
            if (!listed.has(id)) (queueEntries ??= new Map(state.queueEntries)).delete(id);
        }
        const entries = queueEntries ?? state.queueEntries;
        this.#set({
          ...state,
          through: frame.throughSequence,
          snapshot,
          liveItems: liveItems ?? state.liveItems,
          items: items ?? state.items,
          ids: ids ?? state.ids,
          historyIds: historyIds ?? state.historyIds,
          activeIds: activeIds ?? state.activeIds,
          queueEntries: entries,
          inputQueue: inputQueueOf(
            frame.scope.threadId,
            snapshot?.queue,
            entries,
            state.inputQueue,
          ),
          assignments: assignments ?? state.assignments,
        });
        return true;
      }
    }
  }

  // A snapshot before `host.synchronized` is the subscription's cut; after it, the Host's inline
  // repair. A repair keeps earlier pages the reader loaded when they still meet the new window.
  #snapshot(
    next: DetailSnapshot,
    through: string,
    scope: Extract<Frame["scope"], { threadId: string }>,
    authority?: Pick<PersonalResumeCursor, "deploymentId" | "viewerId" | "epoch">,
  ) {
    const state = this.#state;
    const items = new Map<string, TranscriptItem>();
    for (const item of [...next.activeItems, ...next.items]) {
      const previous = items.get(item.id);
      if (previous && !newer(previous, item.revision)) continue;
      const held = state.items.get(item.id);
      items.set(item.id, held?.revision === item.revision ? held : item);
    }
    let historyIds = next.items.map(({ id }) => id);
    let nextBefore = next.nextBefore;
    const first = next.items[0];
    const repair = state.synchronized && state.snapshot !== null;
    if (repair && first && next.nextBefore) {
      const earlier = state.historyIds.filter((id) => {
        const held = state.items.get(id);
        return held && comparePosition(held, first) < 0;
      });
      const meets = state.historyIds.some((id) => {
        const held = state.items.get(id);
        return held && comparePosition(held, first) >= 0;
      });
      if (earlier.length && meets) {
        for (const id of earlier) if (!items.has(id)) items.set(id, state.items.get(id)!);
        historyIds = [...earlier, ...historyIds];
        nextBefore = state.snapshot!.nextBefore;
      }
    }
    const queueEntries = new Map(
      (next.inputQueue ?? []).map((entry) => [entry.message.id as string, entry]),
    );
    if (repair && next.queue)
      for (const id of next.queue.inputs)
        if (!queueEntries.has(id) && state.queueEntries.has(id))
          queueEntries.set(id, state.queueEntries.get(id)!);
    const snapshot = { ...next, nextBefore };
    this.#set({
      ...state,
      through,
      snapshot,
      synchronized: state.synchronized,
      removed: false,
      liveItems: repair ? state.liveItems : emptyState.liveItems,
      items,
      historyIds,
      activeIds: new Set(next.activeItems.map(({ id }) => id)),
      ids: stableIds(state.ids, sortedIds(items)),
      readRevision: "0",
      cursorScope: authority
        ? {
            ...authority,
            threadId: scope.threadId,
            nodeId: scope.kind === "node" ? scope.nodeId : null,
          }
        : (next.nextBefore ?? next.nextAfter ?? state.cursorScope ?? undefined),
      queueEntries,
      inputQueue: inputQueueOf(scope.threadId, next.queue, queueEntries, state.inputQueue),
      assignments: repair ? state.assignments : emptyState.assignments,
      newest: next.anchorItemId == null && next.nextAfter == null,
    });
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

  /** Fills waiting messages the snapshot had no room for; pushed values stay authoritative. */
  installQueueEntries(entries: readonly WaitingInputView[], generation: number) {
    const state = this.#state;
    const queue = state.snapshot?.queue;
    if (generation !== state.generation || !state.synchronized || !queue) return false;
    const listed = new Set<string>(queue.inputs);
    let queueEntries: Map<string, WaitingInputView> | undefined;
    for (const entry of entries) {
      const id = entry.message.id;
      if (!listed.has(id) || state.queueEntries.has(id)) continue;
      (queueEntries ??= new Map(state.queueEntries)).set(id, entry);
    }
    if (!queueEntries) return true;
    this.#set({
      ...state,
      queueEntries,
      inputQueue: inputQueueOf(state.snapshot!.thread.id, queue, queueEntries, state.inputQueue),
    });
    return true;
  }

  installPage(
    page: Page,
    generation: number,
    mode: "earlier" | "newer" | "around" | "latest",
    read?: number,
  ) {
    const state = this.#state;
    if (
      state.generation !== generation ||
      !state.synchronized ||
      !state.snapshot ||
      state.through === null ||
      !this.#readable(read)
    )
      return false;
    const merge = mode === "earlier" || mode === "newer";
    const items = new Map([...state.items].filter(([id]) => merge || state.activeIds.has(id)));
    for (const item of page.items) {
      const previous = state.items.get(item.id);
      items.set(item.id, previous && !newer(previous, item.revision) ? previous : item);
    }
    const historyIds = [
      ...new Set([...(merge ? state.historyIds : []), ...page.items.map(({ id }) => id)]),
    ];
    const nextBefore = mode === "newer" ? state.snapshot.nextBefore : page.nextBefore;
    const newest =
      mode !== "around" && (mode === "earlier" ? state.newest : page.nextAfter == null);
    this.#replay(items, historyIds, nextBefore != null, newest);
    historyIds.sort((a, b) => comparePosition(items.get(a)!, items.get(b)!));
    const snapshot = trimWindow(
      historyIds,
      items,
      state.activeIds,
      {
        ...state.snapshot,
        nextBefore,
        nextAfter:
          mode === "earlier" ? (state.snapshot.nextAfter ?? null) : (page.nextAfter ?? null),
      },
      mode === "earlier" ? "earlier" : "latest",
      state.cursorScope,
    );
    let liveItems: Map<string, TranscriptItem> | undefined;
    for (const { id } of page.items) {
      if (!state.liveItems.has(id)) continue;
      (liveItems ??= new Map(state.liveItems)).delete(id);
    }
    this.#set({
      ...state,
      snapshot,
      historyIds,
      ids: stableIds(state.ids, sortedIds(items)),
      items,
      liveItems: liveItems ?? state.liveItems,
      readRevision: maxRevision(state.readRevision, page.revision),
      newest: mode !== "around" && snapshot?.nextAfter == null,
    });
    return true;
  }

  installOverlays(
    kind: "requests" | "tools" | "nodes",
    page: {
      revision: string;
      entries: readonly (TranscriptItem | RequestSummary)[];
      next: string | null;
    },
    generation: number,
    read?: number,
  ) {
    const state = this.#state;
    if (
      state.generation !== generation ||
      !state.synchronized ||
      !state.snapshot ||
      state.through === null ||
      !this.#readable(read)
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
      const requests = new Map<string, RequestSummary>(
        snapshot.pendingRequests.map((request) => [request.id, request]),
      );
      for (const entry of page.entries) {
        if ("position" in entry) continue;
        if (newer(requests.get(entry.id), entry.revision)) requests.set(entry.id, entry);
      }
      for (const change of this.#pending.values()) {
        if (change.kind !== "request") continue;
        const held = requests.get(change.id);
        if (change.value?.status === "pending") {
          if (newer(held, change.value.revision)) requests.set(change.id, change.value);
        } else if (!held || BigInt(held.revision) <= BigInt(change.sequence))
          requests.delete(change.id);
      }
      snapshot.pendingRequests = [...requests.values()].slice(-100);
    } else {
      for (const entry of page.entries) {
        if (!("position" in entry)) continue;
        const held = items.get(entry.id);
        if (newer(held, entry.revision)) items.set(entry.id, entry);
        if (openWork(items.get(entry.id)!)) activeIds.add(entry.id);
      }
      for (const change of this.#pending.values()) {
        if (change.kind !== "item" || !activeIds.has(change.id)) continue;
        const held = items.get(change.id)!;
        if (change.value && newer(held, change.value.revision)) items.set(change.id, change.value);
        else if (!change.value && BigInt(held.revision) <= BigInt(change.sequence))
          items.delete(change.id);
        const current = items.get(change.id);
        if (current && openWork(current)) continue;
        activeIds.delete(change.id);
        if (current && !state.historyIds.includes(change.id)) items.delete(change.id);
      }
    }
    this.#set({
      ...state,
      snapshot,
      items,
      activeIds,
      readRevision: maxRevision(state.readRevision, page.revision),
      ids: stableIds(state.ids, sortedIds(items)),
    });
    return true;
  }

  // Applies the changes recorded during a page read on top of the page.
  #replay(
    items: Map<string, TranscriptItem>,
    historyIds: string[],
    hasEarlier: boolean,
    newest: boolean,
  ) {
    if (!this.#pending.size) return;
    const window = historyIds.map((id) => items.get(id)!).sort(comparePosition);
    const first = window[0];
    const last = window.at(-1);
    const removed = new Set<string>();
    for (const change of this.#pending.values()) {
      if (change.kind !== "item") continue;
      const held = items.get(change.id);
      if (!change.value) {
        if (held && BigInt(held.revision) <= BigInt(change.sequence)) removed.add(change.id);
        continue;
      }
      if (held) {
        if (newer(held, change.value.revision)) items.set(change.id, change.value);
        continue;
      }
      if (
        (!hasEarlier || !first || comparePosition(change.value, first) >= 0) &&
        (newest || !last || comparePosition(change.value, last) <= 0)
      ) {
        items.set(change.id, change.value);
        historyIds.push(change.id);
      }
    }
    for (const id of removed) {
      items.delete(id);
      removeId(historyIds, id);
    }
  }

  canCheckpoint(state = this.#state) {
    return (
      state.snapshot !== null &&
      state.through !== null &&
      state.newest &&
      BigInt(state.through) >= BigInt(state.readRevision) &&
      (state.historyIds.length <= 50 || state.cursorScope !== undefined) &&
      state.activeIds.size <= 20 &&
      state.snapshot.pendingRequests.length <= 20
    );
  }

  checkpoint(state = this.#state): DetailSnapshot | undefined {
    const { snapshot, items } = state;
    if (!snapshot || !this.canCheckpoint(state)) return;
    const history = state.historyIds.slice(-50).map((id) => items.get(id)!);
    const boundary = history[0];
    const nextBefore =
      state.historyIds.length > history.length && boundary && state.cursorScope
        ? { ...state.cursorScope, beforeId: boundary.id, beforePosition: boundary.position }
        : snapshot.nextBefore;
    const { inputQueue: _inputQueue, ...rest } = snapshot;
    return {
      ...rest,
      nextBefore,
      items: history,
      activeItems: [...state.activeIds].map((id) => items.get(id)!),
      ...(state.inputQueue ? { inputQueue: state.inputQueue.items } : {}),
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

function insertId(
  ids: string[],
  item: TranscriptItem,
  items: Pick<ReadonlyMap<string, TranscriptItem>, "get">,
) {
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
  edge: "earlier" | "latest",
  fallback?: TranscriptState["cursorScope"],
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
    beforeId: boundary.id,
    beforePosition: boundary.position,
  };
  return edge === "earlier"
    ? { ...snapshot, nextAfter: cursor }
    : { ...snapshot, nextBefore: cursor };
}
