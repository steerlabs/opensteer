import { utf8ByteLength, type AuthSessionId } from "@opensteer/core";
import {
  scopedPersonalApiVersion,
  ScopedHostMessageSchema,
  personalHostFrameMaxBytes,
  PersonalResumeCursorSchema,
  PersonalDetailSnapshotSchema,
  PersonalShellSnapshotSchema,
  type PersonalResumeCursor,
  type PersonalScope,
  type PersonalSubscriptionId,
  type ScopedClientMessage,
  type ScopedHostMessage,
} from "@opensteer/protocol/personal-sync";
import type {
  PersonalResourceKind,
  PersonalResourceRevisions,
} from "@opensteer/protocol/resources";
import { ItemTextStore, liveFrameKey } from "./item-text-store.js";
import { PersonalShellStore } from "./personal-shell-store.js";
import {
  personalCacheFormat,
  type PersonalCacheScope,
  type PersonalStreamCache,
  type PersonalStreamCheckpoint,
} from "./personal-stream-cache.js";
import { finalizedItemText, ThreadTranscriptStore } from "./thread-transcript-store.js";

type DetailScope = Exclude<PersonalScope, { kind: "shell" }>;
type DetailId = Extract<ScopedClientMessage, { type: "client.live.resync" }>["subscriptionId"];
type Subscribe = Extract<ScopedClientMessage, { type: "client.subscribe" }>;
type Live = Extract<ScopedHostMessage, { type: "host.live" }>;
export type ScopedPersonalIdentity = Pick<
  PersonalResumeCursor,
  "deploymentId" | "epoch" | "viewerId"
>;
const detailIds = ["detail:0", "detail:1", "detail:2", "detail:3"] as const;
const shellScope = { kind: "shell" } as const;

export function scopeKey(scope: PersonalScope): PersonalResumeCursor["scopeKey"] {
  if (scope.kind === "shell") return "shell";
  return scope.kind === "thread" ? `thread:${scope.threadId}` : `node:${scope.nodeId}`;
}

export interface ObservedDetail {
  readonly scope: DetailScope;
  readonly transcript: ThreadTranscriptStore;
  readonly text: ItemTextStore;
  observers: number;
  slot?: DetailId | undefined;
  anchor?: string;
  controller?: AbortController | undefined;
  held?: Map<string, Live> | undefined;
  heldBytes: number;
  /** Live bytes received since this scope last acknowledged anything. */
  liveBytes: number;
  revision: number;
}

/** The session's resource reads: what it watches, and the revisions the Host says changed. */
export interface PersonalResourcePort {
  interests(): { interests: PersonalResourceKind[]; installed: PersonalResourceRevisions };
  changed(revisions: PersonalResourceRevisions): void;
}

/** The Host pauses a scope after 256 KiB of unacknowledged live text; ack well before that. */
const liveAckBytes = 32 * 1024;

function bytes(value: unknown) {
  return utf8ByteLength(JSON.stringify(value));
}

export class ScopedPersonalStream {
  readonly shell = new PersonalShellStore();
  readonly #resources: PersonalResourcePort | undefined;
  readonly #details = new Map<string, ObservedDetail>();
  readonly #slots = new Map<DetailId, ObservedDetail>();
  readonly #cacheKeys = new Map<string, PersonalCacheScope>();
  readonly #writes = new Map<string, () => Promise<void>>();
  #writing: Promise<void> | undefined;
  #identity: ScopedPersonalIdentity | undefined;
  #sessionId: AuthSessionId | undefined;
  #generation = 0;
  #authority = 0;
  #send: ((frame: ScopedClientMessage) => void) | undefined;
  #background = false;
  #shellReady = false;
  #earlyBytes = 0;
  #attachment = 0;
  #watchPending = false;
  readonly #early: ScopedHostMessage[] = [];
  readonly #deferred = new Set<ObservedDetail>();
  #selected: string | undefined;

  readonly cache: PersonalStreamCache | undefined;
  constructor(cache?: PersonalStreamCache, resources?: PersonalResourcePort) {
    this.cache = cache;
    this.#resources = resources;
  }

  peekDetail(scope: DetailScope) {
    return this.#details.get(scopeKey(scope));
  }

