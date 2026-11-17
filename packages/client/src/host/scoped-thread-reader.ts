import {
  utf8ByteLength,
  type Request,
  MessageIdSchema,
  type ThreadInputQueue,
} from "@opensteer/core";
import type { HostApiClient } from "@opensteer/protocol";
import type {
  TranscriptItem,
  TranscriptItemResult,
  TranscriptOrderCursor,
} from "@opensteer/protocol/transcript";
import type { RunQueueEntry, TranscriptEntry } from "./client.js";
import { unwrapRpcResult } from "./host-session-client.js";
import type { ObservedDetail } from "./scoped-personal-stream.js";
import { transcriptCard } from "./transcript-item-view.js";
import type { VersionedInputQueue } from "./thread-transcript-store.js";

export interface ThreadViewState {
  readonly entries: readonly TranscriptEntry[];
  readonly requests: readonly Request[];
  readonly runQueue: readonly RunQueueEntry[];
  readonly inputQueue: ThreadInputQueue | null;
  readonly synchronized: boolean;
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
type OverlayRead = Awaited<ReturnType<HostApiClient["thread.overlays.page"]>>;
type OverlayPage = Extract<OverlayRead, { ok: true }>["data"];
type RequestSummaries = NonNullable<
  ReturnType<ObservedDetail["transcript"]["getSnapshot"]>["snapshot"]
>["pendingRequests"];

export class TranscriptBodies {
  readonly #entries = new Map<string, { value: TranscriptItemResult; size: number }>();
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
  }

  remove(key: string) {
    this.#bytes -= this.#entries.get(key)?.size ?? 0;
    this.#entries.delete(key);
  }

  clear() {
    this.#entries.clear();
    this.#bytes = 0;
  }
}

export class ScopedThreadReader implements ThreadViewSource {
  readonly #detail: ObservedDetail;
  readonly #rpc: HostApiClient;
  readonly #bodies: TranscriptBodies;
  readonly #release: () => void;
  readonly #listeners = new Set<() => void>();
  readonly #cards = new WeakMap<TranscriptItem, TranscriptEntry | undefined>();
  readonly #overlayReads = new Map<Overlay, number>();
  #queue: { generation: number; promise: Promise<ThreadInputQueue> } | undefined;
  #requestCut: RequestSummaries | undefined;
  readonly #reviewedRevisions = new Map<string, string>();
  #historyRead = 0;
  #rows: ReadonlyMap<string, TranscriptItem> | undefined;
  #liveRows: ReadonlyMap<string, TranscriptItem> | undefined;
  #queueRows: unknown;
  #requestGeneration = 0;
  #view: ThreadViewState = emptyThreadView;

  constructor(detail: ObservedDetail, rpc: HostApiClient, bodies: TranscriptBodies, listen = true) {
    this.#detail = detail;
    this.#rpc = rpc;
    this.#bodies = bodies;
    this.#release = listen ? detail.transcript.subscribe(() => this.#update()) : () => {};
    if (listen) this.#update();
  }

