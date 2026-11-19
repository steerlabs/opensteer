import {
  ScopedHostMessageSchema,
  personalAuthorityChangedReason,
  type PersonalResumeCursor,
  type PersonalScope,
  type ScopedClientMessage,
  type ScopedHostMessage,
} from "@opensteer/protocol/personal-sync";
import type { PersonalResourceKind } from "@opensteer/protocol/resources";

type Subscribe = Extract<ScopedClientMessage, { type: "client.subscribe" }>;
type Address = Pick<Subscribe, "subscriptionId" | "generation">;
type Id = Address["subscriptionId"];
type CutFrame = Extract<
  ScopedHostMessage,
  { type: "host.snapshot" | "host.changes" | "host.removed" }
>;
type WithoutAddress<T> = T extends CutFrame ? Omit<T, keyof Address> : never;
type Watch = Extract<ScopedClientMessage, { type: "client.resources.watch" }>;
type LiveFrame = Extract<ScopedHostMessage, { type: "host.live" }>;
type DetailScope = LiveFrame["scope"];
type LiveResync = Extract<ScopedClientMessage, { type: "client.live.resync" }>;
export type PersonalLiveUpdate = Omit<LiveFrame, "type" | "scope" | keyof Address>;
type ShellProgress = Extract<ScopedHostMessage, { type: "host.synchronized" }>["shellProgress"];
type Resource = Omit<Extract<ScopedHostMessage, { type: "host.resource" }>, "type" | keyof Address>;

interface ScopeCut {
  readonly throughSequence: string;
  readonly cursor: PersonalResumeCursor | null;
  readonly frames: readonly WithoutAddress<CutFrame>[];
  readonly shellProgress?: ShellProgress;
}

interface PersonalSyncPort {
  read(
    scope: PersonalScope,
    cursor: PersonalResumeCursor | null,
    signal: AbortSignal,
    anchorItemId?: string,
    selectedThreadId?: string,
  ): Promise<ScopeCut>;
  send(encoded: string, dispatchGuard: () => boolean, signal: AbortSignal): Promise<boolean>;
  readResources?(
    interests: readonly PersonalResourceKind[],
    installed: Watch["installed"],
    signal: AbortSignal,
  ): Promise<readonly Resource[]>;
  isResourceCurrent?(kind: PersonalResourceKind, revision: string): boolean;
  readLive?(scope: DetailScope, request?: LiveResync): readonly PersonalLiveUpdate[];
  onFailure?(error: unknown): void;
  close(reason: string): void;
}

interface Credit {
  readonly through: string;
  readonly bytes: number;
  readonly changes: number;
  readonly durable: boolean;
  /** A live frame's credit returns with the first acknowledgement after it. */
  readonly acks: number;
}

export interface LiveDeliveryOptions {
  readonly immediate?: boolean;
  readonly replace?: boolean;
}

interface PendingLive {
  readonly update: PersonalLiveUpdate;
  readonly immediate: boolean;
  readonly replace: boolean;
}

interface Subscription {
  readonly request: Subscribe;
  readonly controller: AbortController;
  cursor: PersonalResumeCursor | null;
  pendingHead: bigint;
  credit: Credit[];
  bytes: number;
  changes: number;
  acknowledged: bigint;
  acks: number;
  dispatchedThrough: bigint | null;
  sending: boolean;
  synchronized: boolean;
  /** The next read ignores the cursor, so the Host repairs this scope with a snapshot. */
  repair: boolean;
  removed: boolean;
  pauseCount: number;
  readonly live: Map<string, PendingLive>;
  readonly sentLive: Map<string, number>;
  liveTimer?: ReturnType<typeof setTimeout> | undefined;
  liveReady?: boolean;
  checkCredit?: () => void;
  resources?: { interests: Watch["interests"]; installed: Watch["installed"]; dirty: boolean };
}

const scopeBudget = 256 * 1024;
const socketBudget = 512 * 1024;

export class PersonalSyncSocket {
  readonly #port: PersonalSyncPort;
  readonly #subscriptions = new Map<Id, Subscription>();
  readonly #generations = new Map<Id, number>();
  readonly #inFlight = new Map<Credit, Subscription>();
  readonly #fences = new Set<(scope: PersonalScope) => boolean>();
  #head = 0n;
  #closed = false;
  #initialShellReady = true;
  #selectedThreadId: string | undefined;
  #attached = false;

  constructor(port: PersonalSyncPort) {
    this.#port = port;
  }

  get attached() {
    return this.#attached && this.#initialShellReady && !this.#closed;
  }

