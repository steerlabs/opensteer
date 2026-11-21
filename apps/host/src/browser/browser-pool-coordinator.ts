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
  }): Promise<readonly BrowserPoolSessionLoss[]>;
  /** Whether this session has a live channel here now. */
  live(sessionId: BrowserSessionId): boolean;
  /** Sessions of this runtime that are not terminal and have no live channel here, with tabs. */
  orphans(runtimeId: string): Promise<readonly Omit<BrowserPoolSessionLoss, "reason">[]>;
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
  #display: { phase: "starting" | "restarting" | "failed"; since: Date } | undefined;
  readonly #lost = new Set<BrowserSessionId>();
  #reconnecting: Promise<void> | undefined;
  #lane: Promise<unknown> = Promise.resolve();

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
    this.gate.attach({
      park: (demanded) => this.#serial(() => this.#park(demanded)),
      wake: () =>
        this.#serial(() =>
          this.#retry(
            () => this.#wake(),
            () => this.#discardNow(),
          ),
        ),
    });
  }

  setAdopter(adopter: BrowserPoolAdopter): void {
    this.#adopter = adopter;
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#pruning);
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

  /** While parked or waking, the retained document stands for the live one. */
  retainedDocument(sessionId: string, surfaceId: string): string | undefined {
    return retainedOf(this.#slot)?.documents.find(
      (document) => document.sessionId === sessionId && document.surfaceId === surfaceId,
    )?.documentId;
  }

  /** Call once the Home's startup sweep has run; the gate stays closed until this settles. */
  recover(): Promise<void> {
    return this.#serial(() =>
      this.#retry(
        () => this.#recover(),
        () => this.#discardNow(),
      ),
    );
  }

  tryPark(): Promise<"parked" | "vetoed"> {
    return this.gate.tryPark();
  }

  /**
   * A pooled session's Runner channel was lost; the guest kept its pages. The gate holds sends
   * while the Home reattaches under a newer attachment generation; past the deadline the
   * sessions end with their note.
   */
  channelLost(sessionId: BrowserSessionId): void {
    if (this.#closed) return;
    this.#lost.add(sessionId);
    if (this.#reconnecting) return;
    this.gate.reconnecting();
    this.#reconnecting = this.#serial(() => this.#reconnect())
      .catch((error: unknown) => this.#options.onError?.(error))
      .finally(() => {
        this.#reconnecting = undefined;
      });
  }

  /**
   * Reattaches the lost sessions until they are back or the deadline passes (R2). The deadline is
   * a timer, so a step that stalls loses to it; a step that fails is tried again. It ends open
   * with every session back, or with the ones not back ended with their note.
   */
  async #reconnect(): Promise<void> {
    const expired = AbortSignal.timeout(this.#options.channelDeadlineMs ?? pooledChannelDeadlineMs);
    while (this.#lost.size && !expired.aborted && !this.#closed) {
      try {
        await untilAborted(this.#reattachLost(), expired);
      } catch (error) {
        if (!expired.aborted) this.#options.onError?.(error);
      }
      if (this.#lost.size && !expired.aborted)
        await delay(this.#options.retryMs ?? 250, undefined, { signal: expired }).catch(
          () => undefined,
        );
    }
    this.#lost.clear();
    // The end is written whatever failed before it: a session not back has no channel and ends
    // here with its note.
    await this.#retry(async () => {
      const slot = await this.#read();
      if (slot?.phase === "running") await this.#finishRunning(slot, []);
      else if (slot) this.gate.settle(slot.phase === "parked" ? "parked" : "open");
    });
  }

  async #reattachLost(): Promise<void> {
    let slot = await this.#read();
    if (!slot || slot.phase !== "running") {
      this.#lost.clear();
      return;
    }
    slot = await this.#advance(slot, {
      phase: slot.phase,
      attachmentGeneration: slot.attachmentGeneration + 1,
    });
    const sessions = [...this.#lost];
    await this.#adopter?.reattach({
      sessions,
      documents: [],
      fence: fenceOf(slot),
      attempt: slot.attachmentGeneration,
    });
    for (const sessionId of sessions)
      if (this.#adopter?.live(sessionId)) this.#lost.delete(sessionId);
  }

  /**
   * The device was removed (R6). The gate is released for good at once; every session of the
   * runtime, and each one the revocation already ended, ends with its note and the slot is marked
   * releasing in one write. The row goes only with evidence the guest stopped, which a driver
   * keeps asking for (and recovery resumes after a Home restart). Resolves once the notes are
   * written; the stop is not awaited.
   */
  releaseDevice(ended: readonly BrowserSessionId[] = []): Promise<void> {
    this.gate.released();
    return this.#serial(() =>
      this.#retry(async () => {
        const slot = await this.#read();
        if (!slot || slot.phase === "releasing") return;
        const sessions = await listBrowserPoolRuntimeSessions(
          this.#options.database,
          slot.runnerId,
          slot.runtimeId,
        );
        const all = [...new Set([...sessions, ...ended])];
        this.#slot = await beginBrowserPoolRelease(
          this.#options.database,
          slot,
          await this.#lossesOf(slot, all, "device-removed"),
        );
      }),
    ).then(() => {
      this.#driveRelease();
    });
  }

  #releasing: Promise<void> | undefined;

  /** Asks for the stop until it is known to have happened, then lets the slot go. */
  #driveRelease(): void {
    if (this.#releasing) return;
    this.#releasing = this.#retry(async () => {
      const slot = await this.#read();
      if (slot?.phase !== "releasing") return;
      // A failed status read is not knowing, never "stopped" (R2); only an applied stop or a
      // status that reads stopped is evidence.
      const status = await this.#status();
      if (status.phase !== "stopped") {
        const stopped = await this.#call(slot, "stop", status);
        if (!stopped.applied && stopped.status.phase !== "stopped")
          throw new Error(`The removed device's guest did not stop: ${stopped.reason}.`);
      }
      await finishBrowserPoolRelease(this.#options.database, slot.runnerId);
      this.#slot = undefined;
    })
      .catch((error: unknown) => this.#options.onError?.(error))
      .finally(() => {
        this.#releasing = undefined;
      });
  }

  /** Test seam: the release driver's end, when one runs. */
  released(): Promise<void> {
    return this.#releasing ?? Promise.resolve();
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#lane.then(work, work);
    this.#lane = run.catch(() => undefined);
    return run;
  }

  /**
   * Retries a step until it settles. Every round tries the step itself; once the attempts are
   * used, a round whose step has just failed again gives up the live state with `exhausted`
   * (R3). A failed round is retried, never taken as an answer.
   */
  async #retry<T>(work: () => Promise<T>, exhausted?: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (this.#closed) throw new BrowserPoolAdmissionClosed("The Home is stopping.");
      try {
        return await work();
      } catch (error) {
        this.#options.onError?.(error);
        if (exhausted && attempt + 1 >= discardAfterAttempts)
          try {
            return await exhausted();
          } catch (fallback) {
            this.#options.onError?.(fallback);
          }
        await delay(Math.min(this.#options.retryMs ?? 100 * 2 ** attempt, 5_000));
      }
    }
  }

  /**
   * The last rung: the live state is discarded behind a fresh guest, whatever phase the slot is
   * in. With no slot row there is nothing to discard; the only step is install, which the next
   * round of recovery tries again.
   */
  async #discardNow(): Promise<void> {
    const slot = await this.#read();
    if (!slot) throw new BrowserPoolAdmissionClosed("The pooled browser has no slot yet.");
    await this.#discard(slot, "unrecoverable");
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

  async #call(
    slot: BrowserPoolSlot | undefined,
    kind: "start" | "pause" | "resume" | "stop",
    status: BrowserPoolPhysicalStatus,
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

  async #park(demanded: () => boolean): Promise<"parked" | "vetoed"> {
    const slot = await this.#read();
    if (!slot || slot.phase !== "running") return "vetoed";
    const intentId = randomUUID();
    let intent: BrowserPoolSlot | undefined;
    try {
      intent = await (this.#options.testHooks?.beginPark ?? beginBrowserPoolPark)(
        this.#options.database,
        browserPoolSlotIdentity(slot),
        intentId,
        demanded,
      );
    } catch (error) {
      // A failed reply to COMMIT does not say whether D exists. Admission stays closed and the
      // intent is read back until it is known.
      intent = await this.#retry(async () => {
        const current = await (this.#options.testHooks?.readSlot ?? readBrowserPoolSlot)(
          this.#options.database,
          this.#options.runnerId,
        );
        return current?.intentId === intentId ? current : null;
      }).then(
        (found) => found ?? undefined,
        () => undefined,
      );
      if (!intent && !(error instanceof BrowserPoolAdmissionClosed)) this.#options.onError?.(error);
    }
    if (!intent) {
      await this.#read();
      return "vetoed";
    }
    this.#slot = intent;
    // A send that arrived before the commit vetoes: the intent is released before any retire.
    const vetoedDuringCommit = !this.gate.committed();
    const expected = this.#adopter?.inventory() ?? [];
    let retireSent = vetoedDuringCommit;
    let abort = vetoedDuringCommit;
    // After D the park only ends parked or released: every attempt re-reads where it stands.
    return this.#retry<"parked" | "vetoed">(
      async () => {
        await this.#journal.settleOpen();
        const slot = await this.#read();
        if (!slot || slot.intentId !== intentId || slot.phase === "running") return "vetoed";
        if (slot.phase === "parked") return "parked";
        let state = this.#state();
        if (!retireSent) {
          retireSent = true;
          const retired = await this.#retire(slot);
          state = retired.state;
          // Rule D: a retire whose reply was lost is aborted, even if the runtime retired.
          if (!retired.answered) abort = true;
        }
        if (abort && state.phase !== "sealed") return this.#abort(slot);
        return this.#afterRetire(slot, state, expected);
      },
      async () => {
        await this.#discardNow();
        return "vetoed";
      },
    );
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
      await this.#finishRunning(slot, []);
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
    if (slot.phase === "running") return this.gate.settle("open");
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
    ];
    await this.#finishRunning(slot, losses, {
      adopted: outcome.adopted,
      lost: outcome.lost,
    });
  }

  /** The ladder's last rung: the live state is discarded and a fresh guest is started. */
  async #discard(slot: BrowserPoolSlot, reason: string): Promise<void> {
    const since = new Date();
    this.#display = { phase: reason === "person" ? "restarting" : "starting", since };
    await announceBrowserPool(this.#options.database).catch(() => undefined);
    try {
      await this.#startFresh(slot, reason);
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

  /** The owner's Restart browser: live and saved state are discarded and a fresh guest starts. */
  restart(): Promise<void> {
    // Admission is held from here until the fresh guest is installed (R1).
    const done = this.gate.restarting();
    return this.#serial(async () => {
      const slot = await this.#read();
      if (!slot) throw new BrowserPoolAdmissionClosed();
      await this.#retry(() => this.#discard(slot, "person"));
    }).finally(done);
  }

  /** The phase a client shows: a fresh start or a restart in progress, or a failed start. */
  report():
    { readonly phase: "starting" | "restarting" | "failed"; readonly since: Date } | undefined {
    return this.#display;
  }

  async #startFresh(slot: BrowserPoolSlot, reason: string): Promise<void> {
    let status = await this.#status();
    if (status.phase !== "stopped") {
      const stopped = await this.#call(slot, "stop", status);
      if (!stopped.applied) throw new Error(`The guest did not stop: ${stopped.reason}.`);
      status = stopped.status;
    }
    const started = await this.#call(slot, "start", status);
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
        failedStarts: 0,
      },
      losses,
    );
    this.gate.settle("open");
  }

  async #lossesOf(
    slot: BrowserPoolSlot,
    sessions: readonly BrowserSessionId[],
    reason: string,
  ): Promise<BrowserPoolSessionLoss[]> {
    const retained = retainedOf(slot);
    const rows = await listBrowserPoolSessionTabs(this.#options.database, sessions);
    return sessions.map((sessionId) => {
      const kept = retained ? surfacesOf(retained, sessionId) : [];
      const known = new Set<string>(kept.map(({ surfaceId }) => surfaceId));
      return {
        sessionId,
        reason,
        surfaces: [
          ...kept,
          ...(rows.get(sessionId) ?? [])
            .filter((surfaceId) => !known.has(surfaceId))
            .map((surfaceId) => ({ surfaceId, documentId: null })),
        ],
      };
    });
  }

  async #finishRunning(
    slot: BrowserPoolSlot,
    losses: readonly BrowserPoolSessionLoss[],
    outcome?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const named = new Set(losses.map(({ sessionId }) => sessionId));
    // A session the Home kept with no browser behind it ends now, with its note.
    const orphans = (await this.#adopter?.orphans(this.#options.runtimeId)) ?? [];
    const retained = retainedOf(slot);
    const all = [
      ...losses,
      ...orphans
        .filter(({ sessionId }) => !named.has(sessionId))
        .map(({ sessionId, surfaces }) => ({
          sessionId,
          reason: "not-adopted",
          surfaces: retained?.sessions.includes(sessionId)
            ? surfacesOf(retained, sessionId)
            : surfaces,
        })),
    ];
    const settled = await this.#advance(
      slot,
      { phase: "running", savedState: null, ...(outcome ? { outcome } : {}) },
      all,
    );
    this.gate.settle("open");
    await pruneBrowserPoolBookkeeping(this.#options.database, settled).catch((error: unknown) =>
      this.#options.onError?.(error),
    );
  }

  // ---- Recovery ---------------------------------------------------------------------------

  async #recover(): Promise<void> {
    const slot = await this.#read();
    if (slot?.phase === "releasing") {
      // A removal a Home restart interrupted: admission never opens again; the stop goes on.
      this.gate.released();
      this.#driveRelease();
      return;
    }
    await this.#journal.settleOpen();
    const status = await this.#status();
    const state = this.#state();
    if (!slot) return this.#install(status);
    // The whole fence, the controller's and the runtime's. Only waking may find the epoch moved
    // on by a resume that applied; its own check compares it with that resume.
    const expected = (fence: BrowserPoolRuntimeFence | null) =>
      slot.phase === "waking" && fence
        ? sameFence(fence, { ...fenceOf(slot), epoch: fence.epoch }) && fence.epoch >= slot.epoch
        : sameFence(fence, fenceOf(slot));
    if (!expected(statusFence(status)) || !expected(state.fence))
      return this.#discard(slot, "guest-restarted");
    switch (slot.phase) {
      case "running":
        if (state.phase === "running") return this.#finishRunning(slot, []);
        return this.#settleAfter(await this.#abort(slot));
      case "preparing":
        // A retiring or retired runtime is recovered as not parked; a sealed one goes forward.
        return this.#settleAfter(
          sameIntent(state, slot) && state.phase === "sealed"
            ? await this.#sealAndPause(slot)
            : await this.#abort(slot),
        );
      case "parked": {
        const saved = slot.savedState as { id?: string } | null;
        if (
          status.phase === "paused" &&
          status.savedState?.id === saved?.id &&
          state.phase === "sealed" &&
          sameIntent(state, slot)
        )
          return this.gate.settle("parked");
        return this.#continueWake(await this.#advance(slot, { phase: "waking" }));
      }
      case "waking":
        return this.#continueWake(slot);
    }
  }

  #settleAfter(outcome: "parked" | "vetoed"): void {
    this.gate.settle(outcome === "parked" ? "parked" : "open");
  }

  /**
   * Without its row the Home has no session that could own a page in a guest, so whatever guest
   * the controller reports is stopped and a fresh one started; its fence is the controller's.
   */
  async #install(status: BrowserPoolPhysicalStatus) {
    if (status.phase !== "stopped") {
      const stopped = await this.#call(undefined, "stop", status);
      if (!stopped.applied) throw new Error(`The guest did not stop: ${stopped.reason}.`);
      status = stopped.status;
    }
    const started = await this.#call(undefined, "start", status);
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
    this.gate.settle("open");
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

/** Stops waiting for `work` when `signal` aborts; the work itself is left to settle. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
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

function retainedOf(slot: BrowserPoolSlot | undefined): Retained | undefined {
  const retained = slot?.retained as Retained | null | undefined;
  return retained ?? undefined;
}

function surfacesOf(retained: Retained, sessionId: BrowserSessionId) {
  return retained.documents
    .filter((document) => document.sessionId === sessionId)
    .map(({ surfaceId, documentId }) => ({ surfaceId, documentId }));
}
