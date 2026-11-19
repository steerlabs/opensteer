import { utf8ByteLength, type Request, MessageIdSchema } from "@opensteer/core";
import type { HostApiClient, PersonalInputQueue } from "@opensteer/protocol";
import type {
  TranscriptItem,
  TranscriptItemResult,
  TranscriptOrderCursor,
} from "@opensteer/protocol/transcript";
import type { RunQueueEntry, TranscriptEntry } from "./client.js";
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
  readonly #liveCards = new WeakMap<TranscriptItem, TranscriptEntry | undefined>();
  readonly #overlayReads = new Map<Overlay, number>();
  #queue:
    | { generation: number; repairs: number; promise: Promise<PersonalInputQueue> }
    | undefined;
  /** Overlay pages the person loaded past the cut, read again after a repair. */
  readonly #overlayPages = new Map<Overlay, number>();
  #overlayGeneration = 0;
  #repairs = 0;
  #queueFailure: { generation: number; revision: string; error: unknown } | undefined;
  #requestCut: RequestSummaries | undefined;
  /** A failed Request read tries again, backing off, while the same pending cut stands. */
  #requestRetry: { timer: ReturnType<typeof setTimeout>; attempt: number } | undefined;
  #requestAttempt = 0;
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
    // Node progress is not merged here: each row reads its own from the item text store.
    const unsubscribe = listen ? detail.transcript.subscribe(() => this.#update()) : undefined;
    this.#release = () => unsubscribe?.();
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
    this.#cancelRequestRetry();
    this.#historyRead++;
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
      this.#queueFailure?.generation === state.generation &&
      this.#queueFailure.revision === state.snapshot?.queue?.revision
        ? this.#queueFailure.error
        : undefined;
    const requestChanged =
      pending !== this.#requestCut ||
      (state.synchronized && this.#requestGeneration !== state.generation);
    if (requestChanged) {
      this.#cancelRequestRetry();
      this.#requestAttempt = 0;
      this.#requestCut = pending;
      if (this.#requestGeneration !== state.generation || !state.synchronized)
        this.#reviewedRevisions.clear();
      if (state.synchronized) this.#requestGeneration = state.generation;
      if (state.synchronized && pending?.length) this.#reviewRequests(pending, state.generation);
    }
    if (
      state.synchronized &&
      this.#detail.scope.kind === "thread" &&
      this.#detail.controller &&
      missingQueueEntries(state) &&
      inputQueueError === undefined &&
      (this.#queue?.generation !== state.generation || this.#queue.repairs !== state.repairs)
    )
      void this.queue().catch(() => undefined);
    if (this.#overlayGeneration !== state.generation) {
      this.#overlayGeneration = state.generation;
      this.#overlayPages.clear();
      this.#repairs = state.repairs;
    }
    if (state.synchronized && state.repairs !== this.#repairs) {
      this.#repairs = state.repairs;
      void this.#afterRepair(state.generation, state.repairs).catch(() => undefined);
    }
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
        inputQueueError,
        synchronized: state.synchronized,
      });
    }
  }

  #reviewRequests(pending: RequestSummaries, generation: number) {
    void this.#readRequests(pending, generation).then(
      (complete) => {
        if (!complete) this.#retryRequests(pending, generation);
      },
      () => this.#retryRequests(pending, generation),
    );
  }

  #retryRequests(pending: RequestSummaries, generation: number) {
    const signal = this.#detail.controller?.signal;
    const state = this.#detail.transcript.getSnapshot();
    if (
      !signal ||
      signal.aborted ||
      this.#requestRetry ||
      state.generation !== generation ||
      state.snapshot?.pendingRequests !== pending
    )
      return;
    const attempt = ++this.#requestAttempt;
    const delay = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    const timer = setTimeout(() => {
      this.#requestRetry = undefined;
      signal.removeEventListener("abort", stop);
      this.#reviewRequests(pending, generation);
    }, delay);
    const stop = () => this.#cancelRequestRetry();
    signal.addEventListener("abort", stop, { once: true });
    this.#requestRetry = { timer, attempt };
  }

  #cancelRequestRetry() {
    if (this.#requestRetry) clearTimeout(this.#requestRetry.timer);
    this.#requestRetry = undefined;
  }

  /** Resolves false when some pending Request could not be read and needs another try. */
  async #readRequests(pending: RequestSummaries, generation: number): Promise<boolean> {
    const signal = this.#detail.controller?.signal;
    if (!signal) return true;
    const { threadId } = this.#detail.scope;
    const held = new Map(this.#view.requests.map((request) => [request.id, request]));
    const missing = pending.filter(
      ({ id, revision }) => !held.has(id) || revision !== this.#reviewedRevisions.get(id),
    );
    if (!missing.length) return true;
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
      return true;
    const failed = results.some(({ result }) => !result.ok);
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
    if (!failed) this.#requestAttempt = 0;
    return !failed;
  }

  /** The waiting messages; reads the Host once when the snapshot had no room for some. */
  queue() {
    const state = this.#detail.transcript.getSnapshot();
    if (state.synchronized && state.inputQueue && !missingQueueEntries(state))
      return Promise.resolve(state.inputQueue);
    const existing = this.#queue;
    if (existing?.generation === state.generation && existing.repairs === state.repairs)
      return existing.promise;
    const signal = this.#detail.controller?.signal;
    if (!signal || !state.synchronized)
      return Promise.reject(new Error("This conversation is syncing."));
    const promise = this.#readQueue(state.generation, signal).finally(() => {
      if (this.#queue?.promise === promise) {
        this.#queue = undefined;
        this.#update();
      }
    });
    this.#queue = { generation: state.generation, repairs: state.repairs, promise };
    return promise;
  }

  async #readQueue(generation: number, signal: AbortSignal): Promise<PersonalInputQueue> {
    const revision = this.#detail.transcript.getSnapshot().snapshot?.queue?.revision ?? "0";
    try {
      const queue = unwrapRpcResult(
        await this.#rpc["thread.inputQueue.get"](
          { threadId: this.#detail.scope.threadId },
          { signal },
        ),
      );
      if (signal.aborted || this.#detail.transcript.getSnapshot().generation !== generation)
        throw new Error("The conversation changed while reading its queue.");
      if (queue.threadId !== this.#detail.scope.threadId)
        throw new Error("The Host returned a misaddressed input queue.");
      this.#queueFailure = undefined;
      this.#detail.transcript.installQueueEntries(queue.items, generation);
      return this.#detail.transcript.getSnapshot().inputQueue ?? queue;
    } catch (error) {
      if (!signal.aborted && this.#detail.transcript.getSnapshot().generation === generation)
        this.#queueFailure = { generation, revision, error };
      throw error;
    }
  }

  /**
   * A repair replaced the scope with the Host's cut. What the reader had read on top of the old
   * state is read again: the page around its anchor, or the latest when it follows the tail, and
   * as many overlay pages as the person had loaded. The queue and Requests reread by themselves.
   */
  async #afterRepair(generation: number, repairs: number) {
    const current = () => {
      const state = this.#detail.transcript.getSnapshot();
      return state.generation === generation && state.repairs === repairs;
    };
    const state = this.#detail.transcript.getSnapshot();
    const anchor = this.#detail.anchor;
    const signal = this.#detail.controller?.signal;
    if (anchor !== undefined && !state.items.has(anchor) && signal) {
      const token = this.#detail.transcript.beginRead();
      try {
        const page = await this.#page(signal, null, undefined, anchor);
        if (!current()) return;
        if (page.kind === "page" && page.items.some(({ id }) => id === anchor))
          this.#installPage([page, generation, "around", token], undefined);
        else this.#detail.anchorTo(undefined);
      } finally {
        this.#detail.transcript.endRead(token);
      }
    }
    if (this.#detail.anchor === undefined && !this.#detail.transcript.getSnapshot().newest)
      await this.history("latest");
    for (const [kind, pages] of this.#overlayPages)
      for (let page = 0; page < pages && current(); page++)
        if ((await this.#loadOverlayPage(kind)) === undefined) break;
  }

  setAnchor(itemId: string | undefined) {
    this.#detail.anchorTo(itemId);
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
    const transcript = this.#detail.transcript;
    const token = transcript.beginRead();
    try {
      await this.#history(mode, signal, generation, read, token, before, after, aroundMessageId);
    } finally {
      transcript.endRead(token);
    }
  }

  async #history(
    mode: "earlier" | "newer" | "around" | "latest",
    signal: AbortSignal,
    generation: number,
    read: number,
    token: number,
    before: TranscriptOrderCursor | null | undefined,
    after: TranscriptOrderCursor | null | undefined,
    aroundMessageId: string | undefined,
  ) {
    const current = () =>
      !signal.aborted &&
      read === this.#historyRead &&
      generation === this.#detail.transcript.getSnapshot().generation;
    const page = await this.#page(
      signal,
      before ?? null,
      aroundMessageId,
      undefined,
      after ?? undefined,
    );
    if (!current()) return;
    if (page.kind === "page") {
      if (
        aroundMessageId &&
        !page.items.some((item) => item.kind === "message" && item.messageId === aroundMessageId)
      )
        throw new Error("The requested message is unavailable.");
      this.#installPage([page, generation, mode, token], aroundMessageId);
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
      this.#detail.anchorTo(undefined);
      reset = await this.#page(signal, null, aroundMessageId);
    }
    if (current() && reset.kind === "page")
      this.#installPage(
        [
          reset,
          generation,
          aroundMessageId || (anchor && reset.items.some(({ id }) => id === anchor))
            ? "around"
            : "latest",
          token,
        ],
        aroundMessageId,
      );
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
    // The scope's anchor is where the reader is: none at the tail, the linked message after a jump.
    if (state.newest) this.#detail.anchorTo(undefined);
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

  async loadMoreOverlays(kind: Overlay): Promise<OverlayPage | undefined> {
    const page = await this.#loadOverlayPage(kind);
    if (page) this.#overlayPages.set(kind, (this.#overlayPages.get(kind) ?? 0) + 1);
    return page;
  }

  async #loadOverlayPage(kind: Overlay): Promise<OverlayPage | undefined> {
    const { scope, controller } = this.#detail;
    const state = this.#detail.transcript.getSnapshot();
    const cursor = state.snapshot?.overlayCursors?.[kind];
    if (!controller || !state.synchronized || !cursor || this.#overlayReads.has(kind)) return;
    this.#overlayReads.set(kind, state.generation);
    const nodeId = scope.kind === "node" ? scope.nodeId : null;
    const token = this.#detail.transcript.beginRead();
    try {
      const result = await this.#rpc["thread.overlays.page"](
        { threadId: scope.threadId, ...(nodeId ? { nodeId } : {}), kind, cursor },
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        this.#detail.transcript.getSnapshot().generation !== state.generation
      )
        return;
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
      return this.#detail.transcript.installOverlays(kind, page, state.generation, token)
        ? page
        : undefined;
    } finally {
      this.#detail.transcript.endRead(token);
      if (this.#overlayReads.get(kind) === state.generation) this.#overlayReads.delete(kind);
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
