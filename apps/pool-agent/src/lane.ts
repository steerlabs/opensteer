/** One operation at a time per slot, in arrival order. */
export class Lane {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  get busy(): boolean {
    return this.#depth > 0;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    this.#depth += 1;
    const result = this.#tail.then(work);
    const done = () => {
      this.#depth -= 1;
    };
    // The tail itself never rejects: one failed operation does not fail the next.
    this.#tail = result.then(done, done);
    return result;
  }
}

/** At most `limit` holders at once; the rest wait in order. */
export class Semaphore {
  readonly #limit: number;
  #held = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  async acquire(): Promise<() => void> {
    if (this.#held >= this.#limit)
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#held += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held -= 1;
      this.#waiting.shift()?.();
    };
  }
}

/** A deadline as an AbortSignal and a promise race, so a hung step can never hold a slot. */
export async function within<T>(
  ms: number,
  what: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new DeadlineExceeded(`${what} did not finish within ${ms} ms.`);
          controller.abort(error);
          reject(error);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class DeadlineExceeded extends Error {
  override readonly name = "DeadlineExceeded";
}
