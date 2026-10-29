/** Exponential restart backoff for supervised child processes. */

export interface RestartPolicyOptions {
  readonly baseMs: number;
  /** null leaves the attempt budget unbounded. */
  readonly maximumAttempts: number | null;
  readonly maximumMs: number;
  readonly resetAfterMs: number;
}

/** One capped exponential backoff shared by desktop process supervisors. */
export class RestartPolicy {
  readonly #options: RestartPolicyOptions;
  #attempt = 0;
  #resetTimer: NodeJS.Timeout | undefined;

  constructor(options: RestartPolicyOptions) {
    assertPositive(options.baseMs, "baseMs");
    assertPositive(options.maximumMs, "maximumMs");
    assertPositive(options.resetAfterMs, "resetAfterMs");
    if (options.maximumMs < options.baseMs) {
      throw new TypeError("RestartPolicy maximumMs must be at least baseMs");
    }
    if (
      options.maximumAttempts !== null &&
      (!Number.isInteger(options.maximumAttempts) || options.maximumAttempts < 1)
    ) {
      throw new TypeError("RestartPolicy maximumAttempts must be null or a positive integer");
    }
    this.#options = options;
  }

  /** Restarts counted since the last reset. */
  get attempt(): number {
    return this.#attempt;
  }

  /**
   * Counts this restart and returns how long to wait before it, or null once
   * the attempt budget is spent. A crash also disarms any pending reset: the
   * run that armed it did not stay up.
   */
  nextDelayMs(): number | null {
    this.#clearResetTimer();
    this.#attempt += 1;
    const { baseMs, maximumAttempts, maximumMs } = this.#options;
    if (maximumAttempts !== null && this.#attempt > maximumAttempts) return null;
    return Math.min(maximumMs, baseMs * 2 ** (this.#attempt - 1));
  }

  /**
   * Arms the reset timer for a child that has just started. Surviving
   * `resetAfterMs` clears the attempt count, so an occasional crash never
   * inherits the backoff of one hours earlier. The timer is unref'd: it must
   * not hold the process open.
   */
  markStarted(): void {
    this.#clearResetTimer();
    this.#resetTimer = setTimeout(() => {
      this.#resetTimer = undefined;
      this.#attempt = 0;
    }, this.#options.resetAfterMs);
    this.#resetTimer.unref?.();
  }

  reset(): void {
    this.#clearResetTimer();
    this.#attempt = 0;
  }

  dispose(): void {
    this.#clearResetTimer();
  }

  #clearResetTimer(): void {
    if (!this.#resetTimer) return;
    clearTimeout(this.#resetTimer);
    this.#resetTimer = undefined;
  }
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`RestartPolicy ${name} must be a positive finite number of milliseconds`);
  }
}
