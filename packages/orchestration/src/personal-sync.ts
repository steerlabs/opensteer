import type { RunId } from "@opensteer/core";
import {
  personalAuthorityChangedReason,
  personalHostFrameMaxBytes,
  personalLiveResetMaxStreams,
  type PersonalResumeCursor,
  type PersonalScope,
  type ScopedClientMessage,
  type ScopedHostMessage,
} from "@opensteer/protocol/personal-sync";
import type {
  PersonalResourceKind,
  PersonalResourceRevisions,
} from "@opensteer/protocol/resources";

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
type TextFrame = Extract<ScopedHostMessage, { type: "host.text" }>;
type DetailScope = LiveFrame["scope"];
type LiveResync = Extract<ScopedClientMessage, { type: "client.live.resync" }>;
export type PersonalLiveUpdate = Omit<LiveFrame, "type" | "scope" | "handle" | keyof Address>;
type AddressedFrame = Exclude<ScopedHostMessage, TextFrame>;
type Unaddressed<T> = T extends AddressedFrame ? Omit<T, keyof Address> : never;
/** A frame before the socket addresses it; `host.text` carries a handle instead. */
export type PersonalOutgoingFrame = Unaddressed<AddressedFrame> | TextFrame;
type ShellProgress = Extract<ScopedHostMessage, { type: "host.synchronized" }>["shellProgress"];

interface ScopeCut {
  readonly throughSequence: string;
  readonly cursor: PersonalResumeCursor | null;
  readonly frames: readonly WithoutAddress<CutFrame>[];
  readonly shellProgress?: ShellProgress;
}

interface PersonalSyncPort {
  /** `atLeast`: every commit through it that touched the scope must be in the cut. */
  read(
    scope: PersonalScope,
    cursor: PersonalResumeCursor | null,
    signal: AbortSignal,
    anchorItemId: string | undefined,
    selectedThreadId: string | undefined,
    atLeast: string,
  ): Promise<ScopeCut>;
  send(encoded: string, dispatchGuard: () => boolean, signal: AbortSignal): Promise<boolean>;
  /** Current revisions, from memory; a detail read checks access. */
  resourceRevisions?(kinds: readonly PersonalResourceKind[]): PersonalResourceRevisions;
  readLive?(scope: DetailScope, request?: LiveResync): readonly PersonalLiveUpdate[];
  /** The streams of a scope still open, newest first. */
  liveStreams?(scope: DetailScope): readonly { runId: RunId; streamId: string }[];
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
  /** The stream's card changed: send its identity (`host.live`) again, not only its text. */
  readonly identify?: boolean;
}

interface PendingLive {
  readonly update: PersonalLiveUpdate;
  readonly immediate: boolean;
  readonly replace: boolean;
  /** Sends the stream's full identity under a new handle, as after a resync. */
  readonly identify: boolean;
  readonly bytes: number;
}

interface SentLive {
  readonly handle: number;
  readonly identity: string;
  readonly length: number;
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
  /** The reader's current anchor; a repair snapshot centres on it. */
  anchorItemId: string | undefined;
  removed: boolean;
  pauseCount: number;
  readonly live: Map<string, PendingLive>;
  liveBytes: number;
  readonly sentLive: Map<string, SentLive>;
  liveTimer?: ReturnType<typeof setTimeout> | undefined;
  liveReady?: boolean;
  /** Queued live state overflowed: it was dropped and the scope is repaired, then live is reread. */
  liveReset?: boolean;
  checkCredit?: () => void;
  resources?: { interests: Watch["interests"]; installed: Watch["installed"]; dirty: boolean };
}

const scopeBudget = 256 * 1024;
const socketBudget = 512 * 1024;
const liveQueueBytes = 64 * 1024;
/** Identity, item card and framing a queued live update may add to its text. */
const liveEntryOverhead = 640;

const encodedBodies = new WeakMap<object, { readonly rest: string; readonly bytes: number }>();

/**
 * Encodes a frame for one socket. The body after the address is encoded once per frame object,
 * so a cut shared by several sockets is stringified once; the result equals `JSON.stringify` of
 * `{ type, subscriptionId, generation, ...rest }`.
 */
