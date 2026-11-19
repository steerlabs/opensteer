import { utf8ByteLength, type Request, MessageIdSchema } from "@opensteer/core";
import type { HostApiClient, PersonalInputQueue } from "@opensteer/protocol";
import type {
  TranscriptItem,
  TranscriptItemResult,
  TranscriptOrderCursor,
} from "@opensteer/protocol/transcript";
import { classifyClientFailure } from "../connections/operation-error.js";
import { HostClientRequestError, type RunQueueEntry, type TranscriptEntry } from "./client.js";
import { FencedReads, type FencedRead } from "./fenced-reads.js";
import { unwrapRpcResult } from "./host-session-client.js";
import type { ObservedDetail } from "./scoped-personal-stream.js";
import { transcriptCard } from "./transcript-item-view.js";
import {
  displayedItemIds,
  finalizedItemText,
  type ThreadTranscriptStore,
  type TranscriptState,
} from "./thread-transcript-store.js";

export interface ThreadViewState {
  readonly entries: readonly TranscriptEntry[];
  readonly requests: readonly Request[];
  readonly runQueue: readonly RunQueueEntry[];
  readonly inputQueue: PersonalInputQueue | null;
  readonly synchronized: boolean;
  readonly generation?: number;
  /** Counts the Host's repairs of this scope: each replaced what the reader holds. */
  readonly repairs?: number;
  readonly pendingRequestIds?: readonly string[];
  readonly inputQueueError?: unknown;
  readonly moreTools?: boolean;
  readonly moreNodes?: boolean;
  readonly hasMore: boolean;
  readonly hasNewer: boolean;
  readonly moreRequests: boolean;
}

export const emptyThreadView: ThreadViewState = {
  entries: [],
  requests: [],
  runQueue: [],
  inputQueue: null,
  synchronized: false,
  hasMore: false,
  hasNewer: false,
  moreRequests: false,
};

export interface ThreadViewSource {
  getSnapshot(): ThreadViewState;
  subscribe(listener: () => void): () => void;
}

type Overlay = "requests" | "tools" | "nodes";
type RequestSummaries = NonNullable<
  ReturnType<ObservedDetail["transcript"]["getSnapshot"]>["snapshot"]
>["pendingRequests"];

export class TranscriptBodies {
  readonly #entries = new Map<string, { value: TranscriptItemResult; size: number }>();
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  peek(key: string, revision: string) {
    const value = this.#entries.get(key)?.value;
    return value?.item.revision === revision ? value : undefined;
  }

  #bytes = 0;

  get(key: string, revision: string) {
    const row = this.#entries.get(key);
    if (!row || row.value.item.revision !== revision) return;
    this.#entries.delete(key);
    this.#entries.set(key, row);
    return row.value;
  }

