import { utf8ByteLength } from "@opensteer/core";
import {
  scopedPersonalApiVersion,
  ScopedHostMessageSchema,
  PersonalResumeCursorSchema,
  PersonalDetailSnapshotSchema,
  PersonalShellSnapshotSchema,
  type PersonalResumeCursor,
  type PersonalScope,
  type PersonalSubscriptionId,
  type ScopedClientMessage,
  type ScopedHostMessage,
} from "@opensteer/protocol/personal-sync";
import {
  PersonalResourceViewSchema,
  PersonalResourceKindSchema,
  PersonalRevisionSchema,
  type PersonalResourceKind,
} from "@opensteer/protocol/resources";
import { ItemTextStore } from "./item-text-store.js";
import { PersonalResourceStore } from "./personal-resource-store.js";
import { PersonalShellStore } from "./personal-shell-store.js";
import {
  personalCacheFormat,
  type PersonalCacheScope,
  type PersonalStreamCache,
  type PersonalStreamCheckpoint,
} from "./personal-stream-cache.js";
import { ThreadTranscriptStore } from "./thread-transcript-store.js";

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
  revision: number;
}

function bytes(value: unknown) {
  return utf8ByteLength(JSON.stringify(value));
}

export class ScopedPersonalStream {
  readonly shell = new PersonalShellStore();
  readonly resources = new PersonalResourceStore();
  readonly #details = new Map<string, ObservedDetail>();
  readonly #slots = new Map<DetailId, ObservedDetail>();
  readonly #cacheKeys = new Map<string, PersonalCacheScope>();
  readonly #writes = new Map<string, () => Promise<void>>();
  #writing: Promise<void> | undefined;
  #identity: ScopedPersonalIdentity | undefined;
  #generation = 0;
  #authority = 0;
  #send: ((frame: ScopedClientMessage) => void) | undefined;
  #background = false;
  #shellReady = false;
  #earlyBytes = 0;
  #watchPending = false;
  readonly #early: ScopedHostMessage[] = [];
  #selected: string | undefined;

  readonly cache: PersonalStreamCache | undefined;
  readonly onResource: ((kind: PersonalResourceKind) => void) | undefined;

