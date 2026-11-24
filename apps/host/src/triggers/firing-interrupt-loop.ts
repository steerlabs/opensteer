import { createId, type RunnerId, type TriggerOccurrenceId } from "@opensteer/core";
import type { RunningFiringRef, TriggerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import { CorrelationIdSchema, triggerStopGenerationCapability } from "@opensteer/protocol";

const initialRetryDelayMs = 1_000;
const maxRetryDelayMs = 30_000;
const dispatchTimeoutMs = 3_000;

interface PendingInterrupt {
  attempts: number;
  firing: RunningFiringRef;
  inFlight: boolean;
  timer: NodeJS.Timeout | undefined;
}

export interface FiringInterruptLoopOptions {
  readonly onWarn?: (error: unknown, firing: RunningFiringRef) => void;
  readonly runners: Pick<RunnerRegistry, "dispatch" | "identityForEnvironment">;
  readonly store: Pick<TriggerStore, "isFiringStillRunning" | "listPausedRunningFirings">;
}

/**
 * Keeps sending `trigger.interrupt` for running firings whose automation was paused or archived
 * (from any pause path or across Host restarts) until terminal evidence arrives (AA10).
 */
export class FiringInterruptLoop {
  readonly #onWarn: FiringInterruptLoopOptions["onWarn"];
  readonly #runners: FiringInterruptLoopOptions["runners"];
  readonly #store: FiringInterruptLoopOptions["store"];
  readonly #pending = new Map<TriggerOccurrenceId, PendingInterrupt>();
  #closed = false;
  #waking: Promise<void> | undefined;

  constructor(options: FiringInterruptLoopOptions) {
    this.#onWarn = options.onWarn;
    this.#runners = options.runners;
    this.#store = options.store;
  }

  /** Enqueues a running firing for immediate interrupt and retries until terminal evidence. */
  interrupt(firing: RunningFiringRef): void {
    if (this.#closed) return;
    const existing = this.#pending.get(firing.occurrenceId);
    if (existing) {
      existing.firing = firing;
      if (!existing.inFlight) {
        this.#clearTimer(existing);
        void this.#attempt(existing, false);
      }
      return;
    }
    const entry: PendingInterrupt = {
      attempts: 0,
      firing,
      inFlight: false,
      timer: undefined,
    };
    this.#pending.set(firing.occurrenceId, entry);
    void this.#attempt(entry, false);
  }

  /** Reconciles any running firings whose automation is paused/archived (any pause path or restart). */
  wake(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#waking ??= this.#store
      .listPausedRunningFirings()
      .then((firings) => {
        if (this.#closed) return;
        for (const firing of firings) this.interrupt(firing);
      })
      .catch(() => undefined)
      .finally(() => {
        this.#waking = undefined;
      });
    return this.#waking;
  }

  /**
   * Clears pending interrupts once a Runner reattaches: attachRunnerFirings already answers
   * `revoked` for any paused/archived firing on the same boot (so the Runner aborts it directly)
   * and settles unannounced firings on a new boot to `unknown` (AB4).
   */
  runnerAttached(runnerId: RunnerId, _bootId: string): void {
    if (this.#closed) return;
    for (const [occurrenceId, entry] of this.#pending) {
      if (entry.firing.runnerId !== runnerId) continue;
      this.#clearTimer(entry);
      this.#pending.delete(occurrenceId);
    }
  }

  /** Marks an occurrence settled once terminal evidence arrives in completeExecution. */
  settled(occurrenceId: TriggerOccurrenceId): void {
    const entry = this.#pending.get(occurrenceId);
    if (!entry) return;
    this.#clearTimer(entry);
    this.#pending.delete(occurrenceId);
  }

  pendingCount(): number {
    return this.#pending.size;
  }

  close(): void {
    this.#closed = true;
    for (const entry of this.#pending.values()) this.#clearTimer(entry);
    this.#pending.clear();
  }

  async #attempt(entry: PendingInterrupt, checkStoreFirst: boolean): Promise<void> {
    if (this.#closed || entry.inFlight || this.#pending.get(entry.firing.occurrenceId) !== entry) {
      return;
    }
    entry.inFlight = true;
    this.#clearTimer(entry);
    try {
      // AB4 (rule 7): Never query PostgreSQL or arm a retry timer while the Runner is away.
      // Reattach revokes paused firings directly in the attach reply.
      const identity = this.#connectedIdentity(entry.firing);
      if (!identity) return;

      if (checkStoreFirst) {
        const stillRunning = await this.#store.isFiringStillRunning(entry.firing).catch(() => true);
        if (this.#closed || this.#pending.get(entry.firing.occurrenceId) !== entry) return;
        if (!stillRunning) {
          this.#pending.delete(entry.firing.occurrenceId);
          return;
        }
      }

      const currentIdentity = this.#connectedIdentity(entry.firing);
      if (!currentIdentity) return;

      const stopId = createId("command");
      await this.#runners.dispatch(
        {
          commandId: stopId,
          correlationId: CorrelationIdSchema.parse(stopId),
          environmentId: entry.firing.environmentId,
          executionGeneration: entry.firing.executionGeneration,
          occurrenceId: entry.firing.occurrenceId,
          type: "trigger.interrupt",
        },
        AbortSignal.timeout(dispatchTimeoutMs),
        { connectionGeneration: currentIdentity.connectionGeneration },
      );

      // Dispatching the interrupt frame does not by itself prove termination: keep checking
      // only while the Runner remains connected; if it disconnects, attach handles it on return.
      if (this.#closed || this.#pending.get(entry.firing.occurrenceId) !== entry) return;
      if (this.#connectedIdentity(entry.firing)) {
        this.#scheduleRetry(entry);
      }
    } catch (error) {
      this.#onWarn?.(error, entry.firing);
      if (this.#closed || this.#pending.get(entry.firing.occurrenceId) !== entry) return;
      if (this.#connectedIdentity(entry.firing)) {
        this.#scheduleRetry(entry);
      }
    } finally {
      entry.inFlight = false;
    }
  }

  #connectedIdentity(firing: RunningFiringRef) {
    const identity = this.#runners.identityForEnvironment(firing.environmentId);
    if (
      !identity ||
      identity.runnerId !== firing.runnerId ||
      identity.bootId !== firing.runnerBootId ||
      !identity.capabilities.includes(triggerStopGenerationCapability)
    ) {
      return null;
    }
    return identity;
  }

  #scheduleRetry(entry: PendingInterrupt): void {
    if (this.#closed || this.#pending.get(entry.firing.occurrenceId) !== entry) return;
    const delayMs = Math.min(
      maxRetryDelayMs,
      initialRetryDelayMs * 2 ** Math.min(entry.attempts, 5),
    );
    entry.attempts += 1;
    this.#clearTimer(entry);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.#attempt(entry, true);
    }, delayMs);
    entry.timer.unref();
  }

  #clearTimer(entry: PendingInterrupt): void {
    if (!entry.timer) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
}
