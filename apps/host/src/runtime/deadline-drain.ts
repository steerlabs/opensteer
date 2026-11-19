import { systemClock, type Clock } from "@opensteer/shared/clock";

const maxTimerMs = 2 ** 31 - 1;
const firstRetryMs = 5_000;
const maxRetryMs = 5 * 60_000;

/** A pass that left durable work undone without failing: try again after the backoff. */
export const retryWithBackoff = Symbol("retryWithBackoff");

/** Backs off, but runs no later than a deadline the pass already knows about. */
export interface BackoffNoLaterThan {
  readonly backoffNoLaterThan: Date;
}

type DrainResult = Date | null | typeof retryWithBackoff | BackoffNoLaterThan;

interface DeadlineDrainOptions {
  readonly clock?: Clock;
  readonly drain: () => Promise<DrainResult>;
  readonly onError?: (error: unknown) => void;
}

/**
 * Runs after a wake or at the next durable deadline. A wake during a pass runs
 * again. A failed pass, or one that returns `retryWithBackoff`, retries after
 * 5 s doubling to 5 min; any clean pass resets the backoff.
 */
export class DeadlineDrain {
  readonly #options: DeadlineDrainOptions;
  readonly #clock: Clock;
  #work: Promise<void> | undefined;
  #cancelTimer: (() => void) | undefined;
  #dirty = false;
  #started = false;
  #closed = false;
  #completedPasses = 0;
  #failedPasses = 0;

  constructor(options: DeadlineDrainOptions) {
    this.#options = options;
    this.#clock = options.clock ?? { ...systemClock, now: Date.now };
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.wake();
  }

  /**
   * New durable work or a change that may unblock it: runs a pass now, with the
   * backoff reset. A wake during a pass makes that pass run again after it ends,
   * and every pass ends by arming from what it read, so work that arrives between
   * a pass's read and its arm is never lost: its commit wakes the owner.
   */
  wake(): void {
    this.#failedPasses = 0;
    this.#startPass();
  }

  #startPass(): void {
    if (this.#closed) return;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#dirty = true;
    this.#work ??= this.#run().finally(() => {
      this.#work = undefined;
      if (this.#dirty) this.#startPass();
    });
  }

  async settled(): Promise<number> {
    while (this.#work) await this.#work;
    return this.#completedPasses;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#dirty = false;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    await this.#work;
  }

  async #run(): Promise<void> {
    let next: Date | null = null;
    while (this.#dirty) {
      this.#dirty = false;
      try {
        const result = await this.#options.drain();
        if (result === retryWithBackoff) next = this.#backoff();
        else if (result && !(result instanceof Date)) {
          const backoff = this.#backoff();
          next = result.backoffNoLaterThan < backoff ? result.backoffNoLaterThan : backoff;
        } else {
          this.#failedPasses = 0;
          next = result;
        }
      } catch (error) {
        // A failed read cannot establish that the durable queue is empty.
        next = this.#backoff();
        this.#options.onError?.(error);
      } finally {
        this.#completedPasses++;
      }
    }
    if (next && !this.#closed)
      // The owner's own deadline or retry: keeps the backoff growing.
      this.#cancelTimer = this.#clock.schedule(
        () => this.#startPass(),
        Math.min(maxTimerMs, Math.max(0, next.getTime() - this.#clock.now())),
      );
  }

  #backoff(): Date {
    const delay = Math.min(maxRetryMs, firstRetryMs * 2 ** Math.min(this.#failedPasses, 16));
    this.#failedPasses++;
    return new Date(this.#clock.now() + delay);
  }
}
