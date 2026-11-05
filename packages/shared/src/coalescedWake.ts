/**
 * Runs passes one at a time. A wake during a pass asks for exactly one more,
 * because the running pass may already have read past what the wake announced.
 * A failed pass is not retried on its own, so an outage cannot spin; a wake
 * that arrived during it still runs.
 */
export class CoalescedWake {
  readonly #run: () => Promise<void>;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #onSettled: (() => void) | undefined;
  #running: Promise<void> | undefined;
  #requested = false;

  constructor(options: {
    readonly run: () => Promise<void>;
    readonly onError?: (error: unknown) => void;
    /** Nothing is running and nothing is requested. */
    readonly onSettled?: () => void;
  }) {
    this.#run = options.run;
    this.#onError = options.onError;
    this.#onSettled = options.onSettled;
  }

  wake(): void {
    if (this.#running) {
      this.#requested = true;
      return;
    }
    this.#running = (async () => this.#run())()
      .catch((error: unknown) => this.#onError?.(error))
      .finally(() => {
        this.#running = undefined;
        if (!this.#requested) {
          this.#onSettled?.();
          return;
        }
        this.#requested = false;
        this.wake();
      });
  }

  /**
   * Forgets requested passes and waits for the running one. A wake made after
   * this call belongs to whoever made it, and runs once that pass ends.
   */
  async stop(): Promise<void> {
    this.#requested = false;
    await this.#running;
  }
}