  getSnapshot = () => this.#view;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  dispose() {
    this.#release();
    this.#listeners.clear();
  }

  #publish(view: ThreadViewState) {
    this.#view = view;
    for (const listener of this.#listeners) listener();
  }

  #update() {
    const state = this.#detail.transcript.getSnapshot();
    let entries = this.#view.entries;
    if (this.#rows !== state.items || this.#liveRows !== state.liveItems) {
      for (const [id, item] of this.#rows ?? [])
        if (state.items.get(id) !== item) this.#bodies.remove(this.#bodyKey(id));
      this.#rows = state.items;
      this.#liveRows = state.liveItems;
      entries = [...state.ids, ...state.liveItems.keys()].flatMap((id) => {
        const item = state.items.get(id) ?? state.liveItems.get(id);
        if (!item) return [];
        if (!this.#cards.has(item)) this.#cards.set(item, transcriptCard(item));
        return this.#cards.get(item) ?? [];
      });
    }
    const queue = state.snapshot?.queue;
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
    const inputQueue = state.synchronized ? state.inputQueue : null;
    const hasMore = state.snapshot?.nextBefore != null;
    const hasNewer = state.snapshot?.nextAfter != null;
    const moreRequests = state.snapshot?.overlayCursors?.requests != null;
    const pending = state.snapshot?.pendingRequests;
    const requestChanged =
      pending !== this.#requestCut ||
      (state.synchronized && this.#requestGeneration !== state.generation);
    if (requestChanged) {
      this.#requestCut = pending;
      if (this.#requestGeneration !== state.generation || !state.synchronized)
        this.#reviewedRevisions.clear();
      if (state.synchronized) this.#requestGeneration = state.generation;
      if (state.synchronized && pending?.length)
        void this.#readRequests(pending, state.generation).catch(() => undefined);
    }
    if (
      state.synchronized &&
      this.#detail.scope.kind === "thread" &&
      this.#detail.controller &&
      !state.inputQueue &&
      this.#queue?.generation !== state.generation
    )
      void this.queue().catch(() => undefined);
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
        synchronized: state.synchronized,
      });
    }
  }

  async #readRequests(pending: RequestSummaries, generation: number) {
    const signal = this.#detail.controller?.signal;
    if (!signal) return;
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
        this.#rpc["thread.requests.list"]({ threadId, review }, { signal }).then((result) => ({
          review,
          result,
        })),
      );
    }
    const results = await Promise.all(reads);
    const state = this.#detail.transcript.getSnapshot();
    if (
      signal.aborted ||
      state.generation !== generation ||
      state.snapshot?.pendingRequests !== pending
    )
      return;
    const requests = new Map(this.#view.requests.map((request) => [request.id, request]));
    for (const { review, result } of results) {
      if (!result.ok) continue;
      for (const request of result.data.requests)
        if (
          request.status === "pending" &&
          request.originatingThreadId === threadId &&
          review.some(({ id }) => id === request.id)
        )
          requests.set(request.id, request);
    }
    this.#reviewedRevisions.clear();
    const reviewed = pending.flatMap(({ id, revision }) => {
      const request = requests.get(id);
      if (!request) return [];
      this.#reviewedRevisions.set(id, revision);
      return [request];
    });
    this.#publish({
      ...this.#view,
      requests: reviewed,
    });
  }

  queue() {
    const state = this.#detail.transcript.getSnapshot();
    const existing = this.#queue;
    if (existing?.generation === state.generation) return existing.promise;
    const signal = this.#detail.controller?.signal;
    if (!signal || !state.synchronized)
      return Promise.reject(new Error("This conversation is syncing."));
    const promise = this.#readQueue(state.generation, signal).finally(() => {
      if (this.#queue?.promise === promise) this.#queue = undefined;
    });
    this.#queue = { generation: state.generation, promise };
    return promise;
  }

  async #readQueue(generation: number, signal: AbortSignal): Promise<VersionedInputQueue> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const expectedRevision = this.#detail.transcript.getSnapshot().inputQueueRevision;
      const result = await this.#rpc["thread.inputQueue.get"](
        { threadId: this.#detail.scope.threadId, expectedRevision },
        { signal },
      );
      if (
        !result.ok &&
        result.error.code === "conflict" &&
        !signal.aborted &&
        BigInt(this.#detail.transcript.getSnapshot().inputQueueRevision) > BigInt(expectedRevision)
      )
        continue;
      const queue = unwrapRpcResult(result);
      const current = this.#detail.transcript.getSnapshot();
      if (
        signal.aborted ||
        current.generation !== generation ||
        queue.threadId !== this.#detail.scope.threadId
      )
        throw new Error("The conversation changed while reading its queue.");
      if (queue.revision === undefined)
        throw new Error("The Host omitted the input queue revision.");
      const versioned = { ...queue, revision: queue.revision };
      if (this.#detail.transcript.installQueue(versioned, generation)) return versioned;
      if (current.inputQueue) return current.inputQueue;
      if (current.inputQueueRevision === expectedRevision) break;
    }
    throw new Error("The input queue changed while it was loading.");
  }

  setAnchor(itemId: string | undefined) {
    if (itemId === undefined) delete this.#detail.anchor;
    else this.#detail.anchor = itemId;
  }

  async history(mode: "earlier" | "newer" | "around" | "latest", aroundMessageId?: string) {
    const state = this.#detail.transcript.getSnapshot();
    const { generation, snapshot } = state;
    const signal = this.#detail.controller?.signal;
    if (!signal || !state.synchronized || !snapshot) return;
    const before = mode === "earlier" ? snapshot.nextBefore : null;
    const after = mode === "newer" ? snapshot.nextAfter : null;
    if ((mode === "earlier" && !before) || (mode === "newer" && !after)) return;
    const read = ++this.#historyRead;
    const current = () =>
      !signal.aborted &&
      read === this.#historyRead &&
      generation === this.#detail.transcript.getSnapshot().generation;
    const page = await this.#page(signal, before, aroundMessageId, undefined, after ?? undefined);
    if (!current()) return;
    if (page.kind === "page") {
      if (
        aroundMessageId &&
        !page.items.some((item) => item.kind === "message" && item.messageId === aroundMessageId)
      )
        throw new Error("The requested message is unavailable.");
      this.#detail.transcript.installPage(page, generation, mode);
      return;
    }
    const anchor = this.#detail.anchor ?? before?.beforeId ?? after?.beforeId;
    const reset = await this.#page(signal, null, aroundMessageId, anchor);
    if (anchor && reset.kind === "page" && !reset.items.some(({ id }) => id === anchor))
      throw new Error("The history anchor is unavailable.");
    if (current() && reset.kind === "page")
      this.#detail.transcript.installPage(
        reset,
        generation,
        anchor || aroundMessageId ? "around" : "latest",
      );
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
    return unwrapRpcResult(result);
  }

  async loadMoreOverlays(kind: Overlay): Promise<OverlayPage | undefined> {
    const { scope, controller } = this.#detail;
    const state = this.#detail.transcript.getSnapshot();
    const cursor = state.snapshot?.overlayCursors?.[kind];
    if (!controller || !state.synchronized || !cursor) return;
    const read = (this.#overlayReads.get(kind) ?? 0) + 1;
    this.#overlayReads.set(kind, read);
    const page = unwrapRpcResult(
      await this.#rpc["thread.overlays.page"](
        {
          threadId: scope.threadId,
          ...(scope.kind === "node" ? { nodeId: scope.nodeId } : {}),
          kind,
          ...(cursor ? { cursor } : {}),
        },
        { signal: controller.signal },
      ),
    );
    const current = this.#detail.transcript.getSnapshot();
    if (
      controller.signal.aborted ||
      read !== this.#overlayReads.get(kind) ||
      current.generation !== state.generation ||
      current.through === null ||
      BigInt(page.revision) < BigInt(current.through)
    )
      return;
    this.#detail.transcript.installOverlays(kind, page, state.generation);
    return page;
  }

  #bodyKey(itemId: string) {
    const scope = this.#detail.scope;
    return JSON.stringify([scope.threadId, scope.kind === "node" ? scope.nodeId : null, itemId]);
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
      value.item.id !== itemId ||
      value.item.revision !== item.revision
    )
      return;
    this.#bodies.put(key, value);
    return value;
  }
}
