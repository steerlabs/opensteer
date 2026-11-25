import { utf8ByteLength, type AssignmentSummary } from "@opensteer/core";
import { personalCheckpointMaxBytes } from "./personal-stream-cache.js";
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
export type TranscriptPage = import("zod").infer<typeof TranscriptPageSchema>;
type Page = TranscriptPage;
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

/**
 * What a page read was for. A page that extends the window backward names the edge cursor it was
 * read from: it installs only while that is still the window's top edge, so it can never leave a
 * gap.
 */
export type TranscriptPageAsk = { readonly mode: "earlier"; readonly from: TranscriptOrderCursor };

/**
 * How a page install ended. `stale`: the read raced a change it could not account for, and is
 * read again. `moved`: the window's edge is no longer the one the page continues, so the page
 * answers a window that is gone and is dropped.
 */
export type TranscriptPageInstall = "installed" | "stale" | "moved";

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
  /**
   * True once the reader has extended history beyond the initial bounded tail (loaded earlier pages
   * or hydrated deferred work). Expanded transcripts keep full live sync in memory but do not
   * overwrite the bounded tail disk checkpoint.
   */
  readonly expanded: boolean;
  /**
   * Counts the Host's inline repairs on this generation. A repair replaces the scope, so what a
   * reader read on top of the old state (overlay pages, queue entries) is read again.
   */
  readonly repairs: number;
  /**
   * Counts every snapshot installed, a subscription's cut or a repair, across generations: each
   * replaced the rows the reader had on screen.
   */
  readonly cuts: number;
  /** The sequence of the last snapshot installed: an HTTP read as of an earlier one is stale. */
  readonly snapshotThrough?: string;
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
  expanded: false,
  cuts: 0,
  repairs: 0,
};

