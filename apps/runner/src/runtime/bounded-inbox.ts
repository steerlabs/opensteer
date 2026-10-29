export interface BoundedInboxItem<T> {
  readonly bytes: number;
  readonly value: T;
}

export class BoundedRunnerInbox<T> implements AsyncIterable<T> {
  readonly #maxBytes: number;
  readonly #maxItems: number;
  readonly #queue: Array<BoundedInboxItem<T>> = [];
  readonly #waiters: Array<{
    readonly matches: (value: T) => boolean;
    readonly reject: (error: unknown) => void;
    readonly resolve: (result: IteratorResult<T>) => void;
  }> = [];
  #bytes = 0;
  #closed: unknown | undefined;

  constructor(options: { readonly maxBytes: number; readonly maxItems: number }) {
    this.#maxBytes = options.maxBytes;
    this.#maxItems = options.maxItems;
  }

  push(item: BoundedInboxItem<T>): void {
    if (this.#closed !== undefined) return;
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > this.#maxBytes) {
      throw overflow();
    }
    const waiterIndex = this.#waiters.findIndex((waiter) => waiter.matches(item.value));
    const waiter = waiterIndex < 0 ? undefined : this.#waiters.splice(waiterIndex, 1)[0];
    if (waiter) {
      waiter.resolve({ done: false, value: item.value });
      return;
    }
    if (this.#queue.length >= this.#maxItems || this.#bytes + item.bytes > this.#maxBytes) {
      throw overflow();
    }
    this.#queue.push(item);
    this.#bytes += item.bytes;
  }

  close(error?: unknown): void {
    if (this.#closed !== undefined) return;
    this.#closed = error ?? null;
    this.#queue.length = 0;
    this.#bytes = 0;
    for (const waiter of this.#waiters.splice(0)) {
      if (error === undefined) waiter.resolve({ done: true, value: undefined });
      else waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.nextMatching(() => true) };
  }

  nextMatching(matches: (value: T) => boolean): Promise<IteratorResult<T>> {
    const index = this.#queue.findIndex((item) => matches(item.value));
    const item = index < 0 ? undefined : this.#queue.splice(index, 1)[0];
    if (item) {
      this.#bytes -= item.bytes;
      return Promise.resolve({ done: false, value: item.value });
    }
    if (this.#closed !== undefined) {
      return this.#closed === null
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.#closed);
    }
    return new Promise((resolve, reject) => this.#waiters.push({ matches, reject, resolve }));
  }
}

function overflow(): Error {
  return new Error("Runner connection exceeded its bounded input queue");
}