export function encodePersonalFrame(frame: PersonalOutgoingFrame, address: Address) {
  if (frame.type === "host.text") {
    const encoded = JSON.stringify(frame);
    return { encoded, bytes: Buffer.byteLength(encoded) };
  }
  let body = encodedBodies.get(frame);
  if (!body) {
    const { type: _type, ...rest } = frame;
    const json = JSON.stringify(rest);
    const tail = json === "{}" ? "}" : `,${json.slice(1)}`;
    body = { rest: tail, bytes: Buffer.byteLength(tail) };
    encodedBodies.set(frame, body);
  }
  const head = `{"type":${JSON.stringify(frame.type)},"subscriptionId":${JSON.stringify(address.subscriptionId)},"generation":${address.generation}`;
  return { encoded: head + body.rest, bytes: head.length + body.bytes };
}

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
  #nextHandle = 0;

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

  resourcesChanged(kinds: ReadonlySet<PersonalResourceKind>) {
    const current = this.#subscriptions.get("shell");
    if (!current?.resources?.interests.some((kind) => kinds.has(kind))) return;
    current.resources.dirty = true;
    this.#schedule(current);
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
      anchorItemId: request.anchorItemId,
      removed: false,
      live: new Map(),
      liveBytes: 0,
      sentLive: new Map(),
      pauseCount: [...this.#fences].filter((matches) => matches(request.scope)).length,
      ...(watch ? { resources: { ...watch, dirty: true } } : {}),
    };
    if (prior) this.#cancel(prior);
    this.#generations.set(request.subscriptionId, request.generation);
    this.#subscriptions.set(request.subscriptionId, current);
    this.#reschedule();
  }

  anchor(message: Address & { readonly anchorItemId?: string | undefined }) {
    const current = this.#subscriptions.get(message.subscriptionId);
    if (!current || current.request.generation !== message.generation) return;
    current.anchorItemId = message.anchorItemId;
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
    current.liveBytes = 0;
    current.sentLive.clear();
    current.controller.abort();
    current.checkCredit?.();
  }

  /** Threads with a detail subscription on this socket (at most four). */
  watchedScopes(): DetailScope[] {
    return [...this.#subscriptions.values()].flatMap(({ request, removed }) =>
      request.scope.kind === "shell" || removed ? [] : [request.scope],
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
      this.#queueLive(current, update, options, options?.identify === true);
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
      this.#queueLive(current, update, { replace: true }, true);
  }

  #queueLive(
    current: Subscription,
    update: PersonalLiveUpdate,
    options?: LiveDeliveryOptions,
    identify = false,
  ) {
    // The global head includes unrelated work the slot never needs to read.
    // Its pending head already includes every commit affecting this scope.
    const delivered = BigInt(current.cursor?.afterSequence ?? 0);
    const scopeHead = delivered > current.pendingHead ? delivered : current.pendingHead;
    const barrier = BigInt(update.afterSequence);
    if (barrier > scopeHead && barrier <= this.#head)
      update = { ...update, afterSequence: scopeHead.toString() };
    if (current.liveReset) return;
    const key = JSON.stringify([update.runId, update.attemptId, update.streamId]);
    const previous = current.live.get(key);
    if (previous) {
      current.live.delete(key);
      current.liveBytes -= previous.bytes;
    }
    const text = update.update;
    const entry: PendingLive = {
      update,
      immediate: options?.immediate ?? false,
      replace:
        update.itemId.startsWith("node:") ||
        options?.replace === true ||
        previous?.replace === true,
      identify: identify || previous?.identify === true,
      bytes: liveEntryOverhead + (text.operation === "close" ? 0 : Buffer.byteLength(text.text)),
    };
    current.live.set(key, entry);
    current.liveBytes += entry.bytes;
    // Text past the cap is dropped oldest first and repaired by offsets; a close is never
    // dropped, so a stalled viewer always learns that a stream ended.
    for (const [id, pending] of current.live) {
      if (current.liveBytes <= liveQueueBytes) break;
      if (pending.update.update.operation === "close") continue;
      current.live.delete(id);
      current.liveBytes -= pending.bytes;
    }
    // Only closes are left over the cap: the viewer stopped taking credit. Drop the queue and
    // converge with one repair snapshot plus the streams still open, instead of growing.
    if (current.liveBytes > liveQueueBytes) {
      current.live.clear();
      current.liveBytes = 0;
      current.liveReset = true;
      current.repair = true;
      this.#schedule(current);
      return;
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
    const scope = current.request.scope;
    for (const [key, entry] of this.#readyLive(current)) {
      const { update } = entry;
      const text = update.update;
      const identity = JSON.stringify([update.liveBootId, update.bindingGeneration, update.itemId]);
      const sent = current.sentLive.get(key);
      const known =
        sent !== undefined &&
        sent.identity === identity &&
        !entry.identify &&
        text.operation !== "close";
      const handle = known ? sent.handle : ++this.#nextHandle;
      let frame: PersonalOutgoingFrame;
      if (!known) frame = { ...update, type: "host.live", handle, scope };
      else if (text.operation === "append")
        frame = { type: "host.text", h: handle, o: text.offset, n: text.totalLength, t: text.text };
      else if (
        text.operation === "replace" &&
        !entry.replace &&
        text.offset <= sent.length &&
        sent.length < text.totalLength
      )
        frame = {
          type: "host.text",
          h: handle,
          o: sent.length,
          n: text.totalLength,
          t: text.text.slice(sent.length - text.offset),
        };
      else if (text.operation === "replace")
        frame = {
          type: "host.text",
          h: handle,
          o: text.offset,
          n: text.totalLength,
          t: text.text,
          incomplete: text.incomplete,
        };
      else continue;
      if (!(await this.#send(current, frame, () => current.live.get(key) === entry))) return;
      if (current.live.get(key) === entry) {
        current.live.delete(key);
        current.liveBytes -= entry.bytes;
      }
      current.sentLive.delete(key);
      if (text.operation !== "close")
        current.sentLive.set(key, { handle, identity, length: text.totalLength });
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
    const liveReset = current.liveReset === true;
    const cut = await this.#port.read(
      request.scope,
      cursor,
      controller.signal,
      current.anchorItemId,
      this.#selectedThreadId,
      current.pendingHead.toString(),
    );
    if (!this.#matches(current)) return;
    for (const frame of cut.frames) {
      if (frame.type === "host.removed") {
        if (await this.#send(current, frame)) current.removed = true;
        return;
      }
      const sent = await this.#send(current, frame);
      if (!sent) return;
      if (!cut.cursor) throw new Error("A durable personal cut needs a cursor");
      current.cursor = { ...cut.cursor, afterSequence: frame.throughSequence };
    }
    if (!this.#matches(current) || current.pauseCount > 0 || !cut.cursor) return;
    current.cursor = cut.cursor;
    if (liveReset && current.synchronized && request.scope.kind !== "shell") {
      // The reader learns exactly which streams survive; every other live item of the scope ends.
      const sent = await this.#send(current, {
        type: "host.live-reset",
        scope: request.scope,
        open: (this.#port.liveStreams?.(request.scope) ?? [])
          .slice(0, personalLiveResetMaxStreams)
          .map(({ runId, streamId }) => ({ runId, streamId })),
      });
      if (!sent) return;
      current.liveReset = false;
      current.sentLive.clear();
      for (const update of this.#port.readLive?.(request.scope) ?? [])
        this.#queueLive(current, update, { replace: true }, true);
    }
    if (!current.synchronized) {
      const sent = await this.#send(current, {
        type: "host.synchronized",
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
    if (!this.#port.resourceRevisions || !watch.interests.length) return;
    const latest = this.#port.resourceRevisions(watch.interests);
    const revisions = Object.fromEntries(
      watch.interests.flatMap((kind) =>
        latest[kind] && latest[kind] !== watch.installed[kind] ? [[kind, latest[kind]]] : [],
      ),
    );
    if (!Object.keys(revisions).length) return;
    const sent = await this.#send(
      current,
      { type: "host.resource", revisions },
      () => current.resources === watch,
    );
    if (sent) watch.installed = { ...watch.installed, ...revisions };
    else watch.dirty = true;
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

  async #send(current: Subscription, frame: PersonalOutgoingFrame, stillCurrent = () => true) {
    const guard = () => this.#matches(current) && current.pauseCount === 0 && stillCurrent();
    if (!guard()) return false;
    const { encoded, bytes } = encodePersonalFrame(frame, current.request);
    if (bytes > personalHostFrameMaxBytes(frame)) {
      if (frame.type !== "host.changes")
        throw new Error(`A ${frame.type} frame exceeded its limit`);
      // A replay that does not fit one frame is repaired by a snapshot on the next drain.
      current.repair = true;
      return false;
    }
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
    const live = frame.type === "host.live" || frame.type === "host.text";
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