function comparePosition(
  a: Pick<TranscriptItem, "id" | "position">,
  b: Pick<TranscriptItem, "id" | "position">,
) {
  const delta = BigInt(a.position) - BigInt(b.position);
  return delta < 0n ? -1 : delta > 0n ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function newer(held: { readonly revision: string } | undefined, revision: string) {
  return !held || BigInt(held.revision) < BigInt(revision);
}

/**
 * Live `host.changes` updates never carry `deferredWork` (which is synthesized on folded snapshots
 * and pages). Preserve an anchor's `deferredWork` metadata until `installDeferredWorkPage` clears
 * it.
 */
function preserveDeferredWork(
  previous: TranscriptItem | undefined,
  next: TranscriptItem,
): TranscriptItem {
  if (
    previous &&
    (previous.kind === "tool" || previous.kind === "reasoning") &&
    previous.deferredWork !== undefined &&
    next.kind === previous.kind &&
    next.deferredWork === undefined
  )
    return { ...next, deferredWork: previous.deferredWork };
  return next;
}

function clearDeferredWork(item: TranscriptItem): TranscriptItem {
  if ((item.kind !== "tool" && item.kind !== "reasoning") || item.deferredWork === undefined)
    return item;
  const { deferredWork: _cleared, ...rest } = item;
  return rest;
}

export function displayedItemIds(state: TranscriptState): readonly string[] {
  const placed = placeRunCards(state);
  if (!state.liveItems.size) return placed;
  const ids = [...placed];
  const items = { get: (id: string) => state.items.get(id) ?? state.liveItems.get(id) };
  for (const item of state.liveItems.values()) insertId(ids, item, items);
  return ids;
}

/** Whether a message is the reader's or another sender's input, rather than the agent's words. */
export function transcriptMessageKind(item: Extract<TranscriptItem, { kind: "message" }>) {
  return (
    item.messageKind ??
    (item.view.author === "assistant" || !item.isTurnStart ? "assistant" : "input")
  );
}

/**
 * A Run's card is what every row of the Run reads its state and its reply from, however far above
 * them the Run began. Held for rows in the window while it stands above it, it is drawn with the
 * first of them it belongs beside (the Run's own steps, never a message sent into it), so it joins
 * their turn rather than standing as a row of its own. One with no such row draws nothing.
 */
function placeRunCards(state: TranscriptState): readonly string[] {
  const history = new Set(state.historyIds);
  const held = state.ids.filter((id) =>
    isHeldRunCard(state.items.get(id), history, state.activeIds),
  );
  if (!held.length) return state.ids;
  const heldIds = new Set(held);
  const ids = state.ids.filter((id) => !heldIds.has(id));
  for (const id of held) {
    const card = state.items.get(id)!;
    const at = ids.findIndex((rowId) => {
      const row = state.items.get(rowId);
      return (
        row !== undefined &&
        history.has(rowId) &&
        row.runId === card.runId &&
        (row.kind !== "message" || transcriptMessageKind(row) !== "input")
      );
    });
    if (at >= 0) ids.splice(at, 0, id);
  }
  return ids;
}

function isHeldRunCard(
  item: TranscriptItem | undefined,
  history: ReadonlySet<string>,
  activeIds: ReadonlySet<string>,
) {
  return item?.kind === "run" && !history.has(item.id) && !activeIds.has(item.id);
}

/** Whether the window holds any row of `runId`. */
function holdsRun(
  historyIds: readonly string[],
  items: ReadonlyMap<string, TranscriptItem>,
  runId: string | null,
) {
  return runId !== null && historyIds.some((id) => items.get(id)?.runId === runId);
}

/** Lets go of held Run cards whose rows the window no longer holds. */
function sweepRunCards(
  items: Map<string, TranscriptItem>,
  historyIds: readonly string[],
  activeIds: ReadonlySet<string>,
) {
  const history = new Set(historyIds);
  const runs = new Set(historyIds.map((id) => items.get(id)?.runId));
  for (const [id, item] of items)
    if (isHeldRunCard(item, history, activeIds) && !runs.has(item.runId)) items.delete(id);
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
  /**
   * The state listeners were last told of. A catch-up applied quietly (see `apply`) is not it until
   * `host.synchronized`; a catch-up abandoned before then (the scope left or resubscribed) is
   * dropped, so a reader never keeps a partly caught-up transcript.
   */
  #published: TranscriptState = emptyState;
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
      ...(retained ? this.#published : emptyState),
      generation,
      synchronized: false,
      liveItems: emptyState.liveItems,
      repairs: 0,
    });
  }

  /**
   * Applies one frame. With `catchUp`, a subscription's cut before `host.synchronized` (its
   * snapshot, or every replayed commit) is applied without telling listeners: the catch-up is
   * published once, whole, when `host.synchronized` arrives, so a reader never renders each
   * replayed commit.
   */
  apply(
    frame: Frame,
    authority?: Pick<PersonalResumeCursor, "deploymentId" | "viewerId" | "epoch">,
    catchUp = false,
  ): boolean {
    const state = this.#state;
    if (frame.generation !== state.generation || frame.scope.kind === "shell") return false;
    const quiet = catchUp && !state.synchronized;
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
        this.#snapshot(frame.snapshot, frame.throughSequence, frame.scope, authority, quiet);
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
              const next = preserveDeferredWork(previous, change.value);
              if (previous && !newer(previous, next.revision)) break;
              const history = historyIds ?? state.historyIds;
              const first = (items ?? state.items).get(history[0] ?? "");
              // The store is always tail-anchored: every new item at or past the loaded top
              // boundary lands directly in history. Updates to unloaded older history are ignored
              // unless they are active work or belong to a held Run card.
              const inHistory =
                provisional || !snapshot?.nextBefore || !first || comparePosition(next, first) >= 0;
              const wasActive = (activeIds ?? state.activeIds).has(id);
              const active = openWork(next);
              if (wasActive !== active) {
                activeIds ??= new Set(state.activeIds);
                if (active) activeIds.add(id);
                else activeIds.delete(id);
              }
              if (
                !inHistory &&
                !active &&
                !history.includes(id) &&
                !(next.kind === "run" && holdsRun(history, items ?? state.items, next.runId))
              ) {
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
        if (items && historyIds) {
          sweepRunCards(items, historyIds, activeIds ?? state.activeIds);
          if (ids) ids = ids.filter((id) => items!.has(id));
        }
        if (snapshot?.queue && (queueEntries || snapshot.queue !== state.snapshot?.queue)) {
          const listed = new Set<string>(snapshot.queue.inputs);
          for (const id of (queueEntries ?? state.queueEntries).keys())
            if (!listed.has(id)) (queueEntries ??= new Map(state.queueEntries)).delete(id);
        }
        const entries = queueEntries ?? state.queueEntries;
        this.#set(
          {
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
          },
          quiet,
        );
        return true;
      }
    }
  }

  // A snapshot before `host.synchronized` is the subscription's tail cut; after it, the Host's
  // inline repair. Both install the latest tail window.
  #snapshot(
    next: DetailSnapshot,
    through: string,
    scope: Extract<Frame["scope"], { threadId: string }>,
    authority: Pick<PersonalResumeCursor, "deploymentId" | "viewerId" | "epoch"> | undefined,
    quiet: boolean,
  ) {
    const state = this.#state;
    const items = new Map<string, TranscriptItem>();
    // The cut's Run cards come beside its rows: held for them, outside its history.
    for (const item of [...(next.runs ?? []), ...next.activeItems, ...next.items]) {
      const previous = items.get(item.id);
      if (previous && !newer(previous, item.revision)) continue;
      const held = state.items.get(item.id);
      items.set(
        item.id,
        held?.revision === item.revision && sameDeferredWork(held, item) ? held : item,
      );
    }
    const historyIds = next.items.map(({ id }) => id);
    sweepRunCards(items, historyIds, new Set(next.activeItems.map(({ id }) => id)));
    // After `host.synchronized` this is the Host's repair: it replaces the scope. Rows, queue
    // entries and overlays held from before may be stale, and page reads begun before it are
    // fenced; the reader reads again what it had loaded on top.
    const repair = state.synchronized && state.snapshot !== null;
    if (repair) {
      this.#pending.clear();
      this.#lostReads = this.#readCount;
    }
    const queueEntries = new Map(
      (next.inputQueue ?? []).map((entry) => [entry.message.id as string, entry]),
    );
    const snapshot: DetailSnapshot = { ...next, nextAfter: null };
    this.#set(
      {
        ...state,
        through,
        snapshot,
        synchronized: state.synchronized,
        removed: false,
        // Live text stays through a repair; a provisional card the cut finalized gives way to it.
        liveItems: repair
          ? new Map([...state.liveItems].filter(([id]) => !items.has(id)))
          : emptyState.liveItems,
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
          : (next.nextBefore ?? state.cursorScope ?? undefined),
        queueEntries,
        inputQueue: inputQueueOf(scope.threadId, next.queue, queueEntries, state.inputQueue),
        assignments: emptyState.assignments,
        expanded: false,
        repairs: repair ? state.repairs + 1 : 0,
        cuts: state.cuts + 1,
        snapshotThrough: through,
      },
      quiet,
    );
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
    // A replacement or reidentified frame brings a new face: the card takes it, and its place.
    if (!item || state.items.has(itemId) || state.liveItems.get(itemId) === item) return;
    const liveItems = new Map(state.liveItems);
    if (!liveItems.has(itemId) && liveItems.size >= 16) {
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
    ask: TranscriptPageAsk,
    read?: number,
  ): TranscriptPageInstall {
    const state = this.#state;
    if (
      state.generation !== generation ||
      !state.synchronized ||
      !state.snapshot ||
      state.through === null ||
      !this.#readable(read)
    )
      return "stale";
    if (!sameBoundary(state.snapshot.nextBefore, ask.from)) return "moved";
    const items = new Map(state.items);
    // The page's rows, and beside them the Run cards they read from.
    for (const item of [...(page.runs ?? []), ...page.items]) {
      const previous = state.items.get(item.id);
      const candidate = preserveDeferredWork(previous, item);
      items.set(item.id, previous && !newer(previous, candidate.revision) ? previous : candidate);
    }
    const nextBefore = page.nextBefore;
    const existingFirst = state.historyIds.length ? items.get(state.historyIds[0]!) : undefined;
    const pageLast = page.items.at(-1);
    let historyIds: string[];
    let needsSort = false;
    if (
      !this.#pending.size &&
      (!existingFirst || !pageLast || comparePosition(pageLast, existingFirst) < 0)
    ) {
      // Common backward-extension fast path: strictly older sorted page prepended with no overlap.
      historyIds = [...page.items.map(({ id }) => id), ...state.historyIds];
    } else {
      historyIds = [...new Set([...state.historyIds, ...page.items.map(({ id }) => id)])];
      needsSort = true;
    }
    if (this.#pending.size) {
      this.#replay(items, historyIds, nextBefore != null);
      needsSort = true;
    }
    if (needsSort) historyIds.sort((a, b) => comparePosition(items.get(a)!, items.get(b)!));
    sweepRunCards(items, historyIds, state.activeIds);
    let liveItems: Map<string, TranscriptItem> | undefined;
    for (const { id } of page.items) {
      if (!state.liveItems.has(id)) continue;
      (liveItems ??= new Map(state.liveItems)).delete(id);
    }
    this.#set({
      ...state,
      snapshot: { ...state.snapshot, nextBefore, nextAfter: null },
      historyIds,
      ids: stableIds(state.ids, sortedIds(items)),
      items,
      liveItems: liveItems ?? state.liveItems,
      readRevision: maxRevision(state.readRevision, page.revision),
      expanded: true,
    });
    return "installed";
  }

  /**
   * Splices one page of hydrated deferred work items into place after `workAnchorId`. Clears
   * `deferredWork` on the anchor once `page.hasMore` is false.
   */
  installDeferredWorkPage(
    page: Page,
    generation: number,
    workAnchorId: string,
    read?: number,
  ): TranscriptPageInstall {
    const state = this.#state;
    if (
      state.generation !== generation ||
      !state.synchronized ||
      !state.snapshot ||
      state.through === null ||
      !this.#readable(read)
    )
      return "stale";
    const anchor = state.items.get(workAnchorId);
    if (!anchor) return "moved";
    const items = new Map(state.items);
    for (const item of [...(page.runs ?? []), ...page.items]) {
      const previous = items.get(item.id);
      const candidate = preserveDeferredWork(previous, item);
      items.set(item.id, previous && !newer(previous, candidate.revision) ? previous : candidate);
    }
    if (!page.hasMore) {
      const currentAnchor = items.get(workAnchorId);
      if (currentAnchor) items.set(workAnchorId, clearDeferredWork(currentAnchor));
    }
    const historyIds = [...new Set([...state.historyIds, ...page.items.map(({ id }) => id)])];
    this.#replay(items, historyIds, state.snapshot.nextBefore != null);
    historyIds.sort((a, b) => comparePosition(items.get(a)!, items.get(b)!));
    sweepRunCards(items, historyIds, state.activeIds);
    let liveItems: Map<string, TranscriptItem> | undefined;
    for (const { id } of page.items) {
      if (!state.liveItems.has(id)) continue;
      (liveItems ??= new Map(state.liveItems)).delete(id);
    }
    this.#set({
      ...state,
      historyIds,
      ids: stableIds(state.ids, sortedIds(items)),
      items,
      liveItems: liveItems ?? state.liveItems,
      readRevision: maxRevision(state.readRevision, page.revision),
      expanded: true,
    });
    return "installed";
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
        if (newer(held, entry.revision)) items.set(entry.id, preserveDeferredWork(held, entry));
        if (openWork(items.get(entry.id)!)) activeIds.add(entry.id);
      }
      for (const change of this.#pending.values()) {
        if (change.kind !== "item" || !activeIds.has(change.id)) continue;
        const held = items.get(change.id)!;
        if (change.value && newer(held, change.value.revision))
          items.set(change.id, preserveDeferredWork(held, change.value));
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
  #replay(items: Map<string, TranscriptItem>, historyIds: string[], hasEarlier: boolean) {
    if (!this.#pending.size) return;
    const window = historyIds.map((id) => items.get(id)!).sort(comparePosition);
    const first = window[0];
    const removed = new Set<string>();
    for (const change of this.#pending.values()) {
      if (change.kind !== "item") continue;
      const held = items.get(change.id);
      if (!change.value) {
        if (held && BigInt(held.revision) <= BigInt(change.sequence)) removed.add(change.id);
        continue;
      }
      if (held) {
        if (newer(held, change.value.revision))
          items.set(change.id, preserveDeferredWork(held, change.value));
        continue;
      }
      if (!hasEarlier || !first || comparePosition(change.value, first) >= 0) {
        items.set(change.id, change.value);
        historyIds.push(change.id);
      }
    }
    for (const id of removed) {
      items.delete(id);
      removeId(historyIds, id);
    }
  }

  /** Whether this in-memory store can delta-resume from its cursor on reconnect or re-open. */
  canResume(state = this.#state) {
    return (
      state.snapshot !== null &&
      state.through !== null &&
      BigInt(state.through) >= BigInt(state.readRevision)
    );
  }

  /** Whether this store's bounded tail cut can be persisted as a cold-start disk checkpoint. */
  canCheckpoint(state = this.#state) {
    return (
      !state.expanded &&
      this.canResume(state) &&
      (state.historyIds.length <= 50 || state.cursorScope !== undefined) &&
      state.activeIds.size <= 20 &&
      state.snapshot!.pendingRequests.length <= 20
    );
  }

  checkpoint(state = this.#state): DetailSnapshot | undefined {
    const { snapshot, items } = state;
    if (!snapshot || !this.canCheckpoint(state)) return;
    const { inputQueue: _inputQueue, runs: _runs, ...rest } = snapshot;
    const activeItems = [...state.activeIds].map((id) => items.get(id)!);
    const baseSnapshot = {
      ...rest,
      nextBefore: snapshot.nextBefore,
      nextAfter: null,
      items: [] as TranscriptItem[],
      activeItems,
      ...(state.inputQueue ? { inputQueue: state.inputQueue.items } : {}),
    };
    // Pack the newest contiguous suffix that fits inside the checkpoint budget so a live thread
    // that grew past 1 MiB still persists a valid, resumable cut without exceeding the cache cap.
    const baseBytes = utf8ByteLength(JSON.stringify(baseSnapshot));
    const budget = personalCheckpointMaxBytes - baseBytes - 4096;
    if (budget < 0) return;
    const candidates = state.historyIds.slice(-50).map((id) => items.get(id)!);
    const packed: TranscriptItem[] = [];
    let bytes = 0;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index]!;
      const size = utf8ByteLength(JSON.stringify(candidate)) + 1;
      if (bytes + size > budget) break;
      bytes += size;
      packed.push(candidate);
    }
    if (packed.length === 0 && candidates.length > 0) return;
    const history = packed.reverse();
    // The saved rows carry the Run cards they read from, as a cut does: the cards this window
    // holds now, for these rows. They share the budget, and the oldest rows give way for them.
    const cards = new Map<string, TranscriptItem>();
    for (const item of items.values())
      if (item.kind === "run" && item.runId) cards.set(item.runId, item);
    const runsFor = (rows: readonly TranscriptItem[]) => {
      const held = new Set(rows.flatMap((row) => (row.kind === "run" ? [row.runId] : [])));
      return [
        ...new Set(rows.flatMap((row) => (row.runId && !held.has(row.runId) ? [row.runId] : []))),
      ].flatMap((runId) => cards.get(runId) ?? []);
    };
    let runs = runsFor(history);
    const size = (rows: readonly TranscriptItem[]) =>
      rows.reduce((sum, row) => sum + utf8ByteLength(JSON.stringify(row)) + 1, 0);
    while (history.length > 1 && runs.length && bytes + size(runs) > budget) {
      bytes -= size([history.shift()!]);
      runs = runsFor(history);
    }
    if (runs.length && bytes + size(runs) > budget) return;
    const boundary = history[0];
    const trimmed = state.historyIds.length > history.length;
    if (trimmed && (!boundary || !state.cursorScope)) return;
    const nextBefore =
      trimmed && boundary && state.cursorScope
        ? { ...state.cursorScope, beforeId: boundary.id, beforePosition: boundary.position }
        : snapshot.nextBefore;
    const checkpointSnapshot: DetailSnapshot = {
      ...baseSnapshot,
      nextBefore,
      nextAfter: null,
      items: history,
      ...(runs.length ? { runs } : {}),
    };
    if (utf8ByteLength(JSON.stringify(checkpointSnapshot)) > personalCheckpointMaxBytes) return;
    return checkpointSnapshot;
  }

  #set(state: TranscriptState, quiet = false) {
    this.#state = state;
    if (quiet) return;
    this.#published = state;
    for (const listener of this.#listeners) listener();
  }
}

