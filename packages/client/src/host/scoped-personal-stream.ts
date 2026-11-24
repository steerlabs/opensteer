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
import type { TranscriptItem } from "@opensteer/protocol/transcript";
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
import {
  finalizedItemText,
  ThreadTranscriptStore,
  type TranscriptState,
} from "./thread-transcript-store.js";

type DetailScope = Exclude<PersonalScope, { kind: "shell" }>;
type DetailId = Extract<ScopedClientMessage, { type: "client.live.resync" }>["subscriptionId"];
type Subscribe = Extract<ScopedClientMessage, { type: "client.subscribe" }>;
type Live = Extract<ScopedHostMessage, { type: "host.live" }>;
/** A frame as the stream handles it: `host.text` resolves to the `host.live` its handle names. */
type Frame = Exclude<ScopedHostMessage, { type: "host.text" }>;
type LiveIdentity = Omit<Live, "update">;
/** More than the Host keeps per socket (64 streams in each of four detail slots). */
const maxLiveHandles = 512;
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
  /**
   * Where the reader is, as the last explicit move or the last measurement left it: absent at the
   * latest messages. Ordinary scrolling never changes it.
   */
  anchor?: string;
  /** Sets the anchor for an explicit move (a jump, a link, Return to latest) and tells the Host. */
  anchorTo(itemId: string | undefined): void;
  /**
   * Cuts the scope again from the Host, centred where the reader is: what it holds can no longer
   * be extended (the Host's history moved to a new epoch). Nothing while it is not subscribed.
   */
  recut(): void;
  /**
   * The view's one-shot measurement of the row in view: undefined at the latest messages. Asked
   * only when the position is needed (a repair, a subscription) and no move is under way.
   */
  measure?: (() => string | undefined | null) | undefined;
  /**
   * A move under way owns the position until it has landed (the view revealed its target) or
   * failed: its target is the anchor. `read` once its page is installed and the view is to reveal.
   */
  moving?:
    | {
        readonly intent: number;
        readonly target: string | undefined;
        /** Its page landed. */
        read?: boolean;
        /** The view revealed its target, possibly before the read settled. */
        revealed?: boolean;
      }
    | undefined;
  /**
   * The reader's explicit moves, numbered (a jump, a link, Return to latest). A jump's page, a
   * repair's reread and a subscription's first cut act only for the move they began under.
   */
  intent: number;
  /** Takes the next intent number, for a move the reader is about to make. */
  intend(): number;
  /** The intent current when this scope last subscribed: its first cut answers that one. */
  subscribedIntent: number;
  /** The anchor the Host was last told on this subscription. */
  sentAnchor?: string | null;
  controller?: AbortController | undefined;
  held?: Map<string, Live> | undefined;
  heldBytes: number;
  /** Live bytes received since this scope last acknowledged anything. */
  liveBytes: number;
  revision: number;
  /** Counts subscriptions; a checkpoint taken under an earlier one is not written. */
  subscriptions: number;
  /** The saved checkpoint for this scope was read, or is being read (`"reading"`). */
  saved?: "reading" | "read";
  /**
   * A saved cut whose task the current shell did not list: it only supplies the resume cursor, and
   * is installed once the Host's first reply on `generation` confirms the scope.
   */
  unconfirmed?: { readonly saved: DetailCheckpoint; generation: number };
}

/** The session's resource reads: what it watches, and the revisions the Host says changed. */
export interface PersonalResourcePort {
  interests(): { interests: PersonalResourceKind[]; installed: PersonalResourceRevisions };
  /** `reply`: the Host's answer to this client's attach or watch, not a live push. */
  changed(revisions: PersonalResourceRevisions, reply?: boolean): void;
}

type Identity = ScopedPersonalIdentity;
type Dirty = { readonly detail: ObservedDetail; readonly state: TranscriptState } | undefined;
type DetailCheckpoint = {
  readonly cursor: PersonalResumeCursor;
  readonly state: import("zod").infer<typeof PersonalDetailSnapshotSchema>;
};
type ShellCandidate = {
  readonly identity: Identity;
  readonly sessionId: AuthSessionId;
  readonly shell: {
    readonly cursor: PersonalResumeCursor;
    readonly state: import("zod").infer<typeof PersonalShellSnapshotSchema>;
  };
  readonly details: ReadonlyMap<string, DetailCheckpoint>;
};

