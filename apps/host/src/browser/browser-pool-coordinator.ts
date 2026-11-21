import type {
  BrowserPoolControl,
  BrowserPoolDocument,
  BrowserPoolRuntimeFence,
  BrowserPoolRuntimeState,
} from "@opensteer/browser-runtime-core";
import type { BrowserSessionId, RunnerId } from "@opensteer/core";
import {
  advanceBrowserPoolSlot,
  beginBrowserPoolPark,
  BrowserPoolAdmissionClosed,
  browserPoolSlotIdentity,
  installBrowserPoolSlot,
  listBrowserPoolRuntimeSessions,
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
import { pooledChannelDeadlineMs } from "@opensteer/browser-runtime-core";
import {
  BrowserPoolControllerJournal,
  expectationOf,
  type BrowserPoolControllerResult,
  type BrowserPoolPhysicalController,
  type BrowserPoolPhysicalStatus,
} from "./browser-pool-controller.js";
import { BrowserPoolGate } from "./browser-pool-gate.js";

/** The runtime's signed control channel; in-process for the loopback target. */
export interface BrowserPoolRuntimeChannel {
  poolState(): BrowserPoolRuntimeState | undefined;
  controlPool(control: BrowserPoolControl, signature: Uint8Array): Promise<BrowserPoolRuntimeState>;
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
  quiesce(): Promise<void>;
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
  /** How long a lost Runner channel may take to come back before its sessions end. */
  readonly channelDeadlineMs?: number;
  /** Every controller call and runtime control has this deadline; then its outcome is read. */
  readonly callTimeoutMs?: number;
  /** How often finished bookkeeping past its retention is removed, idle or not. */
  readonly pruneEveryMs?: number;
  readonly onError?: (error: unknown) => void;
  /** Tests lose a commit's reply, a read, or a journal acknowledgement. */
  readonly testHooks?: {
    readonly beginPark?: typeof beginBrowserPoolPark;
    readonly readSlot?: typeof readBrowserPoolSlot;
    readonly settleCall?: (id: string, result: Readonly<Record<string, unknown>>) => Promise<void>;
  };
  /** Tests lose a runtime control's request or its reply. */
  readonly runtimeFault?: (kind: BrowserPoolControl["kind"]) => BrowserPoolRuntimeFault | undefined;
}

interface Retained {
  readonly documents: readonly BrowserPoolDocument[];
  readonly sessions: readonly BrowserSessionId[];
}

/**
 * The Home's half of the pool for one target: the owner of intent. It drives every state,
 * including one found after a restart, to an open or parked gate. The ladder ends in a discard
 * of live state and an open gate, never in a closed one.
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
    { readonly keys: Set<string>; readonly done: PromiseWithResolvers<void> } | undefined;
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
    return (
      this.#lost.get(sessionId)?.documents?.get(surfaceId) ??
      retainedOf(this.#slot)?.documents.find(
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

  /** A pooled session's Runner channel was lost: the loop reattaches it inside its window. */
  channelLost(sessionId: BrowserSessionId, documents?: ReadonlyMap<string, string>): void {
    if (this.#closed) return;
    if (!this.#lost.has(sessionId))
      this.#lost.set(sessionId, { since: Date.now(), ...(documents ? { documents } : {}) });
    this.#publish(this.#slot);
    this.#kick();
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
    this.#restartWanted ??= { keys: new Set(), done: Promise.withResolvers() };
    if (input.key) this.#restartWanted.keys.add(input.key);
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
    let failing: string | undefined;
    while (!this.#closed && !this.#ended) {
      const changed = this.#changed.signal;
      let step: Step | undefined;
      try {
        step = await this.#next();
        if (!step) {
          failures = 0;
          await abortableWait(changed);
          continue;
        }
        // The step is awaited to its end; its own deadlines bound it, so nothing is abandoned.
        await step.run(AbortSignal.timeout(step.deadlineMs ?? defaultStepMs));
        if (failing === step.name) failures = 0;
        this.#publish(this.#slot);
      } catch (error) {
        this.#options.onError?.(error);
        if (step) {
          failures = failing === step.name ? failures + 1 : 1;
          failing = step.name;
          // Once the attempts are used and the step has just failed again, its live state is
          // given up for behind a fresh guest (R3); a failed fallback is tried again later.
          if (step.fallback && failures >= discardAfterAttempts)
            await step.fallback().catch((fallback: unknown) => this.#options.onError?.(fallback));
        }
        await delay(
          Math.min(this.#options.retryMs ?? 100 * 2 ** Math.min(failures, 6), 5_000),
          undefined,
          {
            signal: this.#changed.signal,
          },
        ).catch(() => undefined);
      }
    }
  }

  async #next(): Promise<Step | undefined> {
    const slot = await this.#read();
    this.#publish(slot);
    if (this.#released || slot?.phase === "releasing")
      return { name: "release", run: () => this.#releaseStep(slot) };
    if (this.#restartWanted) return { name: "restart", run: () => this.#restartStep(slot) };
    if (this.#unknownIntent) return { name: "intent", run: () => this.#readIntent() };
    if (!this.#recovered || !slot || slot.phase === "preparing" || slot.phase === "waking")
      return {
        name: "recover",
        run: () => this.#recoverStep(),
        ...(slot ? { fallback: () => this.#discardRead("unrecoverable") } : {}),
      };
    const withoutChannel = slot.phase === "running" ? await this.#withoutChannel() : [];
    if (withoutChannel.length)
      return {
        name: "reconnect",
        deadlineMs: this.#channelDeadlineMs,
        run: (signal) => this.#reconnectStep(slot, withoutChannel, signal),
      };
    if (slot.phase === "parked" && this.gate.demand)
      return {
        name: "wake",
        run: () => this.#wakeStep(),
        fallback: () => this.#discardRead("unrecoverable"),
      };
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
    return this.#options.channelDeadlineMs ?? pooledChannelDeadlineMs;
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
    for (const sessionId of back) this.#lost.delete(sessionId);
    if (back.length < within.length) throw new Error("A session is not back yet.");
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
    if (slot?.phase === "releasing") {
      // A failed status read is not knowing, never "stopped" (R2); only an applied stop or a
      // status that reads stopped is evidence.
      const status = await this.#status();
      if (status.phase !== "stopped") {
        const stopped = await this.#call(slot, "stop", status, true);
        if (!stopped.applied && stopped.status.phase !== "stopped")
          throw new Error(`The removed device's guest did not stop: ${stopped.reason}.`);
      }
      await finishBrowserPoolRelease(this.#options.database, slot.runnerId);
    }
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
    if (slot) {
      const handled = new Set(restartKeysOf(slot));
      if (!wanted.keys.size || [...wanted.keys].some((key) => !handled.has(key))) {
        await this.#adopter?.quiesce();
        await withTimeout(this.gate.idle(), quiesceMs, {
          timeoutError: () => new Error("A send still holds the browser."),
        }).catch((error: unknown) => this.#options.onError?.(error));
        // The live set: a restart that joins while this one runs is answered by the same start.
        await this.#discard(slot, "person", wanted.keys);
      }
      // One that joined after the start was written: its key is recorded with that start too.
      for (
        let late = unrecorded(this.#slot, wanted.keys);
        this.#slot && late.length;
        late = unrecorded(this.#slot, wanted.keys)
      )
        await this.#advance(this.#slot, {
          phase: this.#slot.phase,
          restartKeys: withRestartKeys(this.#slot, late),
        });
    }
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
    this.#slot = await advanceBrowserPoolSlot(this.#options.database, slot, next, losses);
    return this.#slot;
  }

  #state(): BrowserPoolRuntimeState {
    const state = this.#options.runtime.poolState();
    if (!state) throw new Error("The pooled runtime has no pool control.");
    return state;
  }

  #status(): Promise<BrowserPoolPhysicalStatus> {
    return this.#journal.status(this.#options.slotId, this.#options.term);
  }

  /** `replacing`: this call replaces the guest, and closes every open journal row with `status`. */
  async #call(
    slot: BrowserPoolSlot | undefined,
    kind: "start" | "pause" | "resume" | "stop",
    status: BrowserPoolPhysicalStatus,
    replacing = false,
  ): Promise<BrowserPoolControllerResult> {
    return this.#journal.call(
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
    );
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
    );
    const issued = signed.control;
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
    const fault = this.#options.runtimeFault?.(control.kind);
    if (fault === "request") return { state: this.#state(), answered: false };
    try {
      const state = await withTimeout(
        this.#options.runtime.controlPool(control, Buffer.from(signature, "base64")),
        this.#options.callTimeoutMs ?? defaultCallTimeoutMs,
        { timeoutError: () => new Error("The runtime did not answer in time.") },
      );
      return fault === "reply"
        ? { state: this.#state(), answered: false }
        : { state, answered: true };
    } catch {
      // A refusal and a lost reply look alike here: the current state decides.
      return { state: this.#state(), answered: false };
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
    await this.#journal.settleOpen();
    let state = this.#state();
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
    let state = this.#state();
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
    let state = this.#state();
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
    await this.#journal.settleOpen();
    let slot = await this.#read();
    if (!slot) throw new BrowserPoolAdmissionClosed();
    if (slot.phase === "running") return;
    if (slot.phase === "parked") slot = await this.#advance(slot, { phase: "waking" });
    if (slot.phase !== "waking") throw new Error(`Cannot wake from ${slot.phase}.`);
    return this.#continueWake(slot);
  }

  async #continueWake(slot: BrowserPoolSlot): Promise<void> {
    const saved = slot.savedState as { id?: string } | null;
    let status = await this.#status();
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
      if (!result.applied) return this.#discard(slot, result.reason ?? "resume-refused");
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
    let state = this.#state();
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
      if (this.#adopter)
        tabLosses = await this.#adopter.reattach({
          sessions: state.adoption.sessions,
          documents: retained.documents,
          fence: state.fence!,
          attempt,
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
      // A fresh start that did not come up: the person sees it failed, and how often.
      this.#display = { phase: "failed", since: new Date() };
      await recordBrowserPoolStartFailure(this.#options.database, slot.runnerId).catch(
        () => undefined,
      );
      throw error;
    }
  }

  /** The phase a client shows: a fresh start or a restart in progress, or a failed start. */
  report():
    { readonly phase: "starting" | "restarting" | "failed"; readonly since: Date } | undefined {
    return this.#display;
  }

  async #startFresh(
    slot: BrowserPoolSlot,
    reason: string,
    keys: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    let status = await this.#status();
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
    const started = await this.#call(slot, "start", status, replacing);
    if (!started.applied || !started.control || !started.signature)
      throw new Error(`The guest did not start: ${started.reason}.`);
    const { state } = await this.#deliver(started.control, started.signature);
    if (state.phase !== "running" || !sameFence(state.fence, started.control.fence))
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
          slotId: started.control.fence.slot,
          term: started.control.fence.term,
          instanceId: started.control.fence.instance,
          epoch: started.control.fence.epoch,
        },
        savedState: null,
        outcome: { adopted: [], lost: losses.map(({ sessionId }) => ({ sessionId, reason })) },
        lastStart: {
          reason: startReason(reason),
          at: new Date().toISOString(),
          id: randomUUID(),
        },
        // Every key the restart was asked with is handled by this one start.
        ...(keys.size ? { restartKeys: withRestartKeys(slot, [...keys]) } : {}),
        failedStarts: 0,
      },
      losses,
    );
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
    await this.#journal.settleOpen();
    const status = await this.#status();
    const state = this.#state();
    if (!slot) return this.#install(status);
    // The whole fence, the controller's and the runtime's. Only waking may find the epoch moved
    // on by a resume that applied; its own check compares it with that resume.
    // Waking: the controller may be a resume ahead and the runtime an adopt behind; the wake's
    // own checks compare the epoch with that resume.
    const expected = (fence: BrowserPoolRuntimeFence | null) =>
      slot.phase === "waking" && fence
        ? sameFence(fence, { ...fenceOf(slot), epoch: fence.epoch })
        : sameFence(fence, fenceOf(slot));
    if (!expected(statusFence(status)) || !expected(state.fence))
      return this.#discard(slot, "guest-restarted");
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
      case "parked": {
        const saved = slot.savedState as { id?: string } | null;
        if (
          status.phase === "paused" &&
          status.savedState?.id === saved?.id &&
          state.phase === "sealed" &&
          sameIntent(state, slot)
        )
          return;
        return this.#continueWake(await this.#advance(slot, { phase: "waking" }));
      }
      case "waking":
        return this.#continueWake(slot);
    }
  }

  /**
   * Without its row the Home has no session that could own a page in a guest, so whatever guest
   * the controller reports is stopped and a fresh one started; its fence is the controller's.
   */
  async #install(status: BrowserPoolPhysicalStatus) {
    let replacing = true;
    if (status.phase !== "stopped") {
      const stopped = await this.#call(undefined, "stop", status, replacing);
      replacing = false;
      // A refusal returns the state now: a guest that is stopped anyway is stopped.
      if (!stopped.applied && stopped.status.phase !== "stopped")
        throw new Error(`The guest did not stop: ${stopped.reason}.`);
      status = stopped.status;
    }
    const started = await this.#call(undefined, "start", status, replacing);
    if (!started.applied || !started.control || !started.signature)
      throw new Error(`The guest did not start: ${started.reason}.`);
    const { state: installed } = await this.#deliver(started.control, started.signature);
    if (installed.phase !== "running" || !sameFence(installed.fence, started.control.fence))
      throw new Error("The guest was not installed.");
    // The fence comes from the controller, never from the runtime's own state.
    this.#slot = await installBrowserPoolSlot(
      this.#options.database,
      this.#target(started.control.fence),
    );
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
/** How long a step may run before its deadline signal fires. */
const defaultStepMs = 60_000;
/** How long a restart waits for admitted sends to finish once each was asked to stop. */
const quiesceMs = 15_000;
const restartKeysKept = 64;

/** One step of the loop: its name for failure counting, its work, and its fallback. */
interface Step {
  readonly name: string;
  readonly deadlineMs?: number;
  run(signal: AbortSignal): Promise<void>;
  readonly fallback?: () => Promise<void>;
}

function restartKeysOf(slot: BrowserPoolSlot): readonly string[] {
  return Array.isArray(slot.restartKeys) ? slot.restartKeys : [];
}

/** The newest handled keys first, each once, bounded. */
function withRestartKeys(slot: BrowserPoolSlot, keys: readonly string[]): readonly string[] {
  return [...new Set([...keys, ...restartKeysOf(slot)])].slice(0, restartKeysKept);
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
  return retained.documents
    .filter((document) => document.sessionId === sessionId)
    .map(({ surfaceId, documentId, typed }) => ({ surfaceId, documentId, typed: typed === true }));
}