  detail(scope: DetailScope) {
    const key = scopeKey(scope);
    const existing = this.#details.get(key);
    if (existing) return existing;
    const detail: ObservedDetail = {
      scope,
      transcript: new ThreadTranscriptStore(),
      text: new ItemTextStore(),
      observers: 0,
      heldBytes: 0,
      liveBytes: 0,
      revision: 0,
    };
    this.#details.set(key, detail);
    return detail;
  }

  select(scope: Extract<DetailScope, { kind: "thread" }> | undefined) {
    const key = scope && scopeKey(scope);
    if (key === this.#selected) return;
    this.#selected = key;
    if (scope && key) {
      const detail = this.detail(scope);
      this.#details.delete(key);
      this.#details.set(key, detail);
    }
    this.#reconcile();
  }

  observe(scope: DetailScope) {
    const detail = this.detail(scope);
    detail.observers++;
    this.#details.delete(scopeKey(scope));
    this.#details.set(scopeKey(scope), detail);
    this.#reconcile();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      detail.observers--;
      this.#reconcile();
    };
  }

  /** The watched kinds changed; tell the Host once this task settles. */
  watchResources() {
    if (!this.#send || this.#watchPending) return;
    this.#watchPending = true;
    queueMicrotask(() => {
      this.#watchPending = false;
      this.#watchResources();
    });
  }

  async restore(
    identity: ScopedPersonalIdentity & {
      session?: import("zod").infer<typeof PersonalShellSnapshotSchema>["session"];
    },
  ) {
    if (!this.cache || this.#send || this.#identity) return;
    this.#identity = {
      deploymentId: identity.deploymentId,
      viewerId: identity.viewerId,
      epoch: identity.epoch,
    };
    this.#sessionId = identity.session?.sessionId;
    const authority = this.#authority;
    const scopes = [
      shellScope,
      ...[...this.#details.values()].filter((d) => this.#observed(d)).map((d) => d.scope),
    ];
    await Promise.all(
      scopes.map(async (scope) => {
        const key = this.#key(scope);
        if (!key) return;
        const held = await this.cache?.load(key).catch(() => null);
        if (
          !held ||
          this.#authority !== authority ||
          this.#send ||
          held.scope?.format !== personalCacheFormat ||
          held.cursor?.deploymentId !== key.deploymentId ||
          held.cursor.viewerId !== key.viewerId ||
          held.cursor.epoch !== key.epoch ||
          held.cursor.scopeKey !== key.scopeKey ||
          held.scope.deploymentId !== key.deploymentId ||
          held.scope.viewerId !== key.viewerId ||
          held.scope.epoch !== key.epoch ||
          held.scope.scopeKey !== key.scopeKey ||
          !PersonalResumeCursorSchema.safeParse(held.cursor).success
        )
          return;
        if (scope.kind === "shell" && held.kind === "shell") {
          const generation = ++this.#generation;
          this.shell.begin(generation, false);
          const state = PersonalShellSnapshotSchema.safeParse(held.state);
          if (
            !state.success ||
            state.data.deploymentId !== key.deploymentId ||
            state.data.viewerId !== key.viewerId ||
            state.data.epoch !== key.epoch
          )
            return;
          const { session: _oldSession, ...saved } = state.data;
          const snapshot = { ...saved, ...(identity.session ? { session: identity.session } : {}) };
          const frame = {
            type: "host.snapshot",
            scope,
            subscriptionId: "shell",
            generation,
            throughSequence: held.cursor.afterSequence,
            snapshot,
          } as const;
          if (!ScopedHostMessageSchema.safeParse(frame).success || !this.shell.apply(frame)) return;
          this.#cacheKeys.set(key.scopeKey, key);
        } else if (scope.kind !== "shell" && held.kind === "detail") {
          const detail = this.detail(scope);
          const state = PersonalDetailSnapshotSchema.safeParse(held.state);
          if (!state.success || state.data.thread.id !== scope.threadId) return;
          const generation = ++this.#generation;
          detail.transcript.begin(generation, false);
          const frame = {
            type: "host.snapshot",
            scope,
            subscriptionId: "detail:0",
            generation,
            throughSequence: held.cursor.afterSequence,
            snapshot: state.data,
          } as const;
          if (
            !ScopedHostMessageSchema.safeParse(frame).success ||
            !detail.transcript.apply(frame, this.#identity)
          )
            return;
          this.#cacheKeys.set(key.scopeKey, key);
        }
      }),
    );
  }

  /** Counts sockets; a scope repair on one socket keeps its attachment. */
  get attachment() {
    return this.#attachment;
  }

  /** The current socket has delivered its first shell cut. */
  get ready() {
    return this.#shellReady;
  }

  attach(send: (message: ScopedClientMessage) => void) {
    this.disconnect();
    this.#send = send;
    this.#attachment++;
    const generation = ++this.#generation;
    this.shell.begin(generation, true);
    const cursor =
      this.shell.checkpoint() && this.#cursor(shellScope, this.shell.getSnapshot().through);
    const selected =
      this.#selected && !this.#background ? this.#details.get(this.#selected) : undefined;
    const subscription = selected && this.#subscribe(selected, true);
    send({
      type: "client.attach",
      apiVersion: scopedPersonalApiVersion,
      ...(this.#sessionId ? { expectedSessionId: this.#sessionId } : {}),
      generation,
      ...this.#interests(),
      ...(cursor ? { cursor } : {}),
      ...(subscription && subscription.scope.kind === "thread"
        ? { selected: { ...subscription, scope: subscription.scope } }
        : {}),
    });
    this.#reconcile();
  }

  disconnect() {
    this.#send = undefined;
    this.#shellReady = false;
    this.#early.length = 0;
    this.#earlyBytes = 0;
    this.#deferred.clear();
    for (const detail of this.#slots.values()) this.#deactivate(detail);
    this.shell.begin(++this.#generation, true);
  }

  revokeDetails(affected: readonly PersonalSubscriptionId[]) {
    const scopes = affected.flatMap((id) =>
      id === "shell" ? [] : (this.#slots.get(id)?.scope ?? []),
    );
    const roots = new Set(
      scopes.filter(({ kind }) => kind === "thread").map(({ threadId }) => threadId),
    );
    for (const detail of this.#details.values()) {
      if (!scopes.includes(detail.scope) && !roots.has(detail.scope.threadId)) continue;
      const generation = detail.transcript.getSnapshot().generation;
      detail.transcript.apply({
        type: "host.removed",
        scope: detail.scope,
        subscriptionId: detail.slot ?? "detail:0",
        generation,
        reason: "unavailable",
      });
      this.#deactivate(detail);
      this.#removeCheckpoint(detail.scope);
    }
    for (const threadId of roots) {
      this.shell.removeTask(threadId);
      const identity = this.#identity;
      if (identity && this.cache?.removeThread)
        this.#enqueue(`thread-cache:${threadId}`, () =>
          this.cache!.removeThread!(identity, threadId),
        );
    }
    return scopes;
  }

  #purge(identity: ScopedPersonalIdentity | undefined) {
    if (identity && this.cache?.removeViewer) {
      this.#enqueue(JSON.stringify([identity.deploymentId, identity.viewerId]), () =>
        this.cache!.removeViewer!(identity),
      );
    } else if (this.cache) {
      for (const scope of this.#cacheKeys.values())
        this.#enqueue(JSON.stringify(scope), () => this.cache!.remove(scope));
    }
  }

  setBackground(background: boolean) {
    if (background === this.#background) return;
    this.#background = background;
    this.#reconcile();
  }

  clear(removeCheckpoints: boolean) {
    this.disconnect();
    this.#authority++;
    const identity = this.#identity;
    this.#identity = undefined;
    this.#sessionId = undefined;
    this.shell.begin(++this.#generation, false);
    for (const detail of this.#details.values()) {
      detail.transcript.begin(++this.#generation, false);
      detail.text.clear();
    }
    if (removeCheckpoints) this.#purge(identity);
    this.#cacheKeys.clear();
    this.#evict();
  }

  receive(input: unknown, wireBytes?: number) {
    const parsed = ScopedHostMessageSchema.safeParse(input);
    if (!parsed.success) return false;
    const frame = parsed.data;
    if (wireBytes !== undefined && wireBytes > personalHostFrameMaxBytes(frame))
      throw new Error("Personal scope frame exceeds its encoded limit.");
    if (!this.#send) return true;
    if (frame.type === "host.live") this.#creditLive(frame, wireBytes ?? bytes(frame));
    if (frame.subscriptionId === "shell") this.#receiveShell(frame);
    else if (this.#shellReady || frame.type === "host.live") this.#receiveDetail(frame);
    else this.#hold(frame, wireBytes ?? bytes(frame));
    return true;
  }

  // Durable detail waits for the socket's first shell cut, which carries the viewer identity.
  // Past the buffer cap the detail is set aside and resubscribed once the shell is ready.
  #hold(frame: ScopedHostMessage, size: number) {
    const detail = this.#currentDetail(frame);
    if (!detail || this.#deferred.has(detail)) return;
    if (this.#earlyBytes + size <= 256 * 1024 && this.#early.length < 128) {
      this.#earlyBytes += size;
      this.#early.push(frame);
      return;
    }
    this.#deferred.add(detail);
    const kept = this.#early.filter((held) => this.#currentDetail(held) !== detail);
    this.#early.splice(0, this.#early.length, ...kept);
    this.#earlyBytes = kept.reduce((total, held) => total + bytes(held), 0);
  }

  /** Resubscribes the shell; only an explicit refresh or a broken frame order asks for this. */
  repairShell() {
    if (!this.#send) return;
    const generation = ++this.#generation;
    this.shell.begin(generation, true);
    this.#send({
      type: "client.subscribe",
      subscriptionId: "shell",
      scope: shellScope,
      generation,
    });
    for (const detail of this.#slots.values())
      if (!detail.transcript.getSnapshot().synchronized) this.#subscribe(detail, false, true);
    this.#watchResources();
  }

  #receiveShell(frame: ScopedHostMessage) {
    const previous = this.shell.getSnapshot();
    if (frame.generation !== previous.generation) return;
    if (frame.type === "host.resource") {
      this.#resources?.changed(frame.revisions);
      return;
    }
    if (frame.type === "host.live" || frame.type === "host.removed") return;
    if (frame.scope.kind !== "shell") return;
    // A cut behind what this client holds means the Host's history moved back.
    if (
      frame.type === "host.snapshot" &&
      previous.through !== null &&
      BigInt(frame.throughSequence) < BigInt(previous.through)
    ) {
      this.#discardViewerCheckpoints();
      this.shell.resetHistory();
      for (const detail of this.#slots.values()) this.#subscribe(detail, false, true);
    }
    if (frame.type === "host.snapshot" && "tasks" in frame.snapshot) {
      const { deploymentId, viewerId, epoch } = frame.snapshot;
      const old = this.#identity;
      const sessionId = frame.snapshot.session?.sessionId;
      if (
        old &&
        (old.deploymentId !== deploymentId ||
          old.viewerId !== viewerId ||
          old.epoch !== epoch ||
          (this.#sessionId !== undefined && sessionId !== this.#sessionId))
      ) {
        this.#discardViewerCheckpoints();
        for (const detail of this.#slots.values()) this.#subscribe(detail, false, true);
      }
      this.#identity = { deploymentId, viewerId, epoch };
      this.#sessionId = sessionId;
    }
    // Readiness is set before the shell publishes its first synchronized cut on this socket.
    const firstCut =
      frame.type === "host.synchronized" &&
      !this.#shellReady &&
      frame.throughSequence === previous.through;
    if (firstCut) this.#shellReady = true;
    // A frame that does not follow this cut breaks the Host's ordering; start the scope over.
    if (!this.shell.apply(frame)) {
      this.repairShell();
      return;
    }
    this.#ack(frame);
    this.#checkpoint(shellScope);
    if (firstCut) {
      const early = this.#early.splice(0);
      this.#earlyBytes = 0;
      for (const pending of early) this.#receiveDetail(pending);
      const deferred = [...this.#deferred];
      this.#deferred.clear();
      for (const detail of deferred) if (detail.slot) this.#subscribe(detail);
    }
  }

  #discardViewerCheckpoints() {
    this.#authority++;
    this.#purge(this.#identity);
    this.#cacheKeys.clear();
    this.#early.length = 0;
    this.#earlyBytes = 0;
    for (const detail of this.#details.values()) {
      detail.transcript.begin(++this.#generation, false);
      detail.text.clear();
    }
  }

  #currentDetail(frame: ScopedHostMessage): ObservedDetail | undefined {
    if (frame.subscriptionId === "shell") return;
    const detail = this.#slots.get(frame.subscriptionId);
    if (
      detail &&
      frame.scope.kind !== "shell" &&
      frame.scope.threadId === detail.scope.threadId &&
      scopeKey(frame.scope) === scopeKey(detail.scope) &&
      frame.generation === detail.transcript.getSnapshot().generation
    )
      return detail;
    return undefined;
  }

  #receiveDetail(frame: ScopedHostMessage) {
    if (frame.subscriptionId === "shell") return;
    const detail = this.#currentDetail(frame);
    if (!detail) return;
    if (frame.type === "host.live") {
      this.#live(detail, frame);
      return;
    }
    if (
      frame.type === "host.snapshot" &&
      "items" in frame.snapshot &&
      detail.anchor &&
      !frame.snapshot.items.some(({ id }) => id === detail.anchor)
    ) {
      if (frame.snapshot.anchorItemId !== null)
        throw new Error("Transcript snapshot omitted its anchor.");
      delete detail.anchor;
    }
    // A snapshot after `host.synchronized` is the Host's inline repair and applies in place.
    if (!detail.transcript.apply(frame, this.#identity)) {
      this.#subscribe(detail, false, true);
      return;
    }
    if (frame.type === "host.removed") {
      this.#deactivate(detail);
      this.#removeCheckpoint(detail.scope);
      return;
    }
    this.#ack(frame);
    if (frame.type === "host.changes")
      for (const change of frame.changes) {
        if (change.entityKind !== "item") continue;
        if (change.operation === "remove" || finalizedItemText(change.value))
          detail.text.finishItem(change.entityId);
      }
    if (detail.held) {
      for (const [key, live] of detail.held) {
        if (BigInt(frame.throughSequence) < BigInt(live.afterSequence)) continue;
        detail.held.delete(key);
        detail.heldBytes -= bytes(live);
        this.#live(detail, live);
      }
    }
    this.#checkpoint(detail.scope, detail);
  }

  #live(detail: ObservedDetail, frame: Live) {
    const { synchronized, through, items, snapshot } = detail.transcript.getSnapshot();
    if (
      !synchronized ||
      through === null ||
      (frame.update.operation !== "close" &&
        finalizedItemText(
          items.get(frame.itemId) ??
            (snapshot?.nodeSubject?.id === frame.itemId ? snapshot.nodeSubject : undefined),
        ))
    )
      return;
    const result = detail.text.apply(frame, through);
    if (result === "applied") {
      for (const id of detail.transcript.getSnapshot().liveItems.keys())
        if (id !== frame.itemId && !detail.text.get(id))
          detail.transcript.liveItem(undefined, id, true);
      detail.transcript.liveItem(
        detail.text.item(frame.itemId),
        frame.itemId,
        !detail.text.get(frame.itemId)?.text,
      );
    }
    if (result === "repair") this.#resync(frame);
    if (result === "barrier") {
      const held = (detail.held ??= new Map());
      const key = liveFrameKey(frame);
      const previous = held.get(key);
      if (previous) detail.heldBytes -= bytes(previous);
      if (previous && frame.update.operation === "append") {
        held.delete(key);
        this.#resync(frame);
        return;
      }
      const length = bytes(frame);
      if (detail.heldBytes + length > 64 * 1024 || (!previous && held.size >= 16)) {
        held.delete(key);
        this.#resync(frame);
        return;
      }
      detail.heldBytes += length;
      held.set(key, frame);
    }
  }

  // Live frames spend the socket's credit; any ack after them returns it.
  #creditLive(frame: Live, size: number) {
    const detail = this.#currentDetail(frame);
    if (!detail || this.#background) return;
    detail.liveBytes += size;
    const through = detail.transcript.getSnapshot().through;
    if (detail.liveBytes < liveAckBytes || through === null) return;
    detail.liveBytes = 0;
    this.#send?.({
      type: "client.ack",
      subscriptionId: frame.subscriptionId,
      generation: frame.generation,
      throughSequence: through,
    });
  }

  #resync(frame: Live) {
    this.#send?.({
      type: "client.live.resync",
      subscriptionId: frame.subscriptionId,
      generation: frame.generation,
      runId: frame.runId,
      streamIds: [frame.streamId],
    });
  }

  #ack(frame: Extract<ScopedHostMessage, { throughSequence: string }>) {
    if (frame.type !== "host.snapshot" && frame.type !== "host.changes") return;
    if (frame.subscriptionId !== "shell") {
      const detail = this.#slots.get(frame.subscriptionId);
      if (detail) detail.liveBytes = 0;
    }
    this.#send?.({
      type: "client.ack",
      subscriptionId: frame.subscriptionId,
      generation: frame.generation,
      throughSequence: frame.throughSequence,
    });
  }

  #interests() {
    return this.#resources?.interests() ?? { interests: [], installed: {} };
  }

  #watchResources() {
    this.#send?.({
      type: "client.resources.watch",
      subscriptionId: "shell",
      generation: this.shell.getSnapshot().generation,
      ...this.#interests(),
    });
  }

