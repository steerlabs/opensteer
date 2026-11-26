/** One queued batch of a stream's input, from one viewer source. */
export interface OrderedInputBatch<T> {
  /** The viewer source it came from: a reset for that source answers its queued batches. */
  readonly source: string;
  readonly bytes: number;
  readonly value: T;
  /** It lets go of a held press: it always has room, as the Home gives it room. */
  readonly release?: boolean;
}

export interface OrderedInputLaneOptions<T> {
  readonly maxBatches: number;
  readonly maxBytes: number;
  /** Sends one batch and answers it, refused included; settles when it is answered. */
  readonly send: (value: T) => Promise<void>;
  readonly reset: (source: string) => Promise<void>;
  readonly notSent: (value: T) => void;
}

type Queued<T> =
  | { readonly kind: "input"; readonly batch: OrderedInputBatch<T> }
  | { readonly kind: "reset"; readonly source: string };

/**
 * Relays one stream's input to the Mac's helper one batch at a time, in arrival order. The
 * helper admits four batches a stream and refuses the rest, and batches relayed together can
 * reach it out of order; it handles them one by one anyway, so one in flight costs only the
 * local round trip. Every batch keeps its own answer: `send` answers it as the helper did,
 * and a batch that never left is answered by `notSent` when its source resets or the stream
 * ends. A full queue refuses a new batch without sending it, as the helper's full lane does.
 */
export class OrderedInputLane<T> {
  readonly #options: OrderedInputLaneOptions<T>;
  readonly #queue: Queued<T>[] = [];
  #bytes = 0;
  #running = false;
  #ended = false;

  constructor(options: OrderedInputLaneOptions<T>) {
    this.#options = options;
  }

  /** Whether anything is with the helper or waiting for it. */
  get busy(): boolean {
    return this.#running || this.#queue.length > 0;
  }

  /** Queues a batch behind those before it; false when the lane is full or the stream ended. */
  input(batch: OrderedInputBatch<T>): boolean {
    const queued = this.#queue.filter((entry) => entry.kind === "input").length;
    if (
      this.#ended ||
      (!batch.release &&
        (queued >= this.#options.maxBatches || this.#bytes + batch.bytes > this.#options.maxBytes))
    )
      return false;
    this.#queue.push({ kind: "input", batch });
    this.#bytes += batch.bytes;
    void this.#pump();
    return true;
  }

  /** The source lets go: what it still has queued never leaves, and the reset follows the batch in flight. */
  reset(source: string): void {
    if (this.#ended) return;
    this.#answerQueued((entry) => entry.source === source);
    if (!this.#queue.some((entry) => entry.kind === "reset" && entry.source === source))
      this.#queue.push({ kind: "reset", source });
    void this.#pump();
  }

  /** The stream ended: nothing queued leaves; the batch in flight keeps its own answer. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#answerQueued(() => true);
    this.#queue.length = 0;
  }

  #answerQueued(matches: (batch: OrderedInputBatch<T>) => boolean): void {
    for (let index = 0; index < this.#queue.length;) {
      const entry = this.#queue[index]!;
      if (entry.kind === "input" && matches(entry.batch)) {
        this.#queue.splice(index, 1);
        this.#bytes -= entry.batch.bytes;
        this.#options.notSent(entry.batch.value);
      } else index++;
    }
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let next = this.#queue.shift(); next; next = this.#queue.shift()) {
        if (next.kind === "input") {
          this.#bytes -= next.batch.bytes;
          await this.#options.send(next.batch.value).catch(() => undefined);
        } else await this.#options.reset(next.source).catch(() => undefined);
      }
    } finally {
      this.#running = false;
    }
  }
}
