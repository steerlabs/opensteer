import type {
  BrowserPoolControl,
  BrowserPoolEndAnswer,
  BrowserPoolDocument,
  BrowserPoolRuntimeFence,
  BrowserPoolRuntimeState,
} from "@opensteer/browser-runtime-core";
import type { BrowserSessionId, RunnerId } from "@opensteer/core";
import {
  advanceBrowserPoolSlot,
  beginBrowserPoolPark,
  BrowserPoolAdmissionClosed,
  withDatabaseOperationSignal,
  browserPoolSlotIdentity,
  installBrowserPoolSlot,
  listBrowserPoolRuntimeSessions,
  listAppliedBrowserPoolStarts,
  markBrowserPoolStartInstalled,
  listBrowserPoolSessionTabs,
  pruneBrowserPoolBookkeeping,
  announceBrowserPool,
  recordBrowserPoolStartFailure,
  beginBrowserPoolRelease,
  finishBrowserPoolRelease,
  readAppliedBrowserPoolControllerCall,
  readBrowserPoolSlot,
  readBrowserPoolRevocation,
  type BrowserPoolSessionLoss,
  type BrowserPoolSlot,
  type BrowserPoolTargetIdentity,
  type DatabaseSchema,
} from "@opensteer/database";
import type { Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { pooledSessionWithoutChannelMs } from "@opensteer/browser-runtime-core";
import {
  BrowserPoolControllerJournal,
  expectationOf,
  type BrowserPoolControllerResult,
  type BrowserPoolPhysicalController,
  type BrowserPoolPhysicalStatus,
  BrowserPoolUnanswered,
} from "./browser-pool-controller.js";
import { BrowserPoolGate } from "./browser-pool-gate.js";
import {
  BrowserPoolAgentSlotDeleted,
  BrowserPoolAgentUnavailable,
} from "./browser-pool-agent-client.js";

/** The runtime's signed control channel; in-process for the loopback target. */
/**
 * The Home's way to the runtime inside the guest. A remote one cannot always answer: with no
 * guest (stopped) or a paused one there is no runtime to ask, and it says so as `null`, never by
 * throwing. A throw or a deadline is not knowing, and the loop asks again later.
 */
export interface BrowserPoolRuntimeChannel {
  poolState(signal?: AbortSignal): Promise<BrowserPoolRuntimeState | null>;
  controlPool(control: BrowserPoolControl, signature: Uint8Array): Promise<BrowserPoolRuntimeState>;
  /**
   * Asks the runtime to end one session, under a single-use ticket the Home signed for it and
   * this fence (P15); the answer is given after the runtime's own teardown. A throw is not
   * knowing: the row stays closing and the end step asks again.
   */
  endSession(ticket: string, signal?: AbortSignal): Promise<BrowserPoolEndAnswer>;
}

/** A runtime in this process (loopback): its state is always there to read. */
export function loopbackPoolChannel(runtime: {
  poolState(): BrowserPoolRuntimeState | undefined;
  controlPool(control: BrowserPoolControl, signature: Uint8Array): Promise<BrowserPoolRuntimeState>;
  endPoolSession(ticket: string): Promise<BrowserPoolEndAnswer>;
}): BrowserPoolRuntimeChannel {
  return {
    poolState: async () => runtime.poolState() ?? null,
    controlPool: (control, signature) => runtime.controlPool(control, signature),
    endSession: (ticket) => runtime.endPoolSession(ticket),
  };
}

/** What the Home does per session; one session's failure is that session's alone. */
export interface BrowserPoolAdopter {
  /** Live pages the Home believes the runtime has, before a retire. */
  inventory(): readonly { readonly sessionId: BrowserSessionId; readonly surfaceId: string }[];
  /** Reattach each session under fresh authority; returns tabs lost inside adopted sessions. */
  reattach(input: {
    readonly sessions: readonly BrowserSessionId[];
    readonly documents: readonly BrowserPoolDocument[];
    readonly fence: BrowserPoolRuntimeFence;
    readonly attempt: number;
    /** The attempt stops when this aborts; nothing of it is left running. */
    readonly signal?: AbortSignal;
  }): Promise<readonly BrowserPoolSessionLoss[]>;
  /** Whether this session has a live channel here now. */
  live(sessionId: BrowserSessionId): boolean;
  /** The pages the Home keeps for this session: the notes of its end name them. */
  pagesOf(sessionId: BrowserSessionId): Promise<readonly string[]>;
  /** Ready sessions of this runtime with no channel here: the loop reattaches or ends them. */
  withoutChannel(runtimeId: string): Promise<readonly BrowserSessionId[]>;
  /**
   * Before a restart replaces the guest: revoke unredeemed tickets and close every connection
   * and broker of the runtime without ending its row, so each send has its outcome.
   */
  quiesce(signal?: AbortSignal): Promise<void>;
  /**
   * Sessions of this runtime a Stop is ending and that have no broker here: each one stays
   * closing until the runtime answers for it.
   */
  ending?(runtimeId: string): Promise<readonly BrowserSessionId[]>;
  /**
   * The single-use ticket for the runtime's end request of a stopped session, under this fence
   * (P15): no channel is opened and no attachment spent. `gone`: the row is no longer closing
   * (another path ended it, with its own evidence); `undefined`: none can be issued now.
   */
  endTicket?(input: {
    readonly sessionId: BrowserSessionId;
    readonly fence: BrowserPoolRuntimeFence;
    readonly signal?: AbortSignal;
  }): Promise<string | "gone" | undefined>;
  /** The runtime that serves this fence answered that it ended the stopped session. */
  ended?(sessionId: BrowserSessionId): Promise<void>;
}

export type BrowserPoolRuntimeFault = "request" | "reply";

export interface BrowserPoolCoordinatorOptions {
  readonly database: Kysely<DatabaseSchema>;
  readonly runnerId: RunnerId;
  readonly runtimeId: string;
  readonly slotId: string;
  readonly term: number;
  readonly runtime: BrowserPoolRuntimeChannel;
  readonly controller: BrowserPoolPhysicalController;
  readonly retryMs?: number;
  /**
   * The first wait after the controller refused a start or a wake it did not apply, and nothing
   * of the guest was lost (5 s; it doubles to five minutes). Demand, a restart or a removal ends
   * the wait.
   */
  readonly refusedRetryMs?: number;
  /** How long a lost Runner channel may take to come back before its sessions end. */
  readonly channelDeadlineMs?: number;
  /** How long a restart waits for every holder to let go before it settles them itself. */
  readonly quiesceMs?: number;
  /** Every controller call and runtime control has this deadline; then its outcome is read. */
  readonly callTimeoutMs?: number;
  /** How often finished bookkeeping past its retention is removed, idle or not. */
  readonly pruneEveryMs?: number;
  readonly onError?: (error: unknown) => void;
  /**
   * The target may be over: it answered so, signed, or this target's calls have gone unanswered
   * (or been refused unsigned) for `unansweredMs`. The Home asks its account for its target.
   */
  readonly onSuspect?: () => void;
  /** How long calls may go unanswered before the target is suspected (two minutes). */
  readonly unansweredMs?: number;
  /** Tests lose a commit's reply, a read, or a journal acknowledgement. */
  readonly testHooks?: {
    readonly beginPark?: typeof beginBrowserPoolPark;
    readonly readSlot?: typeof readBrowserPoolSlot;
    readonly settleCall?: (id: string, result: Readonly<Record<string, unknown>>) => Promise<void>;
    readonly markInstalled?: typeof markBrowserPoolStartInstalled;
  };
  /** Tests lose a runtime control's request or its reply. */
  readonly runtimeFault?: (kind: BrowserPoolControl["kind"]) => BrowserPoolRuntimeFault | undefined;
}

interface Retained {
  readonly documents: readonly BrowserPoolDocument[];
  readonly sessions: readonly BrowserSessionId[];
}

/**
 * The Home's half of the pool for one target: the owner of intent. One loop drives every state,
 * including one found after a Home restart, to an open or parked gate; a step that keeps failing
 * may give live state up for a fresh guest, chosen like any other step, and never ends closed.
 *
 * Not wired yet (the next piece, with the provisioner): the Home selects a coordinator for a
 * managed pooled target and passes it to `BrowserService` by Runner id. Its idle rule calls
 * `tryPark()` when the browser is open and nobody holds it (no reservation, no viewer, no
 * connected agent's work) for the idle period; a park any send vetoes is simply asked again at
 * the next idle period. Until then only tests construct one and call `tryPark()`.
 */
export class BrowserPoolCoordinator {
  readonly gate = new BrowserPoolGate();
  readonly #options: BrowserPoolCoordinatorOptions;
  readonly #journal: BrowserPoolControllerJournal;
  #slot: BrowserPoolSlot | undefined;
  #adopter: BrowserPoolAdopter | undefined;
  #closed = false;
  #ended = false;
  #display: { phase: "starting" | "restarting" | "failed"; since: Date } | undefined;
  // What is wanted: set by anyone, cleared only by the loop finishing it.
  #released:
    | { readonly ended: Set<BrowserSessionId>; readonly noted: PromiseWithResolvers<void> }
    | undefined;
  #restartWanted:
    | {
        readonly keys: Set<string>;
        readonly done: PromiseWithResolvers<void>;
        /** Asked before any slot existed: the first install answers it. */
        firstInstall?: boolean;
      }
    | undefined;
  #parkWanted: PromiseWithResolvers<"parked" | "vetoed"> | undefined;
  #parkSettling = false;
  #unknownIntent: string | undefined;
  /** When the loop first saw each ready session without a channel: its window runs from there. */
  /** Each session without a channel: when its window began, and its documents then, if known. */
  readonly #lost = new Map<
    BrowserSessionId,
    { readonly since: number; readonly documents?: ReadonlyMap<string, string> }
  >();
  #recovered = false;
  readonly #recovering = Promise.withResolvers<void>();
  readonly #releasedForGood = Promise.withResolvers<void>();
  #changed = new AbortController();
  #running: Promise<void> | undefined;
  /** The step running now, and the signal everything it awaits takes: its deadline or a removal. */
  #step: { readonly name: string; readonly preempt: AbortController } | undefined;
  /** The selection of the next step, while it reads: a removal ends it. */
  #selecting: AbortController | undefined;
  #signal: AbortSignal | undefined;
  /** Live state is given up for (R3): a step the next turn may choose, never run from a catch. */
  #discardWanted: string | undefined;
  /**
   * The target answered, signed, that this Home's guest is gone (`slot-deleted`, `fenced`): its
   * sessions are ended, nothing more is sent to it, and the loop waits for a new target.
   */
  #over: string | undefined;
  /**
   * The end of an over target's sessions: a step of its own, repeated until it has succeeded
   * (P18). `settle`: holders still sending are settled with their outcomes first (a swap).
   */
  #overEnd:
    { done: boolean; settle: boolean; readonly ended: PromiseWithResolvers<void> } | undefined;
  /** The controller's reason for the last start or wake it refused; cleared once one applies. */
  #refused: { readonly reason: string; readonly since: Date } | undefined;

  constructor(options: BrowserPoolCoordinatorOptions) {
    this.#options = options;
    this.#journal = new BrowserPoolControllerJournal(
      options.database,
      options.controller,
      options.runnerId,
      options.callTimeoutMs,
      options.testHooks?.settleCall,
    );
    // An idle browser's finished bookkeeping ages out too, not only on the paths that write.
    this.#pruning = setInterval(() => {
      void this.#prune();
    }, options.pruneEveryMs ?? defaultPruneEveryMs);
    this.#pruning.unref();
    // A waiter with demand, or anything else the gate learns, asks the loop to look again.
    this.gate.onChange = () => this.#kick();
  }

  setAdopter(adopter: BrowserPoolAdopter): void {
    this.#adopter = adopter;
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#pruning);
    this.#kick();
  }

  readonly #pruning: ReturnType<typeof setInterval>;

  async #prune(): Promise<void> {
    if (this.#closed) return;
    const slot = await readBrowserPoolSlot(this.#options.database, this.#options.runnerId).catch(
      () => undefined,
    );
    if (slot && slot.phase !== "releasing")
      await pruneBrowserPoolBookkeeping(this.#options.database, slot).catch((error: unknown) =>
        this.#options.onError?.(error),
      );
  }

  get runtimeId(): string {
    return this.#options.runtimeId;
  }

  get runnerId(): RunnerId {
    return this.#options.runnerId;
  }

  identity(): BrowserPoolTargetIdentity {
    if (!this.#slot) throw new BrowserPoolAdmissionClosed();
    return browserPoolSlotIdentity(this.#slot);
  }

  /** The claim every ticket for this runtime carries. */
  fence(): BrowserPoolRuntimeFence & { readonly attachment: number } {
    const slot = this.#slot;
    if (!slot) throw new BrowserPoolAdmissionClosed();
    return {
      slot: slot.slotId,
      term: slot.term,
      instance: slot.instanceId,
      epoch: slot.epoch,
      attachment: slot.attachmentGeneration,
    };
  }

  /**
   * While the browser is away, the document last known stands for the live one: retained by a
   * park, or held when the session's channel was lost.
   */
  knownDocument(sessionId: BrowserSessionId, surfaceId: string): string | undefined {
    // A running browser's last park no longer says what its pages hold.
    const retained = this.#slot?.phase === "running" ? undefined : retainedOf(this.#slot);
    return (
      this.#lost.get(sessionId)?.documents?.get(surfaceId) ??
      retained?.documents.find(
        (document) => document.sessionId === sessionId && document.surfaceId === surfaceId,
      )?.documentId
    );
  }

  // ---- What is wanted, and the loop -------------------------------------------------------

  /** Starts the loop; resolves once the browser was first recovered, or the device released. */
  recover(): Promise<void> {
    this.#start();
    return this.#recovering.promise;
  }

  /** Asks the loop to park; resolves with where the browser ended. Vetoed at once if it cannot. */
  tryPark(): Promise<"parked" | "vetoed"> {
    if (this.#parkWanted) return this.#parkWanted.promise;
    if (!this.gate.admits || this.gate.held) return Promise.resolve("vetoed");
    this.#parkWanted = Promise.withResolvers();
    this.#kick();
    return this.#parkWanted.promise;
  }

  /**
   * Whether a Stop of a session with no channel waits for the runtime's answer: an awake guest
   * may still hold it. A parked guest is not woken for a Stop; its next adoption omits the row.
   */
  stopWaitsForRuntime(): boolean {
    return this.#slot?.phase !== "parked";
  }

  /** A Stop left a session closing with no channel: the loop ends it with the runtime's answer. */
  stopped(): void {
    this.#kick();
  }

  /** The session has no channel and is inside its window: the loop is reattaching it. */
  reattaching(sessionId: BrowserSessionId): boolean {
    return this.#lost.has(sessionId);
  }

  /** A pooled session's Runner channel was lost: the loop reattaches it inside its window. */
  channelLost(sessionId: BrowserSessionId, documents?: ReadonlyMap<string, string>): void {
    if (this.#closed) return;
    // Each close is its own loss, with its own window and documents: one that arrives while the
    // previous attach is being finished replaces that entry, so the attach cannot delete it.
    this.#lost.set(sessionId, { since: Date.now(), ...(documents ? { documents } : {}) });
    this.#publish(this.#slot);
    // The reconnect step reads every loss again after its backoff: a channel lost while it runs
    // does not end that backoff, or a channel that keeps dropping would be dialled in a loop.
    if (this.#step?.name !== "reconnect") this.#kick();
  }

  /**
   * The device was removed. Admission is released for good at once; the loop ends every session
   * with its note (the ones the revocation already ended included), stops the guest with
   * evidence and lets the slot go. Resolves once the notes are written.
   */
  releaseDevice(ended: readonly BrowserSessionId[] = []): Promise<void> {
    this.#released ??= { ended: new Set(), noted: Promise.withResolvers() };
    for (const sessionId of ended) this.#released.ended.add(sessionId);
    this.gate.set({ hold: "released" });
    // A removal goes first: the step under way stops awaiting, and the next turn is the release.
    if (this.#step && this.#step.name !== "release")
      this.#step.preempt.abort(new BrowserPoolAdmissionClosed("This device was removed."));
    // A selection under way stops too: the next one chooses the release.
    this.#selecting?.abort(new BrowserPoolAdmissionClosed("This device was removed."));
    this.#start();
    this.#kick();
    return this.#released.noted.promise;
  }

  /** The removal's end: the guest is known stopped and the slot is gone. */
  released(): Promise<void> {
    return this.#releasedForGood.promise;
  }

  /**
   * The owner's Restart browser. Admission is held from now until the fresh guest is installed;
   * a restart asked while one is wanted joins it, and every key it was asked with is recorded
   * against the one outcome. A removal goes first.
   */
  restart(input: { readonly key?: string } = {}): Promise<void> {
    if (this.#released)
      return Promise.reject(new BrowserPoolAdmissionClosed("This device was removed."));
    if (this.#over)
      return Promise.reject(new BrowserPoolAdmissionClosed("This browser is not ready."));
    this.#restartWanted ??= { keys: new Set(), done: Promise.withResolvers() };
    // Past the bound a key joins the same outcome without being recorded.
    if (input.key && this.#restartWanted.keys.size < restartKeysKept)
      this.#restartWanted.keys.add(input.key);
    this.gate.set({ hold: "restart" });
    this.#start();
    this.#kick();
    return this.#restartWanted.done.promise;
  }

  #start(): void {
    if (this.#running || this.#closed) return;
    this.#running = this.#run().finally(() => {
      this.#running = undefined;
    });
  }

  #kick(): void {
    const previous = this.#changed;
    this.#changed = new AbortController();
    previous.abort();
  }

  /**
   * The one loop. Each turn reads what is so (the slot row, the sessions without a channel; the
   * controller and the runtime inside the step that needs them) and takes the single next step
   * for what is wanted, first match wins. A failed step is tried again by a later turn, after a
   * backoff any change ends, so a higher line always gets in between two tries.
   */
  async #run(): Promise<void> {
    let failures = 0;
    /** Answers that did not come, or came unsigned, in a row: paced apart, never counted (P18). */
    let unanswered = 0;
    let failing: string | undefined;
    let refusals = 0;
    /** Since when this target's steps have failed, and when it was last suspected for it. */
    let failingSince: number | undefined;
    let suspectedAt: number | undefined;
    while (!this.#closed && !this.#ended) {
      const changed = this.#changed.signal;
      let step: Step | undefined;
      try {
        // Choosing the next step reads the database too: it has a bound, and a removal ends it.
        const selecting = new AbortController();
        this.#selecting = selecting;
        try {
          step = await withDatabaseOperationSignal(
            AbortSignal.any([selecting.signal, AbortSignal.timeout(selectionMs)]),
            Date.now() + selectionMs,
            () => this.#next(),
          );
        } finally {
          this.#selecting = undefined;
        }
        if (!step) {
          failures = 0;
          await abortableWait(changed);
          continue;
        }
        // Everything the step awaits takes its signal, or has its own bound, so a deadline or a
        // removal ends the wait; what it had sent is fenced by its id, sequence or predecessor
        // and its outcome read on a later turn. The awaits, and their bounds:
        //   database statements    the signal and the step's deadline: abortable query options
        //                          outside a transaction (applyDatabaseOperationBudget), and
        //                          statement_timeout and cancel inside one: the pool store's
        //                          transactions run once under the operation's transaction
        //                          budget, the global row's lock that each takes first included
        //   journal insert         the same
        //   controller calls       the signal and callTimeoutMs; not cancelled at the controller:
        //                          its id is settled later, its predecessor fences it
        //   runtime controls       the signal and callTimeoutMs; not cancelled at the runtime: its
        //                          sequence fences it, and the next turn reads the runtime's state
        //   runtime state read     the signal and callTimeoutMs
        //   profile identity       the signal (BrowserLocalProfiles.identity)
        //   selection of the step  its own bound (30 s) and a removal's abort, as a step's
        //   service (Stop) lane    the wait to enter it ends with the signal; work entered checks
        //                          the signal first, sends nothing once it has fired, and is
        //                          awaited to its end (an attach registers and returns)
        //   document lookup        database statements, as above
        //   a page's close         the signal (a tab the person closed while parked)
        //   broker ready           the signal and connectTimeoutMs
        //   broker frame drain     the signal (the broker still finishes once they are handled)
        //   quiesce                the signal and 15 s (each broker's detach goes on; its socket
        //                          is ended at once)
        //   gate idle              the signal and quiesceMs
        //   holders' settlements   database statements, as above (applyDatabaseOperationBudget
        //                          gives each of them the operation's options)
        //   an over target's end   a step of its own ("end-over"), as above, until it succeeds
        //   refusal announcement   outside any step: its own bound (5 s) and the turn's change
        //   backoff                the turn's own change signal and five seconds at most (a start
        //                          or wake the controller refused: 5 s doubling to five minutes)
        const deadlineMs = step.deadlineMs ?? defaultStepMs;
        const preempt = new AbortController();
        const signal = AbortSignal.any([preempt.signal, AbortSignal.timeout(deadlineMs)]);
        this.#step = { name: step.name, preempt };
        this.#signal = signal;
        try {
          await withDatabaseOperationSignal(signal, Date.now() + deadlineMs, () =>
            step!.run(signal),
          );
        } finally {
          this.#step = undefined;
          this.#signal = undefined;
        }
        if (failing === step.name) failures = 0;
        unanswered = 0;
        refusals = 0;
        failingSince = undefined;
        suspectedAt = undefined;
        if (step.name !== "end" && step.name !== "reconnect" && step.name !== "end-over")
          this.#refused = undefined;
        this.#publish(this.#slot);
      } catch (error) {
        this.#options.onError?.(error);
        // Unanswered, or refused unsigned, for long: the account may have a new target (a term
        // superseded is answered by the old host only with an unsigned refusal).
        if (!(error instanceof BrowserPoolNotStarted)) {
          const at = Date.now();
          failingSince ??= at;
          const bound = this.#options.unansweredMs ?? unansweredMs;
          if (
            at - failingSince >= bound &&
            (suspectedAt === undefined || at - suspectedAt >= bound)
          ) {
            suspectedAt = at;
            this.#options.onSuspect?.();
          }
        }
        const over = targetOver(error);
        if (over && !this.#released) {
          this.#beginOver(over);
          this.#options.onSuspect?.();
          continue;
        }
        if (error instanceof BrowserPoolNotStarted) {
          // Not started, and nothing of the guest lost: asked again later, never a reason to
          // give live state up, and spaced so the host is not asked in a loop.
          const announce = this.#refused?.reason !== error.reason;
          this.#refused = { reason: error.reason, since: this.#refused?.since ?? new Date() };
          // Subscribed clients learn of a refusal when it begins or its reason changes; the
          // announcement has its own bound, and a removal ends it.
          if (announce)
            await Promise.resolve()
              .then(() =>
                withDatabaseOperationSignal(
                  AbortSignal.any([changed, AbortSignal.timeout(announceMs)]),
                  Date.now() + announceMs,
                  () => announceBrowserPool(this.#options.database),
                ),
              )
              .catch(() => undefined);
          const first = this.#options.refusedRetryMs ?? refusedRetryMs;
          await delay(
            Math.min(first * 2 ** Math.min(refusals++, 16), refusedRetryMaxMs),
            undefined,
            {
              signal: changed,
            },
          ).catch(() => undefined);
          continue;
        }
        if (unknownAnswer(error)) {
          // Not knowing (P18): asked again, later each time; it never counts toward a discard,
          // and nothing of the guest is given up for it.
          await delay(
            Math.min(
              (this.#options.retryMs ?? 100) * 2 ** Math.min(unanswered++, 16),
              unansweredRetryMaxMs,
            ),
            undefined,
            { signal: changed },
          ).catch(() => undefined);
          continue;
        }
        if (step) {
          failures = failing === step.name ? failures + 1 : 1;
          failing = step.name;
          // Once the attempts are used, live state is given up for behind a fresh guest (R3):
          // the next turn chooses again, so anything wanted above it goes first. Only answers
          // count: none of these attempts was one that did not come.
          if (step.discards && failures >= discardAfterAttempts)
            this.#discardWanted = "unrecoverable";
        }
        // The turn's own change signal: anything asked since this turn began (a removal, a
        // restart, demand) ends the wait, even when it arrived while the step was running.
        await delay(
          Math.min(this.#options.retryMs ?? 100 * 2 ** Math.min(failures, 6), 5_000),
          undefined,
          { signal: changed },
        ).catch(() => undefined);
      }
    }
  }

  async #next(): Promise<Step | undefined> {
    const slot = await this.#read();
    this.#publish(slot);
    if (this.#released || slot?.phase === "releasing")
      return { name: "release", run: () => this.#releaseStep(slot) };
    // Nothing more is sent to a target that is over, once its sessions have their end; a new
    // target is a new coordinator.
    if (this.#over) {
      if (this.#parkWanted) this.#settlePark("vetoed");
      if (this.#overEnd && !this.#overEnd.done)
        return { name: "end-over", run: (signal) => this.#endOverStep(signal) };
      return undefined;
    }
    // A restart accepted before a Home crash is finished by this Home, once.
    const pending = slot ? pendingRestart(slot) : [];
    if (!this.#restartWanted && pending.length)
      this.#restartWanted = { keys: new Set(pending), done: Promise.withResolvers() };
    if (this.#restartWanted && slot) return { name: "restart", run: () => this.#restartStep(slot) };
    // With no slot yet, the first install answers it.
    if (this.#restartWanted) this.#restartWanted.firstInstall = true;
    if (this.#unknownIntent) return { name: "intent", run: () => this.#readIntent() };
    if (this.#discardWanted && slot) {
      const reason = this.#discardWanted;
      return { name: "discard", run: () => this.#discardRead(reason) };
    }
    if (!this.#recovered || !slot || slot.phase === "preparing" || slot.phase === "waking")
      return {
        name: "recover",
        run: () => this.#recoverStep(),
        ...(slot ? { discards: true } : {}),
      };
    const withoutChannel = slot.phase === "running" ? await this.#withoutChannel() : [];
    // A removal or a restart asked during that read is chosen first: selection runs again.
    if (this.#released || this.#restartWanted) return this.#next();
    if (withoutChannel.length)
      return {
        name: "reconnect",
        // One attempt is a step like any other; the sessions' window decides when they end.
        deadlineMs: Math.min(this.#channelDeadlineMs, defaultStepMs),
        run: (signal) => this.#reconnectStep(slot, withoutChannel, signal),
      };
    const ending =
      slot.phase === "running"
        ? ((await this.#adopter?.ending?.(this.#options.runtimeId)) ?? [])
        : [];
    if (this.#released || this.#restartWanted) return this.#next();
    if (ending.length) {
      // A closing row blocks a park anyway: one asked now is vetoed rather than kept waiting.
      if (this.#parkWanted) this.#settlePark("vetoed");
      return { name: "end", run: (signal) => this.#endStep(slot, ending, signal) };
    }
    if (slot.phase === "parked" && this.gate.demand)
      return { name: "wake", run: () => this.#wakeStep(), discards: true };
    if (this.#parkWanted && slot.phase === "running")
      return { name: "park", run: () => this.#parkStep() };
    if (this.#parkWanted) this.#settlePark("vetoed");
    return undefined;
  }

  /** The gate's facts, from the durable state and what is wanted; nothing else sets them. */
  #publish(slot: BrowserPoolSlot | undefined): void {
    const away =
      slot?.phase === "parked"
        ? "parked"
        : slot?.phase === "preparing"
          ? "parking"
          : slot?.phase === "waking"
            ? "waking"
            : this.#lost.size
              ? "reconnecting"
              : null;
    this.gate.set({
      recovered: this.#recovered,
      away,
      hold:
        this.#released || slot?.phase === "releasing"
          ? "released"
          : this.#over
            ? "over"
            : this.#restartWanted
              ? "restart"
              : null,
    });
    // A park that failed after D ends where the browser settled.
    if (this.#parkSettling && slot?.phase === "parked") this.#settlePark("parked");
    if (this.#parkSettling && slot?.phase === "running") this.#settlePark("vetoed");
  }

  #settlePark(outcome: "parked" | "vetoed"): void {
    const wanted = this.#parkWanted;
    this.#parkWanted = undefined;
    this.#parkSettling = false;
    wanted?.resolve(outcome);
  }

  get #channelDeadlineMs(): number {
    return this.#options.channelDeadlineMs ?? pooledSessionWithoutChannelMs;
  }

  /** Ready sessions of this runtime with no channel here; each one's window starts when seen. */
  async #withoutChannel(): Promise<BrowserSessionId[]> {
    const found = [...((await this.#adopter?.withoutChannel(this.#options.runtimeId)) ?? [])];
    const now = Date.now();
    for (const sessionId of found)
      if (!this.#lost.has(sessionId)) this.#lost.set(sessionId, { since: now });
    for (const sessionId of this.#lost.keys())
      if (!found.includes(sessionId)) this.#lost.delete(sessionId);
    this.#publish(this.#slot);
    return found;
  }

  /** Reattach the sessions inside their window; end the ones past it, each with its note. */
  async #reconnectStep(
    slot: BrowserPoolSlot,
    sessions: readonly BrowserSessionId[],
    signal: AbortSignal,
  ): Promise<void> {
    const now = Date.now();
    const remaining = (sessionId: BrowserSessionId) =>
      (this.#lost.get(sessionId)?.since ?? now) + this.#channelDeadlineMs - now;
    const past = sessions.filter((sessionId) => remaining(sessionId) <= 0);
    const within = sessions.filter((sessionId) => remaining(sessionId) > 0);
    if (past.length) {
      await this.#finishRunning(slot, await this.#lossesOf(slot, past, "not-adopted"));
      for (const sessionId of past) this.#lost.delete(sessionId);
      return;
    }
    // The losses this attempt answers: one recorded since is a new loss and stays.
    const answering = new Map(within.map((sessionId) => [sessionId, this.#lost.get(sessionId)]));
    const advanced = await this.#advance(slot, {
      phase: slot.phase,
      attachmentGeneration: slot.attachmentGeneration + 1,
    });
    // The attempt stops at the first window to end: nothing is left running after it.
    const window = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(0, Math.min(...within.map(remaining)))),
    ]);
    await this.#adopter?.reattach({
      sessions: within,
      documents: [],
      fence: fenceOf(advanced),
      attempt: advanced.attachmentGeneration,
      signal: window,
    });
    const back = within.filter((sessionId) => this.#adopter?.live(sessionId));
    for (const sessionId of back)
      if (this.#lost.get(sessionId) === answering.get(sessionId)) this.#lost.delete(sessionId);
    if (back.length < within.length) throw new Error("A session is not back yet.");
  }

  /**
   * The target is over: this Home's guest is gone, by the target's own signed word. Every
   * session of the runtime ends with its note; waiting callers are refused at once (the gate's
   * hold); a restart asked is refused; the loop sends nothing more and waits for a new target.
   */
  /**
   * The target is over: callers are refused from now on (the gate holds first), and ending its
   * sessions is the loop's next step, under its bound, until it has succeeded.
   */
  #beginOver(reason: string, settle = false): PromiseWithResolvers<void> {
    if (!this.#over) {
      this.#over = reason;
      this.#refused = { reason, since: new Date() };
      this.#display = { phase: "failed", since: new Date() };
    }
    this.#overEnd ??= { done: false, settle, ended: Promise.withResolvers() };
    this.#overEnd.settle ||= settle;
    this.#publish(this.#slot);
    this.#settlePark("vetoed");
    this.#recovered = true;
    this.#recovering.resolve();
    this.#kick();
    return this.#overEnd.ended;
  }

  /**
   * An over target's end, as a step: every channel, ticket and viewer of its runtime is closed;
   * holders still sending are settled with their outcomes (a swap); every session ends with its
   * note; a restart asked is answered; clients are told. A turn that fails is tried again.
   */
  async #endOverStep(signal: AbortSignal): Promise<void> {
    const end = this.#overEnd!;
    const reason = this.#over!;
    await this.#adopter?.quiesce(signal);
    if (end.settle) {
      const idle = await withTimeout(this.gate.idle(), this.#options.quiesceMs ?? quiesceMs, {
        signal,
        timeoutError: () => new Error("A send still holds the browser."),
      }).then(
        () => true,
        () => false,
      );
      signal.throwIfAborted();
      if (!idle) await this.gate.settleHolders();
    }
    await this.#endOverSessions(reason);
    // A restart asked is answered once the sessions have their end.
    this.#restartWanted?.done.reject(new BrowserPoolAdmissionClosed("This browser is not ready."));
    this.#restartWanted = undefined;
    await announceBrowserPool(this.#options.database);
    end.done = true;
    end.ended.resolve();
  }

  /**
   * A different target replaces this one (a new term, or a replaced pool host: S7). What is in
   * flight ends, never silently and never carried to the new guest: callers are refused at once
   * (the gate's hold); a holder is asked to stop and, if it does not in time, gets its recorded
   * outcome (unknown when something was sent, refused when nothing was); every channel, ticket
   * and viewer of this runtime is closed; every session ends with its note (a ready one failed, a
   * closing one closed: the target that held its guest is over). Then the loop ends.
   */
  async retire(reason: string): Promise<void> {
    if (this.#released || this.#ended) return;
    const ended = this.#beginOver(reason, true);
    this.#step?.preempt.abort(new BrowserPoolAdmissionClosed("This browser is not ready."));
    this.#selecting?.abort(new BrowserPoolAdmissionClosed("This browser is not ready."));
    this.#start();
    // The end is the loop's step, under its bound, until it has succeeded (or a removal ends
    // the sessions instead).
    await Promise.race([ended.promise, this.#releasedForGood.promise]);
    this.close();
    await this.#running?.catch(() => undefined);
  }

  async #endOverSessions(reason: string): Promise<void> {
    const slot = await this.#read();
    if (slot) {
      const sessions = await listBrowserPoolRuntimeSessions(
        this.#options.database,
        slot.runnerId,
        slot.runtimeId,
      );
      if (sessions.length)
        await advanceBrowserPoolSlot(
          this.#options.database,
          slot,
          { phase: slot.phase },
          await this.#lossesOf(slot, sessions, reason),
        );
    }
  }

  /**
   * Sessions the person stopped while the awake guest held them with no channel here. The Home
   * asks the guest's runtime to end each (P15); its row says closed only on that runtime's
   * answer `ended`, given after its own teardown, while it serves traffic under this fence.
   * Anything else keeps the row closing (no clock of the Home ends it), and the step is asked
   * again, paced. Nothing is reattached and no attachment is spent.
   */
  async #endStep(
    slot: BrowserPoolSlot,
    sessions: readonly BrowserSessionId[],
    signal: AbortSignal,
  ): Promise<void> {
    const adopter = this.#adopter;
    if (!adopter?.endTicket || !adopter.ended) return;
    // A guest that died or changed under a running slot is recovery's: it replaces the guest and
    // ends these rows with that evidence.
    const status = await this.#status();
    if (status.phase !== "running" || !sameFence(statusFence(status), fenceOf(slot))) {
      this.#recovered = false;
      return;
    }
    const fence = fenceOf(slot);
    let unanswered = 0;
    for (const sessionId of sessions) {
      signal.throwIfAborted();
      const ticket = await adopter.endTicket({ sessionId, fence, signal });
      if (ticket === "gone") continue;
      let answer: BrowserPoolEndAnswer | undefined;
      if (ticket !== undefined)
        answer = await withTimeout(
          this.#options.runtime.endSession(ticket, signal),
          this.#options.callTimeoutMs ?? defaultCallTimeoutMs,
          {
            signal,
            timeoutError: () =>
              new BrowserPoolUnanswered("The pooled runtime did not answer in time."),
          },
        ).catch((error: unknown) => {
          this.#options.onError?.(error);
          return undefined;
        });
      if (
        answer?.outcome === "ended" &&
        answer.state.phase === "running" &&
        sameFence(answer.state.fence, fence)
      )
        await adopter.ended(sessionId);
      else unanswered++;
    }
    if (unanswered) throw new Error("A stopped session's end is not answered yet.");
  }

  /** The removal, to its end; a turn that fails is tried again before anything else. */
  async #releaseStep(slot: BrowserPoolSlot | undefined): Promise<void> {
    if (slot && slot.phase !== "releasing") {
      const sessions = await listBrowserPoolRuntimeSessions(
        this.#options.database,
        slot.runnerId,
        slot.runtimeId,
      );
      const all = [...new Set([...sessions, ...(this.#released?.ended ?? [])])];
      slot = await beginBrowserPoolRelease(
        this.#options.database,
        slot,
        await this.#lossesOf(slot, all, "device-removed"),
      );
    }
    this.#released?.noted.resolve();
    // With or without a slot row the controller is asked: a guest started before its row was
    // written is stopped too. A failed status read is not knowing, never "stopped" (R2); only an
    // applied stop or a status that reads stopped is evidence, and only once every Start this
    // Home sent has its answer: each open one is sent again by its own id first (P1). A Start
    // still on its way after the slot is deleted is the agent's to refuse, by the slot and its
    // term (tests/browser-pool-pair.integration.test.ts).
    // A target that answered, signed, that the guest is gone (the slot deleted, or another
    // term) is that evidence: nothing more is asked of it.
    if (!this.#over)
      try {
        await this.#journal.settleStarts(this.#signal);
        const status = await this.#status();
        if (status.phase !== "stopped") {
          const stopped = await this.#call(slot, "stop", status, true);
          if (!stopped.applied && stopped.status.phase !== "stopped")
            throw new Error(`The removed device's guest did not stop: ${stopped.reason}.`);
        }
      } catch (error) {
        if (!targetOver(error)) throw error;
      }
    await finishBrowserPoolRelease(this.#options.database, this.#options.runnerId);
    this.#slot = undefined;
    this.#ended = true;
    this.gate.set({ hold: "released" });
    this.#restartWanted?.done.reject(new BrowserPoolAdmissionClosed("This device was removed."));
    this.#restartWanted = undefined;
    this.#settlePark("vetoed");
    this.#recovering.resolve();
    this.#releasedForGood.resolve();
  }

  /**
   * The owner's restart: every holder is asked to stop (the gate's hold ends their signals), the
   * old runtime's attachments, tickets and brokers are closed so each send has its outcome, and
   * only once nothing is held is the guest replaced.
   */
  async #restartStep(slot: BrowserPoolSlot | undefined): Promise<void> {
    const wanted = this.#restartWanted!;
    if (slot && !wanted.firstInstall) {
      const handled = new Set(restartKeysOf(slot));
      if (!wanted.keys.size || [...wanted.keys].some((key) => !handled.has(key))) {
        // Durable before the first effect: a crash from here on is finished by recovery.
        if (wanted.keys.size)
          slot = await this.#advance(slot, { phase: slot.phase, restartWanted: [...wanted.keys] });
        await this.#adopter?.quiesce(this.#signal);
        const idle = await withTimeout(this.gate.idle(), this.#options.quiesceMs ?? quiesceMs, {
          ...(this.#signal ? { signal: this.#signal } : {}),
          timeoutError: () => new Error("A send still holds the browser."),
        }).then(
          () => true,
          () => false,
        );
        this.#signal?.throwIfAborted();
        // A holder still here (a script that ignores its abort) gets its recorded outcome first,
        // unknown when it sent something and refused when it sent nothing: never a guess.
        if (!idle) await this.gate.settleHolders();
        // The live set: a restart that joins while this one runs is answered by the same start.
        await this.#discard(slot, "person", wanted.keys);
        this.#discardWanted = undefined;
      }
    }
    // One that joined after the start was written, or one the first install answered: its key
    // is recorded with that start. Keys are bounded, so this ends.
    for (
      let late = unrecorded(this.#slot, wanted.keys);
      this.#slot && late.length;
      late = unrecorded(this.#slot, wanted.keys)
    )
      await this.#advance(this.#slot, {
        phase: this.#slot.phase,
        restartKeys: withRestartKeys(this.#slot, late),
        restartWanted: [],
      });
    this.#restartWanted = undefined;
    this.#publish(this.#slot);
    wanted.done.resolve();
  }

  /** A park intent whose commit reply was lost is read back before anything else admits. */
  async #readIntent(): Promise<void> {
    const intentId = this.#unknownIntent!;
    const current = await (this.#options.testHooks?.readSlot ?? readBrowserPoolSlot)(
      this.#options.database,
      this.#options.runnerId,
    );
    this.#unknownIntent = undefined;
    // Not found: it never happened. Found: the park committed and goes on from D.
    if (current?.intentId !== intentId || current.phase !== "preparing") {
      this.gate.endPark();
      this.#settlePark("vetoed");
      return;
    }
    this.#slot = current;
    this.#parkSettling = true;
    const outcome = await this.#afterD(current, !this.gate.committed());
    this.#publish(this.#slot);
    this.#settlePark(outcome);
  }

  async #recoverStep(): Promise<void> {
    // A removal a Home crash interrupted after the revocation: the slot is released, and the
    // sessions the revocation ended get their notes.
    const revoked = await readBrowserPoolRevocation(this.#options.database, this.#options.runnerId);
    if (revoked) {
      this.#released ??= { ended: new Set(), noted: Promise.withResolvers() };
      for (const sessionId of revoked) this.#released.ended.add(sessionId);
      this.#publish(this.#slot);
      return;
    }
    await this.#recover();
    // Sessions a Home restart left without a channel are counted before admission opens.
    if (this.#slot?.phase === "running") await this.#withoutChannel();
    this.#recovered = true;
    this.#publish(this.#slot);
    this.#recovering.resolve();
  }

  async #wakeStep(): Promise<void> {
    await this.#wake();
  }

  async #discardRead(reason: string): Promise<void> {
    const slot = await this.#read();
    if (!slot) throw new BrowserPoolAdmissionClosed("The pooled browser has no slot yet.");
    await this.#discard(slot, reason);
    this.#discardWanted = undefined;
    this.#recovered = true;
    this.#publish(this.#slot);
    this.#recovering.resolve();
  }

  async #parkStep(): Promise<void> {
    try {
      const outcome = await this.#park();
      // The caller sees the gate as the step left it.
      this.#publish(this.#slot);
      this.#settlePark(outcome);
    } catch (error) {
      // After D the browser goes forward or back by recovery; the caller learns where it ended.
      this.#parkSettling = true;
      throw error;
    }
  }

  async #read(): Promise<BrowserPoolSlot | undefined> {
    this.#slot = await (this.#options.testHooks?.readSlot ?? readBrowserPoolSlot)(
      this.#options.database,
      this.#options.runnerId,
    );
    return this.#slot;
  }

  async #advance(
    slot: BrowserPoolSlot,
    next: Parameters<typeof advanceBrowserPoolSlot>[2],
    losses?: readonly BrowserPoolSessionLoss[],
  ): Promise<BrowserPoolSlot> {
    // A step whose deadline passed, or that a removal ended, writes nothing more.
    this.#signal?.throwIfAborted();
    this.#slot = await advanceBrowserPoolSlot(this.#options.database, slot, next, losses);
    return this.#slot;
  }

  /** The runtime's state, read now; null: there is no runtime to ask (no guest, or paused). */
  async #runtimeState(): Promise<BrowserPoolRuntimeState | null> {
    this.#signal?.throwIfAborted();
    return withTimeout(
      this.#options.runtime.poolState(this.#signal),
      this.#options.callTimeoutMs ?? defaultCallTimeoutMs,
      {
        timeoutError: () => new BrowserPoolUnanswered("The pooled runtime did not answer in time."),
        ...(this.#signal ? { signal: this.#signal } : {}),
      },
    );
  }

  /** The state of a runtime that must be running here; not answering is not knowing. */
  async #state(): Promise<BrowserPoolRuntimeState> {
    const state = await this.#runtimeState();
    if (!state) throw new Error("The pooled runtime cannot be asked yet.");
    return state;
  }

  #status(): Promise<BrowserPoolPhysicalStatus> {
    return this.#journal.status(this.#options.slotId, this.#options.term, this.#signal);
  }

  /** `replacing`: this call replaces the guest, and closes every open journal row with `status`. */
  async #call(
    slot: BrowserPoolSlot | undefined,
    kind: "start" | "pause" | "resume" | "stop",
    status: BrowserPoolPhysicalStatus,
    replacing = false,
    restartKeys?: ReadonlySet<string>,
  ): Promise<BrowserPoolControllerResult> {
    this.#signal?.throwIfAborted();
    const result = await this.#journal.call(
      {
        slotId: this.#options.slotId,
        term: this.#options.term,
        kind,
        expect: expectationOf(status),
        ...(kind === "resume" && slot?.intentId
          ? { intent: { id: slot.intentId, sequence: slot.intentSequence } }
          : {}),
      },
      slot?.intentId ?? null,
      replacing ? status : undefined,
      this.#signal,
      restartKeys?.size ? [...restartKeys] : undefined,
    );
    // Stored and signed: the call's term is not the slot's. This target is over for this Home.
    if (!result.applied && result.reason === "fenced") throw new BrowserPoolTargetFenced();
    return result;
  }

  /** A runtime control the controller signed. A lost reply is read back from the runtime. */
  async #control(
    slot: BrowserPoolSlot,
    kind: "retire" | "release" | "seal" | "complete",
    fence: BrowserPoolRuntimeFence,
    attempt?: number,
  ): Promise<BrowserPoolRuntimeState> {
    const control: Omit<BrowserPoolControl, "sequence" | "expect"> = {
      kind,
      fence,
      intent: { id: slot.intentId!, sequence: slot.intentSequence },
      ...(attempt ? { attempt } : {}),
    };
    const signed = await this.#journal.call(
      {
        slotId: this.#options.slotId,
        term: this.#options.term,
        kind: "sign",
        expect: expectationOf(await this.#status()),
        control,
      },
      slot.intentId,
      undefined,
      this.#signal,
    );
    const issued = signed.control;
    if (!signed.applied && signed.reason === "fenced") throw new BrowserPoolTargetFenced();
    if (
      !signed.applied ||
      !signed.signature ||
      !issued ||
      issued.kind !== kind ||
      !sameFence(issued.fence, fence) ||
      issued.intent?.id !== control.intent?.id ||
      issued.attempt !== control.attempt
    )
      throw new Error(`The controller did not sign ${kind}: ${signed.reason ?? "refused"}.`);
    return (await this.#deliver(issued, signed.signature)).state;
  }

  /**
   * Delivers a signed control with a deadline. `answered` is false when the reply was lost or
   * did not come in time: the current state is then read, and the outcome is not assumed.
   */
  async #deliver(
    control: BrowserPoolControl,
    signature: string,
  ): Promise<{ readonly state: BrowserPoolRuntimeState; readonly answered: boolean }> {
    this.#signal?.throwIfAborted();
    const fault = this.#options.runtimeFault?.(control.kind);
    if (fault === "request") return { state: await this.#state(), answered: false };
    try {
      const state = await withTimeout(
        this.#options.runtime.controlPool(control, Buffer.from(signature, "base64")),
        this.#options.callTimeoutMs ?? defaultCallTimeoutMs,
        {
          timeoutError: () => new BrowserPoolUnanswered("The runtime did not answer in time."),
          // The control is not cancelled: the runtime orders controls by sequence, and the
          // next one the loop sends (a release, a newer intent) is applied after it.
          ...(this.#signal ? { signal: this.#signal } : {}),
        },
      );
      return fault === "reply"
        ? { state: await this.#state(), answered: false }
        : { state, answered: true };
    } catch {
      // A refusal and a lost reply look alike here: the current state decides.
      return { state: await this.#state(), answered: false };
    }
  }

  /** Retire, and whether its own reply came back: a lost retire reply is an abort. */
  async #retire(slot: BrowserPoolSlot) {
    const control: BrowserPoolControl["kind"] = "retire";
    const signed = await this.#journal.call(
      {
        slotId: this.#options.slotId,
        term: this.#options.term,
        kind: "sign",
        expect: expectationOf(await this.#status()),
        control: {
          kind: control,
          fence: fenceOf(slot),
          intent: { id: slot.intentId!, sequence: slot.intentSequence },
        },
      },
      slot.intentId,
      undefined,
      this.#signal,
    );
    if (!signed.applied || !signed.signature || signed.control?.kind !== "retire")
      throw new Error(`The controller did not sign retire: ${signed.reason ?? "refused"}.`);
    return this.#deliver(signed.control, signed.signature);
  }

  // ---- Park -------------------------------------------------------------------------------

  /** D, then the retire. Before D a send vetoes; a lost commit reply is read back first. */
  async #park(): Promise<"parked" | "vetoed"> {
    const slot = this.#slot;
    if (!slot || slot.phase !== "running" || !this.gate.beginPark()) return "vetoed";
    const intentId = randomUUID();
    let intent: BrowserPoolSlot | undefined;
    try {
      intent = await (this.#options.testHooks?.beginPark ?? beginBrowserPoolPark)(
        this.#options.database,
        browserPoolSlotIdentity(slot),
        intentId,
        () => this.gate.demandedSince(),
      );
    } catch (error) {
      // A failed reply to COMMIT does not say whether D exists. Admission stays closed (the
      // gate is still preparing) until the next turn reads the intent back.
      this.#unknownIntent = intentId;
      throw error;
    }
    if (!intent) {
      this.gate.endPark();
      return "vetoed";
    }
    this.#slot = intent;
    // A send that arrived before the commit vetoes: the intent is released before any retire.
    return this.#afterD(intent, !this.gate.committed());
  }

  async #afterD(intent: BrowserPoolSlot, vetoedDuringCommit: boolean) {
    const expected = this.#adopter?.inventory() ?? [];
    await this.#journal.settleOpen(this.#signal);
    let state = await this.#state();
    let abort = vetoedDuringCommit;
    if (!vetoedDuringCommit) {
      const retired = await this.#retire(intent);
      state = retired.state;
      // Rule D: a retire whose reply was lost is aborted, even if the runtime retired.
      if (!retired.answered) abort = true;
    }
    if (abort && state.phase !== "sealed") return this.#abort(intent);
    return this.#afterRetire(intent, state, expected);
  }

  async #afterRetire(
    slot: BrowserPoolSlot,
    state: BrowserPoolRuntimeState,
    expected: readonly { readonly sessionId: BrowserSessionId; readonly surfaceId: string }[],
  ): Promise<"parked" | "vetoed"> {
    const same = sameIntent(state, slot);
    // A page ended while its session was suspended was dropped: the park must not commit.
    if (same && state.phase === "retired" && !state.cancelled && state.retired && !state.dropped) {
      const kept = new Set(
        state.retired.documents.map(({ sessionId, surfaceId }) => `${sessionId}\n${surfaceId}`),
      );
      // A page the Home knows that the retire did not keep is an unexpected drop: abort.
      if (expected.every(({ sessionId, surfaceId }) => kept.has(`${sessionId}\n${surfaceId}`))) {
        const recorded = await this.#advance(slot, {
          phase: "preparing",
          retained: { ...state.retired },
        });
        return this.#sealAndPause(recorded);
      }
    }
    if (same && state.phase === "sealed") return this.#sealAndPause(slot);
    return this.#abort(slot);
  }

  /** Release, then reattach so every retained page is reachable, then open. */
  async #abort(slot: BrowserPoolSlot): Promise<"parked" | "vetoed"> {
    let state = await this.#state();
    const pending =
      !sameIntent(state, slot) ||
      (!state.cancelled && (state.phase === "running" || state.phase === "retiring")) ||
      state.phase === "retired";
    if (pending && state.phase !== "uninstalled")
      state = await this.#control(slot, "release", fenceOf(slot));
    if (state.phase === "uninstalled" || !sameFence(state.fence, fenceOf(slot))) {
      await this.#discard(slot, "guest-restarted");
      return "vetoed";
    }
    if (!sameIntent(state, slot)) throw new Error("The runtime did not record the release.");
    // The park committed: it can only go forward.
    if (state.phase === "sealed") return this.#sealAndPause(slot);
    if (state.phase === "adopting" || state.adoption?.outcome) {
      await this.#readopt(slot, state);
      return "vetoed";
    }
    if (state.phase === "running" && state.cancelled) {
      // A page the vetoed retire could not thaw was closed: it is that page's loss, with its
      // note; its session is kept.
      await this.#finishRunning(slot, pageLosses(state.unthawed ?? []));
      return "vetoed";
    }
    throw new Error(`The runtime is still ${state.phase}.`);
  }

  async #sealAndPause(slot: BrowserPoolSlot): Promise<"parked" | "vetoed"> {
    let state = await this.#state();
    // A lost seal request is sent again once; a refusal leaves it released.
    for (
      let tries = 0;
      tries < 2 && !(sameIntent(state, slot) && state.phase === "sealed");
      tries++
    )
      state = await this.#control(slot, "seal", fenceOf(slot));
    if (!(sameIntent(state, slot) && state.phase === "sealed")) return this.#abort(slot);
    if (!slot.retained && state.retired)
      slot = await this.#advance(slot, { phase: "preparing", retained: { ...state.retired } });
    return this.#pause(slot);
  }

  async #pause(slot: BrowserPoolSlot): Promise<"parked" | "vetoed"> {
    const applied = await readAppliedBrowserPoolControllerCall(
      this.#options.database,
      this.#options.runnerId,
      slot.intentId!,
      "pause",
    );
    let savedState = (applied?.result as BrowserPoolControllerResult | null)?.savedState;
    if (!savedState) {
      const status = await this.#status();
      const result = await this.#call(slot, "pause", status);
      if (!result.applied) {
        // The guest cannot be paused: its live state cannot be kept.
        await this.#discard(slot, "pause-refused");
        return "vetoed";
      }
      savedState = result.savedState;
    }
    await this.#advance(slot, {
      phase: "parked",
      savedState: savedState as unknown as Record<string, unknown>,
    });
    return "parked";
  }

  // ---- Wake -------------------------------------------------------------------------------

  async #wake(): Promise<void> {
    // One recovery live and at start: an open journal row is settled by its id first, so a
    // guest a lost acknowledgement left resumed is never mistaken for one without live state.
    await this.#journal.settleOpen(this.#signal);
    let slot = await this.#read();
    if (!slot) throw new BrowserPoolAdmissionClosed();
    if (slot.phase === "running") return;
    let read: BrowserPoolPhysicalStatus | undefined;
    if (slot.phase === "parked") {
      // The guest's status is read before the slot leaves parked: a read that does not come
      // leaves it parked, with nothing to recover (P18).
      read = await this.#status();
      slot = await this.#advance(slot, { phase: "waking" });
    }
    if (slot.phase !== "waking") throw new Error(`Cannot wake from ${slot.phase}.`);
    return this.#continueWake(slot, read);
  }

  async #continueWake(slot: BrowserPoolSlot, read?: BrowserPoolPhysicalStatus): Promise<void> {
    const saved = slot.savedState as { id?: string } | null;
    let status = read ?? (await this.#status());
    let resumed = await this.#appliedResume(slot);
    if (!resumed) {
      if (
        status.phase !== "paused" ||
        !sameFence(statusFence(status), fenceOf(slot)) ||
        !saved?.id ||
        status.savedState?.id !== saved.id
      )
        return this.#discard(slot, "live-state-unavailable");
      const result = await this.#call(slot, "resume", status);
      if (!result.applied) {
        // Refused with the saved state still there (the controller's reason, such as a profile
        // disk that is missing): not woken, asked again later, and never given up for a fresh
        // guest. Only a refusal that shows the state gone discards it.
        const now = result.status;
        if (
          now.phase === "paused" &&
          sameFence(statusFence(now), fenceOf(slot)) &&
          now.savedState?.id === saved.id
        ) {
          // Back to parked: it is asked again only while someone wants the browser.
          if (slot.phase === "waking") await this.#advance(slot, { phase: "parked" });
          throw new BrowserPoolNotStarted(result.reason);
        }
        return this.#discard(slot, result.reason ?? "resume-refused");
      }
      resumed = result;
      status = result.status;
    }
    const adopt = resumed.control!;
    // The resume moves the epoch on; slot, term and instance stay the slot's.
    if (
      !sameFence(adopt.fence, { ...fenceOf(slot), epoch: adopt.fence.epoch }) ||
      (status.phase === "running" && !sameFence(statusFence(status), adopt.fence))
    )
      return this.#discard(slot, "guest-changed");
    if (slot.epoch !== adopt.fence.epoch)
      slot = await this.#advance(slot, {
        phase: "waking",
        fence: { instanceId: adopt.fence.instance, epoch: adopt.fence.epoch },
      });
    // Resumed, the guest runs again: only now is its runtime asked.
    let state = await this.#state();
    if (state.phase === "sealed") state = (await this.#deliver(adopt, resumed.signature!)).state;
    // An adopt that did not arrive leaves the runtime sealed under the epoch before it: the
    // next attempt sends it again.
    if (
      state.phase === "sealed" &&
      state.fence &&
      sameFence(state.fence, { ...fenceOf(slot), epoch: state.fence.epoch })
    )
      throw new Error("The runtime has not adopted yet.");
    if (!sameFence(state.fence, fenceOf(slot))) return this.#discard(slot, "guest-changed");
    if (sameIntent(state, slot) && (state.phase === "adopting" || state.adoption?.outcome))
      return this.#readopt(slot, state);
    throw new Error(`The runtime did not adopt: ${state.phase}.`);
  }

  async #appliedResume(slot: BrowserPoolSlot): Promise<BrowserPoolControllerResult | undefined> {
    if (!slot.intentId) return undefined;
    const row = await readAppliedBrowserPoolControllerCall(
      this.#options.database,
      this.#options.runnerId,
      slot.intentId,
      "resume",
    );
    return (row?.result as BrowserPoolControllerResult | null) ?? undefined;
  }

  /** Adoption per session: the runtime decides who was reattached; the rest are lost. */
  async #readopt(slot: BrowserPoolSlot, state: BrowserPoolRuntimeState): Promise<void> {
    const retained = retainedOf(slot) ?? {
      documents: state.retired?.documents ?? [],
      sessions: state.adoption?.sessions ?? [],
    };
    let tabLosses: readonly BrowserPoolSessionLoss[] = [];
    if (state.phase === "adopting" && state.adoption && !state.adoption.outcome) {
      slot = await this.#advance(slot, {
        phase: slot.phase,
        attachmentGeneration: slot.attachmentGeneration + 1,
      });
      const attempt = slot.attachmentGeneration;
      this.#signal?.throwIfAborted();
      if (this.#adopter)
        tabLosses = await this.#adopter.reattach({
          sessions: state.adoption.sessions,
          documents: retained.documents,
          fence: state.fence!,
          attempt,
          ...(this.#signal ? { signal: this.#signal } : {}),
        });
      // Partial results survive a restart: they are durable before the runtime completes.
      slot = await this.#advance(slot, {
        phase: slot.phase,
        outcome: { pendingTabLosses: tabLosses } as unknown as Record<string, unknown>,
      });
      state = await this.#control(slot, "complete", state.fence!, attempt);
    } else {
      tabLosses =
        (slot.outcome as { pendingTabLosses?: BrowserPoolSessionLoss[] } | null)
          ?.pendingTabLosses ?? [];
    }
    const outcome = state.adoption?.outcome;
    if (state.phase !== "running" || !outcome || !sameIntent(state, slot))
      throw new Error("The browser adoption has no outcome yet.");
    const lostIds = new Set(outcome.lost.map(({ sessionId }) => sessionId));
    const losses: BrowserPoolSessionLoss[] = [
      ...outcome.lost.map(({ sessionId, reason }) => ({
        sessionId,
        reason: reason ?? "not-adopted",
        surfaces: surfacesOf(retained, sessionId),
      })),
      ...tabLosses.filter(({ sessionId }) => !lostIds.has(sessionId)),
      // A page that did not thaw is that page's loss with its note; its session is kept.
      ...pageLosses(
        outcome.pagesLost ?? [],
        (sessionId, surfaceId) =>
          retained.documents.find(
            (document) => document.sessionId === sessionId && document.surfaceId === surfaceId,
          )?.documentId ?? null,
      ),
    ];
    await this.#finishRunning(slot, losses, {
      adopted: outcome.adopted,
      lost: outcome.lost,
    });
  }

  /** The ladder's last rung: the live state is discarded and a fresh guest is started. */
  async #discard(
    slot: BrowserPoolSlot,
    reason: string,
    keys: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const since = new Date();
    this.#display = { phase: reason === "person" ? "restarting" : "starting", since };
    await announceBrowserPool(this.#options.database).catch(() => undefined);
    try {
      await this.#startFresh(slot, reason, keys);
      this.#display = undefined;
    } catch (error) {
      // A fresh start that did not come up: the person sees it failed, and how often. One the
      // controller refused is not a failed start: it is reported with its reason instead.
      // One whose answer did not come is not known to have failed: it is asked again (P18).
      if (unknownAnswer(error)) {
        this.#display = { phase: reason === "person" ? "restarting" : "starting", since };
        throw error;
      }
      this.#display = { phase: "failed", since: new Date() };
      if (!(error instanceof BrowserPoolNotStarted))
        await recordBrowserPoolStartFailure(this.#options.database, slot.runnerId).catch(
          () => undefined,
        );
      throw error;
    }
  }

  /**
   * The phase a client shows: a fresh start or a restart in progress, or a failed start. A start
   * or wake the controller refused carries its reason (`egress-required`,
   * `profile-disk-missing`, or one this Home does not know): the words for it are the client's.
   */
  report():
    | {
        readonly phase: "starting" | "restarting" | "failed";
        readonly since: Date;
        readonly refused?: string;
      }
    | undefined {
    const refused = this.#refused;
    if (!refused) return this.#display;
    return {
      ...(this.#display ?? { phase: "failed" as const, since: refused.since }),
      refused: refused.reason,
    };
  }

  async #startFresh(
    slot: BrowserPoolSlot,
    reason: string,
    asked: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    // Every Start sent before has its answer first: one that applied is this replacement's.
    await this.#journal.settleStarts(this.#signal);
    let status = await this.#status();
    const keys = new Set(asked);
    let started = await this.#appliedStart(status, slot);
    if (started) {
      for (const key of started.restartKeys) keys.add(key);
    } else {
      // The first call of a replacement closes every open row: nothing old is replayed later.
      let replacing = true;
      if (status.phase !== "stopped") {
        const stopped = await this.#call(slot, "stop", status, replacing);
        replacing = false;
        // A refusal returns the state now: a guest that is stopped anyway is stopped.
        if (!stopped.applied && stopped.status.phase !== "stopped")
          throw new Error(`The guest did not stop: ${stopped.reason}.`);
        status = stopped.status;
      }
      // The restart's keys are written with its Start, before it is sent.
      started = {
        result: await this.#call(slot, "start", status, replacing, keys),
        restartKeys: [],
      };
    }
    const { result: startedResult } = started;
    if (!startedResult.applied) throw new BrowserPoolNotStarted(startedResult.reason);
    if (!startedResult.control || !startedResult.signature)
      throw new Error(`The guest did not start: ${startedResult.reason}.`);
    const control = startedResult.control;
    const signature = startedResult.signature;
    const { state } = await this.#deliver(control, signature);
    if (state.phase !== "running" || !sameFence(state.fence, control.fence))
      throw new Error("The fresh guest was not installed.");
    const sessions = await listBrowserPoolRuntimeSessions(
      this.#options.database,
      slot.runnerId,
      slot.runtimeId,
    );
    // The tabs come from the Home's own rows, not from a manifest that may be missing.
    const losses = await this.#lossesOf(slot, sessions, reason);
    this.#slot = await advanceBrowserPoolSlot(
      this.#options.database,
      slot,
      {
        phase: "running",
        fence: {
          slotId: control.fence.slot,
          term: control.fence.term,
          instanceId: control.fence.instance,
          epoch: control.fence.epoch,
        },
        savedState: null,
        outcome: { adopted: [], lost: losses.map(({ sessionId }) => ({ sessionId, reason })) },
        lastStart: {
          reason: startReason(reason),
          at: new Date().toISOString(),
          id: randomUUID(),
        },
        // Every key the restart was asked with is handled by this one start.
        ...(keys.size ? { restartKeys: withRestartKeys(slot, [...keys]), restartWanted: [] } : {}),
        failedStarts: 0,
      },
      losses,
    );
    // Held by the slot now; until this write, the slot's own fence says the same, so a write that
    // fails changes nothing the person sees (the slot never installs a Start it holds again).
    await this.#markInstalled(startedResult.id);
  }

  async #lossesOf(
    slot: BrowserPoolSlot,
    sessions: readonly BrowserSessionId[],
    reason: string,
  ): Promise<BrowserPoolSessionLoss[]> {
    // A running browser was woken or started since its last park: that park's documents and
    // what was typed in them are no longer what is so.
    const retained = slot.phase === "running" ? undefined : retainedOf(slot);
    const rows = await listBrowserPoolSessionTabs(this.#options.database, sessions);
    return Promise.all(
      sessions.map(async (sessionId) => {
        const kept = retained ? surfacesOf(retained, sessionId) : [];
        const known = new Set<string>(kept.map(({ surfaceId }) => surfaceId));
        // The Home's own tab rows, and the pages it keeps for the session.
        const pages = [
          ...(rows.get(sessionId) ?? []),
          ...((await this.#adopter?.pagesOf(sessionId).catch(() => [])) ?? []),
        ].filter((surfaceId) => !known.has(surfaceId) && known.add(surfaceId));
        return {
          sessionId,
          reason,
          surfaces: [...kept, ...pages.map((surfaceId) => ({ surfaceId, documentId: null }))],
        };
      }),
    );
  }

  async #finishRunning(
    slot: BrowserPoolSlot,
    losses: readonly BrowserPoolSessionLoss[],
    outcome?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const settled = await this.#advance(
      slot,
      { phase: "running", savedState: null, ...(outcome ? { outcome } : {}) },
      losses,
    );
    await pruneBrowserPoolBookkeeping(this.#options.database, settled).catch((error: unknown) =>
      this.#options.onError?.(error),
    );
  }

  // ---- Recovery ---------------------------------------------------------------------------

  async #recover(): Promise<void> {
    const slot = await this.#read();
    await this.#journal.settleOpen(this.#signal);
    const status = await this.#status();
    if (!slot) return this.#install(status);
    // The whole fence, the controller's and the runtime's. Only waking may find the epoch moved
    // on by a resume that applied; its own check compares it with that resume.
    // Waking: the controller may be a resume ahead and the runtime an adopt behind; the wake's
    // own checks compare the epoch with that resume.
    const expected = (fence: BrowserPoolRuntimeFence | null) =>
      slot.phase === "waking" && fence
        ? sameFence(fence, { ...fenceOf(slot), epoch: fence.epoch })
        : sameFence(fence, fenceOf(slot));
    // A stopped guest has no fence: it is replaced, with nothing to adopt.
    if (!expected(statusFence(status))) return this.#discard(slot, "guest-restarted");
    // A paused guest has no runtime to ask: the row and the controller's signed status say where
    // it is, with nothing cached from before a Home restart.
    if (status.phase === "paused") {
      const saved = slot.savedState as { id?: string } | null;
      switch (slot.phase) {
        case "parked":
          if (saved?.id && status.savedState?.id === saved.id) return;
          return this.#continueWake(await this.#advance(slot, { phase: "waking" }));
        case "waking":
          return this.#continueWake(slot);
        case "preparing":
          // The pause applied before its row was written: the park finishes.
          await this.#pause(slot);
          return;
        default:
          // Running by the row and paused by the controller: no intent explains it.
          return this.#discard(slot, "guest-changed");
      }
    }
    // A running guest is asked; one that cannot answer yet is asked again by a later turn.
    const state = await this.#state();
    if (!expected(state.fence)) return this.#discard(slot, "guest-restarted");
    switch (slot.phase) {
      case "running":
        if (state.phase === "running") return this.#finishRunning(slot, []);
        await this.#abort(slot);
        return;
      case "preparing":
        // A retiring or retired runtime is recovered as not parked; a sealed one goes forward.
        if (sameIntent(state, slot) && state.phase === "sealed") await this.#sealAndPause(slot);
        else await this.#abort(slot);
        return;
      case "parked":
        // Parked by the row and running by the controller: it is woken from what it holds.
        return this.#continueWake(await this.#advance(slot, { phase: "waking" }));
      case "waking":
        return this.#continueWake(slot);
    }
  }

  /**
   * Without its row the Home has no session that could own a page in a guest, so whatever guest
   * the controller reports is stopped and a fresh one started; its fence is the controller's.
   */
  async #install(status: BrowserPoolPhysicalStatus) {
    // A first install that applied before the Home went: its guest is installed, not replaced.
    const applied = await this.#appliedStart(status, undefined);
    let replacing = true;
    if (!applied && status.phase !== "stopped") {
      const stopped = await this.#call(undefined, "stop", status, replacing);
      replacing = false;
      // A refusal returns the state now: a guest that is stopped anyway is stopped.
      if (!stopped.applied && stopped.status.phase !== "stopped")
        throw new Error(`The guest did not stop: ${stopped.reason}.`);
      status = stopped.status;
    }
    const started = applied?.result ?? (await this.#call(undefined, "start", status, replacing));
    if (!started.applied) throw new BrowserPoolNotStarted(started.reason);
    if (!started.control || !started.signature)
      throw new Error(`The guest did not start: ${started.reason}.`);
    const { state: installed } = await this.#deliver(started.control, started.signature);
    if (installed.phase !== "running" || !sameFence(installed.fence, started.control.fence))
      throw new Error("The guest was not installed.");
    // The fence comes from the controller, never from the runtime's own state.
    this.#slot = await installBrowserPoolSlot(
      this.#options.database,
      this.#target(started.control.fence),
    );
    await this.#markInstalled(started.id);
  }

  /**
   * A Start the controller applied whose guest is the one running now and that the slot does
   * not hold yet: a Home went between that Start and its install. It is this replacement's, so it
   * is installed, never replaced again, and the restart keys written with it are answered by it.
   */
  async #appliedStart(
    status: BrowserPoolPhysicalStatus,
    slot: BrowserPoolSlot | undefined,
  ): Promise<
    | { readonly result: BrowserPoolControllerResult; readonly restartKeys: readonly string[] }
    | undefined
  > {
    const running = statusFence(status);
    if (status.phase !== "running" || !running) return undefined;
    for (const row of await listAppliedBrowserPoolStarts(
      this.#options.database,
      this.#options.runnerId,
    )) {
      const result = row.result as unknown as BrowserPoolControllerResult | null;
      if (!result?.control || !result.signature || !sameFence(running, result.control.fence))
        continue;
      // The slot already holds it: nothing is pending, and a new replacement is a new one.
      if (slot && sameFence(fenceOf(slot), result.control.fence)) return undefined;
      return { result, restartKeys: row.restartKeys ?? [] };
    }
    return undefined;
  }

  async #markInstalled(id: string): Promise<void> {
    await (this.#options.testHooks?.markInstalled ?? markBrowserPoolStartInstalled)(
      this.#options.database,
      id,
    ).catch((error: unknown) => this.#options.onError?.(error));
  }

  #target(fence: BrowserPoolRuntimeFence): BrowserPoolTargetIdentity {
    return {
      runnerId: this.#options.runnerId,
      runtimeId: this.#options.runtimeId,
      slotId: fence.slot,
      term: fence.term,
      instanceId: fence.instance,
      epoch: fence.epoch,
    };
  }
}

