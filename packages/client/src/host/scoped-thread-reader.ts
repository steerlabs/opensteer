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
  readonly generation?: number;
  readonly pendingRequestIds?: readonly string[];
  readonly requestsRefreshing?: boolean;
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
type OverlayRead = Awaited<ReturnType<HostApiClient["thread.overlays.page"]>>;
type OverlayPage = Extract<OverlayRead, { ok: true }>["data"];
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
  readonly #overlayReads = new Map<Overlay, number>();
  #queue: { generation: number; promise: Promise<ThreadInputQueue> } | undefined;
  #queueFailure: { generation: number; revision: string; error: unknown } | undefined;
  #requestCut: RequestSummaries | undefined;
  readonly #reviewedRevisions = new Map<string, string>();
  #historyRead = 0;
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
      entries = [...state.ids, ...state.liveItems.keys()].flatMap((id) => {
        const item = state.items.get(id) ?? state.liveItems.get(id);
        if (!item) return [];
        if (!this.#cards.has(item)) this.#cards.set(item, transcriptCard(item));
        return this.#cards.get(item) ?? [];
      });
    }
    const queue =
      state.synchronized && !state.stale.has("run-queue") ? state.snapshot?.queue : undefined;
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
    const moreRequests =
      state.synchronized &&
      !state.stale.has("requests") &&
      state.snapshot?.overlayCursors?.requests != null;
    const moreTools =
      state.synchronized &&
      !state.stale.has("tools") &&
      state.snapshot?.overlayCursors?.tools != null;
    const moreNodes =
      state.synchronized &&
      !state.stale.has("nodes") &&
      state.snapshot?.overlayCursors?.nodes != null;
    const pending = state.stale.has("requests") ? undefined : state.snapshot?.pendingRequests;
    const inputQueueError =
      this.#queueFailure?.generation === state.generation &&
      this.#queueFailure.revision === state.inputQueueRevision
        ? this.#queueFailure.error
        : undefined;
    if (state.synchronized) {
      for (const kind of ["requests", "tools", "nodes"] as const)
        if (state.stale.has(kind) && !this.#overlayReads.has(kind))
          void this.#readOverlays(kind, true).catch(() => undefined);
    }
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
      inputQueueError === undefined &&
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
      moreTools !== this.#view.moreTools ||
      moreNodes !== this.#view.moreNodes ||
      requestChanged ||
      state.stale.has("requests") !== this.#view.requestsRefreshing ||
      state.generation !== this.#view.generation ||
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
        requestsRefreshing: state.stale.has("requests"),
        generation: state.generation,
        inputQueueError,
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
      state.stale.has("requests") ||
      state.snapshot?.pendingRequests !== pending
    )
      return;
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
      if (this.#queue?.promise === promise) {
        this.#queue = undefined;
        this.#update();
      }
    });
    this.#queue = { generation: state.generation, promise };
    return promise;
  }

  async #readQueue(generation: number, signal: AbortSignal): Promise<VersionedInputQueue> {
    for (;;) {
      const expectedRevision = this.#detail.transcript.getSnapshot().inputQueueRevision;
      try {
        const result = await this.#rpc["thread.inputQueue.get"](
          { threadId: this.#detail.scope.threadId, expectedRevision },
          { signal },
        );
        const current = this.#detail.transcript.getSnapshot();
        if (signal.aborted || current.generation !== generation)
          throw new Error("The conversation changed while reading its queue.");
        if (current.inputQueueRevision !== expectedRevision) continue;
        const queue = unwrapRpcResult(result);
        if (
          queue.threadId !== this.#detail.scope.threadId ||
          queue.revision === undefined ||
          BigInt(queue.revision) < BigInt(expectedRevision)
        )
          throw new Error("The Host returned a stale or misaddressed input queue.");
        const versioned = { ...queue, revision: queue.revision };
        this.#queueFailure = undefined;
        if (this.#detail.transcript.installQueue(versioned, generation)) return versioned;
        if (current.inputQueue) return current.inputQueue;
        throw new Error("The input queue changed while it was loading.");
      } catch (error) {
        if (!signal.aborted && this.#detail.transcript.getSnapshot().generation === generation)
          this.#queueFailure = { generation, revision: expectedRevision, error };
        throw error;
      }
    }
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
    let reset = await this.#page(signal, null, aroundMessageId, anchor);
    if (!current()) return;
    if (anchor && (reset.kind !== "page" || !reset.items.some(({ id }) => id === anchor))) {
      if (
        !(reset.kind === "history-reset" && reset.anchorUnavailable) &&
        this.#detail.transcript.getSnapshot().items.has(anchor)
      )
        throw new Error("The history anchor is unavailable.");
      delete this.#detail.anchor;
      reset = await this.#page(signal, null, aroundMessageId);
    }
    if (current() && reset.kind === "page")
      this.#detail.transcript.installPage(
        reset,
        generation,
        aroundMessageId || (anchor && reset.items.some(({ id }) => id === anchor))
          ? "around"
          : "latest",
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
        BigInt(page.orderRevision) > BigInt(page.revision) ||
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
              cursor.orderRevision !== page.orderRevision ||
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

  loadMoreOverlays(kind: Overlay): Promise<OverlayPage | undefined> {
    return this.#readOverlays(kind, false);
  }

  async #readOverlays(kind: Overlay, refresh: boolean): Promise<OverlayPage | undefined> {
    const { scope, controller } = this.#detail;
    const state = this.#detail.transcript.getSnapshot();
    let cursor = refresh ? undefined : state.snapshot?.overlayCursors?.[kind];
    if (
      !controller ||
      !state.synchronized ||
      (!refresh && (!cursor || state.stale.has(kind))) ||
      this.#overlayReads.has(kind)
    )
      return;
    const expectedRevision = state.overlayRevisions.get(kind);
    this.#overlayReads.set(kind, state.generation);
    const nodeId = scope.kind === "node" ? scope.nodeId : null;
    const entries: OverlayPage["entries"] = [];
    const desired = refresh
      ? Math.max(
          20,
          kind === "requests"
            ? (state.snapshot?.pendingRequests.length ?? 0)
            : [...state.activeIds].filter(
                (id) => state.items.get(id)?.kind === (kind === "nodes" ? "node" : "tool"),
              ).length,
        )
      : 20;
    let page: OverlayPage | undefined;
    try {
      do {
        const result = await this.#rpc["thread.overlays.page"](
          {
            threadId: scope.threadId,
            ...(nodeId ? { nodeId } : {}),
            kind,
            ...(cursor ? { cursor } : {}),
            ...(expectedRevision ? { expectedRevision } : {}),
          },
          { signal: controller.signal },
        );
        const current = this.#detail.transcript.getSnapshot();
        if (
          controller.signal.aborted ||
          current.generation !== state.generation ||
          current.overlayRevisions.get(kind) !== expectedRevision
        )
          return;
        const next = unwrapRpcResult(result);
        if (
          next.threadId !== scope.threadId ||
          next.nodeId !== nodeId ||
          next.kind !== kind ||
          (page && next.revision !== page.revision) ||
          (expectedRevision && BigInt(next.revision) < BigInt(expectedRevision)) ||
          next.entries.some(
            (entry) =>
              BigInt(entry.revision) > BigInt(next.revision) ||
              (kind === "requests"
                ? "position" in entry ||
                  entry.threadId !== scope.threadId ||
                  entry.status !== "pending"
                : !("position" in entry) ||
                  entry.nodeId !== nodeId ||
                  entry.kind !== (kind === "tools" ? "tool" : "node")),
          ) ||
          (next.next !== null && (next.next === cursor || next.entries.length === 0))
        )
          throw new Error("The Host returned an overlay page for the wrong scope or cut.");
        entries.push(...next.entries);
        page = next;
        cursor = page.next ?? undefined;
      } while (cursor && entries.length < desired && refresh);
      const combined = { ...page, entries };
      return this.#detail.transcript.installOverlays(kind, combined, state.generation, refresh)
        ? combined
        : undefined;
    } finally {
      if (this.#overlayReads.get(kind) === state.generation) {
        this.#overlayReads.delete(kind);
        const current = this.#detail.transcript.getSnapshot();
        if (current.overlayRevisions.get(kind) !== expectedRevision) this.#update();
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
      !matchesBody(item, value.body) ||
      (value.body.kind === "message" && value.body.message.threadId !== scope.threadId)
    )
      return;
    this.#bodies.put(key, value);
    return value;
  }
}

function matchesBody(item: TranscriptItem, body: TranscriptItemResult["body"]) {
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
    default:
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
