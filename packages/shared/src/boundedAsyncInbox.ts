/**
 * A socket's inbox with a ceiling, in both items and bytes.
 *
 * A protocol socket that reads faster than it can process would otherwise let
 * whoever is on the other end decide how much Host memory to occupy. Overflow
 * is a protocol error rather than backpressure: the peer broke the contract,
 * and the connection is the thing to lose.
 *
 * With `flow`, the inbox also pauses its source at a high-water mark and
 * resumes it at half, so a peer that honors transport backpressure is slowed
 * down instead of reaching the ceiling. The ceiling must leave room for what
 * the source delivers after it is paused, such as the rest of one read.
 */
export interface BoundedInboxItem<T> {
  readonly bytes: number;
  readonly value: T;
}

export interface BoundedInboxFlow {
  readonly highWaterBytes: number;
  readonly highWaterItems: number;
  readonly pause: () => void;
  readonly resume: () => void;
}

export class BoundedAsyncInbox<T> implements AsyncIterable<T> {
  readonly #flow: BoundedInboxFlow | undefined;
  readonly #maxBytes: number;
  readonly #maxItems: number;
  readonly #queue: Array<BoundedInboxItem<T>> = [];
  readonly #waiters: Array<{
    readonly reject: (error: unknown) => void;
    readonly resolve: (result: IteratorResult<T>) => void;
  }> = [];
  #bytes = 0;
  #closed: unknown | undefined;
  #paused = false;

  constructor(options: {
    readonly flow?: BoundedInboxFlow;
    readonly maxBytes: number;
    readonly maxItems: number;
  }) {
    this.#flow = options.flow;
    this.#maxBytes = options.maxBytes;
    this.#maxItems = options.maxItems;
  }

  push(item: BoundedInboxItem<T>): void {
    if (this.#closed !== undefined) return;
    if (item.bytes < 0 || item.bytes > this.#maxBytes) throw overflow();
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: item.value });
      return;
    }
    if (this.#queue.length >= this.#maxItems || this.#bytes + item.bytes > this.#maxBytes) {
      throw overflow();
    }
    this.#queue.push(item);
    this.#bytes += item.bytes;
    const flow = this.#flow;
    if (
      flow &&
      !this.#paused &&
      (this.#bytes >= flow.highWaterBytes || this.#queue.length >= flow.highWaterItems)
    ) {
      this.#paused = true;
      flow.pause();
    }
  }

  close(error?: unknown): void {
    if (this.#closed !== undefined) return;
    this.#closed = error ?? null;
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }

  private next(): Promise<IteratorResult<T>> {
    const item = this.#queue.shift();
    if (item) {
      this.#bytes -= item.bytes;
      const flow = this.#flow;
      if (
        flow &&
        this.#paused &&
        this.#bytes <= flow.highWaterBytes / 2 &&
        this.#queue.length <= flow.highWaterItems / 2
      ) {
        this.#paused = false;
        flow.resume();
      }
      return Promise.resolve({ done: false, value: item.value });
    }
    if (this.#closed !== undefined) {
      return this.#closed === null
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.#closed);
    }
    return new Promise((resolve, reject) => this.#waiters.push({ reject, resolve }));
  }
}

export class BoundedInboxOverflowError extends Error {
  constructor() {
    super("The connection exceeded its bounded input queue.");
    this.name = "BoundedInboxOverflowError";
  }
}

function overflow(): BoundedInboxOverflowError {
  return new BoundedInboxOverflowError();
}
