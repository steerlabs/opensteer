import { systemClock, type Clock } from "@opensteer/shared/clock";

interface ReconcileLoopOptions {
  readonly clock?: Pick<Clock, "schedule">;
  readonly intervalMs: number;
  readonly onError: (error: unknown) => void;
  readonly random?: () => number;
  readonly reconcile: () => Promise<void>;
  readonly sweep: () => void;
}

export class ReconcileLoop {
  readonly #intervalMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #random: () => number;
  readonly #reconcile: () => Promise<void>;
  readonly #sweep: () => void;
  readonly #clock: Pick<Clock, "schedule">;
  #completedPasses = 0;
  #active: Promise<void> | undefined;
  #consecutiveFailures = 0;
  #started = false;
  #stopped = false;
  #cancelTimer: (() => void) | undefined;

  constructor(options: ReconcileLoopOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new TypeError("Reconciliation interval must be a positive integer");
    }
    this.#intervalMs = options.intervalMs;
    this.#clock = options.clock ?? systemClock;
    this.#onError = options.onError;
    this.#random = options.random ?? Math.random;
    this.#reconcile = options.reconcile;
    this.#sweep = options.sweep;
  }

  start(): void {
    if (this.#started) throw new Error("Reconciliation loop is already started");
    this.#started = true;
    this.#schedule();
  }

  async close(): Promise<void> {
    this.#stopped = true;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    await this.#active;
  }

  /** Waits for the current pass, including rescheduling; it never starts more work. */
  async settled(): Promise<number> {
    await this.#active;
    return this.#completedPasses;
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#cancelTimer = this.#clock.schedule(() => {
      this.#cancelTimer = undefined;
      const active = this.#run().finally(() => {
        this.#completedPasses += 1;
        if (this.#active === active) this.#active = undefined;
        this.#schedule();
      });
      this.#active = active;
    }, this.#nextDelayMs());
  }

  async #run(): Promise<void> {
    try {
      this.#sweep();
      await this.#reconcile();
      this.#consecutiveFailures = 0;
    } catch (error) {
      this.#consecutiveFailures += 1;
      try {
        this.#onError(error);
      } catch {
        // Error reporting must not stop reconciliation or Host shutdown.
      }
    }
  }

  #nextDelayMs(): number {
    // Jitter keeps Hosts sharing one database from reconciling in lockstep.
    if (this.#consecutiveFailures === 0) {
      return Math.floor(this.#intervalMs * (0.5 + this.#random()));
    }
    const ceiling = this.#intervalMs * Math.min(10, 2 ** this.#consecutiveFailures);
    return Math.floor(this.#random() * ceiling);
  }
}

/** Independent reconcilers settle before dependent work, even when a sibling fails. */
export async function reconcileServices(
  work: readonly Promise<unknown>[],
  afterSettled: () => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(work);
  await afterSettled();
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) throw new AggregateError(failures, "Host reconciliation failed");
}