  put(key: string, value: TranscriptItemResult) {
    this.remove(key);
    const size = utf8ByteLength(JSON.stringify(value));
    this.#entries.set(key, { value, size });
    this.#bytes += size;
    for (const id of this.#entries.keys()) {
      if (this.#bytes <= 4 * 1024 * 1024) break;
      this.remove(id);
    }
    for (const listener of this.#listeners) listener();
  }

  remove(key: string) {
    this.#bytes -= this.#entries.get(key)?.size ?? 0;
    if (this.#entries.delete(key)) for (const listener of this.#listeners) listener();
  }

  clear() {
    this.#entries.clear();
    this.#bytes = 0;
    for (const listener of this.#listeners) listener();
  }
}

export class ScopedThreadReader implements ThreadViewSource {
  readonly #detail: ObservedDetail;
  readonly #rpc: HostApiClient;
  readonly #bodies: TranscriptBodies;
  readonly #release: () => void;
  readonly #listeners = new Set<() => void>();
  readonly #cards = new WeakMap<TranscriptItem, TranscriptEntry | undefined>();
  readonly #liveCards = new WeakMap<TranscriptItem, TranscriptEntry | undefined>();
  /** Every read that installs into the detail: fenced by its generation and repair count. */
  readonly #reads: FencedReads;
  /** Overlay pages the person loaded past the cut; a repair reads them again to this depth. */
  readonly #overlayDepth = new Map<Overlay, number>();
  readonly #overlayLoaded = new Map<Overlay, { epoch: string; pages: number }>();
  #repairs = 0;
  /** The queue cut a tail read filled: it is read once per queue revision and repair. */
  #queueFilled: string | undefined;
  #queueFailure: { cut: string; error: unknown } | undefined;
  #requestCut: RequestSummaries | undefined;
  readonly #reviewedRevisions = new Map<string, string>();
  #rows: ReadonlyMap<string, TranscriptItem> | undefined;
  #liveRows: ReadonlyMap<string, TranscriptItem> | undefined;
  #queueRows: unknown;
  #requestGeneration = 0;
  #bodyGeneration = 0;
  #view: ThreadViewState = emptyThreadView;

  constructor(detail: ObservedDetail, rpc: HostApiClient, bodies: TranscriptBodies, listen = true) {
    this.#detail = detail;
    this.#rpc = rpc;
    this.#bodies = bodies;
    this.#reads = new FencedReads({ epoch: () => readEpoch(detail.transcript.getSnapshot()) });
    // Node progress is not merged here: each row reads its own from the item text store.
    const unsubscribe = listen ? detail.transcript.subscribe(() => this.#update()) : undefined;
    this.#release = () => unsubscribe?.();
    if (listen) this.#update();
  }

  getSnapshot = () => this.#view;
  #disposed = false;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  dispose() {
    this.#disposed = true;
    this.#reads.dispose();
    this.#release();
    this.#listeners.clear();
  }

  #publish(view: ThreadViewState) {
    this.#view = view;
    for (const listener of this.#listeners) listener();
  }

  #update() {
    const state = this.#detail.transcript.getSnapshot();
    if (this.#bodyGeneration !== state.generation) {
      for (const id of this.#rows?.keys() ?? [])
        this.#bodies.remove(this.#bodyKey(id, this.#bodyGeneration));
      this.#bodyGeneration = state.generation;
    }
    let entries = this.#view.entries;
    if (this.#rows !== state.items || this.#liveRows !== state.liveItems) {
      for (const [id, item] of this.#rows ?? [])
        if (state.items.get(id) !== item) this.#bodies.remove(this.#bodyKey(id));
      this.#rows = state.items;
      this.#liveRows = state.liveItems;
      entries = displayedItemIds(state).flatMap((id) => {
        const durable = state.items.get(id);
        const item = durable ?? state.liveItems.get(id);
        if (!item) return [];
        const cards = durable ? this.#cards : this.#liveCards;
        if (!cards.has(item)) cards.set(item, transcriptCard(item, undefined, !durable));
        return cards.get(item) ?? [];
      });
    }
    const queue = state.synchronized ? state.snapshot?.queue : undefined;
    let runQueue = this.#view.runQueue;
    if (queue !== this.#queueRows) {
      this.#queueRows = queue;
      runQueue =
        queue?.runs.flatMap((run) => {
          if (
            run.status !== "queued" &&
            run.status !== "starting" &&
            run.status !== "running" &&
            run.status !== "waiting"
          )
            return [];
          return [
            {
              id: run.id,
              status: run.status,
              createdAt: run.createdAt ?? state.snapshot!.thread.askedAt,
              threadId: this.#detail.scope.threadId,
              runOrdinal: run.runOrdinal ?? 0,
            },
          ];
        }) ?? [];
    }
    const inputQueue = state.inputQueue;
    const hasMore = state.snapshot?.nextBefore != null;
    const hasNewer = state.snapshot?.nextAfter != null;
    const moreRequests = state.synchronized && state.snapshot?.overlayCursors?.requests != null;
    const moreTools = state.synchronized && state.snapshot?.overlayCursors?.tools != null;
    const moreNodes = state.synchronized && state.snapshot?.overlayCursors?.nodes != null;
    const pending = state.snapshot?.pendingRequests;
    const inputQueueError =
      this.#queueFailure?.cut === queueCut(state) ? this.#queueFailure.error : undefined;
    const requestChanged =
      pending !== this.#requestCut ||
      (state.synchronized && this.#requestGeneration !== state.generation);
    if (requestChanged) {
      this.#requestCut = pending;
      if (this.#requestGeneration !== state.generation || !state.synchronized)
        this.#reviewedRevisions.clear();
      if (state.synchronized) this.#requestGeneration = state.generation;
      this.#reads.changed("requests");
      if (state.synchronized && pending?.length)
        void this.#reads
          .request("requests", (read) => this.#readRequests(read), { observed: this.#observed })
          .catch(() => undefined);
    }
    if (
      state.synchronized &&
      this.#detail.scope.kind === "thread" &&
      missingQueueEntries(state) &&
      inputQueueError === undefined &&
      this.#queueFilled !== queueCut(state) &&
      !this.#reads.busy("queue")
    )
      void this.queue().catch(() => undefined);
    if (state.synchronized && state.repairs !== this.#repairs) {
      this.#repairs = state.repairs;
      this.#afterRepair();
    } else if (!state.synchronized) this.#repairs = state.repairs;
    const requests = !state.synchronized
      ? emptyThreadView.requests
      : requestChanged
        ? this.#view.requests.filter((request) =>
            pending?.some(
              ({ id, revision }) =>
                id === request.id && revision === this.#reviewedRevisions.get(id),
            ),
          )
        : this.#view.requests;
    if (
      entries !== this.#view.entries ||
      requests !== this.#view.requests ||
      runQueue !== this.#view.runQueue ||
      hasMore !== this.#view.hasMore ||
      hasNewer !== this.#view.hasNewer ||
      moreRequests !== this.#view.moreRequests ||
      moreTools !== this.#view.moreTools ||
      moreNodes !== this.#view.moreNodes ||
      requestChanged ||
      state.generation !== this.#view.generation ||
      state.repairs !== this.#view.repairs ||
      inputQueueError !== this.#view.inputQueueError ||
      inputQueue !== this.#view.inputQueue ||
      state.synchronized !== this.#view.synchronized
    ) {
      this.#publish({
        entries,
        requests,
        runQueue,
        inputQueue,
        hasMore,
        hasNewer,
        moreRequests,
        moreTools,
        moreNodes,
        pendingRequestIds:
          requestChanged || !state.synchronized
            ? (pending?.map(({ id }) => id) ?? [])
            : (this.#view.pendingRequestIds ?? []),
        generation: state.generation,
        repairs: state.repairs,
        inputQueueError,
        synchronized: state.synchronized,
      });
    }
  }

  /** The scope is subscribed and its cut current: reads may run and install. */
  readonly #observed = () => {
    const controller = this.#detail.controller;
    return (
      controller !== undefined &&
      !controller.signal.aborted &&
      this.#detail.transcript.getSnapshot().synchronized
    );
  };

  /** Reads the full Requests behind the pending summaries this cut holds. */
  async #readRequests(read: FencedRead) {
    const state = this.#detail.transcript.getSnapshot();
    const pending = state.snapshot?.pendingRequests ?? [];
    const { threadId } = this.#detail.scope;
    const held = new Map(this.#view.requests.map((request) => [request.id, request]));
    const missing = pending.filter(
      ({ id, revision }) => !held.has(id) || revision !== this.#reviewedRevisions.get(id),
    );
    if (!missing.length) return;
    const reads = [];
    for (let i = 0; i < missing.length; i += 20) {
      const review = missing.slice(i, i + 20).map(({ id, revision }) => ({ id, revision }));
      reads.push(
        this.#rpc
          ["thread.requests.list"]({ threadId, review }, { signal: read.signal })
          .then((result) => ({ review, result })),
      );
    }
    const results = await Promise.all(reads);
    if (!read.current()) return;
    const requests = new Map<string, Request & { reviewedRevision?: string | undefined }>(
      this.#view.requests.map((request) => [request.id, request]),
    );
    for (const { review, result } of results) {
      if (!result.ok || result.data.threadId !== threadId) continue;
      for (const request of result.data.requests)
        if (
          request.status === "pending" &&
          request.originatingThreadId === threadId &&
          review.some(
            ({ id, revision }) =>
              id === request.id && result.data.reviewedRevisions?.[id] === revision,
          )
        )
          requests.set(request.id, {
            ...request,
            reviewedRevision: result.data.reviewedRevisions?.[request.id],
          });
    }
    this.#reviewedRevisions.clear();
    const reviewed = pending.flatMap(({ id, revision }) => {
      const request = requests.get(id);
      if (request?.reviewedRevision !== revision) return [];
      this.#reviewedRevisions.set(id, revision);
      return [request];
    });
    this.#publish({ ...this.#view, requests: reviewed });
    // What could not be read is read again, backing off, while this cut stands.
    const failed = results.find(({ result }) => !result.ok)?.result;
    if (failed && !failed.ok) unwrapRpcResult(failed);
  }

  /** The waiting messages; reads the tail once when the cut had no room for some. */
  async queue(): Promise<PersonalInputQueue> {
    const state = this.#detail.transcript.getSnapshot();
    if (state.synchronized && state.inputQueue && !missingQueueEntries(state))
      return state.inputQueue;
    if (!this.#observed()) throw new Error("This conversation is syncing.");
    await this.#reads.request("queue", (read) => this.#readQueue(read), {
      observed: this.#observed,
    });
    const now = this.#detail.transcript.getSnapshot();
    if (!now.inputQueue) throw new Error("The conversation changed while reading its queue.");
    return now.inputQueue;
  }

  async #readQueue(read: FencedRead) {
    const cut = queueCut(this.#detail.transcript.getSnapshot());
    try {
      const queue = unwrapRpcResult(
        await this.#rpc["thread.inputQueue.get"](
          { threadId: this.#detail.scope.threadId },
          { signal: read.signal },
        ),
      );
      if (!read.current()) return;
      if (queue.threadId !== this.#detail.scope.threadId)
        throw new Error("The Host returned a misaddressed input queue.");
      const state = this.#detail.transcript.getSnapshot();
      this.#queueFailure = undefined;
      this.#queueFilled = cut;
      this.#detail.transcript.installQueueEntries(queue.items, state.generation);
    } catch (error) {
      if (read.current() && !classifyClientFailure(error).retryable) {
        this.#queueFailure = { cut, error };
        this.#update();
      }
      throw error;
    }
  }

  /**
   * A repair replaced the scope with the Host's cut. What the reader had read on top of it is
   * read again: around its anchor (or the latest at the tail), and the overlay pages the person
   * had loaded. A history read already in flight runs again in the new cut instead, so a newer
   * jump is never replaced by this reread. The queue and Requests reread by themselves.
   */
  #afterRepair() {
    const state = this.#detail.transcript.getSnapshot();
    const anchor = this.#detail.anchor;
    if (
      !this.#reads.busy("history") &&
      (anchor !== undefined ? !state.items.has(anchor) : !state.newest)
    )
      void this.#reads
        .request("history", (read) => this.#readHistory(read, { mode: "anchor" }), {
          observed: this.#observed,
        })
        .catch(() => undefined);
    for (const [kind, depth] of this.#overlayDepth)
      if (depth > 0) void this.#requestOverlays(kind, true).catch(() => undefined);
  }

  /** The row the reader is looking at as they scroll: none at the tail. */
  setAnchor(itemId: string | undefined) {
    this.#detail.anchorTo(itemId, true);
  }

  /**
   * Reads history for the reader. A newer request supersedes one in flight; one overtaken by a
   * repair runs again in the new cut, so a jump lands even when a repair arrived first.
   */
  history(mode: "earlier" | "newer" | "around" | "latest", aroundMessageId?: string) {
    if (this.#disposed) return Promise.resolve();
    // The person waits on this read: a failure is theirs to see and retry. One asked for while the
    // scope resubscribes waits for its cut rather than finding nothing, so a valid link still lands.
    return this.#reads.request(
      "history",
      async (read) => {
        if (!this.#ready() && (!(await this.#untilObserved(read.signal)) || !read.current()))
          return;
        await this.#readHistory(read, { mode, aroundMessageId });
      },
      { observed: () => !this.#disposed, retry: false },
    );
  }

  #ready() {
    return this.#observed() && this.#detail.transcript.getSnapshot().snapshot !== null;
  }

  /** Resolves once the scope is subscribed and its cut current; false when the read ended first. */
  #untilObserved(signal: AbortSignal) {
    return new Promise<boolean>((resolve) => {
      const check = () => {
        if (signal.aborted) finish(false);
        else if (this.#ready()) finish(true);
      };
      const finish = (observed: boolean) => {
        unsubscribe();
        signal.removeEventListener("abort", check);
        resolve(observed);
      };
      const unsubscribe = this.#detail.transcript.subscribe(check);
      signal.addEventListener("abort", check);
      check();
    });
  }

  async #readHistory(
    read: FencedRead,
    intent: {
      readonly mode: "earlier" | "newer" | "around" | "latest" | "anchor";
      readonly aroundMessageId?: string | undefined;
    },
  ) {
    const state = this.#detail.transcript.getSnapshot();
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const { mode, aroundMessageId } = intent;
    const transcript = this.#detail.transcript;
    const token = transcript.beginRead();
    try {
      if (mode === "anchor") {
        const anchor = this.#detail.anchor;
        if (anchor !== undefined && !state.items.has(anchor)) {
          const page = await this.#page(read.signal, null, undefined, anchor);
          // The reader scrolled on to a row this client holds: that is where they are now.
          if (!read.current() || this.#detail.anchor !== anchor) return;
          if (page.kind === "page" && page.items.some(({ id }) => id === anchor)) {
            this.#installPage([page, state.generation, "around", token], undefined);
            return;
          }
          // The Host no longer has the reader's row: the reader follows the latest messages.
          this.#detail.anchorTo(undefined);
        }
        if (this.#detail.anchor !== undefined || transcript.getSnapshot().newest) return;
        const latest = await this.#page(read.signal, null);
        if (read.current() && latest.kind === "page")
          this.#installPage([latest, state.generation, "latest", token], undefined);
        return;
      }
      const before = mode === "earlier" ? snapshot.nextBefore : null;
      const after = mode === "newer" ? snapshot.nextAfter : null;
      if ((mode === "earlier" && !before) || (mode === "newer" && !after)) return;
      const page = await this.#page(
        read.signal,
        before ?? null,
        aroundMessageId,
        undefined,
        after ?? undefined,
      );
      if (!read.current()) return;
      if (page.kind === "page") {
        if (
          aroundMessageId &&
          !page.items.some((item) => item.kind === "message" && item.messageId === aroundMessageId)
        )
          throw new HostClientRequestError({
            code: "not_found",
            message: "The requested message is unavailable.",
            status: 404,
          });
        this.#installPage([page, state.generation, mode, token], aroundMessageId);
        return;
      }
      const anchor = this.#detail.anchor ?? before?.beforeId ?? after?.beforeId;
      let reset = await this.#page(read.signal, null, aroundMessageId, anchor);
      if (!read.current()) return;
      if (anchor && (reset.kind !== "page" || !reset.items.some(({ id }) => id === anchor))) {
        if (
          !(reset.kind === "history-reset" && reset.anchorUnavailable) &&
          transcript.getSnapshot().items.has(anchor)
        )
          throw new Error("The history anchor is unavailable.");
        this.#detail.anchorTo(undefined);
        reset = await this.#page(read.signal, null, aroundMessageId);
      }
      if (read.current() && reset.kind === "page")
        this.#installPage(
          [
            reset,
            state.generation,
            aroundMessageId || (anchor && reset.items.some(({ id }) => id === anchor))
              ? "around"
              : "latest",
            token,
          ],
          aroundMessageId,
        );
    } finally {
      transcript.endRead(token);
    }
  }

  #installPage(
    args: Parameters<ThreadTranscriptStore["installPage"]>,
    aroundMessageId: string | undefined,
  ) {
    if (!this.#detail.transcript.installPage(...args)) return;
    const state = this.#detail.transcript.getSnapshot();
    for (const item of args[0].items) {
      const current = state.items.get(item.id);
      if (finalizedItemText(current)) this.#detail.text.finishItem(item.id);
    }
    // The scope's anchor is where the reader is: none back at the latest, the linked message after a
    // jump. Paging keeps it: the reader still looks at the row they scrolled to.
    if (args[2] === "latest" && state.newest) this.#detail.anchorTo(undefined);
    else if (aroundMessageId) {
      const target = args[0].items.find(
        (item) => item.kind === "message" && item.messageId === aroundMessageId,
      );
      if (target) this.#detail.anchorTo(target.id);
    }
  }

  async #page(
    signal: AbortSignal,
    before: TranscriptOrderCursor | null,
    aroundMessageId?: string,
    anchorItemId?: string,
    after?: TranscriptOrderCursor,
  ) {
    const scope = this.#detail.scope;
    const query = {
      threadId: scope.threadId,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ...(aroundMessageId ? { aroundMessageId: MessageIdSchema.parse(aroundMessageId) } : {}),
      ...(anchorItemId ? { anchorItemId } : {}),
    };
    const result =
      scope.kind === "node"
        ? await this.#rpc["node.items.page"]({ ...query, nodeId: scope.nodeId }, { signal })
        : await this.#rpc["thread.items.page"](query, { signal });
    const page = unwrapRpcResult(result);
    if (page.kind === "page") {
      const nodeId = scope.kind === "node" ? scope.nodeId : null;
      const expected =
        before ??
        after ??
        this.#detail.transcript.getSnapshot().snapshot?.nextBefore ??
        this.#detail.transcript.getSnapshot().snapshot?.nextAfter;
      const boundaries = [
        [page.nextBefore, page.items[0]],
        [page.nextAfter, page.items.at(-1)],
      ] as const;
      if (
        page.threadId !== scope.threadId ||
        page.nodeId !== nodeId ||
        page.items.some((item, i) => {
          const prior = page.items[i - 1];
          return (
            item.nodeId !== nodeId ||
            BigInt(item.revision) > BigInt(page.revision) ||
            (prior &&
              (BigInt(prior.position) > BigInt(item.position) ||
                (prior.position === item.position && prior.id >= item.id)))
          );
        }) ||
        new Set(page.items.map(({ id }) => id)).size !== page.items.length ||
        boundaries.some(
          ([cursor, item]) =>
            cursor &&
            (!item ||
              cursor.threadId !== scope.threadId ||
              cursor.nodeId !== nodeId ||
              cursor.beforeId !== item.id ||
              cursor.beforePosition !== item.position ||
              (expected &&
                (cursor.viewerId !== expected.viewerId ||
                  cursor.epoch !== expected.epoch ||
                  cursor.deploymentId !== expected.deploymentId))),
        )
      )
        throw new Error("The Host returned a history page for the wrong scope or cut.");
    }
    return page;
  }

  /** Loads one more page of `kind`; a repair reads the pages loaded so far again. */
  async loadMoreOverlays(kind: Overlay): Promise<void> {
    const state = this.#detail.transcript.getSnapshot();
    if (!this.#observed() || !state.snapshot?.overlayCursors?.[kind]) return;
    const loaded = this.#overlayLoaded.get(kind);
    const pages = loaded?.epoch === readEpoch(state) ? loaded.pages : 0;
    this.#overlayDepth.set(kind, Math.max(this.#overlayDepth.get(kind) ?? 0, pages + 1));
    await this.#requestOverlays(kind, false);
  }

  #requestOverlays(kind: Overlay, retry: boolean) {
    return this.#reads.request(`overlay:${kind}`, (read) => this.#readOverlays(read, kind), {
      observed: this.#observed,
      retry,
    });
  }

  /** Reads `kind`'s pages past the cut until the depth the person loaded, or the end. */
  async #readOverlays(read: FencedRead, kind: Overlay) {
    const { scope } = this.#detail;
    const nodeId = scope.kind === "node" ? scope.nodeId : null;
    const epoch = readEpoch(this.#detail.transcript.getSnapshot());
    for (;;) {
      const state = this.#detail.transcript.getSnapshot();
      const loaded = this.#overlayLoaded.get(kind);
      const pages = loaded?.epoch === epoch ? loaded.pages : 0;
      const cursor = state.snapshot?.overlayCursors?.[kind];
      if (!cursor || pages >= (this.#overlayDepth.get(kind) ?? 0)) return;
      const token = this.#detail.transcript.beginRead();
      try {
        const result = await this.#rpc["thread.overlays.page"](
          { threadId: scope.threadId, ...(nodeId ? { nodeId } : {}), kind, cursor },
          { signal: read.signal },
        );
        if (!read.current()) return;
        const page = unwrapRpcResult(result);
        if (
          page.threadId !== scope.threadId ||
          page.nodeId !== nodeId ||
          page.kind !== kind ||
          page.entries.some(
            (entry) =>
              BigInt(entry.revision) > BigInt(page.revision) ||
              (kind === "requests"
                ? "position" in entry ||
                  entry.threadId !== scope.threadId ||
                  entry.status !== "pending"
                : !("position" in entry) ||
                  entry.nodeId !== nodeId ||
                  entry.kind !== (kind === "tools" ? "tool" : "node")),
          ) ||
          (page.next !== null && (page.next === cursor || page.entries.length === 0))
        )
          throw new Error("The Host returned an overlay page for the wrong scope or cut.");
        if (!this.#detail.transcript.installOverlays(kind, page, state.generation, token)) return;
        this.#overlayLoaded.set(kind, { epoch, pages: pages + 1 });
      } finally {
        this.#detail.transcript.endRead(token);
      }
    }
  }

  #bodyKey(itemId: string, generation = this.#detail.transcript.getSnapshot().generation) {
    return transcriptBodyKey(this.#detail.scope, generation, itemId);
  }

  async body(itemId: string) {
    const { scope, controller } = this.#detail;
    const state = this.#detail.transcript.getSnapshot();
    const item = state.items.get(itemId);
    if (!controller || !state.synchronized || !item) return;
    const key = this.#bodyKey(itemId);
    const cached = this.#bodies.get(key, item.revision);
    if (cached) return cached;
    const value = unwrapRpcResult(
      await this.#rpc["transcript.item.get"](
        {
          threadId: scope.threadId,
          ...(scope.kind === "node" ? { nodeId: scope.nodeId } : {}),
          itemId,
          expectedRevision: item.revision,
        },
        { signal: controller.signal },
      ),
    );
    const current = this.#detail.transcript.getSnapshot();
    if (
      controller.signal.aborted ||
      state.generation !== current.generation ||
      current.items.get(itemId) !== item ||
      value.threadId !== scope.threadId ||
      value.nodeId !== item.nodeId ||
      value.item.id !== itemId ||
      value.item.revision !== item.revision ||
      value.item.kind !== item.kind ||
      value.item.nodeId !== item.nodeId ||
      value.item.runId !== item.runId ||
      value.item.attemptId !== item.attemptId ||
      !(value.body === null ? value.truncated : matchesBody(item, value.body)) ||
      (value.body?.kind === "message" && value.body.message.threadId !== scope.threadId)
    )
      return;
    this.#bodies.put(key, value);
    return value;
  }
}

/** A detail's read epoch: a new subscription or a repair starts a new one. */
function readEpoch(state: TranscriptState) {
  return `${state.generation}:${state.repairs}`;
}

function queueCut(state: TranscriptState) {
  return `${state.generation}:${state.repairs}:${state.snapshot?.queue?.revision ?? ""}`;
}

function missingQueueEntries(state: TranscriptState) {
  const inputs = state.snapshot?.queue?.inputs;
  return !!inputs && inputs.some((id) => !state.queueEntries.has(id));
}

function matchesBody(item: TranscriptItem, body: NonNullable<TranscriptItemResult["body"]>) {
  switch (item.kind) {
    case "message":
      return body.kind === "message" && body.message.id === item.messageId;
    case "node-message":
    case "reasoning":
      return body.kind === "text";
    case "node":
      return body.kind === "node" && body.node.id === item.executionNodeId;
    case "tool":
      return body.kind === "tool";
    case "run":
      return body.kind === "run" && body.run.id === item.runId;
    case "assignment":
      return body.kind === "assignment" && body.assignment.id === item.delegationId;
    case "place":
      return body.kind === "place";
    case "request":
    case "app":
      return false;
  }
}

export function transcriptBodyKey(
  scope: ObservedDetail["scope"],
  generation: number,
  itemId: string,
) {
  return JSON.stringify([
    scope.threadId,
    scope.kind === "node" ? scope.nodeId : null,
    generation,
    itemId,
  ]);
}
