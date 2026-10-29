export class EventBufferOverflowError extends Error {
  constructor(message = "A must-deliver harness event exceeded the bounded event buffer") {
    super(message);
    this.name = "EventBufferOverflowError";
  }
}

export interface PublishOptions {
  readonly delivery: "must-deliver" | "disposable";
  readonly coalesceKey?: string;
}

interface BufferedItem<T> {
  readonly value: T;
  readonly bytes: number;
  readonly delivery: PublishOptions["delivery"];
  readonly coalesceKey: string | undefined;
}

interface WaitingConsumer<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
}

interface BoundedEventStreamOptions<T> {
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly sizeOf?: (value: T) => number;
}

export class BoundedEventStream<T> implements AsyncIterable<T> {
  readonly #maxBytes: number;
  readonly #maxItems: number;
  readonly #sizeOf: (value: T) => number;
  readonly #queue: BufferedItem<T>[] = [];
  readonly #waiting: WaitingConsumer<T>[] = [];
  #bufferedBytes = 0;
  #closed = false;
  #error: unknown;

  constructor(options: BoundedEventStreamOptions<T>) {
    if (!Number.isInteger(options.maxItems) || options.maxItems < 1) {
      throw new TypeError("maxItems must be a positive integer");
    }
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new TypeError("maxBytes must be a positive integer");
    }
    this.#maxItems = options.maxItems;
    this.#maxBytes = options.maxBytes;
    this.#sizeOf = options.sizeOf ?? defaultSizeOf;
  }

  get bufferedBytes(): number {
    return this.#bufferedBytes;
  }

  get bufferedItems(): number {
    return this.#queue.length;
  }

  publish(value: T, options: PublishOptions): boolean {
    if (this.#closed) throw new Error("Cannot publish to a closed event stream");
    const waiting = this.#waiting.shift();
    if (waiting) {
      waiting.resolve({ done: false, value });
      return true;
    }

    const bytes = this.#safeSize(value);
    if (options.delivery === "disposable" && options.coalesceKey) {
      const existingIndex = this.#queue.findIndex(
        (item) => item.delivery === "disposable" && item.coalesceKey === options.coalesceKey,
      );
      if (existingIndex >= 0) {
        const existing = this.#queue[existingIndex];
        if (!existing) throw new Error("Event buffer index disappeared");
        const prospectiveBytes = this.#bufferedBytes - existing.bytes + bytes;
        if (prospectiveBytes > this.#maxBytes) return false;
        this.#queue[existingIndex] = {
          bytes,
          coalesceKey: options.coalesceKey,
          delivery: options.delivery,
          value,
        };
        this.#bufferedBytes = prospectiveBytes;
        return true;
      }
    }

    if (!this.#fits(bytes)) {
      if (options.delivery === "disposable") return false;
      // Progress a reader can do without never costs an event it cannot.
      this.#evictDisposable(bytes);
      if (!this.#fits(bytes)) {
        const error = new EventBufferOverflowError();
        this.close(error);
        throw error;
      }
    }

    this.#queue.push({
      bytes,
      coalesceKey: options.coalesceKey,
      delivery: options.delivery,
      value,
    });
    this.#bufferedBytes += bytes;
    return true;
  }

  close(error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    const consumers = this.#waiting.splice(0);
    for (const consumer of consumers) {
      if (error === undefined) consumer.resolve({ done: true, value: undefined });
      else consumer.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.#next() };
  }

  #next(): Promise<IteratorResult<T>> {
    const item = this.#queue.shift();
    if (item) {
      this.#bufferedBytes -= item.bytes;
      return Promise.resolve({ done: false, value: item.value });
    }
    if (this.#closed) {
      return this.#error === undefined
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.#error);
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiting.push({ reject, resolve });
    });
  }

  #fits(bytes: number): boolean {
    return this.#queue.length < this.#maxItems && this.#bufferedBytes + bytes <= this.#maxBytes;
  }

  /** Drops the oldest disposable items until `bytes` more would fit. */
  #evictDisposable(bytes: number): void {
    for (let index = 0; index < this.#queue.length && !this.#fits(bytes);) {
      const item = this.#queue[index];
      if (item?.delivery !== "disposable") {
        index += 1;
        continue;
      }
      this.#queue.splice(index, 1);
      this.#bufferedBytes -= item.bytes;
    }
  }

  #safeSize(value: T): number {
    const bytes = this.#sizeOf(value);
    if (!Number.isFinite(bytes) || bytes < 0)
      throw new TypeError("sizeOf returned an invalid size");
    return Math.ceil(bytes);
  }
}

function defaultSizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
