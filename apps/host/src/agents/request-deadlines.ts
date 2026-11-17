const maxTimerMs = 2 ** 31 - 1;

interface RequestDeadlineOptions {
  readonly next: () => Promise<Date | null>;
  readonly settle: (now: Date) => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly now?: () => number;
}

export class RequestDeadlines {
  readonly #options: RequestDeadlineOptions;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #work: Promise<void> | undefined;
  #dirty = false;
  #closed = false;

  constructor(options: RequestDeadlineOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  changed(): void {
    void this.settle().catch(this.#options.onError);
  }

  settle(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#dirty = true;
    this.#work ??= this.#plan().finally(() => {
      this.#work = undefined;
      if (this.#dirty && !this.#closed) this.changed();
    });
    return this.#work;
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    await this.#work?.catch(() => undefined);
  }

  #schedule(delay: number) {
    if (this.#closed) return;
    this.#timer = setTimeout(() => this.changed(), Math.min(delay, maxTimerMs));
    this.#timer.unref();
  }

  async #plan() {
    clearTimeout(this.#timer);
    try {
      while (this.#dirty && !this.#closed) {
        this.#dirty = false;
        const next = await this.#options.next();
        if (this.#closed) break;
        const now = this.#now();
        if (next && next.getTime() <= now) {
          await this.#options.settle(new Date(now));
          this.#dirty = true;
        } else if (next && !this.#dirty) {
          this.#schedule(next.getTime() - now);
        }
      }
    } catch (error) {
      this.#dirty = false;
      this.#schedule(1_000);
      throw error;
    }
  }
}