function sameDeferredWork(a: TranscriptItem, b: TranscriptItem) {
  const da = a.kind === "tool" || a.kind === "reasoning" ? a.deferredWork : undefined;
  const db = b.kind === "tool" || b.kind === "reasoning" ? b.deferredWork : undefined;
  if (da === db) return true;
  if (!da || !db) return false;
  return (
    da.itemCount === db.itemCount &&
    da.startedAt === db.startedAt &&
    da.endedAt === db.endedAt &&
    da.onlyThinking === db.onlyThinking
  );
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
  ids.splice(lowerBound(ids, items, item), 0, item.id);
}

/**
 * The index where `item` stands, or would, in a window sorted by position; with `after`, the
 * index just past it.
 */
function lowerBound(
  ids: readonly string[],
  items: Pick<ReadonlyMap<string, TranscriptItem>, "get">,
  item: Pick<TranscriptItem, "id" | "position">,
  after = false,
) {
  let first = 0;
  let end = ids.length;
  while (first < end) {
    const mid = Math.floor((first + end) / 2);
    const order = comparePosition(items.get(ids[mid]!)!, item);
    if (order < 0 || (after && order === 0)) first = mid + 1;
    else end = mid;
  }
  return first;
}

function sameBoundary(
  held: Pick<TranscriptOrderCursor, "beforeId" | "beforePosition"> | null | undefined,
  from: Pick<TranscriptOrderCursor, "beforeId" | "beforePosition">,
) {
  return held?.beforeId === from.beforeId && held.beforePosition === from.beforePosition;
}