  attach(request: Extract<ScopedClientMessage, { type: "client.attach" }>) {
    if (this.#attached || this.#closed) return;
    this.#attached = true;
    this.#initialShellReady = false;
    const { selected, ...shell } = request;
    this.#selectedThreadId = selected?.scope.threadId;
    this.subscribe(
      {
        type: "client.subscribe",
        scope: { kind: "shell" },
        subscriptionId: "shell",
        generation: shell.generation,
        ...(shell.cursor ? { cursor: shell.cursor } : {}),
      },
      { interests: shell.interests, installed: shell.installed },
    );
    if (selected) this.subscribe({ ...selected, type: "client.subscribe" });
  }

  watchResources(message: Watch) {
    const current = this.#subscriptions.get("shell");
    if (!current || current.request.generation !== message.generation) return;
    current.resources = { interests: message.interests, installed: message.installed, dirty: true };
    this.#schedule(current);
  }

  subscribe(request: Subscribe, resources?: Pick<Watch, "interests" | "installed">) {
    if (this.#closed || request.generation <= (this.#generations.get(request.subscriptionId) ?? 0))
      return;
    const peers = [...this.#subscriptions.values()].filter(
      (current) => current.request.subscriptionId !== request.subscriptionId,
    );
    if (
      request.scope.kind === "node" &&
      peers.filter((current) => current.request.scope.kind === "node").length >= 2
    ) {
      this.close("Too many node subscriptions");
      return;
    }
    const prior = this.#subscriptions.get(request.subscriptionId);
    const watch = resources ?? (request.scope.kind === "shell" ? prior?.resources : undefined);
    const current: Subscription = {
      request,
      controller: new AbortController(),
      cursor: request.cursor ?? null,
      pendingHead: this.#head,
      credit: [],
      bytes: 0,
      changes: 0,
      acknowledged: 0n,
      acks: 0,
      dispatchedThrough: null,
      sending: false,
      synchronized: false,
      repair: false,
      removed: false,
      live: new Map(),
      sentLive: new Map(),
      pauseCount: [...this.#fences].filter((matches) => matches(request.scope)).length,
      ...(watch ? { resources: { ...watch, dirty: true } } : {}),
    };
    if (prior) this.#cancel(prior);
    this.#generations.set(request.subscriptionId, request.generation);
    this.#subscriptions.set(request.subscriptionId, current);
    this.#reschedule();
  }

  unsubscribe(address: Address) {
    const current = this.#subscriptions.get(address.subscriptionId);
    if (!current || current.request.generation !== address.generation) return;
    this.#cancel(current);
    this.#subscriptions.delete(address.subscriptionId);
    this.#reschedule();
  }

  ack(input: Address & { readonly throughSequence: string }) {
    const current = this.#subscriptions.get(input.subscriptionId);
    if (!current || current.request.generation !== input.generation) return;
    const through = BigInt(input.throughSequence);
    if (current.dispatchedThrough === null || through > current.dispatchedThrough) {
      this.close("Acknowledgement is ahead of delivered state");
      return;
    }
    if (through > current.acknowledged) current.acknowledged = through;
    current.acks++;
    if (this.#releaseCredits(current)) this.#reschedule();
  }

  #releaseCredits(current: Subscription) {
    const previous = current.credit.length;
    let kept = 0;
    for (const credit of current.credit) {
      if (
        !this.#inFlight.has(credit) &&
        (credit.durable
          ? BigInt(credit.through) <= current.acknowledged
          : credit.acks < current.acks)
      ) {
        current.bytes -= credit.bytes;
        current.changes -= credit.changes;
      } else current.credit[kept++] = credit;
    }
    current.credit.length = kept;
    return kept < previous;
  }

  wake(head: string, changedScopes?: ReadonlySet<string>) {
    const sequence = BigInt(head);
    if (this.#closed) return;
    if (sequence > this.#head) this.#head = sequence;
    for (const current of this.#subscriptions.values()) {
      const { scope } = current.request;
      const key =
        scope.kind === "shell"
          ? "shell"
          : scope.kind === "thread"
            ? `thread:${scope.threadId}`
            : `node:${scope.nodeId}`;
      if (changedScopes && !changedScopes.has("deployment") && !changedScopes.has(key)) continue;
      if (sequence > current.pendingHead) current.pendingHead = sequence;
      this.#schedule(current);
    }
  }

  suspendAuthority(scopes: ReadonlySet<string>) {
    return this.suspend((scope) => {
      if (scopes.has("deployment")) return true;
      if (scope.kind === "shell") return scopes.has("shell");
      return (
        scopes.has(`thread:${scope.threadId}`) ||
        (scope.kind === "node" && scopes.has(`node:${scope.nodeId}`))
      );
    });
  }

  suspend(matches: (scope: PersonalScope) => boolean) {
    const affected = () =>
      [...this.#subscriptions.values()].filter((current) => matches(current.request.scope));
    this.#fences.add(matches);
    for (const current of affected()) {
      current.pauseCount++;
      current.checkCredit?.();
    }
    return {
      committed: () => {
        if (!this.#fences.delete(matches)) return;
        const ids = affected().map((current) => current.request.subscriptionId);
        if (ids.length) this.close(personalAuthorityChangedReason(ids));
      },
      rolledBack: () => {
        if (!this.#fences.delete(matches)) return;
        for (const current of affected()) {
          current.pauseCount--;
          this.#schedule(current);
        }
      },
    };
  }

  close(reason: string) {
    if (this.#closed) return;
    this.#closed = true;
    for (const current of this.#subscriptions.values()) this.#cancel(current);
    this.#subscriptions.clear();
    this.#port.close(reason);
  }

  #cancel(current: Subscription) {
    clearTimeout(current.liveTimer);
    current.live.clear();
    current.sentLive.clear();
    current.controller.abort();
    current.checkCredit?.();
  }

  /** Threads with a detail subscription on this socket (at most four). */
  watchedThreads() {
    return [...this.#subscriptions.values()].flatMap(({ request, removed }) =>
      request.scope.kind === "shell" || removed ? [] : [request.scope.threadId],
    );
  }

  observesThread(threadId: string) {
    return [...this.#subscriptions.values()].some(
      ({ request, synchronized, removed, pauseCount }) =>
        synchronized &&
        !removed &&
        pauseCount === 0 &&
        request.scope.kind !== "shell" &&
        request.scope.threadId === threadId,
    );
  }

  offerLive(scope: DetailScope, update: PersonalLiveUpdate, options?: LiveDeliveryOptions) {
    for (const current of this.#subscriptions.values()) {
      const subscribed = current.request.scope;
      if (
        !current.synchronized ||
        current.removed ||
        subscribed.kind !== scope.kind ||
        subscribed.threadId !== scope.threadId ||
        (subscribed.kind === "node" && scope.kind === "node" && subscribed.nodeId !== scope.nodeId)
      )
        continue;
      this.#queueLive(current, update, options);
    }
  }

  resyncLive(request: LiveResync) {
    const current = this.#subscriptions.get(request.subscriptionId);
    if (
      !current?.synchronized ||
      current.removed ||
      current.request.generation !== request.generation ||
      current.request.scope.kind === "shell"
    )
      return;
    for (const update of this.#port.readLive?.(current.request.scope, request) ?? [])
      this.#queueLive(current, update, { replace: true });
  }

  #queueLive(current: Subscription, update: PersonalLiveUpdate, options?: LiveDeliveryOptions) {
    // The global head includes unrelated work the slot never needs to read.
    // Its pending head already includes every commit affecting this scope.
    const delivered = BigInt(current.cursor?.afterSequence ?? 0);
    const scopeHead = delivered > current.pendingHead ? delivered : current.pendingHead;
    const barrier = BigInt(update.afterSequence);
    if (barrier > scopeHead && barrier <= this.#head)
      update = { ...update, afterSequence: scopeHead.toString() };
    const key = JSON.stringify([update.runId, update.attemptId, update.streamId]);
    const previous = current.live.get(key);
    current.live.delete(key);
    const entry = {
      update,
      immediate: options?.immediate ?? false,
      replace:
        update.itemId.startsWith("node:") ||
        options?.replace === true ||
        previous?.replace === true,
    };
    current.live.set(key, entry);
    let bytes = [...current.live.values()].reduce(
      (total, frame) => total + Buffer.byteLength(JSON.stringify(frame.update)) + 128,
      0,
    );
    for (const [id, frame] of current.live) {
      if (bytes <= 64 * 1024) break;
      current.live.delete(id);
      bytes -= Buffer.byteLength(JSON.stringify(frame.update)) + 128;
    }
    if (entry.immediate) {
      this.#schedule(current);
    } else if (!current.liveTimer && !current.liveReady) {
      current.liveTimer = setTimeout(() => {
        current.liveTimer = undefined;
        current.liveReady = true;
        this.#schedule(current);
      }, 50);
      current.liveTimer.unref?.();
    }
  }

  #readyLive(current: Subscription) {
    const through = BigInt(current.cursor?.afterSequence ?? 0);
    return [...current.live].filter(
      ([, { immediate, update }]) =>
        (immediate || current.liveReady) && BigInt(update.afterSequence) <= through,
    );
  }

  async #sendLive(current: Subscription) {
    if (current.request.subscriptionId === "shell" || current.request.scope.kind === "shell")
      return;
    for (const [key, entry] of this.#readyLive(current)) {
      const { update } = entry;
      const last = current.sentLive.get(key);
      const text = update.update;
      const append =
        !entry.replace &&
        last !== undefined &&
        text.operation === "replace" &&
        text.offset <= last &&
        last < text.totalLength;
      const { item: _item, ...identity } = update;
      const frame = append
        ? {
            ...identity,
            update: {
              operation: "append" as const,
              offset: last,
              totalLength: text.totalLength,
              text: text.text.slice(last - text.offset),
            },
          }
        : update;
      if (
        !(await this.#send(
          current,
          {
            ...frame,
            type: "host.live",
            subscriptionId: current.request.subscriptionId,
            generation: current.request.generation,
            scope: current.request.scope,
          },
          () => current.live.get(key) === entry,
        ))
      )
        return;
      if (current.live.get(key) === entry) current.live.delete(key);
      current.sentLive.delete(key);
      if (text.operation !== "close") current.sentLive.set(key, text.totalLength);
      if (current.sentLive.size > 64)
        current.sentLive.delete(current.sentLive.keys().next().value!);
    }
    if (![...current.live.values()].some(({ immediate }) => !immediate)) current.liveReady = false;
  }

  #matches(current: Subscription) {
    return (
      !this.#closed &&
      this.#subscriptions.get(current.request.subscriptionId) === current &&
      !current.controller.signal.aborted
    );
  }

  #reschedule() {
    for (const current of this.#subscriptions.values()) this.#schedule(current);
  }

  #schedule(current: Subscription) {
    current.checkCredit?.();
    if (
      !this.#matches(current) ||
      current.pauseCount > 0 ||
      current.sending ||
      current.removed ||
      (!this.#initialShellReady && current.request.subscriptionId !== "shell")
    )
      return;
    if (
      current.synchronized &&
      !current.repair &&
      current.pendingHead <= BigInt(current.cursor?.afterSequence ?? 0) &&
      !current.resources?.dirty &&
      this.#readyLive(current).length === 0
    )
      return;
    current.sending = true;
    void this.#drain(current)
      .catch((error: unknown) => {
        if (!this.#matches(current)) return;
        this.#port.onFailure?.(error);
        this.close("Personal scope delivery failed");
      })
      .finally(() => {
        current.sending = false;
        this.#schedule(current);
      });
  }

  async #drain(current: Subscription) {
    const { request, controller } = current;
    if (
      current.synchronized &&
      !current.repair &&
      current.pendingHead <= BigInt(current.cursor?.afterSequence ?? 0)
    ) {
      await this.#sendResources(current);
      await this.#sendLive(current);
      return;
    }
    const cursor = current.repair ? null : current.cursor;
    current.repair = false;
    const cut = await this.#port.read(
      request.scope,
      cursor,
      controller.signal,
      request.anchorItemId,
      this.#selectedThreadId,
    );
    if (!this.#matches(current)) return;
    const address = { subscriptionId: request.subscriptionId, generation: request.generation };
    for (const frame of cut.frames) {
      if (frame.type === "host.removed") {
        if (await this.#send(current, { ...frame, ...address })) current.removed = true;
        return;
      }
      const sent = await this.#send(current, { ...frame, ...address });
      if (!sent) return;
      if (!cut.cursor) throw new Error("A durable personal cut needs a cursor");
      if (frame.type === "host.snapshot" && "tasks" in frame.snapshot && current.resources) {
        for (const resource of frame.snapshot.resources ?? [])
          current.resources.installed = {
            ...current.resources.installed,
            [resource.kind]: resource.revision,
          };
      }
      current.cursor = { ...cut.cursor, afterSequence: frame.throughSequence };
    }
    if (!this.#matches(current) || current.pauseCount > 0 || !cut.cursor) return;
    current.cursor = cut.cursor;
    const watched = current.resources;
    if (watched && cut.shellProgress) {
      const revisions = cut.shellProgress.resourceRevisions;
      watched.dirty ||= watched.interests.some(
        (kind) => watched.installed[kind] !== revisions[kind],
      );
    }
    if (!current.synchronized) {
      const sent = await this.#send(current, {
        type: "host.synchronized",
        ...address,
        scope: request.scope,
        throughSequence: cut.throughSequence,
        ...(cut.shellProgress ? { shellProgress: cut.shellProgress } : {}),
      });
      if (sent) {
        current.synchronized = true;
        if (request.scope.kind !== "shell")
          for (const update of this.#port.readLive?.(request.scope) ?? [])
            this.#queueLive(current, update);
        if (request.subscriptionId === "shell" && !this.#initialShellReady) {
          this.#initialShellReady = true;
          this.#reschedule();
        }
      }
    }
    if (current.synchronized) {
      await this.#sendResources(current);
      await this.#sendLive(current);
    }
  }

  async #sendResources(current: Subscription) {
    const watch = current.resources;
    if (!watch?.dirty) return;
    watch.dirty = false;
    if (!this.#port.readResources || !watch.interests.length) return;
    const views = await this.#port.readResources(
      watch.interests,
      watch.installed,
      current.controller.signal,
    );
    for (const view of views) {
      if (current.resources !== watch || !this.#matches(current)) return;
      if (!watch.interests.includes(view.kind)) continue;
      const isCurrent = () => this.#port.isResourceCurrent?.(view.kind, view.revision) ?? true;
      if (!isCurrent()) {
        watch.dirty = true;
        continue;
      }
      const sent = await this.#send(
        current,
        {
          type: "host.resource",
          subscriptionId: "shell",
          generation: current.request.generation,
          ...view,
        },
        () => current.resources === watch && isCurrent(),
      );
      if (!sent) {
        if (!isCurrent()) {
          watch.dirty = true;
          continue;
        }
        watch.dirty = true;
        return;
      }
      watch.installed = { ...watch.installed, [view.kind]: view.revision };
    }
  }

  #hasCredit(current: Subscription, bytes: number, changes: number) {
    if (current.bytes + bytes > scopeBudget || current.changes + changes > 128) return false;
    let socketBytes = [...this.#subscriptions.values()].reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    let socketChanges = [...this.#subscriptions.values()].reduce(
      (sum, entry) => sum + entry.changes,
      0,
    );
    for (const [credit, entry] of this.#inFlight) {
      if (!this.#matches(entry)) {
        socketBytes += credit.bytes;
        socketChanges += credit.changes;
      }
    }
    return socketBytes + bytes <= socketBudget && socketChanges + changes <= 256;
  }

  async #send(current: Subscription, frame: ScopedHostMessage, stillCurrent = () => true) {
    const guard = () => this.#matches(current) && current.pauseCount === 0 && stillCurrent();
    if (!guard()) return false;
    const parsed = ScopedHostMessageSchema.safeParse(frame);
    if (!parsed.success) {
      if (frame.type !== "host.changes") throw parsed.error;
      // A replay that does not fit one frame is repaired by a snapshot on the next drain.
      current.repair = true;
      return false;
    }
    const encoded = JSON.stringify(parsed.data);
    const bytes = Buffer.byteLength(encoded);
    const changes = frame.type === "host.changes" ? frame.changes.length : 0;
    if (bytes > scopeBudget || changes > 128)
      throw new Error("A single personal frame exceeded its credit");
    try {
      // A scope out of credit pauses with this frame and its cut until the client acknowledges.
      while (guard() && !this.#hasCredit(current, bytes, changes)) {
        const available = Promise.withResolvers<void>();
        current.checkCredit = () => {
          if (!guard() || this.#hasCredit(current, bytes, changes)) available.resolve();
        };
        await available.promise;
      }
    } finally {
      delete current.checkCredit;
    }
    if (!guard()) return false;
    const durable = frame.type === "host.snapshot" || frame.type === "host.changes";
    const live = frame.type === "host.live";
    const credit: Credit = {
      through: "throughSequence" in frame ? frame.throughSequence : "0",
      bytes,
      changes,
      durable,
      acks: current.acks,
    };
    current.credit.push(credit);
    this.#inFlight.set(credit, current);
    current.bytes += bytes;
    current.changes += changes;
    let sent = false;
    try {
      const signal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(5000)]);
      sent = await this.#port.send(
        encoded,
        () => {
          if (!guard()) return false;
          if (durable || frame.type === "host.synchronized") {
            const through = BigInt(frame.throughSequence);
            if (current.dispatchedThrough === null || through > current.dispatchedThrough)
              current.dispatchedThrough = through;
          }
          return true;
        },
        signal,
      );
      if (!sent && guard()) this.close("Personal sync transport did not dispatch a frame");
      return sent && this.#matches(current);
    } finally {
      this.#inFlight.delete(credit);
      if ((!durable && !live) || !sent) {
        const index = current.credit.indexOf(credit);
        if (index >= 0) {
          current.credit.splice(index, 1);
          current.bytes -= bytes;
          current.changes -= changes;
        }
      }
      if (this.#releaseCredits(current) || (!durable && !live) || !sent || !this.#matches(current))
        this.#reschedule();
    }
  }
}