/** How long a subscription, or the socket's attach, waits for saved state before going without. */
export const savedStartWaitMs = 150;

/** Saved checkpoints are written together, at most this often, in idle time. */
const checkpointIntervalMs = 2_000;

/** Inactive scopes kept in memory, most recently shown first, beyond the subscribed ones. */
const retainedDetails = 8;
/**
 * What those kept scopes may hold in inline text (UTF-16 code units, about 2 bytes each) past the
 * two most recent, which are always kept so going back and forth between tasks stays instant.
 */
const retainedTextBudget = 16 * 1024 * 1024;

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
  readonly #writes = new Map<string, () => Promise<void>>();
  #writing: Promise<void> | undefined;
  /**
   * Scopes whose checkpoint changed since the last flush, written together at most every 2 s. A
   * detail's entry holds its state as of the change, so leaving the task before the flush still
   * writes what it last showed.
   */
  readonly #dirty = new Map<string, Dirty>();
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #candidate: ShellCandidate | undefined;
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
  readonly #early: Frame[] = [];
  /** Live stream identities this socket's Host named, by handle. */
  readonly #handles = new Map<number, LiveIdentity>();
  readonly #deferred = new Set<ObservedDetail>();
  #selected: string | undefined;

  readonly cache: PersonalStreamCache | undefined;
  /** The Deployment a saved start is read for, also cleared when no viewer is known yet. */
  readonly #cacheDeploymentId: string | undefined;
  /** The cache fence this stream's identity was confirmed under; its writes carry it. */
  #fence: Promise<number> | undefined;

  constructor(
    cache?: PersonalStreamCache,
    resources?: PersonalResourcePort,
    cacheDeploymentId?: string,
    released?: () => void,
  ) {
    this.cache = cache;
    this.#resources = resources;
    this.#cacheDeploymentId = cacheDeploymentId;
    this.#released = released;
  }

  /** Told after the stream lets go of an inactive scope, so what was built on it can go too. */
  readonly #released: (() => void) | undefined;

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
      subscriptions: 0,
      anchorTo: (itemId) => this.#anchorTo(detail, itemId),
      recut: () => {
        if (detail.slot) this.#subscribe(detail, false, true);
      },
      intent: 0,
      intend: () => ++detail.intent,
      subscribedIntent: 0,
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

  /**
   * Reads the newest saved shell, and the selected task's saved detail, for a cold start. Nothing
   * from them is shown until the socket's attach reply confirms the same viewer, Deployment, epoch
   * and session; until then they only supply the resume cursors.
   */
  async restore() {
    if (!this.cache || this.#send || this.#identity) return;
    const authority = this.#authority;
    const shell = await this.cache.latestShell(this.#cacheDeploymentId).catch(() => null);
    const candidate = shell && validShellCheckpoint(shell);
    if (!candidate || this.#authority !== authority || this.#send || this.#identity) return;
    const details = new Map<string, DetailCheckpoint>();
    const selected = this.#selected ? this.#details.get(this.#selected) : undefined;
    if (selected) {
      const held = await this.cache
        .load({
          ...candidate.identity,
          scopeKey: scopeKey(selected.scope),
          format: personalCacheFormat,
        })
        .catch(() => null);
      const detail = held && validDetailCheckpoint(held, selected.scope, candidate.identity);
      if (detail) details.set(scopeKey(selected.scope), detail);
    }
    if (this.#authority !== authority || this.#send || this.#identity) return;
    this.#candidate = { ...candidate, details };
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
    const candidate = this.#candidate;
    const cursor = candidate
      ? candidate.shell.cursor
      : this.shell.checkpoint() && this.#cursor(shellScope, this.shell.getSnapshot().through);
    const selected =
      this.#selected && !this.#background ? this.#details.get(this.#selected) : undefined;
    const subscription = selected && !this.#mustLoad(selected) && this.#subscribe(selected, true);
    const saved = subscription && candidate?.details.get(scopeKey(subscription.scope));
    // The selected task's saved cut waits for the Host's reply on its own subscription.
    if (selected && subscription && saved)
      selected.unconfirmed = { saved, generation: subscription.generation };
    const interests = this.#interests();
    send({
      type: "client.attach",
      apiVersion: scopedPersonalApiVersion,
      ...(candidate
        ? { expectedSessionId: candidate.sessionId }
        : this.#sessionId
          ? { expectedSessionId: this.#sessionId }
          : {}),
      generation,
      ...interests,
      ...(cursor ? { cursor } : {}),
      ...(subscription && subscription.scope.kind === "thread"
        ? {
            selected: {
              ...subscription,
              scope: subscription.scope,
              ...(saved ? { cursor: saved.cursor } : {}),
            },
          }
        : {}),
    });
    this.#reconcile();
  }

  disconnect() {
    this.#send = undefined;
    this.#handles.clear();
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
      if (identity && this.cache)
        this.#enqueue(`thread-cache:${threadId}`, () =>
          this.cache!.removeThread(identity, threadId),
        );
    }
    return scopes;
  }

  /**
   * Clears a viewer's saved state, durably against any other writer. With no viewer known yet (a
   * refusal before the saved start was read), the whole Deployment's, or everything this storage
   * holds when the Deployment is not known either. The cache orders it before any later fence.
   */
  #purge(identity: ScopedPersonalIdentity | undefined) {
    if (!this.cache) return;
    this.#fence = undefined;
    const cleared = identity
      ? this.cache.removeViewer(identity)
      : this.#cacheDeploymentId !== undefined
        ? this.cache.removeDeployment(this.#cacheDeploymentId)
        : this.cache.clear();
    void cleared.catch(() => undefined);
  }

  /** This viewer is the socket's: its writes from now on carry the cache's current fence. */
  #confirm(identity: ScopedPersonalIdentity) {
    const changed =
      !this.#identity ||
      this.#identity.deploymentId !== identity.deploymentId ||
      this.#identity.viewerId !== identity.viewerId ||
      this.#identity.epoch !== identity.epoch;
    this.#identity = identity;
    if (this.cache && (changed || !this.#fence))
      this.#fence = this.cache.fence(identity).catch(() => -1);
  }

  setBackground(background: boolean) {
    if (background === this.#background) return;
    this.#background = background;
    if (background) this.flushCheckpoints();
    this.#reconcile();
  }

  clear(removeCheckpoints: boolean) {
    this.disconnect();
    this.#authority++;
    const identity = this.#identity ?? this.#candidate?.identity;
    this.#identity = undefined;
    this.#fence = undefined;
    this.#sessionId = undefined;
    this.#candidate = undefined;
    this.#dirty.clear();
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    this.shell.begin(++this.#generation, false);
    for (const detail of this.#details.values()) {
      detail.transcript.begin(++this.#generation, false);
      detail.text.clear();
      delete detail.saved;
      delete detail.unconfirmed;
    }
    if (removeCheckpoints) this.#purge(identity);
    this.#evict();
  }

  /**
   * Applies one frame. `wireBytes` is the received text's size, checked against the frame's limit;
   * a frame from the socket must also carry its shell's session.
   */
  receive(input: unknown, wireBytes?: number) {
    const parsed = ScopedHostMessageSchema.safeParse(input);
    if (!parsed.success) return false;
    if (wireBytes !== undefined && wireBytes > personalHostFrameMaxBytes(parsed.data))
      throw new Error("Personal scope frame exceeds its encoded limit.");
    if (
      wireBytes !== undefined &&
      parsed.data.type === "host.snapshot" &&
      "tasks" in parsed.data.snapshot &&
      !parsed.data.snapshot.session
    )
      throw new Error("The Host omitted its authenticated shell identity.");
    if (!this.#send) return true;
    const frame = this.#resolveLive(parsed.data);
    if (!frame) return true;
    if (frame.type === "host.live") this.#creditLive(frame, wireBytes ?? bytes(frame));
    if (frame.subscriptionId === "shell") this.#receiveShell(frame);
    else if (this.#shellReady || frame.type === "host.live") this.#receiveDetail(frame);
    else this.#hold(frame, wireBytes ?? bytes(frame));
    return true;
  }

  #resolveLive(frame: ScopedHostMessage): Frame | undefined {
    if (frame.type === "host.live") {
      const { update: _update, ...identity } = frame;
      this.#handles.set(frame.handle, identity);
      if (this.#handles.size > maxLiveHandles)
        this.#handles.delete(this.#handles.keys().next().value!);
      return frame;
    }
    if (frame.type !== "host.text") return frame;
    const identity = this.#handles.get(frame.h);
    if (!identity) return undefined;
    this.#handles.delete(frame.h);
    this.#handles.set(frame.h, identity);
    const text = { offset: frame.o, totalLength: frame.n, text: frame.t };
    return {
      ...identity,
      update:
        frame.incomplete === undefined
          ? { operation: "append", ...text }
          : { operation: "replace", ...text, incomplete: frame.incomplete },
    };
  }

  // Durable detail waits for the socket's first shell cut, which carries the viewer identity.
  // Past the buffer cap the detail is set aside and resubscribed once the shell is ready.
  #hold(frame: Frame, size: number) {
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

  #receiveShell(frame: Frame) {
    if (frame.generation !== this.shell.getSnapshot().generation) return;
    if (
      this.#candidate &&
      (frame.type === "host.snapshot" ||
        frame.type === "host.changes" ||
        frame.type === "host.synchronized")
    )
      this.#settleCandidate(frame);
    const previous = this.shell.getSnapshot();
    if (frame.type === "host.resource") {
      this.#resources?.changed(frame.revisions, frame.reply === true);
      return;
    }
    if (
      frame.type === "host.live" ||
      frame.type === "host.live-reset" ||
      frame.type === "host.removed"
    )
      return;
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
      this.#confirm({ deploymentId, viewerId, epoch });
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
    const gone =
      frame.type === "host.changes"
        ? frame.changes.flatMap((change) =>
            change.entityKind === "task" && change.operation === "remove" ? [change.entityId] : [],
          )
        : frame.type === "host.snapshot"
          ? [...previous.tasks.keys()].filter((id) => !this.shell.getSnapshot().tasks.has(id))
          : [];
    for (const threadId of gone) this.#forgetTask(threadId);
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

  /** The attach reply decides whether the saved state read for a cold start is this viewer's. */
  #settleCandidate(
    frame: Extract<
      ScopedHostMessage,
      { type: "host.snapshot" | "host.changes" | "host.synchronized" }
    >,
  ) {
    const candidate = this.#candidate!;
    this.#candidate = undefined;
    if (frame.type === "host.snapshot") {
      if (!("tasks" in frame.snapshot)) return;
      const { deploymentId, viewerId, epoch, session } = frame.snapshot;
      if (
        deploymentId !== candidate.identity.deploymentId ||
        viewerId !== candidate.identity.viewerId ||
        epoch !== candidate.identity.epoch ||
        session?.sessionId !== candidate.sessionId
      ) {
        // Another viewer, session or history: the saved state was never shown and is removed.
        this.#purge(candidate.identity);
        for (const detail of this.#details.values()) delete detail.unconfirmed;
        return;
      }
    }
    // A reply that is not a snapshot resumed from the saved cursor under the saved session.
    this.#confirm(candidate.identity);
    this.#sessionId = candidate.sessionId;
    if (frame.type !== "host.snapshot") {
      this.shell.apply({
        type: "host.snapshot",
        scope: shellScope,
        subscriptionId: "shell",
        generation: frame.generation,
        throughSequence: candidate.shell.cursor.afterSequence,
        snapshot: candidate.shell.state,
      });
    }
  }

  #discardViewerCheckpoints() {
    this.#authority++;
    this.#purge(this.#identity);
    this.#dirty.clear();
    this.#early.length = 0;
    this.#earlyBytes = 0;
    for (const detail of this.#details.values()) {
      detail.transcript.begin(++this.#generation, false);
      detail.text.clear();
      delete detail.saved;
      delete detail.unconfirmed;
    }
  }

  /** Whether the socket's current synchronized shell lists this task. */
  #listsTask(threadId: string) {
    const shell = this.shell.getSnapshot();
    return this.#shellReady && shell.synchronized && shell.tasks.has(threadId);
  }

  /** A task the shell no longer holds: its saved and retained cuts go, here and on disk. */
  #forgetTask(threadId: string) {
    for (const [key, detail] of this.#details) {
      if (detail.scope.threadId !== threadId) continue;
      delete detail.unconfirmed;
      if (detail.slot) continue;
      this.#dirty.delete(key);
      if (detail.observers > 0 || key === this.#selected) {
        detail.transcript.begin(++this.#generation, false);
        delete detail.saved;
      } else {
        this.#details.delete(key);
        this.#released?.();
      }
    }
    const identity = this.#identity;
    if (identity && this.cache)
      this.#enqueue(`thread-cache:${threadId}`, () => this.cache!.removeThread(identity, threadId));
  }

  #currentDetail(frame: Frame): ObservedDetail | undefined {
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

  #receiveDetail(frame: Frame) {
    if (frame.subscriptionId === "shell") return;
    const detail = this.#currentDetail(frame);
    if (!detail) return;
    if (frame.type === "host.live") {
      this.#live(detail, frame);
      return;
    }
    if (frame.type === "host.live-reset") {
      this.#liveReset(detail, frame);
      return;
    }
    // The Host's first reply confirms a saved cut it resumed from; a snapshot or removal replaces it.
    const unconfirmed = detail.unconfirmed;
    if (unconfirmed) {
      delete detail.unconfirmed;
      if (
        unconfirmed.generation === frame.generation &&
        (frame.type === "host.changes" || frame.type === "host.synchronized")
      ) {
        this.#installDetail(detail, unconfirmed.saved, frame.generation);
        detail.saved = "read";
      }
    }
    // A subscription's first cut answers the anchor it asked for: null means that row is gone.
    // A repair's cut may answer an older anchor; the reader reads around its own instead.
    if (
      frame.type === "host.snapshot" &&
      "items" in frame.snapshot &&
      detail.anchor &&
      frame.snapshot.anchorItemId === null &&
      !detail.transcript.getSnapshot().synchronized &&
      // Only the anchor this subscription asked for: the reader may have moved since.
      detail.intent === detail.subscribedIntent
    )
      delete detail.anchor;
    // A snapshot after `host.synchronized` is the Host's inline repair and applies in place. Where
    // the reader is goes with it, measured now, before the repair replaces what is on screen.
    if (
      frame.type === "host.snapshot" &&
      "items" in frame.snapshot &&
      detail.transcript.getSnapshot().synchronized
    )
      this.#position(detail);
    if (!detail.transcript.apply(frame, this.#identity, true)) {
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
    else if (frame.type === "host.snapshot" && "items" in frame.snapshot) {
      for (const item of frame.snapshot.items)
        if (finalizedItemText(item)) detail.text.finishItem(item.id);
      for (const item of frame.snapshot.activeItems)
        if (finalizedItemText(item)) detail.text.finishItem(item.id);
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

  /**
   * The Host dropped this scope's queued live state: only the streams it names are still open, and
   * each is named again by a replace. Every other stream's text, held frame and provisional card goes.
   */
  #liveReset(detail: ObservedDetail, frame: Extract<Frame, { type: "host.live-reset" }>) {
    const open = new Set(frame.open.map(({ runId, streamId }) => `${runId}\n${streamId}`));
    for (const [key, live] of detail.held ?? []) {
      if (open.has(`${live.runId}\n${live.streamId}`)) continue;
      detail.held!.delete(key);
      detail.heldBytes -= bytes(live);
    }
    detail.text.keep(frame.open);
    for (const id of detail.transcript.getSnapshot().liveItems.keys())
      if (!detail.text.get(id)) detail.transcript.liveItem(undefined, id, true);
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

  #anchorTo(detail: ObservedDetail, itemId: string | undefined) {
    if (itemId === undefined) delete detail.anchor;
    else detail.anchor = itemId;
    this.#sendAnchor(detail);
  }

  /**
   * Where the reader is, at the moment it is needed: a move under way owns it with its target;
   * otherwise the view measures the row in view, once, now; otherwise the last explicit anchor.
   */
  #position(detail: ObservedDetail) {
    // A measurement that cannot tell (null: the view is mid-layout) keeps the last place.
    const measured = detail.moving ? undefined : detail.measure?.();
    const at = detail.moving
      ? detail.moving.target
      : detail.measure && measured !== null
        ? measured
        : detail.anchor;
    if (at === undefined) delete detail.anchor;
    else detail.anchor = at;
  }

  #sendAnchor(detail: ObservedDetail) {
    const anchor = detail.anchor ?? null;
    if (!detail.slot || detail.sentAnchor === anchor) return;
    detail.sentAnchor = anchor;
    this.#send?.({
      type: "client.anchor",
      subscriptionId: detail.slot,
      generation: detail.transcript.getSnapshot().generation,
      ...(anchor === null ? {} : { anchorItemId: anchor }),
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

  #ack(frame: Extract<Frame, { throughSequence: string }>) {
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
      if (selected && !selected.slot && !this.#mustLoad(selected)) {
        if (this.#slots.size === detailIds.length) {
          const first = this.#slots.entries().next();
          if (!first.done) this.#unsubscribe(...first.value);
        }
        this.#subscribe(selected);
      }
      for (const detail of this.#details.values())
        if (this.#observed(detail) && !detail.slot && !this.#mustLoad(detail))
          this.#subscribe(detail);
    } else
      for (const detail of this.#details.values())
        if (this.#observed(detail) && !detail.slot) this.#mustLoad(detail);
    this.#evict();
  }

  /** Whether a scope must first read its saved checkpoint, so it can paint it and resume from it. */
  #mustLoad(detail: ObservedDetail) {
    const identity = this.#identity;
    if (!this.cache || !identity || detail.saved === "read") return false;
    if (detail.transcript.getSnapshot().snapshot) {
      detail.saved = "read";
      return false;
    }
    if (detail.saved === "reading") return true;
    detail.saved = "reading";
    const authority = this.#authority;
    // Storage never holds a subscription: past a short wait the scope subscribes without its
    // saved cut, and a read that lands later is dropped.
    const waited = setTimeout(() => {
      if (this.#authority !== authority || detail.saved !== "reading") return;
      detail.saved = "read";
      if (this.#details.get(scopeKey(detail.scope)) === detail) this.#reconcile();
    }, savedStartWaitMs);
    const key = {
      ...identity,
      scopeKey: scopeKey(detail.scope),
      format: personalCacheFormat,
    } as const;
    void this.cache
      .load(key)
      .catch(() => null)
      .then((held) => {
        clearTimeout(waited);
        if (this.#authority !== authority || detail.saved !== "reading") return;
        detail.saved = "read";
        const saved = held && validDetailCheckpoint(held, detail.scope, identity);
        if (saved && !detail.slot && !detail.transcript.getSnapshot().snapshot) {
          // Painted now only for a task the current shell lists; otherwise the Host confirms it.
          if (this.#listsTask(detail.scope.threadId)) {
            const generation = ++this.#generation;
            detail.transcript.begin(generation, false);
            this.#installDetail(detail, saved, generation);
          } else detail.unconfirmed = { saved, generation: 0 };
        }
        if (this.#details.get(scopeKey(detail.scope)) === detail) this.#reconcile();
      });
    return true;
  }

  #installDetail(detail: ObservedDetail, saved: DetailCheckpoint, generation: number) {
    return detail.transcript.apply(
      {
        type: "host.snapshot",
        scope: detail.scope,
        subscriptionId: detail.slot ?? "detail:0",
        generation,
        throughSequence: saved.cursor.afterSequence,
        snapshot: saved.state,
      },
      this.#identity,
    );
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
    detail.subscriptions++;
    detail.held = undefined;
    detail.heldBytes = 0;
    detail.liveBytes = 0;
    detail.slot = slot;
    this.#slots.set(slot, detail);
    detail.transcript.begin(generation, true);
    detail.text.generation(generation);
    if (repair) delete detail.unconfirmed;
    if (detail.unconfirmed) detail.unconfirmed.generation = generation;
    const cursor =
      !repair && detail.transcript.canCheckpoint()
        ? this.#cursor(detail.scope, detail.transcript.getSnapshot().through)
        : detail.unconfirmed?.saved.cursor;
    // The subscription centres on where the reader is now.
    this.#position(detail);
    const subscription = {
      subscriptionId: slot,
      scope: detail.scope,
      generation,
      ...(cursor ? { cursor } : {}),
      ...(detail.anchor ? { anchorItemId: detail.anchor } : {}),
    } satisfies Omit<Subscribe, "type">;
    detail.sentAnchor = detail.anchor ?? null;
    detail.subscribedIntent = detail.intent;
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

  /**
   * Keeps the most recently shown inactive scopes whole, so returning to one paints it at once and
   * resumes from its cursor. Each holds at most its trimmed window (see the transcript store).
   */
  #evict() {
    let kept = 0;
    let text = 0;
    const inactive = [...this.#details.entries()].reverse();
    for (const [key, detail] of inactive) {
      if (detail.slot || key === this.#selected) continue;
      const { items } = detail.transcript.getSnapshot();
      if (items.size > 0) {
        text += this.#inlineText(items);
        kept++;
        if (kept <= 2 || (kept <= retainedDetails && text <= retainedTextBudget)) continue;
      }
      if (detail.observers > 0) detail.transcript.begin(++this.#generation, false);
      else {
        this.#details.delete(key);
        this.#released?.();
      }
    }
  }

  readonly #inlineTexts = new WeakMap<ReadonlyMap<string, TranscriptItem>, number>();

  /** The inline text a window holds: what makes one large, without serializing it. */
  #inlineText(items: ReadonlyMap<string, TranscriptItem>) {
    let length = this.#inlineTexts.get(items);
    if (length !== undefined) return length;
    length = 0;
    for (const item of items.values()) if ("text" in item) length += item.text?.length ?? 0;
    this.#inlineTexts.set(items, length);
    return length;
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
    if (!this.cache || !this.#identity) return;
    // Only a synchronized cut is worth saving; a catch-up frame never replaces the last one marked.
    if (detail && !detail.transcript.getSnapshot().synchronized) return;
    this.#dirty.set(
      scopeKey(scope),
      detail && {
        detail,
        state: detail.transcript.getSnapshot(),
      },
    );
    this.#flushTimer ??= setTimeout(() => {
      const idle = globalThis.requestIdleCallback;
      if (idle) idle(() => this.flushCheckpoints(), { timeout: 1_000 });
      else this.flushCheckpoints();
    }, checkpointIntervalMs);
  }

  /** Writes every changed scope's checkpoint now: on the timer, when backgrounded or hidden. */
  flushCheckpoints() {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    const dirty = [...this.#dirty];
    this.#dirty.clear();
    for (const [key, entry] of dirty) {
      const checkpoint = this.#checkpointOf(entry);
      if (!checkpoint) continue;
      const authority = this.#authority;
      const fence = () =>
        entry ? entry.detail.subscriptions : this.shell.getSnapshot().generation;
      const taken = fence();
      const current = () => authority === this.#authority && fence() === taken;
      const written = this.#fence;
      if (!written) continue;
      const session = this.#sessionId;
      this.#enqueue(key, async () =>
        this.cache!.commit(checkpoint, current, await written, session),
      );
    }
  }

  #checkpointOf(entry: Dirty): PersonalStreamCheckpoint | undefined {
    const scope = entry?.detail.scope ?? shellScope;
    const state = entry ? entry.state : this.shell.getSnapshot();
    const cursor = this.#cursor(scope, state.through);
    const key = this.#key(scope);
    if (!cursor || !key || !state.synchronized) return;
    if (entry) {
      const { detail } = entry;
      // A scope let go for recency still writes what it showed; one replaced by another does not.
      const held = this.#details.get(key.scopeKey);
      if (held && held !== detail) return;
      const snapshot = detail.transcript.checkpoint(entry.state);
      if (!snapshot) return;
      const strip = (item: import("@opensteer/protocol/transcript").TranscriptItem) => {
        if (item.kind !== "message" || item.clientSendKey === undefined) return item;
        const { clientSendKey: _discard, ...view } = item;
        return view;
      };
      return {
        scope: key,
        cursor,
        kind: "detail",
        state: {
          ...snapshot,
          items: snapshot.items.map(strip),
          activeItems: snapshot.activeItems.map(strip),
        },
      };
    }
    const snapshot = this.shell.checkpoint();
    if (!snapshot?.session || snapshot.session.sessionId !== this.#sessionId) return;
    return {
      scope: key,
      cursor,
      kind: "shell",
      state: snapshot,
    };
  }

  #removeCheckpoint(scope: PersonalScope) {
    const key = this.#key(scope);
    this.#dirty.delete(scopeKey(scope));
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

function validShellCheckpoint(held: PersonalStreamCheckpoint): ShellCandidate | undefined {
  if (held?.kind !== "shell" || held.scope?.format !== personalCacheFormat) return;
  const cursor = PersonalResumeCursorSchema.safeParse(held.cursor);
  if (!cursor.success || cursor.data.scopeKey !== "shell") return;
  const identity = {
    deploymentId: cursor.data.deploymentId,
    viewerId: cursor.data.viewerId,
    epoch: cursor.data.epoch,
  };
  const frame = ScopedHostMessageSchema.safeParse({
    type: "host.snapshot",
    scope: shellScope,
    subscriptionId: "shell",
    generation: 1,
    throughSequence: cursor.data.afterSequence,
    snapshot: held.state,
  });
  if (!frame.success || frame.data.type !== "host.snapshot" || !("tasks" in frame.data.snapshot))
    return;
  const state = frame.data.snapshot;
  if (
    !sameIdentity(held.scope, identity) ||
    held.scope.scopeKey !== "shell" ||
    !sameIdentity(state, identity) ||
    !state.session ||
    state.session.user.id !== identity.viewerId
  )
    return;
  return {
    identity,
    sessionId: state.session.sessionId,
    shell: { cursor: cursor.data, state },
    details: new Map(),
  };
}

function validDetailCheckpoint(
  held: PersonalStreamCheckpoint,
  scope: DetailScope,
  identity: Identity,
): DetailCheckpoint | undefined {
  const key = scopeKey(scope);
  if (
    held?.kind !== "detail" ||
    held.scope?.format !== personalCacheFormat ||
    !sameIdentity(held.scope, identity) ||
    held.scope.scopeKey !== key
  )
    return;
  const cursor = PersonalResumeCursorSchema.safeParse(held.cursor);
  if (!cursor.success || !sameIdentity(cursor.data, identity) || cursor.data.scopeKey !== key)
    return;
  const frame = ScopedHostMessageSchema.safeParse({
    type: "host.snapshot",
    scope,
    subscriptionId: "detail:0",
    generation: 1,
    throughSequence: cursor.data.afterSequence,
    snapshot: held.state,
  });
  if (!frame.success || frame.data.type !== "host.snapshot" || "tasks" in frame.data.snapshot)
    return;
  return { cursor: cursor.data, state: frame.data.snapshot };
}

function sameIdentity(
  a: Pick<PersonalCacheScope, "deploymentId" | "viewerId" | "epoch">,
  b: Pick<PersonalCacheScope, "deploymentId" | "viewerId" | "epoch">,
) {
  return a.deploymentId === b.deploymentId && a.viewerId === b.viewerId && a.epoch === b.epoch;
}