  #observed(detail: ObservedDetail) {
    return detail.observers > 0 || scopeKey(detail.scope) === this.#selected;
  }

  #reconcile() {
    for (const [slot, detail] of this.#slots) {
      if (!this.#background && this.#observed(detail)) continue;
      this.#unsubscribe(slot, detail);
    }
    if (this.#send && !this.#background) {
      const selected = this.#selected ? this.#details.get(this.#selected) : undefined;
      if (selected && !selected.slot) {
        if (this.#slots.size === detailIds.length) {
          const first = this.#slots.entries().next();
          if (!first.done) this.#unsubscribe(...first.value);
        }
        this.#subscribe(selected);
      }
      for (const detail of this.#details.values())
        if (this.#observed(detail) && !detail.slot) this.#subscribe(detail);
    }
    this.#evict();
  }

  #unsubscribe(slot: DetailId, detail: ObservedDetail) {
    this.#send?.({
      type: "client.unsubscribe",
      subscriptionId: slot,
      generation: detail.transcript.getSnapshot().generation,
    });
    this.#deactivate(detail);
  }

  #subscribe(detail: ObservedDetail, attaching = false, repair = false) {
    if (
      detail.scope.kind === "node" &&
      !detail.slot &&
      [...this.#slots.values()].filter((value) => value.scope.kind === "node").length >= 2
    )
      return;
    const slot = detail.slot ?? detailIds.find((id) => !this.#slots.has(id));
    if (!slot) return;
    const generation = ++this.#generation;
    detail.controller?.abort();
    detail.controller = new AbortController();
    detail.revision++;
    detail.held = undefined;
    detail.heldBytes = 0;
    detail.liveBytes = 0;
    detail.slot = slot;
    this.#slots.set(slot, detail);
    detail.transcript.begin(generation, true);
    detail.text.generation(generation);
    const cursor =
      !repair && detail.transcript.canCheckpoint()
        ? this.#cursor(detail.scope, detail.transcript.getSnapshot().through)
        : undefined;
    const subscription = {
      subscriptionId: slot,
      scope: detail.scope,
      generation,
      ...(cursor ? { cursor } : {}),
      ...(detail.anchor ? { anchorItemId: detail.anchor } : {}),
    } satisfies Omit<Subscribe, "type">;
    if (!attaching) this.#send?.({ type: "client.subscribe", ...subscription });
    return subscription;
  }

  #deactivate(detail: ObservedDetail) {
    if (detail.slot) this.#slots.delete(detail.slot);
    detail.slot = undefined;
    detail.revision++;
    detail.controller?.abort();
    detail.controller = undefined;
    detail.held = undefined;
    detail.heldBytes = 0;
    detail.text.clear();
    detail.transcript.begin(++this.#generation, true);
  }

  readonly #retainedBytes = new WeakMap<ReadonlyMap<string, unknown>, number>();

  #evict() {
    let count = 0;
    let size = 0;
    const inactive = [...this.#details.entries()].reverse();
    for (const [key, detail] of inactive) {
      if (detail.slot || key === this.#selected) continue;
      const state = detail.transcript.getSnapshot();
      count += state.items.size;
      let weight = this.#retainedBytes.get(state.items);
      if (weight === undefined) {
        weight = bytes([...state.items.values()]);
        this.#retainedBytes.set(state.items, weight);
      }
      size += weight;
      if (count <= 1000 && size <= 2 * 1024 * 1024 && state.items.size > 0) continue;
      if (detail.observers > 0) detail.transcript.begin(++this.#generation, false);
      else this.#details.delete(key);
    }
  }

  #key(scope: PersonalScope): PersonalCacheScope | undefined {
    if (!this.#identity) return;
    return { ...this.#identity, scopeKey: scopeKey(scope), format: personalCacheFormat };
  }

  #cursor(scope: PersonalScope, through: string | null): PersonalResumeCursor | undefined {
    if (!this.#identity || through === null) return;
    return { ...this.#identity, scopeKey: scopeKey(scope), afterSequence: through };
  }

  #checkpoint(scope: PersonalScope, detail?: ObservedDetail) {
    if (!this.cache) return;
    const state = detail ? detail.transcript.getSnapshot() : this.shell.getSnapshot();
    const cursor = this.#cursor(scope, state.through);
    const key = this.#key(scope);
    if (!cursor || !key || !state.synchronized) return;
    if (detail && !detail.transcript.canCheckpoint()) return;
    const authority = this.#authority;
    const current = () =>
      authority === this.#authority &&
      (detail ? detail.transcript.getSnapshot() : this.shell.getSnapshot()).generation ===
        state.generation;
    this.#cacheKeys.delete(key.scopeKey);
    this.#cacheKeys.set(key.scopeKey, key);
    if (this.#cacheKeys.size > 128) {
      const first = this.#cacheKeys.entries().next();
      if (!first.done) {
        const [oldest, oldKey] = first.value;
        this.#cacheKeys.delete(oldest);
        this.#enqueue(oldest, () => this.cache!.remove(oldKey));
      }
    }
    this.#enqueue(key.scopeKey, async () => {
      if (!current()) return;
      const checkpoint: PersonalStreamCheckpoint | undefined = detail
        ? (() => {
            const snapshot = detail.transcript.checkpoint();
            const strip = (item: import("@opensteer/protocol/transcript").TranscriptItem) => {
              if (item.kind !== "message" || item.clientSendKey === undefined) return item;
              const { clientSendKey: _discard, ...view } = item;
              return view;
            };
            const state = snapshot && {
              ...snapshot,
              items: snapshot.items.map(strip),
              activeItems: snapshot.activeItems.map(strip),
            };
            const detailCut = detail.transcript.getSnapshot();
            const nextCursor = this.#cursor(scope, detailCut.through);
            return state && nextCursor && { scope: key, cursor: nextCursor, kind: "detail", state };
          })()
        : (() => {
            const snapshot = this.shell.checkpoint();
            const nextCursor = this.#cursor(scope, this.shell.getSnapshot().through);
            return (
              snapshot &&
              nextCursor && {
                scope: key,
                cursor: nextCursor,
                kind: "shell",
                state: withoutSession(snapshot),
              }
            );
          })();
      if (checkpoint) await this.cache!.commit(checkpoint, current);
    });
  }

  #removeCheckpoint(scope: PersonalScope) {
    const key = this.#key(scope);
    if (key && this.cache) this.#enqueue(key.scopeKey, () => this.cache!.remove(key));
  }

  #enqueue(key: string, write: () => Promise<void>) {
    this.#writes.set(key, write);
    if (this.#writing) return;
    this.#writing = Promise.resolve().then(async () => {
      try {
        for (const [scope, next] of this.#writes) {
          this.#writes.delete(scope);
          await next().catch(() => undefined);
        }
      } finally {
        this.#writing = undefined;
      }
    });
  }
}

function withoutSession(snapshot: import("zod").infer<typeof PersonalShellSnapshotSchema>) {
  const { session: _session, ...state } = snapshot;
  return state;
}
