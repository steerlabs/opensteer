import { systemClock, type Clock } from "@opensteer/shared/clock";

interface WorkspaceReconcileLoopOptions {
  readonly clock?: Pick<Clock, "schedule">;
  readonly intervalMs: number;
  readonly onError: (error: unknown) => void;
  readonly random?: () => number;
  readonly reconcile: () => Promise<void>;
  readonly sweep: () => void;
}

export class WorkspaceReconcileLoop {
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

  constructor(options: WorkspaceReconcileLoopOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new TypeError("Workspace reconciliation interval must be a positive integer");
    }
    this.#intervalMs = options.intervalMs;
    this.#clock = options.clock ?? systemClock;
    this.#onError = options.onError;
    this.#random = options.random ?? Math.random;
    this.#reconcile = options.reconcile;
    this.#sweep = options.sweep;
  }

  start(): void {
    if (this.#started) throw new Error("Workspace reconciliation loop is already started");
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
        // Error reporting must not stop storage reconciliation or Host shutdown.
      }
    }
  }

  #nextDelayMs(): number {
    // Healthy passes are jittered across a full interval so that several Host
    // instances sharing one Manager and one database do not sweep in lockstep
    // — the archive sweep on this pass mutates rows every Host is eligible to
    // claim. The window is centred on the configured interval, so the mean
    // cadence is unchanged: jitter de-correlates the fleet, it does not
    // double the reconcile rate.
    if (this.#consecutiveFailures === 0) {
      return Math.floor(this.#intervalMs * (0.5 + this.#random()));
    }
    const ceiling = this.#intervalMs * Math.min(10, 2 ** this.#consecutiveFailures);
    return Math.floor(this.#random() * ceiling);
  }
}