  constructor(cache?: PersonalStreamCache, onResource?: (kind: PersonalResourceKind) => void) {
    this.cache = cache;
    this.onResource = onResource;
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
      revision: 0,
    };
    this.#details.set(key, detail);
    return detail;
  }

  select(scope: Extract<DetailScope, { kind: "thread" }> | undefined) {
    const key = scope && scopeKey(scope);
    if (key === this.#selected) return;
    this.#selected = key;
    if (scope) this.detail(scope);
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

  watchResource(kind: PersonalResourceKind, listener: () => void) {
    const release = this.resources.watch(kind, listener);
    this.#scheduleWatch();
    return () => {
      release();
      this.#scheduleWatch();
    };
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
          held.scope.format !== personalCacheFormat ||
          held.cursor.deploymentId !== key.deploymentId ||
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
          this.resources.begin(generation);
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
          this.resources.updateRevisions(generation, snapshot.resourceRevisions);
          for (const [kind, resource] of Object.entries(held.resources)) {
            if (
              resource &&
              PersonalResourceKindSchema.safeParse(kind).success &&
              PersonalRevisionSchema.safeParse(resource.revision).success &&
              PersonalResourceViewSchema.safeParse(resource.view).success
            )
              this.resources.install({
                ...resource,
                kind: kind as PersonalResourceKind,
                type: "host.resource",
                subscriptionId: "shell",
                generation,
              });
          }
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
          if (!ScopedHostMessageSchema.safeParse(frame).success || !detail.transcript.apply(frame))
            return;
          this.#cacheKeys.set(key.scopeKey, key);
        }
      }),
    );
  }

  attach(send: (message: ScopedClientMessage) => void) {
    this.disconnect();
    this.#send = send;
    const generation = ++this.#generation;
    this.shell.begin(generation, true);
    this.resources.begin(generation);
    const cursor =
      this.shell.checkpoint() && this.#cursor(shellScope, this.shell.getSnapshot().through);
    const selected =
      this.#selected && !this.#background ? this.#details.get(this.#selected) : undefined;
    const subscription = selected && this.#subscribe(selected, true);
    send({
      type: "client.attach",
      apiVersion: scopedPersonalApiVersion,
      generation,
      ...this.resources.getInterests(),
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
    for (const detail of this.#slots.values()) this.#deactivate(detail);
    this.shell.begin(++this.#generation, true);
  }

  revokeDetails(affected: readonly PersonalSubscriptionId[]) {
    for (const id of affected) {
      if (id === "shell") continue;
      const detail = this.#slots.get(id);
      if (!detail) continue;
      detail.transcript.apply({
        type: "host.removed",
        scope: detail.scope,
        subscriptionId: id,
        generation: detail.transcript.getSnapshot().generation,
        reason: "unavailable",
      });
      this.#deactivate(detail);
      this.#removeCheckpoint(detail.scope);
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
    this.shell.begin(++this.#generation, false);
    this.resources.clear();
    for (const detail of this.#details.values()) {
      detail.transcript.begin(++this.#generation, false);
      detail.text.clear();
    }
    if (removeCheckpoints && identity && this.cache?.removeViewer)
      this.#enqueue("viewer", () => this.cache!.removeViewer!(identity));
    else if (removeCheckpoints) {
      for (const scope of this.#cacheKeys.values())
        this.#enqueue(scope.scopeKey, () => this.cache!.remove(scope));
    }
    this.#cacheKeys.clear();
    this.#evict();
  }

  receive(input: unknown) {
    const parsed = ScopedHostMessageSchema.safeParse(input);
    if (!parsed.success) return false;
    const frame = parsed.data;
    if (!this.#send) return true;
    if (frame.subscriptionId === "shell") this.#receiveShell(frame);
    else if (this.#shellReady) this.#receiveDetail(frame);
    else {
      if (frame.type === "host.live") return true;
      const size = bytes(frame);
      if (this.#earlyBytes + size > 256 * 1024 || this.#early.length >= 128)
        throw new Error("Detail arrived before its shell cut.");
      this.#earlyBytes += size;
      this.#early.push(frame);
    }
    return true;
  }

  repairShell() {
    if (!this.#send) return;
    this.#shellReady = false;
    const generation = ++this.#generation;
    this.shell.begin(generation, true);
    this.resources.begin(generation);
    this.#send({
      type: "client.subscribe",
      subscriptionId: "shell",
      scope: shellScope,
      generation,
    });
    this.#watchResources();
  }

  #receiveShell(frame: ScopedHostMessage) {
    const previous = this.shell.getSnapshot();
    if (frame.generation !== previous.generation) return;
    if (frame.type === "host.resource") {
      if (this.resources.install(frame)) {
        this.onResource?.(frame.kind);
        this.#checkpoint(shellScope);
      }
      return;
    }
    if (frame.type === "host.live" || frame.type === "host.removed") return;
    if (frame.scope.kind !== "shell") return;
    if (frame.type === "host.snapshot" && "tasks" in frame.snapshot) {
      const { deploymentId, viewerId, epoch, resourceRevisions } = frame.snapshot;
      const old = this.#identity;
      if (
        old &&
        (old.deploymentId !== deploymentId || old.viewerId !== viewerId || old.epoch !== epoch)
      ) {
        this.#authority++;
        this.resources.clear();
        for (const detail of this.#details.values()) {
          detail.transcript.begin(++this.#generation, false);
          detail.text.clear();
          if (detail.slot) this.#subscribe(detail, false, true);
        }
      }
      this.#identity = { deploymentId, viewerId, epoch };
      this.resources.updateRevisions(frame.generation, resourceRevisions);
    }
    if (frame.type === "host.snapshot-required" || !this.shell.apply(frame)) {
      if (frame.type === "host.snapshot-required") this.shell.apply(frame);
      this.repairShell();
      return;
    }
    if (frame.type === "host.changes" && this.shell.getSnapshot().invalidated.size) {
      this.#ack(frame);
      this.repairShell();
      return;
    }
    if (frame.type === "host.snapshot" && "tasks" in frame.snapshot) {
      for (const resource of frame.snapshot.resources ?? []) {
        if (
          this.resources.install({
            ...resource,
            type: "host.resource",
            subscriptionId: "shell",
            generation: frame.generation,
          })
        )
          this.onResource?.(resource.kind);
      }
    }
    const progress = "shellProgress" in frame ? frame.shellProgress : undefined;
    if (progress) this.resources.updateRevisions(frame.generation, progress.resourceRevisions);
    this.#ack(frame);
    this.#checkpoint(shellScope);
    if (frame.type === "host.synchronized") {
      this.#shellReady = true;
      const early = this.#early.splice(0);
      this.#earlyBytes = 0;
      for (const pending of early) this.#receiveDetail(pending);
    }
  }

  #receiveDetail(frame: ScopedHostMessage) {
    if (frame.subscriptionId === "shell") return;
    const detail = this.#slots.get(frame.subscriptionId);
    if (
      !detail ||
      scopeKey(frame.scope) !== scopeKey(detail.scope) ||
      frame.scope.kind === "shell" ||
      frame.scope.threadId !== detail.scope.threadId
    )
      return;
    const state = detail.transcript.getSnapshot();
    if (frame.generation !== state.generation) return;
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
    if (frame.type === "host.snapshot-required" || !detail.transcript.apply(frame)) {
      if (frame.type === "host.snapshot-required") detail.transcript.apply(frame);
      this.#subscribe(detail, false, true);
      return;
    }
    if (frame.type === "host.removed") {
      this.#deactivate(detail);
      this.#removeCheckpoint(detail.scope);
      return;
    }
    this.#ack(frame);
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
    const { synchronized, through } = detail.transcript.getSnapshot();
    if (!synchronized || through === null) return;
    const result = detail.text.apply(frame, through);
    if (result === "applied")
      detail.transcript.liveItem(frame.item, frame.itemId, frame.update.operation === "close");
    if (result === "repair") this.#resync(frame);
    if (result === "barrier") {
      const held = (detail.held ??= new Map());
      const key = frame.streamId;
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
    this.#send?.({
      type: "client.ack",
      subscriptionId: frame.subscriptionId,
      generation: frame.generation,
      throughSequence: frame.throughSequence,
    });
  }

  #scheduleWatch() {
    if (!this.#send || this.#watchPending) return;
    this.#watchPending = true;
    queueMicrotask(() => {
      this.#watchPending = false;
      this.#watchResources();
    });
  }

  #watchResources() {
    this.#send?.({
      type: "client.resources.watch",
      subscriptionId: "shell",
      generation: this.shell.getSnapshot().generation,
      ...this.resources.getInterests(),
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
    detail.slot = slot;
    this.#slots.set(slot, detail);
    detail.transcript.begin(generation, true);
    detail.text.generation(generation);
    const cursor =
      !repair && detail.transcript.checkpoint()
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

  #evict() {
    let count = 0;
    let size = 0;
    const inactive = [...this.#details.entries()].reverse();
    for (const [key, detail] of inactive) {
      if (this.#observed(detail)) continue;
      const state = detail.transcript.getSnapshot();
      count += state.items.size;
      size += bytes([...state.items.values()]);
      if (count <= 1000 && size <= 2 * 1024 * 1024 && state.items.size > 0) continue;
      this.#details.delete(key);
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
    const checkpoint: PersonalStreamCheckpoint | undefined = detail
      ? (() => {
          const snapshot = detail.transcript.checkpoint();
          return snapshot && { scope: key, cursor, kind: "detail", state: snapshot };
        })()
      : (() => {
          const snapshot = this.shell.checkpoint();
          return (
            snapshot && {
              scope: key,
              cursor,
              kind: "shell",
              state: withoutSession(snapshot),
              resources: this.resources.checkpoint(),
            }
          );
        })();
    if (!checkpoint) return;
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
    this.#enqueue(key.scopeKey, () =>
      current() ? this.cache!.commit(checkpoint, current) : Promise.resolve(),
    );
  }

  #removeCheckpoint(scope: PersonalScope) {
    const key = this.#key(scope);
    if (key && this.cache) this.#enqueue(key.scopeKey, () => this.cache!.remove(key));
  }

  #enqueue(key: string, write: () => Promise<void>) {
    this.#writes.set(key, write);
    this.#writing ??= Promise.resolve().then(async () => {
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
