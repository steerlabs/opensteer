import type { Clock } from "./clock.js";

/** Only the domain receiving this clock moves; sockets and test deadlines stay real. */
export class ManualClock implements Clock {
  #now: number;
  readonly #scheduled = new Map<() => void, number>();
  readonly #listeners = new Set<() => void>();

  constructor(now = Date.now()) {
    this.#now = now;
  }

  readonly now = (): number => this.#now;

  readonly schedule = (callback: () => void, milliseconds: number): (() => void) => {
    this.#scheduled.set(callback, this.#now + milliseconds);
    for (const listener of this.#listeners) listener();
    return () => this.#scheduled.delete(callback);
  };

  advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new Error("A domain clock can only advance by a finite nonnegative interval");
    const until = this.#now + milliseconds;
    for (;;) {
      const next = [...this.#scheduled].sort((a, b) => a[1] - b[1])[0];
      if (!next || next[1] > until) break;
      this.#now = next[1];
      this.#scheduled.delete(next[0]);
      next[0]();
    }
    this.#now = until;
  }

  readonly wait = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const cancel = this.schedule(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, milliseconds);
      const abort = () => {
        cancel();
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
    });

  /** Drives domain waits until an observed operation settles, including waits registered after I/O. */
  async runUntilSettled<T>(operation: Promise<T>): Promise<T> {
    let changed!: () => void;
    let change = new Promise<void>((resolve) => {
      changed = resolve;
    });
    const listener = () => changed();
    this.#listeners.add(listener);
    const settled = operation.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      for (;;) {
        const next = [...this.#scheduled.values()].sort((a, b) => a - b)[0];
        if (next !== undefined) {
          this.advanceBy(next - this.#now);
          if (this.#scheduled.size) changed();
        }
        const result = await Promise.race([settled, change.then(() => null)]);
        if (result) {
          if ("error" in result) throw result.error;
          return result.value;
        }
        change = new Promise<void>((resolve) => {
          changed = resolve;
        });
      }
    } finally {
      this.#listeners.delete(listener);
    }
  }
}
