import { systemClock, type Clock } from "@opensteer/shared/clock";

const maxTimerMs = 2 ** 31 - 1;

interface DeadlineDrainOptions {
  readonly clock?: Clock;
  readonly drain: () => Promise<Date | null>;
  readonly onError?: (error: unknown) => void;
}

/** Runs after a wake or at the next durable deadline. A wake during a pass runs again. */
export class DeadlineDrain {
  readonly #options: DeadlineDrainOptions;
  readonly #clock: Clock;
  #work: Promise<void> | undefined;
  #cancelTimer: (() => void) | undefined;
  #dirty = false;
  #started = false;
  #closed = false;
  #completedPasses = 0;

  constructor(options: DeadlineDrainOptions) {
    this.#options = options;
    this.#clock = options.clock ?? { ...systemClock, now: Date.now };
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.wake();
  }

  wake(): void {
    if (this.#closed) return;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#dirty = true;
    this.#work ??= this.#run().finally(() => {
      this.#work = undefined;
      if (this.#dirty) this.wake();
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
        next = await this.#options.drain();
      } catch (error) {
        // A failed read cannot establish that the durable queue is empty.
        next = new Date(this.#clock.now() + 5_000);
        this.#options.onError?.(error);
      } finally {
        this.#completedPasses++;
      }
    }
    if (next && !this.#closed)
      this.#cancelTimer = this.#clock.schedule(
        () => this.wake(),
        Math.min(maxTimerMs, Math.max(0, next.getTime() - this.#clock.now())),
      );
  }
}