const discardAfterAttempts = 6;
/** How long a target's calls may go unanswered before the Home asks its account again. */
const unansweredMs = 120_000;
/** How long choosing the next step may read before it is tried again. */
const selectionMs = 30_000;
const refusedRetryMs = 5_000;
const refusedRetryMaxMs = 5 * 60_000;

/**
 * The target's own signed word that this Home's guest is gone: the host key's answer that the
 * slot was deleted, or a stored answer that the call's term is not the slot's (`fenced`).
 * Unsigned refusals are not this: they stay "unknown, ask again".
 */
/**
 * No answer, or none signed (P18): a pool host that cannot be reached, one that answered
 * unsigned (a superseded term is answered only so), a relay that refused, a call past its
 * deadline. Not knowing: asked again later, never counted toward a discard or a failed start.
 */
function unknownAnswer(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 4; depth++) {
    if (cause instanceof BrowserPoolAgentUnavailable || cause instanceof BrowserPoolUnanswered)
      return true;
    const { name, code, message } = cause as { name?: unknown; code?: unknown; message?: unknown };
    if (name === "PoolRelayRefused" || name === "TimeoutError" || name === "AbortError")
      return true;
    if (typeof code === "string" && networkCodes.has(code)) return true;
    if (cause instanceof TypeError && message === "fetch failed") return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

const networkCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function targetOver(error: unknown): string | undefined {
  if (error instanceof BrowserPoolAgentSlotDeleted) return "slot-deleted";
  if (error instanceof BrowserPoolNotStarted && error.reason === "fenced") return "fenced";
  if (error instanceof BrowserPoolTargetFenced) return "fenced";
  return undefined;
}

/** A call the controller refused, signed and stored, because its term is not the slot's. */
class BrowserPoolTargetFenced extends Error {}

/** The controller answered, signed and stored, that it did not start or wake the guest. */
class BrowserPoolNotStarted extends Error {
  readonly reason: string;
  constructor(reason: string | undefined) {
    super(`The guest was not started: ${reason ?? "refused"}.`);
    this.reason = reason ?? "refused";
  }
}
/** How long a step may run before its deadline signal fires. */
const defaultStepMs = 60_000;
/** How long a restart waits for admitted sends to finish once each was asked to stop. */
const quiesceMs = 15_000;
/** The longest wait before an unanswered call is asked again. */
const unansweredRetryMaxMs = 30_000;
/** The bound of a refusal's announcement to clients, outside any step. */
const announceMs = 5_000;
const restartKeysKept = 64;

/** One step of the loop: its name for failure counting, its work, and its fallback. */
interface Step {
  readonly name: string;
  readonly deadlineMs?: number;
  run(signal: AbortSignal): Promise<void>;
  /** After its attempts are used, the loop may choose to give live state up for this one. */
  readonly discards?: boolean;
}

function restartKeysOf(slot: BrowserPoolSlot): readonly string[] {
  return Array.isArray(slot.restartKeys) ? slot.restartKeys : [];
}

/** The newest handled keys first, each once, bounded. */
function withRestartKeys(slot: BrowserPoolSlot, keys: readonly string[]): readonly string[] {
  return [...new Set([...keys, ...restartKeysOf(slot)])].slice(0, restartKeysKept);
}

/** Keys accepted before a crash whose restart no start has answered yet. */
function pendingRestart(slot: BrowserPoolSlot): string[] {
  const handled = new Set(restartKeysOf(slot));
  const wanted = Array.isArray(slot.restartWanted) ? slot.restartWanted : [];
  return wanted.filter((key) => !handled.has(key));
}

function unrecorded(slot: BrowserPoolSlot | undefined, keys: ReadonlySet<string>): string[] {
  const handled = new Set(slot ? restartKeysOf(slot) : []);
  return [...keys].filter((key) => !handled.has(key));
}

/** Resolves when `signal` aborts. */
function abortableWait(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

/** Why a fresh start happened, in the words clients branch on. */
function startReason(reason: string): "expired" | "host" | "person" {
  if (reason === "person") return "person";
  if (reason === "live-state-unavailable") return "expired";
  return "host";
}
const defaultCallTimeoutMs = 10_000;
const defaultPruneEveryMs = 60 * 60_000;

/** Every fence comparison: slot, term, instance and epoch alike. */
function sameFence(a: BrowserPoolRuntimeFence | null, b: BrowserPoolRuntimeFence): boolean {
  return (
    !!a &&
    a.slot === b.slot &&
    a.term === b.term &&
    a.instance === b.instance &&
    a.epoch === b.epoch
  );
}

/** The controller's fence, when its guest has one. */
function statusFence(status: BrowserPoolPhysicalStatus): BrowserPoolRuntimeFence | null {
  return status.instance !== null && status.epoch !== null
    ? { slot: status.slotId, term: status.term, instance: status.instance, epoch: status.epoch }
    : null;
}

function fenceOf(slot: BrowserPoolSlot): BrowserPoolRuntimeFence {
  return { slot: slot.slotId, term: slot.term, instance: slot.instanceId, epoch: slot.epoch };
}

function sameIntent(state: BrowserPoolRuntimeState, slot: BrowserPoolSlot): boolean {
  return state.intent?.id === slot.intentId && state.intent?.sequence === slot.intentSequence;
}

/** Pages lost on their own, grouped by session, each session kept. */
function pageLosses(
  pages: readonly {
    readonly sessionId: BrowserSessionId;
    readonly surfaceId: string;
    readonly reason: string;
  }[],
  documentOf: (sessionId: BrowserSessionId, surfaceId: string) => string | null = () => null,
): BrowserPoolSessionLoss[] {
  const bySession = new Map<BrowserSessionId, { surfaceId: string; documentId: string | null }[]>();
  for (const { sessionId, surfaceId } of pages)
    bySession.set(sessionId, [
      ...(bySession.get(sessionId) ?? []),
      { surfaceId, documentId: documentOf(sessionId, surfaceId) },
    ]);
  return [...bySession].map(([sessionId, surfaces]) => ({
    sessionId,
    reason: "thaw-failed",
    surfaces,
    endSession: false,
  }));
}

function retainedOf(slot: BrowserPoolSlot | undefined): Retained | undefined {
  const retained = slot?.retained as Retained | null | undefined;
  return retained ?? undefined;
}

function surfacesOf(retained: Retained, sessionId: BrowserSessionId) {
  return (
    retained.documents
      .filter((document) => document.sessionId === sessionId)
      // The park's manifest says for each page whether it held typed text: known yes or no.
      .map(({ surfaceId, documentId, typed }) => ({ surfaceId, documentId, typed: typed === true }))
  );
}
